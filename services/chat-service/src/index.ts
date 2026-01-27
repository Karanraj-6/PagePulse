import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*", // Adjust for prod
        methods: ["GET", "POST"]
    }
});

// --- gRPC Auth Client Setup ---
const PROTO_PATH = path.join(__dirname, '../../../packages/protos/auth.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const authProto: any = grpc.loadPackageDefinition(packageDefinition).auth;
const authClient = new authProto.AuthService(
    `auth-service:${process.env.GRPC_PORT_AUTH || 50051}`,
    grpc.credentials.createInsecure()
);

// Middleware: Validate Token on Connection
io.use((socket, next) => {
    const token = socket.handshake.auth.token; // Expect { auth: { token: "..." } } on client
    if (!token) {
        return next(new Error("Authentication error: No token provided"));
    }

    // Call Auth Service via gRPC
    authClient.ValidateToken({ token }, (err: any, response: any) => {
        if (err) {
            console.error("Auth gRPC Error:", err);
            return next(new Error("Authentication error: Validation failed"));
        }
        if (!response || !response.valid) {
            return next(new Error("Authentication error: Invalid Token"));
        }

        // Attach user info to socket
        (socket as any).user = {
            id: response.user_id,
            email: response.email,
            role: response.role
        };
        console.log(`User authenticated: ${response.email}`);
        next();
    });
});

io.on('connection', (socket) => {
    const user = (socket as any).user;
    console.log(`User connected: ${socket.id} (${user.email})`);

    socket.on('join_room', (room) => {
        socket.join(room);
        console.log(`User ${user.email} joined room ${room}`);
    });

    socket.on('send_message', (data) => {
        // Broadcast to room
        io.to(data.room).emit('receive_message', {
            ...data,
            sender: user.email // Enforce sender identity
        });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Chat Service running on port ${PORT}`);
});
