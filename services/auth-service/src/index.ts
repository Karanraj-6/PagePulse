import express from 'express';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { Pool } from 'pg';
import fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import amqp from 'amqplib';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import multer from 'multer';

const app = express();
app.use(cookieParser());
app.use(cors({
    origin: ["http://localhost:5173", "http://localhost:3000"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
}));
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || '89b88155b09089801b90128faa96d4af7e92b7860f7762527107f5cd427b0c8c';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672';

// AWS S3 Configuration
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    }
});

const S3_BUCKET = process.env.S3_BUCKET_NAME || 'your-bucket-name';

// Configure Multer for memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            cb(new Error('Only image files are allowed!'));
            return;
        }
        cb(null, true);
    }
});

// Helper function to upload to S3
async function uploadToS3(file: Express.Multer.File, userId: string): Promise<string> {
    const fileExtension = file.originalname.split('.').pop();
    const fileName = `avatars/${userId}-${randomUUID()}.${fileExtension}`;

    const command = new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: fileName,
        Body: file.buffer,
        ContentType: file.mimetype,
        ACL: 'public-read',
    });

    try {
        await s3Client.send(command);
        return `https://${S3_BUCKET}.s3.amazonaws.com/${fileName}`;
    } catch (error) {
        console.error('S3 Upload Error:', error);
        throw new Error('Failed to upload image to S3');
    }
}

// --- Database Setup ---
const pool = new Pool({
    connectionString: process.env.DB_URL
});

