import express from 'express';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import fs from 'fs';
import { Pool, QueryResult } from 'pg';
import { runIngestion } from './ingestion/worker';

// --- Express App Setup ---
const app = express();
app.use(express.json());

// Enable CORS
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// --- Database Setup ---
export const pool = new Pool({
    connectionString: process.env.DB_URL || 'postgresql://postgres:postgres@postgres:5432/bookdb'
});

async function initDB() {
    const maxRetries = 10;
    let retries = 0;
    while (retries < maxRetries) {
        try {
            const initSqlPath = path.join(__dirname, 'db/init.sql');
            const initSql = fs.readFileSync(initSqlPath, 'utf8');
            await pool.query(initSql);
            console.log('[DB] Database initialized successfully');

            // Start Background Ingestion
            runIngestion().catch(err => console.error("[Ingestion] Background process failed:", err));
            return;
        } catch (err) {
            retries++;
            console.error(`[DB] Connection failed (Attempt ${retries}/${maxRetries}):`, err);
            await new Promise(res => setTimeout(res, 5000));
        }
    }
    console.error('[DB] Could not connect to database after multiple attempts. Exiting.');
    process.exit(1);
}

initDB();

import Redis from 'ioredis';
import axios from 'axios';

// --- Redis Setup ---
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');
const GUTENDEX_BASE = "https://gutendex.com/books";

// --- Helper: Trending Deque ---
async function addToTrending(book: any) {
    try {
        const bookStr = JSON.stringify(book);
        // Push to head
        await redis.lpush('trending_books', bookStr);
        // Trim to size 20
        await redis.ltrim('trending_books', 0, 19);
    } catch (err) {
        console.error("Redis Trending Error:", err);
    }
}

// --- Routes ---

app.get('/', (req, res) => {
    res.send('Book Service is Running (Production Mode)');
});

