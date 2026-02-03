import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';
import * as crypto from 'crypto';
import cors from 'cors';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const app = express();
app.use(cors({
    origin: ["http://localhost:5173"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
}));
app.use(express.json()); // Enable JSON body parsing

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "http://localhost:5173",
        methods: ["GET", "POST"],
        credentials: true
    }
}
});

// --- gRPC Client Setup ---
const PROTO_PATH = path.join(__dirname, '../../../packages/protos/auth.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const authProto: any = grpc.loadPackageDefinition(packageDefinition).auth;
const AUTH_GRPC_URL = process.env.AUTH_GRPC_URL || 'auth-service:50051';
const authClient = new authProto.AuthService(AUTH_GRPC_URL, grpc.credentials.createInsecure());

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

// 2. Initiate/Invite Book Session
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

    socket.on('reading_message', (data: { conversationId: string, sender: any, content: string }) => {
        // Broadcast ONLY - No DB
        const { conversationId, sender, content } = data;
        io.to(conversationId).emit('reading_message', {
            sender,
            content,
            time: Date.now()
        });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const userId = (socket as any).userId;

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

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
    console.log(`Chat Service running on port ${PORT}`);
});
