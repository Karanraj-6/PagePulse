import express from 'express';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { Pool } from 'pg';
import fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import amqp from 'amqplib';

const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_key_123';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672';

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

// Initialize DB on startup
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

// --- Helper: Password Hashing (using crypto) ---
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

        // Publish Event
        publishEvent('user.registered', { email, username });

        res.json({ userId, username, message: "User created" });
    } catch (err: any) {
        if (err.code === '23505') { // Unique violation
            return res.status(409).json({ error: "Username or email already exists" });
        }
        console.error("Register Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 2. Login
app.post('/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Missing fields" });

    try {
        const result = await pool.query('SELECT user_id, username, password_hash FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(401).json({ error: "Invalid credentials" });

        const user = result.rows[0];
        const inputHash = hashPassword(password);

        if (inputHash !== user.password_hash) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const token = jwt.sign(
            { user_id: user.user_id, username: user.username },
            JWT_SECRET,
            { expiresIn: '1h' }
        );

        res.json({ token, user: { id: user.user_id, name: user.username } });
    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 3. Search Users (for Friend Discovery)
app.get('/users', async (req, res) => {
    const { q } = req.query;
    try {
        const query = typeof q === 'string' ? q : '';
        const result = await pool.query(
            "SELECT user_id, username FROM users WHERE username ILIKE $1 LIMIT 10",
            [`%${query}%`]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Search Users Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 4. Friend Management
// GET /friends?userId=UUID (List friends)
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

// GET /friends/accept (Handle Email Link)
app.get('/friends/accept', async (req, res) => {
    const { userId, targetId } = req.query;
    // userId: The person accepting (the friend_id in DB)
    // targetId: The person who sent (the user_id in DB) - this is the one who gets notified

    if (!userId || !targetId) return res.send("Invalid Link");

    try {
        const updateRes = await pool.query(
            "UPDATE friends SET status = 'accepted' WHERE user_id = $2 AND friend_id = $1 AND status = 'pending' RETURNING *",
            [userId, targetId]
        );

        if ((updateRes.rowCount || 0) > 0) {
            // Get accepter's name
            const accepterRes = await pool.query("SELECT username FROM users WHERE user_id = $1", [userId]);
            const accepterName = accepterRes.rows[0]?.username || "A friend";

            // Create in-app notification for requester
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

// POST /friends (Send Request or Block)
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

        // Publish Event if it's a Friend Request
        if (action === 'add') {
            // Need usernames for email
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
                    senderId: myId,  // For the link: senderId is targetId in /friends/accept param logic
                    targetId: targetId // For the link: targetId is userId in /friends/accept param logic
                });
            }
        }

        res.json({ success: true, status });
    } catch (err) {
        console.error("Friend Request Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// PUT /friends (Accept Request via JSON API)
app.put('/friends', async (req, res) => {
    const { myId, targetId } = req.body;
    try {
        const updateRes = await pool.query(
            "UPDATE friends SET status = 'accepted' WHERE user_id = $2 AND friend_id = $1 AND status = 'pending' RETURNING *",
            [myId, targetId]
        );

        if ((updateRes.rowCount || 0) > 0) {
            // Get accepter's name (myId is the one accepting)
            const accepterRes = await pool.query("SELECT username FROM users WHERE user_id = $1", [myId]);
            const accepterName = accepterRes.rows[0]?.username || "A friend";

            // Create notification for requester (targetId is the one who asked)
            await pool.query(
                "INSERT INTO notifications (user_id, message) VALUES ($1, $2)",
                [targetId, `${accepterName} accepted your friend request!`]
            );
        }

        res.json({ success: true });
    } catch (err) {
        console.error("Accept Friend Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 5. Notifications Management

// GET /notifications?userId=UUID
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

// DELETE /notifications/:id
app.delete('/notifications/:id', async (req, res) => {
    const { id } = req.params;
    // Note: In a real app, verify that the notification belongs to the authenticated user.
    // For now, simple ID deletion.
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
    } catch (err) { callback(null, { valid: false }); }
}
function startGrpcServer() {
    const server = new grpc.Server();
    server.addService(authProto.AuthService.service, { ValidateToken: validateToken });
    const GRPC_PORT = process.env.GRPC_PORT || 50051;
    server.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), () => {
        console.log(`Auth gRPC Server running on port ${GRPC_PORT}`);
        server.start();
    });
}
startGrpcServer();
