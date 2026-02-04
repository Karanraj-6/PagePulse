import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import amqp from 'amqplib';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { initEmailService, sendEmail } from './email';

const app = express();
app.use(cors({
    origin: ["http://localhost:5173", "http://localhost:3000"],
    credentials: true
}));
app.use(express.json());

// --- Environment Variables ---
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672';
const MONGODB_URL = process.env.MONGODB_URL || 'mongodb://admin:mongo_pass_123@mongodb:27017/notifications_db?authSource=admin';
const AUTH_GRPC_URL = process.env.AUTH_GRPC_URL || 'auth-service:50051';
const HTTP_PORT = process.env.HTTP_PORT || 3000;

// --- gRPC Client Setup ---
const PROTO_PATH = path.join(__dirname, '../packages/protos/auth.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const authProto: any = grpc.loadPackageDefinition(packageDefinition).auth;
const authClient = new authProto.AuthService(AUTH_GRPC_URL, grpc.credentials.createInsecure());

// Promisify gRPC call
const getUserById = (userId: string): Promise<{ username: string; email: string; found: boolean }> => {
    return new Promise((resolve) => {
        authClient.GetUserById({ user_id: userId }, (err: any, response: any) => {
            if (err) {
                console.error("gRPC GetUserById Error:", err);
                resolve({ username: 'Unknown', email: '', found: false });
            } else {
                resolve(response);
            }
        });
    });
};

// gRPC: Accept friend request
const acceptFriendGrpc = (userId: string, targetId: string): Promise<{ success: boolean; message: string; new_status: string }> => {
    return new Promise((resolve) => {
        authClient.AcceptFriend({ user_id: userId, target_id: targetId }, (err: any, response: any) => {
            if (err) {
                console.error("gRPC AcceptFriend Error:", err);
                resolve({ success: false, message: 'gRPC error', new_status: '' });
            } else {
                resolve(response);
            }
        });
    });
};

// gRPC: Block user
const blockUserGrpc = (userId: string, targetId: string): Promise<{ success: boolean; message: string; new_status: string }> => {
    return new Promise((resolve) => {
        authClient.BlockUser({ user_id: userId, target_id: targetId }, (err: any, response: any) => {
            if (err) {
                console.error("gRPC BlockUser Error:", err);
                resolve({ success: false, message: 'gRPC error', new_status: '' });
            } else {
                resolve(response);
            }
        });
    });
};

// gRPC: Reject friend request
const rejectFriendGrpc = (userId: string, targetId: string): Promise<{ success: boolean; message: string; new_status: string }> => {
    return new Promise((resolve) => {
        authClient.RejectFriend({ user_id: userId, target_id: targetId }, (err: any, response: any) => {
            if (err) {
                console.error("gRPC RejectFriend Error:", err);
                resolve({ success: false, message: 'gRPC error', new_status: '' });
            } else {
                resolve(response);
            }
        });
    });
};

// --- MongoDB Schema ---
const notificationSchema = new mongoose.Schema({
    receiver_id: { type: String, required: true, index: true },
    sender_id: { type: String, required: true },
    sender_username: { type: String },
    type: { 
        type: String, 
        enum: ['friend_requested', 'friend_accepted', 'welcome', 'system'],
        required: true 
    },
    message: { type: String, required: true },
    read: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now }
});

const Notification = mongoose.model('Notification', notificationSchema);

// --- Message Templates ---
const generateMessage = (type: string, senderUsername: string): string => {
    switch (type) {
        case 'friend_requested':
            return `${senderUsername} wants to add you as a friend`;
        case 'friend_accepted':
            return `${senderUsername} accepted your friend request`;
        case 'welcome':
            return `Welcome to PagePulse, ${senderUsername}!`;
        default:
            return 'You have a new notification';
    }
};

