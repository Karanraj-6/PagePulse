import axios from "axios";
import { Pool } from "pg";
// @ts-ignore
import EPub from "epub";
import { JSDOM } from "jsdom";
import path from "path";
import fs from "fs";


const pool = new Pool({
    connectionString: process.env.DB_URL || 'postgresql://postgres:postgres@postgres:5432/bookdb'
});

const GUTENDEX = "https://gutendex.com/books/";
const BOOK_LIMIT = 100;
const PAGE_HEIGHT = 900; // px for pagination
const EPUB_DIR = path.join(__dirname, '../../epubs');

if (!fs.existsSync(EPUB_DIR)) {
    fs.mkdirSync(EPUB_DIR, { recursive: true });
}

export async function runIngestion() {
    console.log("[Ingestion] Starting...");
    let page = 1;
    let ingested = 0;

    while (ingested < BOOK_LIMIT) {
        try {
            const { data } = await axios.get(`${GUTENDEX}?page=${page}`);
            for (const book of data.results) {
                if (ingested >= BOOK_LIMIT) break;
                await ingestBook(book);
                ingested++;
            }
            page++;
        } catch (error) {
            console.error("[Ingestion] Error fetching from Gutendex:", error);
            break;
        }
    }

    console.log("✅ [Ingestion] Done");
}

async function ingestBook(book: any) {
    const client = await pool.connect();
    try {
        console.log(`[Ingestion] Processing ${book.id}: ${book.title}`);
        await client.query(
            `INSERT INTO books(id,title,authors,summaries,languages,copyright,media_type,formats,download_count)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
            [
                book.id,
                book.title,
                JSON.stringify(book.authors),
                book.summaries,
                book.languages,
                book.copyright,
                book.media_type,
                JSON.stringify(book.formats),
                book.download_count
            ]
        );

        await storeCategories(client, book);

        const epubUrl = book.formats["application/epub+zip"];
        if (epubUrl) {
            await processEpub(book.id, epubUrl, client);
        }

    } catch (err) {
        console.error(`[Ingestion] Failed to ingest book ${book.id}:`, err);
    } finally {
        client.release();
    }
}

async function storeCategories(client: any, book: any) {
    for (const rawShelf of book.bookshelves || []) {
        // Strip "Category: " then take first token
        const tempName = rawShelf.replace(/^Category: /, "").trim();
        const parts = tempName.split(/[^a-zA-Z0-9]+/);
        let shelf = parts[0];
        if (!shelf && parts.length > 1) shelf = parts[1];
        if (!shelf) shelf = "Uncategorized";

        shelf = shelf.charAt(0).toUpperCase() + shelf.slice(1);

        const { rows } = await client.query(
            `INSERT INTO categories(name)
       VALUES($1)
       ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name
       RETURNING id`,
            [shelf]
        );

        await client.query(
            `INSERT INTO book_categories(book_id, category_id)
       VALUES($1,$2)
       ON CONFLICT DO NOTHING`,
            [book.id, rows[0].id]
        );
    }
}

async function processEpub(bookId: number, epubUrl: string, client: any) {
    // Check if pages already exist
    const check = await client.query('SELECT 1 FROM book_pages WHERE book_id = $1 LIMIT 1', [bookId]);
    if ((check.rowCount || 0) > 0) {
        console.log(`[Ingestion] Pages for ${bookId} already exist. Skipping EPUB.`);
        return;
    }

    // Download EPUB
    const localEpubPath = path.join(EPUB_DIR, `${bookId}.epub`);
    if (!fs.existsSync(localEpubPath)) {
        try {
            const response = await axios.get(epubUrl, { responseType: 'arraybuffer' });
            fs.writeFileSync(localEpubPath, response.data);
        } catch (error) {
            console.error(`[Ingestion] Failed to download EPUB for ${bookId}:`, error);
            throw error;
        }
    }

    const epub = new EPub(localEpubPath);

    // Parse EPUB
    await new Promise<void>((resolve, reject) => {
        epub.on("end", () => resolve());
        epub.on("error", (err: any) => reject(err));
        epub.parse();
    });

    let pageNumber = 1;

    for (const chapter of epub.flow) {
        try {
            const html = await getChapter(epub, chapter.id);
            const pages = paginate(html);

            for (const page of pages) {
                await client.query(
                    `INSERT INTO book_pages(book_id,page_number,html)
         VALUES($1,$2,$3)
         ON CONFLICT DO NOTHING`,
                    [bookId, pageNumber++, page]
                );
            }
        } catch (err) {
            console.error(`[Ingestion] Error processing chapter ${chapter.id} for book ${bookId}:`, err);
        }
    }
    console.log(`[Ingestion] Stored ${pageNumber} pages for ${bookId}`);
}

function getChapter(epub: any, id: string): Promise<string> {
    return new Promise((res, rej) => {
        epub.getChapter(id, (err: any, text: string) => {
            if (err) rej(err);
            else res(text);
        });
    });
}

function paginate(html: string): string[] {
    const dom = new JSDOM(`<body>${html}</body>`);
    const document = dom.window.document;

    const pages: string[] = [];
    let current = "";
    let height = 0;

    for (const node of Array.from(document.body.children)) {
        current += node.outerHTML;
        height += 120; // rough heuristic

        if (height >= PAGE_HEIGHT) {
            pages.push(current);
            current = "";
            height = 0;
        }
    }

    if (current) pages.push(current);
    // If no children but text content exists, push it
    if (pages.length === 0 && document.body.innerHTML.trim().length > 0) {
        pages.push(document.body.innerHTML);
    }

    return pages;
}
