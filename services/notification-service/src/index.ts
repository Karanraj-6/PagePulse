import amqp from 'amqplib';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';

async function start() {
    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        const channel = await connection.createChannel();
        const queue = 'notifications';

        await channel.assertQueue(queue, { durable: false });
        console.log(`Waiting for messages in ${queue}...`);

        channel.consume(queue, (msg) => {
            if (msg) {
                console.log(" [x] Received '%s'", msg.content.toString());
                // Logic: Send Email
                console.log(" [x] Email sent.");
                channel.ack(msg); // Acknowledge message
            }
        });
    } catch (error) {
        console.error("Failed to connect to RabbitMQ", error);
        setTimeout(start, 5000); // Retry logic
    }
}

start();
