import express from 'express';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';

const app = express();
app.use(express.json());

// mock login
app.post('/login', (req, res) => {
    // Logic: Verify credentials
    res.json({ token: "mock_jwt_token", user: { id: "1", name: "User" } });
});

const HTTP_PORT = process.env.HTTP_PORT || 3000;
app.listen(HTTP_PORT, () => {
    console.log(`Auth Service REST running on port ${HTTP_PORT}`);
});

// --- gRPC Server for Token Validation ---
const PROTO_PATH = path.join(__dirname, '../../../packages/protos/auth.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});
const authProto: any = grpc.loadPackageDefinition(packageDefinition).auth;

function validateToken(call: any, callback: any) {
    const token = call.request.token;
    console.log("Validating token via gRPC:", token);
    // Logic: jwt.verify(token)
    callback(null, { user_id: "1", email: "test@example.com", role: "user", valid: true });
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