// GET /categories (Cached)
app.get('/categories', async (req, res) => {
    try {
        const cached = await redis.get('categories');
        if (cached) {
            return res.json(JSON.parse(cached));
        }

        const result = await pool.query('SELECT name FROM categories ORDER BY name ASC');
        const categories = result.rows.map(r => r.name);

        await redis.set('categories', JSON.stringify(categories), 'EX', 3600); // 1 hr cache
        res.json(categories);
    } catch (err) {
        console.error("Categories Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// GET /books/trending (From Redis Deque)
app.get('/books/trending', async (req, res) => {
    try {
        const list = await redis.lrange('trending_books', 0, -1);
        const books = list.map(s => JSON.parse(s));
        res.json(books);
    } catch (err) {
        console.error("Trending Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// GET /books (List & Search)
app.get('/books', async (req, res) => {
    const { page = 1, category, search } = req.query;
    const offset = (Number(page) - 1) * 20;

    try {
        // --- A. Search Strategy (Redis -> DB -> Gutendex) ---
        if (search) {
            const query = String(search).trim();
            const cacheKey = `search:${query.toLowerCase()}`;

            // 1. Check Redis Cache for Search Results
            const cachedSearch = await redis.get(cacheKey);
            if (cachedSearch) {
                return res.json(JSON.parse(cachedSearch));
            }

            // 2. Check DB
            const dbQuery = `
                SELECT * 
                FROM books 
                WHERE title ILIKE $1 OR authors ILIKE $1 
                LIMIT 20
            `;
            const dbRes = await pool.query(dbQuery, [`%${query}%`]);

            if (dbRes.rows.length > 0) {
                const results = dbRes.rows.map(row => ({
                    ...row,
                    authors: typeof row.authors === 'string' ? JSON.parse(row.authors) : row.authors,
                    formats: typeof row.formats === 'string' ? JSON.parse(row.formats) : row.formats
                }));

                await redis.set(cacheKey, JSON.stringify(results), 'EX', 600); // 10 mins
                if (results[0]) await addToTrending(results[0]);
                return res.json(results);
            }

            // 3. Gutendex API (Fallback)
            console.log(`[Search] Fallback to Gutendex for: ${query}`);
            const apiRes = await axios.get(`${GUTENDEX_BASE}?search=${encodeURIComponent(query)}`);
            const apiBooks = apiRes.data.results; // Gutendex structure

            if (apiBooks.length > 0) {
                // Return immediately, caching logic handles persistence later/async if needed
                // User requirement: "store in redisdb trending deque"
                const topBook = apiBooks[0];
                await addToTrending(topBook);

                // Cache the API result
                await redis.set(cacheKey, JSON.stringify(apiBooks), 'EX', 600);

                // OPTIONAL: Background Insert into DB (fire and forget)
                // We're not blocking response for insert
                // (Implementation omitted for brevity to keep response fast, relying on worker for bulk, or add logic here if strict persistence needed)

                return res.json(apiBooks);
            }

            return res.json([]);
        }

        // --- B. Standard List / Category Filter ---
        let sql = 'SELECT * FROM books';
        const params: any[] = [];
        let whereClauses: string[] = [];

        if (category) {
            whereClauses.push(`id IN (SELECT book_id FROM book_categories bc JOIN categories c ON bc.category_id = c.id WHERE c.name ILIKE $${params.length + 1})`);
            params.push(category);
        }

        if (whereClauses.length > 0) {
            sql += ' WHERE ' + whereClauses.join(' AND ');
        }

        sql += ` ORDER BY download_count DESC LIMIT 20 OFFSET $${params.length + 1}`;
        params.push(offset);

        const result = await pool.query(sql, params);
        const books = result.rows.map(row => ({
            ...row,
            authors: typeof row.authors === 'string' ? JSON.parse(row.authors) : row.authors,
            formats: typeof row.formats === 'string' ? JSON.parse(row.formats) : row.formats
        }));

        res.json(books);

    } catch (err: any) {
        console.error("Get Books Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});


// GET /books/:id/pages
// Returns paginated content for iframe consumption
app.get('/books/:id/pages', async (req, res) => {
    const bookId = parseInt(req.params.id);
    if (isNaN(bookId)) {
        return res.status(400).json({ error: "Invalid Book ID" });
    }

    try {
        // 1. Fetch metadata
        const bookRes = await pool.query('SELECT title, download_count FROM books WHERE id = $1', [bookId]);
        if ((bookRes.rowCount || 0) === 0) {
            // TODO: Trigger async fetch if missing (User flow)
            // For now, return 404 if not found in DB
            return res.status(404).json({ error: "Book not found. It may be ingesting." });
        }
        const book = bookRes.rows[0];

        // 2. Fetch pages
        const pagesRes = await pool.query(
            'SELECT page_number, html FROM book_pages WHERE book_id = $1 ORDER BY page_number ASC',
            [bookId]
        );

        if ((pagesRes.rowCount || 0) === 0) {
            return res.status(202).json({
                message: "Book metadata exists but pages are processing.",
                book_id: bookId
            });
        }

        // 3. Construct response
        const response = {
            book_id: bookId,
            title: book.title,
            total_pages: pagesRes.rowCount || 0,
            pages: pagesRes.rows.map((row: any) => ({
                page: row.page_number,
                html: row.html
            }))
        };

        res.json(response);

    } catch (error: any) {
        console.error(`Error fetching pages for ${bookId}:`, error);
        res.status(500).json({ error: error.message });
    }
});


// --- gRPC Server Setup (Book Service) ---
const PROTO_OPTIONS = {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
};
const BOOK_PROTO_PATH = path.join(__dirname, '../../../packages/protos/book.proto');
const bookPkgDef = protoLoader.loadSync(BOOK_PROTO_PATH, PROTO_OPTIONS);
const bookProto: any = grpc.loadPackageDefinition(bookPkgDef).book;

function getBook(call: any, callback: any) {
    const bookId = call.request.id;
    // Basic mock implementation for gRPC compatibility
    // Ideally this should query the DB too
    pool.query('SELECT title, authors FROM books WHERE id = $1', [bookId])
        .then((res: QueryResult) => {
            if ((res.rowCount || 0) > 0) {
                const b = res.rows[0];
                callback(null, {
                    id: bookId,
                    title: b.title,
                    author: b.authors?.[0]?.name || "Unknown",
                    price: 0
                });
            } else {
                callback(null, { id: bookId, title: "Unknown", author: "Unknown", price: 0 });
            }
        })
        .catch((err: Error) => {
            callback(null, { id: bookId, title: "Error", author: "Error", price: 0 });
        });
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

const HTTP_PORT = process.env.HTTP_PORT || 3001;
app.listen(HTTP_PORT, () => {
    console.log(`Book Service REST API running on port ${HTTP_PORT}`);
});
