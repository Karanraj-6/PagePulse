import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import amqp from 'amqplib';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import dotenv from 'dotenv';

// Load .env as fallback (for local dev without Docker).
// In Docker, env vars come from docker-compose env_file.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Safety: strip surrounding quotes from env vars (Compose/dotenv edge case)
function stripQuotes(val: string | undefined): string | undefined {
    if (val && val.startsWith('"') && val.endsWith('"')) return val.slice(1, -1);
    if (val && val.startsWith("'") && val.endsWith("'")) return val.slice(1, -1);
    return val;
}
process.env.MONGODB_URL = stripQuotes(process.env.MONGODB_URL);
process.env.SMTP_HOST = stripQuotes(process.env.SMTP_HOST);
process.env.SMTP_PORT = stripQuotes(process.env.SMTP_PORT);
process.env.SMTP_USER = stripQuotes(process.env.SMTP_USER);
process.env.SMTP_PASS = stripQuotes(process.env.SMTP_PASS);

// Log presence (not values) of critical vars for debugging
console.log('[Config] MONGODB_URL set?', !!process.env.MONGODB_URL);
console.log('[Config] SMTP_HOST set?', !!process.env.SMTP_HOST);

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

// --- gRPC Client Setup (auth-service) ---
const PROTO_PATH = path.join(__dirname, '../packages/protos/auth.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const authProto: any = grpc.loadPackageDefinition(packageDefinition).auth;
const authClient = new authProto.AuthService(AUTH_GRPC_URL, grpc.credentials.createInsecure());

// --- gRPC Client Setup (chat-service – real-time push) ---
const NOTIF_PROTO_PATH = path.join(__dirname, '../packages/protos/notification.proto');
const notifPkgDef = protoLoader.loadSync(NOTIF_PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const notifProto: any = grpc.loadPackageDefinition(notifPkgDef).notification;
const CHAT_GRPC_URL = process.env.CHAT_GRPC_URL || 'chat-service:50053';
const chatPushClient = new notifProto.NotificationPush(CHAT_GRPC_URL, grpc.credentials.createInsecure());

/**
 * Fire-and-forget push to chat-service so it can emit to the user's socket.
 * Failures are logged but never block the caller.
 */
function pushToChat(notification: {
    receiver_id: string;
    sender_id: string;
    sender_username?: string | null;
    type: string;
    message: string;
    _id?: any;
    invitation_id?: string | null;
}) {
    const req = {
        user_id: notification.receiver_id,
        type: notification.type,
        message: notification.message,
        sender_id: notification.sender_id,
        sender_username: notification.sender_username || '',
        notification_id: notification._id ? notification._id.toString() : '',
        invitation_id: notification.invitation_id || ''
    };
    chatPushClient.PushNotification(req, (err: any, res: any) => {
        if (err) {
            console.warn('[Push] gRPC PushNotification failed (non-fatal):', err.message);
        } else if (res?.delivered) {
            console.log(`[Push] Delivered real-time notification to user ${req.user_id}`);
        } else {
            console.log(`[Push] User ${req.user_id} not connected — stored only`);
        }
    });
}

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
        enum: ['friend_requested', 'friend_accepted', 'welcome', 'system', 'invitation'],
        required: true 
    },
    message: { type: String, required: true },
    read: { type: Boolean, default: false },
    // optional link to an invitation document
    invitation_id: { type: String, required: false, index: true },
    created_at: { type: Date, default: Date.now }
});

const Notification = mongoose.model('Notification', notificationSchema);

// Invitation schema
const invitationSchema = new mongoose.Schema({
    receiver_id: { type: String, required: true, index: true },
    sender_id: { type: String, required: true },
    sender_username: { type: String },
    book_id: { type: String, required: true },
    book_title: { type: String, required: true },
    created_at: { type: Date, default: Date.now }
});

const Invitation = mongoose.model('Invitation', invitationSchema);

