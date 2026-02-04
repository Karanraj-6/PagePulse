import nodemailer from 'nodemailer';

// --- Configuration ---
// For Development: Use Ethereal (Fake SMTP)
// For Production: Use Gmail/SendGrid via ENV variables
const SMTP_CONFIG = {
    host: process.env.SMTP_HOST || 'smtp.ethereal.email',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false, // Port 587 uses STARTTLS, not implicit TLS
    auth: {
        user: process.env.SMTP_USER || 'test_user',
        pass: process.env.SMTP_PASS || 'test_pass'
    }
};

// Create Reusable Transporter
let transporter: nodemailer.Transporter;

export async function initEmailService() {
    if (!process.env.SMTP_HOST) {
        // Create a test account if no env vars provided
        const testAccount = await nodemailer.createTestAccount();
        transporter = nodemailer.createTransport({
            host: "smtp.ethereal.email",
            port: 587,
            secure: false,
            auth: {
                user: testAccount.user,
                pass: testAccount.pass,
            },
        });
        console.log(`[Email] Using Ethereal Test Account: ${testAccount.user}`);
    } else {
        transporter = nodemailer.createTransport(SMTP_CONFIG);
        console.log(`[Email] Using configured SMTP server: ${SMTP_CONFIG.host}`);
    }
}

// --- Templates ---

const STYLE = `
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    color: #333;
    line-height: 1.6;
    max-width: 600px;
    margin: 0 auto;
    padding: 20px;
    border: 1px solid #eee;
    border-radius: 8px;
    background-color: #f9f9f9;
`;

const HEADER = `
    <div style="text-align: center; margin-bottom: 20px;">
        <h1 style="color: #4F46E5; margin: 0;">PagePulse</h1>
        <p style="color: #666; margin-top: 5px;">Your Social Reading Hub</p>
    </div>
`;

const FOOTER = `
    <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #999; text-align: center;">
        <p>&copy; ${new Date().getFullYear()} PagePulse. All rights reserved.</p>
    </div>
`;

function getWelcomeTemplate(username: string): string {
    return `
    <div style="font-family: 'Verdana', sans-serif; background-color: #fcfcfc; padding: 40px; border-radius: 12px; max-width: 600px; margin: auto; color: #333;">
    ${HEADER}
    <h2 style="color: #111; font-size: 24px; margin-bottom: 20px;">Hi ${username},</h2>
    <p style="font-size: 16px; line-height: 1.7;">
        Welcome to <strong>PagePulse</strong>📚. Here, it’s all about books, quiet reading, and hanging out with friends who like the same stories.
    </p>
    <p style="font-size: 16px; line-height: 1.7;">If you want, you can:</p>
    <ul style="padding-left: 20px; font-size: 16px; line-height: 1.7;">
        <li>Look through books people are reading now</li>
        <li>Start a private reading session</li>
        <li>Share thoughts or chats with friends</li>
    </ul>
        ${FOOTER}
    </div>
    `;
}

function getFriendRequestTemplate(senderName: string, acceptLink: string): string {
    return `
    <div style="${STYLE}">
        ${HEADER}
        <h2 style="color: #111;">New Friend Request 📬</h2>
        <p><strong>${senderName}</strong> wants to be friends with you on PagePulse!</p>
        <p>Friends can:</p>
        <ul style="padding-left: 20px;">
            <li>See each other's reading status</li>
            <li>Chat privately</li>
            <li>Share book recommendations</li>
        </ul>
        <div style="text-align: center; margin: 30px 0;">
            <a href="${acceptLink}" style="background-color: #10B981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Accept Request</a>
        </div>
        <p style="font-size: 12px; color: #666; text-align: center;">Or ignore this email to decline.</p>
        ${FOOTER}
    </div>
    `;
}

export async function sendEmail(type: 'WELCOME' | 'FRIEND_REQUEST', to: string, data: any) {
    if (!transporter) await initEmailService();

    let subject = "";
    let html = "";

    switch (type) {
        case 'WELCOME':
            subject = "Welcome to PagePulse! 📚";
            html = getWelcomeTemplate(data.username);
            break;
        case 'FRIEND_REQUEST':
            subject = `${data.senderName} sent you a friend request`;
            html = getFriendRequestTemplate(data.senderName, data.acceptLink);
            break;
    }

    try {
        const info = await transporter.sendMail({
            from: '"PagePulse" <karanraj3056@gmail.com>',
            to,
            subject,
            html,
        });

        console.log(`[Email] Sent '${type}' to ${to}. ID: ${info.messageId}`);
        // Preview only available when using Ethereal
        const preview = nodemailer.getTestMessageUrl(info);
        if (preview) {
            console.log(`[Email] Preview URL: ${preview}`);
        }
    } catch (err) {
        console.error(`[Email] Failed to send '${type}' to ${to}:`, err);
    }
}