async function initDB() {
    const maxRetries = 10;
    let retries = 0;
    while (retries < maxRetries) {
        try {
            const initSqlPath = path.join(__dirname, 'db/init.sql');
            const initSql = fs.readFileSync(initSqlPath, 'utf8');
            await pool.query(initSql);
            console.log('[DB] Auth Database initialized successfully');
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

// --- RabbitMQ Setup ---
let channel: amqp.Channel;
async function connectRabbitMQ() {
    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        channel = await connection.createChannel();
        await channel.assertQueue('notifications', { durable: true });
        console.log('[RabbitMQ] Connected and queue "notifications" asserted');
    } catch (err) {
        console.error('[RabbitMQ] Connection failed:', err);
    }
}
connectRabbitMQ();

function publishEvent(eventType: string, payload: any) {
    if (channel) {
        const msg = JSON.stringify({ type: eventType, payload });
        channel.sendToQueue('notifications', Buffer.from(msg));
        console.log(`[RabbitMQ] Published: ${eventType}`);
    } else {
        console.warn('[RabbitMQ] Channel not ready, message lost:', eventType);
    }
}

// --- Helper: Password Hashing ---
function hashPassword(password: string): string {
    return createHash('sha256').update(password).digest('hex');
}

// --- REST API Endpoints ---

// 1. Register
app.post('/auth/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: "Missing fields" });

    try {
        const userId = randomUUID();
        const passwordHash = hashPassword(password);

        await pool.query(
            'INSERT INTO users (user_id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
            [userId, username, email, passwordHash]
        );

        // Create default profile photo entry
        await pool.query(
            'INSERT INTO profile_photos (user_id, photo_url) VALUES ($1, $2)',
            [userId, null]
        );

        publishEvent('user.registered', { userId, email, username });

        const token = jwt.sign(
            { user_id: userId, username: username },
            JWT_SECRET,
            { expiresIn: '1h' }
        );

        res.cookie('token', token, {
            httpOnly: true,
            secure: false,
            sameSite: 'lax',
            maxAge: 3600000
        });

        res.json({ userId, username, token, message: "User created" });
    } catch (err: any) {
        if (err.code === '23505') {
            return res.status(409).json({ error: "Username or email already exists" });
        }
        console.error("Register Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 2.5 Get Current User (Me)
app.get('/auth/me', async (req, res) => {
    const token = req.cookies.token;
    if (!token) {
        return res.status(401).json({ error: "Not authenticated" });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;

        // Fetch user details with profile photo
        const userResult = await pool.query(
            'SELECT user_id, username, email FROM users WHERE user_id = $1',
            [decoded.user_id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = userResult.rows[0];

        // Fetch profile photo
        const photoResult = await pool.query(
            'SELECT photo_url FROM profile_photos WHERE user_id = $1',
            [decoded.user_id]
        );

        const avatar = photoResult.rows[0]?.photo_url || null;

        res.json({
            id: user.user_id,
            username: user.username,
            email: user.email,
            avatar: avatar
        });
    } catch (err) {
        return res.status(401).json({ error: "Invalid token" });
    }
});

// 2. Login
app.post('/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Missing fields" });

    try {
        console.log(`[Login] Attempt for username: '${username}'`);
        const result = await pool.query(
            'SELECT user_id, username, email, password_hash FROM users WHERE username = $1 OR email = $1',
            [username]
        );

        if (result.rows.length === 0) {
            console.log(`[Login] User '${username}' not found in DB.`);
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const user = result.rows[0];
        const inputHash = hashPassword(password);

        console.log(`[Login] Found user: ${user.username}`);

        if (inputHash !== user.password_hash) {
            console.log(`[Login] Password mismatch!`);
            return res.status(401).json({ error: "Invalid credentials" });
        }

        // Fetch profile photo
        const profile_url = await pool.query(
            'SELECT photo_url FROM profile_photos WHERE user_id = $1',
            [user.user_id]
        );

        console.log(`[Login] Success!`);
        const token = jwt.sign(
            { user_id: user.user_id, username: user.username },
            JWT_SECRET,
            { expiresIn: '1h' }
        );

        // Set cookie for session-based auth (same as register)
        res.cookie('token', token, {
            httpOnly: true,
            secure: false,
            sameSite: 'lax',
            maxAge: 3600000
        });

        res.json({
            token,
            user: {
                id: user.user_id,
                name: user.username,
                email: user.email,
                avatar: profile_url.rows[0]?.photo_url || null
            }
        });
    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Logout
app.post('/auth/logout', (req, res) => {
    res.clearCookie('token', {
        httpOnly: true,
        path: '/',
        sameSite: 'lax', // Must match login setting
        secure: false // Set true if using https
    });
    res.json({ success: true });
});

// NEW: Upload Avatar
app.post('/users/avatar', upload.single('avatar'), async (req, res) => {
    try {
        const token = req.cookies.token;
        if (!token) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        const decoded = jwt.verify(token, JWT_SECRET) as any;
        const userId = decoded.user_id;

        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded" });
        }

        console.log(`[Avatar Upload] User ${userId} uploading file: ${req.file.originalname}`);

        // Upload to S3
        const avatarUrl = await uploadToS3(req.file, userId);

        console.log(`[Avatar Upload] Successfully uploaded to S3: ${avatarUrl}`);

        // Update or insert profile photo in database
        const existingPhoto = await pool.query(
            'SELECT user_id FROM profile_photos WHERE user_id = $1',
            [userId]
        );

        if (existingPhoto.rows.length > 0) {
            // Update existing
            await pool.query(
                'UPDATE profile_photos SET photo_url = $1 WHERE user_id = $2',
                [avatarUrl, userId]
            );
        } else {
            // Insert new
            await pool.query(
                'INSERT INTO profile_photos (user_id, photo_url) VALUES ($1, $2)',
                [userId, avatarUrl]
            );
        }

        console.log(`[Avatar Upload] Database updated for user ${userId}`);

        res.json({
            success: true,
            avatarUrl
        });
    } catch (error: any) {
        console.error('Avatar Upload Error:', error);
        if (error.message === 'Failed to upload image to S3') {
            res.status(500).json({ error: "Failed to upload image to cloud storage" });
        } else {
            res.status(500).json({ error: "Internal Server Error" });
        }
    }
});

// 3. Search Users (with fuzzy/trigram support)
app.get('/users', async (req, res) => {
    const { q } = req.query;
    try {
        const query = typeof q === 'string' ? q.trim() : '';
        if (!query) {
            return res.json([]);
        }
        
        // Trigram similarity search with ILIKE fallback
        const result = await pool.query(
            `SELECT user_id, username, similarity(username, $1) as score
             FROM users 
             WHERE username % $1 OR username ILIKE $2
             ORDER BY score DESC, username ASC
             LIMIT 10`,
            [query, `%${query}%`]
        );
        res.json(result.rows.map(r => ({ user_id: r.user_id, username: r.username })));
    } catch (err) {
        console.error("Search Users Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

    // 3.5. Search Addable Friends (like /users but exclude any existing friend/requests)
app.get('/addfriends', async (req, res) => {
        const { q, userId } = req.query;
        try {
            const query = typeof q === 'string' ? q.trim() : '';
            if (!query) return res.json([]);
            if (!userId || typeof userId !== 'string') return res.status(400).json({ error: "Missing userId" });

            const result = await pool.query(
                `SELECT user_id, username, similarity(username, $1) as score
                 FROM users
                 WHERE (username % $1 OR username ILIKE $2)
                   AND user_id != $3
                   AND user_id NOT IN (
                        SELECT friend_id FROM friends WHERE user_id = $3
                        UNION
                        SELECT user_id FROM friends WHERE friend_id = $3
                   )
                 ORDER BY score DESC, username ASC
                 LIMIT 10`,
                [query, `%${query}%`, userId]
            );

            res.json(result.rows.map((r: any) => ({ user_id: r.user_id, username: r.username })));
        } catch (err) {
            console.error("AddFriends Search Error:", err);
            res.status(500).json({ error: "Internal Server Error" });
        }
    });

// 4. Friend Management
app.get('/friends', async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    try {
        const result = await pool.query(`
            SELECT u.user_id, u.username, f.status 
            FROM friends f
            JOIN users u ON u.user_id = f.friend_id
            WHERE f.user_id = $1
            UNION
            SELECT u.user_id, u.username, f.status 
            FROM friends f
            JOIN users u ON u.user_id = f.user_id
            WHERE f.friend_id = $1
        `, [userId]);

        res.json(result.rows);
    } catch (err) {
        console.error("Get Friends Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/friends/accept', async (req, res) => {
    const { userId, targetId } = req.query;

    if (!userId || !targetId) return res.send("Invalid Link");

    try {
        const updateRes = await pool.query(
            "UPDATE friends SET status = 'accepted' WHERE user_id = $2 AND friend_id = $1 AND status = 'pending' RETURNING *",
            [userId, targetId]
        );

        if ((updateRes.rowCount || 0) > 0) {
            const accepterRes = await pool.query("SELECT username FROM users WHERE user_id = $1", [userId]);
            const accepterName = accepterRes.rows[0]?.username || "A friend";

            await pool.query(
                "INSERT INTO notifications (user_id, message) VALUES ($1, $2)",
                [targetId, `${accepterName} accepted your friend request!`]
            );
        }

        res.send("<h1>Friend Request Accepted! You can close this tab.</h1>");
    } catch (err) {
        console.error("Link Accept Error:", err);
        res.send("<h1>Error accepting request.</h1>");
    }
});

app.post('/friends', async (req, res) => {
    const { myId, targetId, action } = req.body;
    if (!myId || !targetId || !['add', 'block'].includes(action)) {
        return res.status(400).json({ error: "Invalid payload" });
    }

    try {
        const now = new Date();
        const status = action === 'block' ? 'blocked' : 'pending';

        const exists = await pool.query('SELECT * FROM friends WHERE user_id = $1 AND friend_id = $2', [myId, targetId]);
        if (exists.rows.length > 0) {
            await pool.query('UPDATE friends SET status = $3 WHERE user_id = $1 AND friend_id = $2', [myId, targetId, status]);
        } else {
            await pool.query(
                'INSERT INTO friends (user_id, friend_id, status, requested_at) VALUES ($1, $2, $3, $4)',
                [myId, targetId, status, now]
            );
        }

        if (action === 'add') {
            const senderRes = await pool.query('SELECT username FROM users WHERE user_id = $1', [myId]);
            const targetRes = await pool.query('SELECT username, email FROM users WHERE user_id = $1', [targetId]);

            if (senderRes.rows.length > 0 && targetRes.rows.length > 0) {
                const senderName = senderRes.rows[0].username;
                const targetEmail = targetRes.rows[0].email;
                const targetName = targetRes.rows[0].username;

                publishEvent('friend.requested', {
                    senderName,
                    targetName,
                    targetEmail,
                    senderId: myId,
                    targetId: targetId
                });
            }
        }

        res.json({ success: true, status });
    } catch (err) {
        console.error("Friend Request Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.put('/friends', async (req, res) => {
    const { myId, targetId } = req.body;
    try {
        const updateRes = await pool.query(
            "UPDATE friends SET status = 'accepted' WHERE user_id = $2 AND friend_id = $1 AND status = 'pending' RETURNING *",
            [myId, targetId]
        );

        if ((updateRes.rowCount || 0) > 0) {
            // Publish friend.accepted event to RabbitMQ for notification-service
            publishEvent('friend.accepted', {
                accepterId: myId,
                requesterId: targetId
            });
        }

        res.json({ success: true });
    } catch (err) {
        console.error("Accept Friend Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 5. Notifications Management
app.get('/notifications', async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    try {
        const result = await pool.query(
            "SELECT id, message, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC",
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Get Notifications Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.delete('/notifications/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM notifications WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (err) {
        console.error("Delete Notification Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

const HTTP_PORT = process.env.HTTP_PORT || 3000;
app.listen(HTTP_PORT, () => {
    console.log(`Auth Service REST running on port ${HTTP_PORT}`);
});

// gRPC Server
const PROTO_PATH = path.join(__dirname, '../../../packages/protos/auth.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const authProto: any = grpc.loadPackageDefinition(packageDefinition).auth;

function validateToken(call: any, callback: any) {
    const token = call.request.token;
    if (!token) return callback(null, { valid: false });
    try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        callback(null, { user_id: decoded.user_id, email: decoded.email || "", role: "user", valid: true });
    } catch (err) {
        callback(null, { valid: false });
    }
}

function checkBlockStatus(call: any, callback: any) {
    const { user_id, target_user_id } = call.request;
    if (!user_id || !target_user_id) {
        return callback(null, { is_blocked: false });
    }

    const query = `
        SELECT 1 FROM friends 
        WHERE ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)) 
          AND status = 'blocked'
    `;

    pool.query(query, [user_id, target_user_id])
        .then(res => {
            const isBlocked = (res.rowCount || 0) > 0;
            callback(null, { is_blocked: isBlocked });
        })
        .catch(err => {
            console.error("gRPC CheckBlockStatus Error:", err);
            // Default to not blocked on error to avoid blocking logic on failure, or handle differently?
            // User requested independence, failing safe usually means allow unless sure blocked? or block? 
            // Standard approach: fail open or return error. Let's return false for now but log it.
            callback(null, { is_blocked: false });
        });
}

function getUserByUsername(call: any, callback: any) {
    const { username } = call.request;
    if (!username) {
        return callback(null, { found: false });
    }

    pool.query('SELECT user_id FROM users WHERE username = $1', [username])
        .then(res => {
            if (res.rows.length > 0) {
                callback(null, { user_id: res.rows[0].user_id, found: true });
            } else {
                callback(null, { found: false });
            }
        })
        .catch(err => {
            console.error("gRPC GetUserByUsername Error:", err);
            callback(null, { found: false });
        });
}

function checkFriendship(call: any, callback: any) {
    const { user_id, target_user_id } = call.request;
    if (!user_id || !target_user_id) {
        return callback(null, { is_friend: false });
    }

    const query = `
        SELECT 1 FROM friends 
        WHERE ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)) 
          AND status = 'accepted'
    `;

    pool.query(query, [user_id, target_user_id])
        .then(res => {
            const isFriend = (res.rowCount || 0) > 0;
            callback(null, { is_friend: isFriend });
        })
        .catch(err => {
            console.error("gRPC CheckFriendship Error:", err);
            callback(null, { is_friend: false });
        });
}

function getFriendsList(call: any, callback: any) {
    const { user_id } = call.request;
    if (!user_id) {
        return callback(null, { friend_ids: [] });
    }

    const query = `
        SELECT 
            CASE WHEN user_id = $1 THEN friend_id ELSE user_id END as friend_id
        FROM friends 
        WHERE (user_id = $1 OR friend_id = $1) AND status = 'accepted'
    `;

    pool.query(query, [user_id])
        .then(res => {
            const friendIds = res.rows.map(row => row.friend_id);
            callback(null, { friend_ids: friendIds });
        })
        .catch(err => {
            console.error("gRPC GetFriendsList Error:", err);
            callback(null, { friend_ids: [] });
        });
}

function getUserById(call: any, callback: any) {
    const { user_id } = call.request;
    if (!user_id) {
        return callback(null, { found: false });
    }

    pool.query('SELECT user_id, username, email FROM users WHERE user_id = $1', [user_id])
        .then(res => {
            if (res.rows.length > 0) {
                const user = res.rows[0];
                callback(null, { 
                    user_id: user.user_id, 
                    username: user.username, 
                    email: user.email,
                    found: true 
                });
            } else {
                callback(null, { found: false });
            }
        })
        .catch(err => {
            console.error("gRPC GetUserById Error:", err);
            callback(null, { found: false });
        });
}

// Accept friend request via gRPC
async function acceptFriend(call: any, callback: any) {
    const { user_id, target_id } = call.request;
    if (!user_id || !target_id) {
        return callback(null, { success: false, message: 'Missing user_id or target_id' });
    }

    try {
        // user_id = accepter, target_id = requester
        const updateRes = await pool.query(
            "UPDATE friends SET status = 'accepted' WHERE user_id = $2 AND friend_id = $1 AND status = 'pending' RETURNING *",
            [user_id, target_id]
        );

        if ((updateRes.rowCount || 0) > 0) {
            // Publish friend.accepted event
            publishEvent('friend.accepted', {
                accepterId: user_id,
                requesterId: target_id
            });
            callback(null, { success: true, message: 'Friend request accepted', new_status: 'accepted' });
        } else {
            callback(null, { success: false, message: 'No pending request found' });
        }
    } catch (err) {
        console.error("gRPC AcceptFriend Error:", err);
        callback(null, { success: false, message: 'Database error' });
    }
}

// Block user via gRPC
async function blockUser(call: any, callback: any) {
    const { user_id, target_id } = call.request;
    if (!user_id || !target_id) {
        return callback(null, { success: false, message: 'Missing user_id or target_id' });
    }

    try {
        // Check if friendship exists
        const exists = await pool.query(
            'SELECT * FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
            [user_id, target_id]
        );

        if (exists.rows.length > 0) {
            // Update existing to blocked
            await pool.query(
                "UPDATE friends SET status = 'blocked' WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)",
                [user_id, target_id]
            );
        } else {
            // Create new blocked entry
            await pool.query(
                'INSERT INTO friends (user_id, friend_id, status, requested_at) VALUES ($1, $2, $3, $4)',
                [user_id, target_id, 'blocked', new Date()]
            );
        }

        callback(null, { success: true, message: 'User blocked', new_status: 'blocked' });
    } catch (err) {
        console.error("gRPC BlockUser Error:", err);
        callback(null, { success: false, message: 'Database error' });
    }
}

// Reject/delete friend request via gRPC
async function rejectFriend(call: any, callback: any) {
    const { user_id, target_id } = call.request;
    if (!user_id || !target_id) {
        return callback(null, { success: false, message: 'Missing user_id or target_id' });
    }

    try {
        // Delete the pending request
        const deleteRes = await pool.query(
            "DELETE FROM friends WHERE user_id = $2 AND friend_id = $1 AND status = 'pending' RETURNING *",
            [user_id, target_id]
        );

        if ((deleteRes.rowCount || 0) > 0) {
            callback(null, { success: true, message: 'Friend request rejected', new_status: 'removed' });
        } else {
            callback(null, { success: false, message: 'No pending request found' });
        }
    } catch (err) {
        console.error("gRPC RejectFriend Error:", err);
        callback(null, { success: false, message: 'Database error' });
    }
}

function startGrpcServer() {
    const server = new grpc.Server();
    server.addService(authProto.AuthService.service, {
        ValidateToken: validateToken,
        CheckBlockStatus: checkBlockStatus,
        GetUserByUsername: getUserByUsername,
        GetUserById: getUserById,
        CheckFriendship: checkFriendship,
        GetFriendsList: getFriendsList,
        AcceptFriend: acceptFriend,
        BlockUser: blockUser,
        RejectFriend: rejectFriend
    });
    const GRPC_PORT = process.env.GRPC_PORT || 50051;
    server.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), () => {
        console.log(`Auth gRPC Server running on port ${GRPC_PORT}`);
        server.start();
    });
}
startGrpcServer();