// Helper: delete notification with a retry (attempts default 2)
async function deleteNotificationWithRetry(id: string, attempts = 2): Promise<boolean> {
    for (let i = 1; i <= attempts; i++) {
        try {
            const del = await Notification.findByIdAndDelete(id);
            if (del) {
                console.log(`[Notification] Deleted notification ${id} (attempt ${i})`);
                return true;
            } else {
                console.warn(`[Notification] Delete attempt ${i} returned null for ${id}`);
            }
        } catch (e) {
            console.error(`[Notification] Delete attempt ${i} error for ${id}:`, e);
        }

        if (i < attempts) {
            // small backoff before retry
            await new Promise((res) => setTimeout(res, 1000));
        }
    }
    console.error(`[Notification] Failed to delete notification ${id} after ${attempts} attempts`);
    return false;
}

// --- Message Templates ---
const generateMessage = (type: string, senderUsername: string, extra?: any): string => {
    switch (type) {
        case 'friend_requested':
            return `${senderUsername} wants to add you as a friend`;
        case 'friend_accepted':
            return `${senderUsername} accepted your friend request`;
        case 'welcome':
            return `Welcome to PagePulse, ${senderUsername}!`;
        case 'invitation':
            // extra can contain bookTitle
            return `${senderUsername} invited you to read ${extra?.bookTitle || 'a book'}`;
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
                        pushToChat(notification.toObject());

                        // Also send welcome email
                        await sendEmail('WELCOME', payload.email, { username: payload.username });
                    }

                    if (type === 'friend.requested') {
                        const { senderId, targetId, targetEmail } = payload;

                        if (!senderId || !targetId) {
                            console.error('[Notification] Invalid friend.requested payload:', payload);
                            return;
                        }

                        const senderInfo = await getUserById(senderId);
                        const senderUsername =
                            senderInfo.found ? senderInfo.username : payload.senderName || 'Someone';

                        const notification = new Notification({
                            receiver_id: targetId,
                            sender_id: senderId,
                            sender_username: senderUsername,
                            type: 'friend_requested',
                            message: generateMessage('friend_requested', senderUsername)
                        });

                        await notification.save();
                        pushToChat(notification.toObject());
                        console.log(`[Notification] Saved friend request notification for ${targetId}`);

                        if (targetEmail) {
                            const baseUrl = process.env.PUBLIC_URL || 'http://localhost:3001';
                            const link = `${baseUrl}/friends/accept?userId=${targetId}&targetId=${senderId}`;
                            try {
                                await sendEmail('FRIEND_REQUEST', targetEmail, {
                                    senderName: senderUsername,
                                    acceptLink: link
                                });
                            } catch (err: any) {
                                console.warn('[Notification] Email failed (non-fatal):', err?.message ?? err);
                            }
                        }
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
                        pushToChat(notification.toObject());
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

// Create an invitation (sender invites receiver to read a book)
app.post('/invitations', async (req, res) => {
    try {
        const { sender_id, receiver_id, book_id, book_title } = req.body;
        if (!sender_id || !receiver_id || !book_id || !book_title) {
            return res.status(400).json({ error: 'Missing fields' });
        }

        // Resolve sender username via gRPC
        const senderInfo = await getUserById(sender_id);
        const senderUsername = senderInfo.found ? senderInfo.username : 'Someone';

        const invitation = new Invitation({ sender_id, receiver_id, sender_username: senderUsername, book_id, book_title });
        await invitation.save();

        // Create a notification linked to this invitation
        const notification = new Notification({
            receiver_id,
            sender_id,
            sender_username: senderUsername,
            type: 'invitation',
            message: generateMessage('invitation', senderUsername, { bookTitle: book_title }),
            invitation_id: invitation._id.toString()
        });
        await notification.save();
        pushToChat(notification.toObject());

        res.json({ success: true, invitationId: invitation._id, notificationId: notification._id });
    } catch (err) {
        console.error('Create invitation error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// List invitations for a user
app.get('/invitations/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const invitations = await Invitation.find({ receiver_id: userId }).sort({ created_at: -1 }).limit(50);
        res.json(invitations);
    } catch (err) {
        console.error('Get invitations error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Delete an invitation (clear)
app.delete('/invitations/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const inv = await Invitation.findById(id);
        if (!inv) return res.status(404).json({ error: 'Invitation not found' });

        // Delete linked notification(s)
        try {
            await Notification.deleteMany({ invitation_id: id });
        } catch (e) {
            console.warn('[Invitation] Failed to delete linked notifications:', e);
        }

        await Invitation.findByIdAndDelete(id);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete invitation error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

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
        const notif = await Notification.findById(id);
        if (!notif) return res.status(404).json({ error: 'Notification not found' });

        // If notification is linked to an invitation, delete that invitation as well
        if (notif.invitation_id) {
            try {
                await Invitation.findByIdAndDelete(notif.invitation_id);
                console.log(`[Invitation] Deleted linked invitation ${notif.invitation_id}`);
            } catch (e) {
                console.warn(`[Invitation] Failed to delete linked invitation ${notif.invitation_id}:`, e);
            }
        }

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
    console.log('[POST /notifications/:id/accept] body:', req.body);
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
        console.log('[Notification] gRPC AcceptFriend result:', result);

        let deleted = false;
        if (result.success) {
            deleted = await deleteNotificationWithRetry(id, 2);
        }

        const responsePayload = {
            success: !!result.success,
            message: result.message || (result.success ? 'Accepted' : 'Failed'),
            new_status: result.new_status || '',
            deleted
        };
        console.log('[Notification] Responding to accept:', responsePayload);
        return res.json(responsePayload);
    } catch (err) {
        console.error("Accept friend error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Block user from notification
app.post('/notifications/:id/block', async (req, res) => {
    console.log('[POST /notifications/:id/block] body:', req.body);
    try {
        const { id } = req.params;
        
        const notification = await Notification.findById(id);
        if (!notification) {
            return res.status(404).json({ error: "Notification not found" });
        }

        // Call auth-service via gRPC to block
        const result = await blockUserGrpc(notification.receiver_id, notification.sender_id);
        console.log('[Notification] gRPC BlockUser result:', result);

        let deleted = false;
        if (result.success) {
            deleted = await deleteNotificationWithRetry(id, 2);
        }

        const responsePayload = {
            success: !!result.success,
            message: result.message || (result.success ? 'Blocked' : 'Failed'),
            new_status: result.new_status || '',
            deleted
        };
        console.log('[Notification] Responding to block:', responsePayload);
        return res.json(responsePayload);
    } catch (err) {
        console.error("Block user error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Reject/decline friend request from notification
app.post('/notifications/:id/reject', async (req, res) => {
    console.log('[POST /notifications/:id/reject] body:', req.body);
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
        console.log('[Notification] gRPC RejectFriend result:', result);

        let deleted = false;
        if (result.success) {
            deleted = await deleteNotificationWithRetry(id, 2);
        }

        const responsePayload = {
            success: !!result.success,
            message: result.message || (result.success ? 'Rejected' : 'Failed'),
            new_status: result.new_status || '',
            deleted
        };
        console.log('[Notification] Responding to reject:', responsePayload);
        return res.json(responsePayload);
    } catch (err) {
        console.error("Reject friend error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Direct friend actions (without notification ID)
app.post('/friends/accept', async (req, res) => {
    console.log('[POST /friends/accept] body:', req.body);
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
    console.log('[POST /friends/block] body:', req.body);
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
    console.log('[POST /friends/reject] body:', req.body);
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

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 5000;

export async function connectMongoWithRetry(
  mongoUri: string,
  retries = MAX_RETRIES
): Promise<void> {
  try {
    console.log('[MongoDB] Connecting...');
    await mongoose.connect(mongoUri);
    console.log('[MongoDB]  Connected');
    } catch (err: any) {
        console.error('[MongoDB]  Connection failed:', err?.message ?? err);

    if (retries <= 0) {
      console.error('[MongoDB] Exhausted retries. Exiting.');
      process.exit(1);
    }

    console.log(
      `[MongoDB] 🔁 Retrying in ${RETRY_DELAY_MS / 1000}s... (${retries} left)`
    );

    await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
    return connectMongoWithRetry(mongoUri, retries - 1);
  }
}


// --- Start Server ---
async function start() {
    try {
        // Connect to MongoDB
        console.log(`[Notification] Connecting to MongoDB...`);
        await connectMongoWithRetry(MONGODB_URL);
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
