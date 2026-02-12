import crypto from 'crypto';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { Pool } from 'pg';
import path from 'path';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import fs from 'fs';

const allowedOrigins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:4173",
    "https://pagepulse-ebon.vercel.app"
];

const app = express();
app.use(cookieParser());
// Health check endpoint for Kubernetes
app.get('/health', (req, res) => res.send('OK'));
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
}));
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
            if (!origin || allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error("Not allowed by CORS"));
            }
        },
        methods: ["GET", "POST"],
        credentials: true
    }
});

// --- gRPC Client Setup (auth-service) ---
const AUTH_PROTO_PATH = path.join(__dirname, '../../../packages/protos/auth.proto');
const authPkgDef = protoLoader.loadSync(AUTH_PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const authProto: any = grpc.loadPackageDefinition(authPkgDef).auth;
const AUTH_GRPC_URL = process.env.AUTH_GRPC_URL || 'auth-service:50051';
const authClient = new authProto.AuthService(AUTH_GRPC_URL, grpc.credentials.createInsecure());

// --- gRPC Server Setup (notification push) ---
const NOTIF_PROTO_PATH = path.join(__dirname, '../../../packages/protos/notification.proto');
const notifPkgDef = protoLoader.loadSync(NOTIF_PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const notifProto: any = grpc.loadPackageDefinition(notifPkgDef).notification;

// userId → Set<socketId>  — tracks every connected socket per user
const userSockets = new Map<string, Set<string>>();

function addUserSocket(userId: string, socketId: string) {
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId)!.add(socketId);
}

function removeUserSocket(userId: string, socketId: string) {
    const socks = userSockets.get(userId);
    if (socks) {
        socks.delete(socketId);
        if (socks.size === 0) userSockets.delete(userId);
    }
}

// gRPC handler: notification-service calls this to push a real-time alert
function pushNotificationHandler(call: any, callback: any) {
    const { user_id, type, message, sender_id, sender_username, notification_id, invitation_id } = call.request;
    const sockets = userSockets.get(user_id);

    if (sockets && sockets.size > 0) {
        const payload = { user_id, type, message, sender_id, sender_username, notification_id, invitation_id };
        for (const sid of sockets) {
            io.to(sid).emit('receive_notification', payload);
        }
        console.log(`[Push] Emitted receive_notification to ${sockets.size} socket(s) for user ${user_id}`);
        callback(null, { delivered: true, error: '' });
    } else {
        console.log(`[Push] No active sockets for user ${user_id} – notification stored only`);
        callback(null, { delivered: false, error: 'User not connected' });
    }
}

// Start gRPC server
const GRPC_PORT = process.env.GRPC_PORT || '50053';
const grpcServer = new grpc.Server();
grpcServer.addService(notifProto.NotificationPush.service, { PushNotification: pushNotificationHandler });
grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
        console.error('[gRPC] Failed to bind:', err);
    } else {
        console.log(`[gRPC] NotificationPush server listening on port ${port}`);
    }
});

// Promisify gRPC calls
const checkBlockStatusMap = (userId: string, targetUserId: string): Promise<boolean> => {
    return new Promise((resolve, reject) => {
        authClient.CheckBlockStatus({ user_id: userId, target_user_id: targetUserId }, (err: any, response: any) => {
            if (err) {
                console.error("gRPC CheckBlockStatus Error:", err);
                resolve(false); // Fail safe/open?
            } else {
                resolve(response.is_blocked);
            }
        });
    });
};

const getUserByUsernameMap = (username: string): Promise<string | null> => {
    return new Promise((resolve, reject) => {
        authClient.GetUserByUsername({ username }, (err: any, response: any) => {
            if (err) {
                console.error("gRPC GetUserByUsername Error:", err);
                resolve(null);
            } else {
                resolve(response.found ? response.user_id : null);
            }
        });
    });
};

const getFriendsListMap = (userId: string): Promise<string[]> => {
    return new Promise((resolve, reject) => {
        authClient.GetFriendsList({ user_id: userId }, (err: any, response: any) => {
            if (err) {
                console.error("gRPC GetFriendsList Error:", err);
                resolve([]);
            } else {
                resolve(response.friend_ids || []);
            }
        });
    });
};

// --- Database Setup ---
const pool = new Pool({
    connectionString: process.env.DB_URL
});