// --- RabbitMQ Consumer ---
let rabbitmqRetryCount = 0;
async function startRabbitMQConsumer() {
    try {
        if (rabbitmqRetryCount === 0) {
            console.log(`[Notification] Connecting to RabbitMQ...`);
        }
        const connection = await amqp.connect(RABBITMQ_URL);
        const channel = await connection.createChannel();
        const queue = 'notifications';

        await channel.assertQueue(queue, { durable: true });
        rabbitmqRetryCount = 0; // Reset on success
        console.log(`[Notification] ✅ RabbitMQ connected, listening on queue: ${queue}`);

        channel.consume(queue, async (msg) => {
            if (msg) {
                try {
                    const data = JSON.parse(msg.content.toString());
                    const { type, payload } = data;

                    console.log(`[Notification] Received event: ${type}`);

                    if (type === 'user.registered') {
                        // Welcome notification
                        const notification = new Notification({
                            receiver_id: payload.userId,
                            sender_id: 'system',
                            sender_username: 'PagePulse',
                            type: 'welcome',
                            message: generateMessage('welcome', payload.username)
                        });
                        await notification.save();

                        // Also send welcome email
                        await sendEmail('WELCOME', payload.email, { username: payload.username });
                    }

                    if (type === 'friend.requested') {
                        // Get sender info via gRPC
                        const senderInfo = await getUserById(payload.senderId);
                        const senderUsername = senderInfo.found ? senderInfo.username : payload.senderName || 'Someone';

                        // Save notification to MongoDB
                        const notification = new Notification({
                            receiver_id: payload.targetId,
                            sender_id: payload.senderId,
                            sender_username: senderUsername,
                            type: 'friend_requested',
                            message: generateMessage('friend_requested', senderUsername)
                        });
                        await notification.save();
                        console.log(`[Notification] Saved friend request notification for ${payload.targetId}`);

                        // Also send email
                        const baseUrl = process.env.PUBLIC_URL || 'http://localhost:3001';
                        const link = `${baseUrl}/friends/accept?userId=${payload.targetId}&targetId=${payload.senderId}`;
                        await sendEmail('FRIEND_REQUEST', payload.targetEmail, {
                            senderName: senderUsername,
                            acceptLink: link
                        });
                    }

                    if (type === 'friend.accepted') {
                        // Get accepter info via gRPC
                        const accepterInfo = await getUserById(payload.accepterId);
                        const accepterUsername = accepterInfo.found ? accepterInfo.username : 'Someone';

                        // Notify the original requester
                        const notification = new Notification({
                            receiver_id: payload.requesterId,
                            sender_id: payload.accepterId,
                            sender_username: accepterUsername,
                            type: 'friend_accepted',
                            message: generateMessage('friend_accepted', accepterUsername)
                        });
                        await notification.save();
                        console.log(`[Notification] Saved friend accepted notification for ${payload.requesterId}`);
                    }

                } catch (err) {
                    console.error("[Notification] Error processing message:", err);
                }

                channel.ack(msg);
            }
        });
    } catch (error) {
        rabbitmqRetryCount++;
        if (rabbitmqRetryCount <= 3) {
            console.log(`[Notification] RabbitMQ not ready, retrying in 5s... (attempt ${rabbitmqRetryCount})`);
        }
        setTimeout(startRabbitMQConsumer, 5000);
    }
}

// --- REST API Endpoints ---

