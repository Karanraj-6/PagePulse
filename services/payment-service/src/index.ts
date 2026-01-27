import express from 'express';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';

const app = express();
app.use(express.json());

app.post('/pay', (req, res) => {
    console.log("Processing payment via REST...");
    res.json({ success: true, transactionId: "tx_rest_123" });
});

const HTTP_PORT = process.env.HTTP_PORT || 3000;
app.listen(HTTP_PORT, () => {
    console.log(`Payment Service REST running on port ${HTTP_PORT}`);
});

// --- gRPC Server Setup ---
const PROTO_PATH = path.join(__dirname, '../../../packages/protos/payment.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const paymentProto: any = grpc.loadPackageDefinition(packageDefinition).payment;

function processPayment(call: any, callback: any) {
    const { user_id, amount } = call.request;
    console.log(`Processing gRPC Payment of $${amount} for user ${user_id}`);

    // Mock Logic
    if (amount > 0) {
        callback(null, { success: true, transaction_id: "tx_grpc_" + Date.now(), message: "Payment Successful" });
    } else {
        callback(null, { success: false, transaction_id: "", message: "Invalid Amount" });
    }
}

function startGrpcServer() {
    const server = new grpc.Server();
    server.addService(paymentProto.PaymentService.service, { ProcessPayment: processPayment });
    const GRPC_PORT = process.env.GRPC_PORT || 50053; // Default to 50053
    server.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), () => {
        console.log(`Payment gRPC Server running on port ${GRPC_PORT}`);
        server.start();
    });
}

startGrpcServer();