async function initDB() {
    // ... (existing initDB)
    const maxRetries = 10;
    let retries = 0;
    while (retries < maxRetries) {
        try {
            const initSqlPath = path.join(__dirname, 'db/init.sql');
            const initSql = fs.readFileSync(initSqlPath, 'utf8');
            await pool.query(initSql);
            console.log('[DB] Chat Database initialized successfully');
            return;
        } catch (err) {
            retries++;
            console.log(`[DB] Connection failed (Attempt ${retries}/${maxRetries}), retrying in 5s...`);
            await new Promise(res => setTimeout(res, 5000));
        }
    }
    console.error('[DB] Could not connect to database after multiple attempts. Exiting.');
    process.exit(1);
}

initDB();

// --- HTTP API Routes ---

// 1. Initiate Private Chat (by user_id)
app.post('/private', async (req, res) => {
    const { myId, targetUserId } = req.body;

    if (!myId || !targetUserId) {
        return res.status(400).json({ error: "Missing myId or targetUserId" });
    }

    try {

        // A. Check for Blocked Status (gRPC)
        const isBlocked = await checkBlockStatusMap(myId, targetUserId);

        if (isBlocked) {
            return res.status(403).json({ error: "Cannot create chat: User is blocked" });
        }



        // B. Check for existing private conversation
        const existingRes = await pool.query(`
            SELECT c.conversation_id 
            FROM conversations c
            JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id
            JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id
            WHERE c.type = 'private' 
              AND cp1.user_id = $1 
              AND cp2.user_id = $2
        `, [myId, targetUserId]);

        if (existingRes.rows.length > 0) {
            return res.json({ conversationId: existingRes.rows[0].conversation_id, created: false });
        }

        // C. Create new conversation
        const newConvId = crypto.randomUUID();
        const now = new Date();

        await pool.query('BEGIN');
        await pool.query('INSERT INTO conversations (conversation_id, type, created_at) VALUES ($1, $2, $3)', [newConvId, 'private', now]);
        await pool.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)', [newConvId, myId]);
        await pool.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)', [newConvId, targetUserId]);
        await pool.query('COMMIT');

        return res.json({ conversationId: newConvId, created: true });

    } catch (err) {
        await pool.query('ROLLBACK');
        console.error("Error creating private chat:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 2. Get Private Chat Message History
app.get('/private/:conversationId/messages', async (req, res) => {
    const { conversationId } = req.params;
    const { limit = 50, before } = req.query; // Pagination: limit & cursor

    try {
        let query = `
            SELECT message_id, conversation_id, sender_id, content, sent_at
            FROM messages 
            WHERE conversation_id = $1
        `;
        const params: any[] = [conversationId];

        // Cursor-based pagination (load older messages)
        if (before) {
            query += ` AND sent_at < $2`;
            params.push(before);
        }

        query += ` ORDER BY sent_at DESC LIMIT $${params.length + 1}`;
        params.push(Number(limit));

        const result = await pool.query(query, params);

        // Return in chronological order (oldest first)
        res.json({
            messages: result.rows.reverse(),
            hasMore: result.rows.length === Number(limit)
        });

    } catch (err) {
        console.error("Error fetching messages:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 3. Get User's Conversations List
app.get('/conversations/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const result = await pool.query(`
            SELECT 
                c.conversation_id,
                c.type,
                c.created_at,
                (
                    SELECT json_build_object(
                        'message_id', m.message_id,
                        'sender_id', m.sender_id,
                        'content', m.content,
                        'sent_at', m.sent_at
                    )
                    FROM messages m 
                    WHERE m.conversation_id = c.conversation_id 
                    ORDER BY m.sent_at DESC LIMIT 1
                ) as last_message,
                (
                    SELECT array_agg(cp2.user_id) 
                    FROM conversation_participants cp2 
                    WHERE cp2.conversation_id = c.conversation_id 
                    AND cp2.user_id != $1
                ) as other_participants
            FROM conversations c
            JOIN conversation_participants cp ON c.conversation_id = cp.conversation_id
            WHERE cp.user_id = $1 AND c.type = 'private'
            ORDER BY (
                SELECT MAX(m.sent_at) FROM messages m WHERE m.conversation_id = c.conversation_id
            ) DESC NULLS LAST
        `, [userId]);

        res.json({ conversations: result.rows });

    } catch (err) {
        console.error("Error fetching conversations:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Proxy endpoint: fetch user details from auth-service via gRPC and return to frontend
app.get('/chatusers/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Missing id" });

    try {
        authClient.GetUserById({ user_id: id }, (err: any, response: any) => {
            if (err) {
                console.error("gRPC GetUserById Error:", err);
                return res.status(502).json({ error: "Auth service error" });
            }

            if (!response || !response.found) {
                return res.status(404).json({ found: false });
            }

            // Map auth-service fields to a simple shape for chat frontend
            return res.json({
                id: response.user_id,
                username: response.username,
                email: response.email,
                avatar: response.avatar || null
            });
        });
    } catch (err) {
        console.error("/chatusers/:id Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 4. Initiate/Invite Book Session
app.post('/reading', async (req, res) => {
    const { myId, bookId, friendUsername } = req.body; // friendUsername optional

    try {
        const newConvId = crypto.randomUUID();
        const now = new Date();

        await pool.query('BEGIN');
        // Create session with Host logic
        await pool.query(
            'INSERT INTO conversations (conversation_id, type, book_id, host_user_id, created_at) VALUES ($1, $2, $3, $4, $5)',
            [newConvId, 'book', bookId, myId, now]
        );

        // Add Host
        await pool.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)', [newConvId, myId]);

        // Add Friend if provided
        if (friendUsername) {
            const friendId = await getUserByUsernameMap(friendUsername);
            if (friendId) {
                await pool.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)', [newConvId, friendId]);
            }
        }
        await pool.query('COMMIT');

        return res.json({ conversationId: newConvId });

    } catch (err) {
        await pool.query('ROLLBACK');
        console.error("Error creating reading session:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// --- WebSocket Logic ---
interface ReadingSession {
    host: string;
    users: Set<string>;
}

const activeSessions = new Map<string, ReadingSession>(); // conversationId -> Session

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // --- Register userId ↔ socket for real-time notifications ---
    socket.on('register', (userId: string) => {
        if (!userId) return;
        (socket as any).userId = userId;
        addUserSocket(userId, socket.id);
        console.log(`[Socket] Registered user ${userId} → socket ${socket.id}`);
    });

    // --- Private Chat Events (Persisted) ---
    socket.on('join_private_chat', (conversationId: string) => {
        socket.join(conversationId);
        console.log(`User ${socket.id} joined private chat ${conversationId}`);
    });

    socket.on('send_private_message', async (data: any) => {
        const { conversation_id, sender_id, content } = data;
        try {
            // Check for Blocked Status before sending
            // We need the recipient ID. Query participants.
            const partRes = await pool.query(`
                SELECT user_id FROM conversation_participants 
                WHERE conversation_id = $1 AND user_id != $2
            `, [conversation_id, sender_id]);

            if (partRes.rows.length > 0) {
                const recipientId = partRes.rows[0].user_id;
                const isBlocked = await checkBlockStatusMap(sender_id, recipientId);

                if (isBlocked) {
                    socket.emit("error", "Message failed: You are blocked or have blocked this user");
                    return;
                }
            }

            const message_id = crypto.randomUUID();
            const sent_at = new Date();

            // Persist
            await pool.query(
                'INSERT INTO messages (message_id, conversation_id, sender_id, content, sent_at) VALUES ($1, $2, $3, $4, $5)',
                [message_id, conversation_id, sender_id, content, sent_at]
            );

            // Broadcast
            io.to(conversation_id).emit('receive_private_message', {
                message_id, conversation_id, sender_id, content, sent_at
            });
        } catch (err) {
            console.error("Error saving private message:", err);
            socket.emit("error", "Failed to send message");
        }
    });

    // --- Reading Session Events (Ephemeral) ---
    socket.on('join_reading_session', (data: { conversationId: string, userId: string, bookId: number }) => {
        const { conversationId, userId } = data;
        socket.join(conversationId);

        // Track session state in memory
        if (!activeSessions.has(conversationId)) {
            // First user is host (or frontend tells us who host is? Assuming first joiner for now or derived from DB check?)
            // User requirement: "Backend creates / joins room... if !has -> set host".
            // Ideally frontend calls an API to create the session in DB first, then joins.
            // Here, we just track active participation.
            activeSessions.set(conversationId, {
                host: userId,
                users: new Set([userId])
            });
            console.log(`[Reading] New session ${conversationId} started by host ${userId}`);
        } else {
            activeSessions.get(conversationId)?.users.add(userId);
            console.log(`[Reading] User ${userId} joined session ${conversationId}`);
        }

        // Tag socket with userId for disconnect handling
        (socket as any).userId = userId;
    });

    socket.on('reading_message', async (data: { conversationId: string, sender: any, senderId: string, content: string, isFriendsOnly?: boolean }) => {
        const { conversationId, sender, senderId, content, isFriendsOnly } = data;
        const messagePayload = {
            sender,
            senderId,
            content,
            time: Date.now(),
            isFriendsOnly: isFriendsOnly || false
        };

        if (isFriendsOnly && senderId) {
            // Get sender's friends list via gRPC
            const friendIds = await getFriendsListMap(senderId);
            const friendSet = new Set(friendIds);

            // Get all sockets in the room and filter
            const roomSockets = await io.in(conversationId).fetchSockets();
            for (const roomSocket of roomSockets) {
                const recipientId = (roomSocket as any).userId;
                // Send only to sender themselves or their friends
                if (recipientId === senderId || friendSet.has(recipientId)) {
                    roomSocket.emit('reading_message', messagePayload);
                }
            }
        } else {
            // Broadcast to everyone in the room
            io.to(conversationId).emit('reading_message', messagePayload);
        }
    });

    // --- Public Book Room Events ---
    socket.on('join_book_room', (data: { bookId: string | number, userId: string }) => {
        const { bookId, userId } = data;
        const roomName = `book_${bookId}`;
        socket.join(roomName);
        console.log(`User ${userId} joined public book room ${roomName}`);

        // Notify others in the room
        socket.to(roomName).emit('user_joined_book', { userId, count: io.sockets.adapter.rooms.get(roomName)?.size || 0 });

        // Store room on socket for disconnect handling
        (socket as any).bookRoom = roomName;
        (socket as any).userId = userId; // Ensure userId is set
    });

    // [NEW] Handle request for the list of active users in a public book room
    socket.on('request_active_users', async (data: { bookId: string | number }) => {
        const { bookId } = data;
        const roomName = `book_${bookId}`;
        try {
            // Fetch all sockets currently in this room
            const sockets = await io.in(roomName).fetchSockets();

            // Extract the 'userId' from each socket (requires join_book_room to set it)
            const userIds = sockets
                .map(s => (s as any).userId)
                .filter(id => !!id);

            // Send the list of IDs back to the requester
            socket.emit('active_users', userIds);

            console.log(`[BookRoom] Sent ${userIds.length} active users for ${roomName}`);
        } catch (error) {
            console.error("Error fetching active users:", error);
        }
    });

    socket.on('leave_book_room', (data: { bookId: string | number, userId: string }) => {
        const { bookId, userId } = data;
        const roomName = `book_${bookId}`;
        socket.leave(roomName);
        console.log(`User ${userId} left public book room ${roomName}`);

        socket.to(roomName).emit('user_left_book', { userId, count: io.sockets.adapter.rooms.get(roomName)?.size || 0 });
        delete (socket as any).bookRoom;
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const userId = (socket as any).userId;
        const bookRoom = (socket as any).bookRoom;

        // Clean up notification socket registry
        if (userId) {
            removeUserSocket(userId, socket.id);
        }

        // 1. Handle Public Book Room Disconnect
        if (bookRoom && userId) {
            console.log(`[BookRoom] User ${userId} disconnected from ${bookRoom}`);
            io.to(bookRoom).emit('user_left_book', { userId, count: io.sockets.adapter.rooms.get(bookRoom)?.size || 0 });
        }

        // 2. Handle Private/Reading Session Disconnects
        if (userId) {
            // Check if host of any active session
            for (const [cid, session] of activeSessions.entries()) {
                if (session.host === userId) {
                    console.log(`[Reading] Host ${userId} left. Ending session ${cid}`);
                    io.to(cid).emit('session_ended');
                    activeSessions.delete(cid);
                    io.in(cid).disconnectSockets(true);
                } else if (session.users.has(userId)) {
                    session.users.delete(userId);
                }
            }
        }
    });
});

const PORT = process.env.HTTP_PORT || process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Chat Service running on port ${PORT}`);
});