// Get notifications for a user
app.get('/notifications/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { unreadOnly } = req.query;

        const query: any = { receiver_id: userId };
        if (unreadOnly === 'true') {
            query.read = false;
        }

        const notifications = await Notification.find(query)
            .sort({ created_at: -1 })
            .limit(50);

        res.json(notifications);
    } catch (err) {
        console.error("Get notifications error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Get unread count
app.get('/notifications/:userId/count', async (req, res) => {
    try {
        const { userId } = req.params;
        const count = await Notification.countDocuments({ receiver_id: userId, read: false });
        res.json({ count });
    } catch (err) {
        console.error("Get notification count error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Mark notification as read
app.put('/notifications/:id/read', async (req, res) => {
    try {
        const { id } = req.params;
        await Notification.findByIdAndUpdate(id, { read: true });
        res.json({ success: true });
    } catch (err) {
        console.error("Mark read error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Mark all as read for a user
app.put('/notifications/:userId/read-all', async (req, res) => {
    try {
        const { userId } = req.params;
        await Notification.updateMany({ receiver_id: userId, read: false }, { read: true });
        res.json({ success: true });
    } catch (err) {
        console.error("Mark all read error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Delete a notification
app.delete('/notifications/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await Notification.findByIdAndDelete(id);
        res.json({ success: true });
    } catch (err) {
        console.error("Delete notification error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// --- Friend Action Endpoints (communicate with auth-service via gRPC) ---

// Accept friend request from notification
app.post('/notifications/:id/accept', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Get the notification
        const notification = await Notification.findById(id);
        if (!notification) {
            return res.status(404).json({ error: "Notification not found" });
        }

        if (notification.type !== 'friend_requested') {
            return res.status(400).json({ error: "This notification is not a friend request" });
        }

        // Call auth-service via gRPC to accept
        // receiver_id = the person accepting, sender_id = the requester
        const result = await acceptFriendGrpc(notification.receiver_id, notification.sender_id);

        if (result.success) {
            // Mark notification as read and update type
            await Notification.findByIdAndUpdate(id, { 
                read: true,
                message: `You accepted ${notification.sender_username}'s friend request`
            });
        }

        res.json(result);
    } catch (err) {
        console.error("Accept friend error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Block user from notification
app.post('/notifications/:id/block', async (req, res) => {
    try {
        const { id } = req.params;
        
        const notification = await Notification.findById(id);
        if (!notification) {
            return res.status(404).json({ error: "Notification not found" });
        }

        // Call auth-service via gRPC to block
        const result = await blockUserGrpc(notification.receiver_id, notification.sender_id);

        if (result.success) {
            // Delete the notification
            await Notification.findByIdAndDelete(id);
        }

        res.json(result);
    } catch (err) {
        console.error("Block user error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Reject/decline friend request from notification
app.post('/notifications/:id/reject', async (req, res) => {
    try {
        const { id } = req.params;
        
        const notification = await Notification.findById(id);
        if (!notification) {
            return res.status(404).json({ error: "Notification not found" });
        }

        if (notification.type !== 'friend_requested') {
            return res.status(400).json({ error: "This notification is not a friend request" });
        }

        // Call auth-service via gRPC to reject
        const result = await rejectFriendGrpc(notification.receiver_id, notification.sender_id);

        if (result.success) {
            // Delete the notification
            await Notification.findByIdAndDelete(id);
        }

        res.json(result);
    } catch (err) {
        console.error("Reject friend error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Direct friend actions (without notification ID)
app.post('/friends/accept', async (req, res) => {
    try {
        const { userId, targetId } = req.body;
        if (!userId || !targetId) {
            return res.status(400).json({ error: "Missing userId or targetId" });
        }
        const result = await acceptFriendGrpc(userId, targetId);
        res.json(result);
    } catch (err) {
        console.error("Accept friend error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.post('/friends/block', async (req, res) => {
    try {
        const { userId, targetId } = req.body;
        if (!userId || !targetId) {
            return res.status(400).json({ error: "Missing userId or targetId" });
        }
        const result = await blockUserGrpc(userId, targetId);
        res.json(result);
    } catch (err) {
        console.error("Block user error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.post('/friends/reject', async (req, res) => {
    try {
        const { userId, targetId } = req.body;
        if (!userId || !targetId) {
            return res.status(400).json({ error: "Missing userId or targetId" });
        }
        const result = await rejectFriendGrpc(userId, targetId);
        res.json(result);
    } catch (err) {
        console.error("Reject friend error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// --- Start Server ---
async function start() {
    try {
        // Connect to MongoDB
        console.log(`[Notification] Connecting to MongoDB...`);
        await mongoose.connect(MONGODB_URL);
        console.log(`[Notification] ✅ MongoDB connected`);

        // Initialize email service
        await initEmailService();

        // Start RabbitMQ consumer
        await startRabbitMQConsumer();

        // Start HTTP server
        app.listen(HTTP_PORT, () => {
            console.log(`[Notification] HTTP API running on port ${HTTP_PORT}`);
        });

    } catch (err) {
        console.error("[Notification] Startup failed:", err);
        process.exit(1);
    }
}

start();
