import amqp from 'amqplib';
import { initEmailService, sendEmail } from './email';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672';

async function start() {
    console.log(`[Notification] Connecting to RabbitMQ at ${RABBITMQ_URL}...`);

    // Initialize Email Service (Creates test account if needed)
    await initEmailService();

    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        const channel = await connection.createChannel();
        const queue = 'notifications';

        await channel.assertQueue(queue, { durable: true });
        console.log(`[Notification] Waiting for messages in ${queue}...`);

        channel.consume(queue, async (msg) => {
            if (msg) {
                const contentStr = msg.content.toString();

                try {
                    const data = JSON.parse(contentStr);
                    const { type, payload } = data;

                    if (type === 'user.registered') {
                        await sendEmail('WELCOME', payload.email, { username: payload.username });
                    }
                    if (type === 'friend.requested') {
                        const baseUrl = process.env.PUBLIC_URL || 'http://localhost:3000';
                        const link = `${baseUrl}/friends/accept?userId=${payload.targetId}&targetId=${payload.senderId}`;
                        await sendEmail('FRIEND_REQUEST', payload.targetEmail, {
                            senderName: payload.senderName,
                            acceptLink: link
                        });
                    }
                } catch (err) {
                    console.error("Error processing message:", err);
                }

                channel.ack(msg);
            }
        });
    } catch (error) {
        console.error("Failed to connect to RabbitMQ", error);
        setTimeout(start, 5000);
    }
}

start();
