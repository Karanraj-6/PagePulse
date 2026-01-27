import express from 'express';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';

// --- Express App Setup ---
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Book Service is Running');
});

// --- gRPC Clients Setup ---
const PROTO_OPTIONS = {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
};

// 1. Auth Client
const AUTH_PROTO_PATH = path.join(__dirname, '../../../packages/protos/auth.proto');
const authPkgDef = protoLoader.loadSync(AUTH_PROTO_PATH, PROTO_OPTIONS);
const authProto: any = grpc.loadPackageDefinition(authPkgDef).auth;
const authClient = new authProto.AuthService(
    `auth-service:${process.env.GRPC_PORT_AUTH || 50051}`,
    grpc.credentials.createInsecure()
);

// 2. Payment Client
const PAYMENT_PROTO_PATH = path.join(__dirname, '../../../packages/protos/payment.proto');
const paymentPkgDef = protoLoader.loadSync(PAYMENT_PROTO_PATH, PROTO_OPTIONS);
const paymentProto: any = grpc.loadPackageDefinition(paymentPkgDef).payment;
const paymentClient = new paymentProto.PaymentService(
    `payment-service:${process.env.GRPC_PORT_PAYMENT || 50053}`,
    grpc.credentials.createInsecure()
);


// Route: Rent a book (Synchronous gRPC Orchestration)
app.post('/rent/:id', async (req, res) => {
    const bookId = req.params.id;
    const userToken = req.headers['authorization'] || ""; // Expect "Bearer <token>"

    console.log(`[Rent] Starting process for Book ${bookId}`);

    // Step 1: Validate User via gRPC
    authClient.ValidateToken({ token: userToken }, (err: any, user: any) => {
        if (err) {
            console.error("Auth Service Error:", err);
            return res.status(500).json({ error: "Auth Service Error" });
        }
        if (!user || !user.valid) {
            return res.status(401).json({ error: "Unauthorized: Invalid Token" });
        }
        console.log(`[Rent] User validated: ${user.email} (ID: ${user.user_id})`);

        // Step 2: Process Payment via gRPC
        const paymentPayload = {
            user_id: user.user_id,
            amount: 10.99, // Mock price
            currency: "USD"
        };

        paymentClient.ProcessPayment(paymentPayload, (err: any, receipt: any) => {
            if (err) {
                console.error("Payment Service Error:", err);
                return res.status(500).json({ error: "Payment Failed" });
            }

            if (!receipt.success) {
                return res.status(400).json({ error: "Payment Declined", details: receipt.message });
            }

            console.log(`[Rent] Payment successful: ${receipt.transaction_id}`);

            // Step 3: Conclude (RabbitMQ event would go here)
            res.json({
                success: true,
                message: `Book ${bookId} rented successfully`,
                receipt: receipt.transaction_id,
                user: user.email
            });
        });
    });
});

const HTTP_PORT = process.env.HTTP_PORT || 3001;
app.listen(HTTP_PORT, () => {
    console.log(`Book Service REST API running on port ${HTTP_PORT}`);
});

// --- gRPC Server Setup (Book Service) ---
const BOOK_PROTO_PATH = path.join(__dirname, '../../../packages/protos/book.proto');
const bookPkgDef = protoLoader.loadSync(BOOK_PROTO_PATH, PROTO_OPTIONS);
const bookProto: any = grpc.loadPackageDefinition(bookPkgDef).book;

function getBook(call: any, callback: any) {
    const bookId = call.request.id;
    const book = {
        id: bookId,
        title: "The Great Gatsby",
        author: "F. Scott Fitzgerald",
        price: 10.99
    };
    callback(null, book);
}

function startGrpcServer() {
    const server = new grpc.Server();
    server.addService(bookProto.BookService.service, { GetBook: getBook });
    const GRPC_PORT = process.env.GRPC_PORT || 50052;
    server.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), () => {
        console.log(`Book gRPC Server running on port ${GRPC_PORT}`);
        server.start();
    });
}

startGrpcServer();
