
import axios from 'axios';

const AUTH_URL = 'http://localhost:3000/auth';
const USERS_URL = 'http://localhost:3000/users';
const FRIENDS_URL = 'http://localhost:3000/friends';
const BOOK_URL = 'http://localhost:3001/books';
const CATEGORIES_URL = 'http://localhost:3001/categories';
const CHAT_URL = 'http://localhost:4000/private';

async function verifyBackend() {
    console.log("🚀 Starting Backend Verification...\n");

    try {
        // --- 1. Auth Service ---
        console.log("1. Testing Auth Service...");
        const username = `testuser_${Date.now()}`;
        const email = `${username}@example.com`;
        const password = "password123";

        // Register
        console.log(`   Registering user: ${username}...`);
        const regRes = await axios.post(`${AUTH_URL}/register`, { username, email, password });
        console.log("   ✅ Register Success:", regRes.data);
        const myId = regRes.data.userId;

        // Login
        console.log(`   Logging in...`);
        const loginRes = await axios.post(`${AUTH_URL}/login`, { username, password });
        console.log("   ✅ Login Success. Token received.");
        const token = loginRes.data.token;

        // Create a friend
        const friendName = `friend_${Date.now()}`;
        const friendReg = await axios.post(`${AUTH_URL}/register`, { username: friendName, email: `${friendName}@example.com`, password: "password123" });
        const friendId = friendReg.data.userId;
        console.log(`   Created friend: ${friendName} (${friendId})`);

        // --- 2. Book Service (Redis + Gutendex) ---
        console.log("\n2. Testing Book Service (Redis + Ingestion)...");

        // Search (Should hit Gutendex if not in DB, then cache)
        const searchQuery = "Frankenstein";
        console.log(`   Searching for '${searchQuery}'...`);
        const searchRes = await axios.get(`${BOOK_URL}?search=${searchQuery}`);
        console.log(`   ✅ Search returned ${searchRes.data.length} results.`);

        if (searchRes.data.length > 0) {
            const book = searchRes.data[0];
            console.log(`   Top Result: ${book.title} (ID: ${book.id})`);

            // Get Pages
            console.log(`   Fetching pages for Book ID ${book.id}...`);
            const pagesRes = await axios.get(`${BOOK_URL}/${book.id}/pages`);
            console.log(`   ✅ Pages Response:`, {
                book_id: pagesRes.data.book_id,
                total_pages: pagesRes.data.total_pages
            });
        }

        // Categories
        console.log(`   Fetching Categories...`);
        const catRes = await axios.get(CATEGORIES_URL);
        console.log(`   ✅ Categories found: ${catRes.data.length}`);

        // Trending
        console.log(`   Fetching Trending (Redis)...`);
        const trendRes = await axios.get(`${BOOK_URL}/trending`);
        console.log(`   ✅ Trending books in Redis: ${trendRes.data.length}`);


        // --- 3. Chat Service ---
        console.log("\n3. Testing Chat Service...");

        // Initiate Private Chat
        console.log(`   Initiating chat between ${username} and ${friendName}...`);
        try {
            const chatRes = await axios.post(CHAT_URL, { myId, targetUserId: friendId });
            console.log("   ✅ Chat Created:", chatRes.data);
        } catch (err: any) {
            console.error("   ❌ Chat Creation Failed:", err.response?.data || err.message);
        }

        console.log("\n✅ Backend Verification Complete!");

    } catch (error: any) {
        console.error("\n❌ Verification Failed:", error.response?.data || error.message);
    }
}

verifyBackend();
