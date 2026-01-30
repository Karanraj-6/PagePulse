import { Pool } from "pg";

const pool = new Pool({
    connectionString: process.env.DB_URL || 'postgres://admin:secure_password_123@postgres:5432/pagepulse_db'
});

async function cleanup() {
    const client = await pool.connect();
    try {
        console.log("Fetching categories...");
        const { rows: categories } = await client.query("SELECT * FROM categories");

        const nameToId = new Map<string, number>();
        // First pass: map existing clean names
        for (const cat of categories) {
            if (!cat.name.startsWith("Category: ")) {
                nameToId.set(cat.name, cat.id);
            }
        }

        // Logic: specific user request to take first token only (split by space or special chars)
        // e.g. "Short Stories" -> "Short", "Plays/Films/Dramas" -> "Plays"
        for (const cat of categories) {
            // Split by non-word characters (including spaces, punctuation, etc.) and take first part
            // But we want to be careful with things like "Sci-Fi" if they want "Sci". 
            // User said "breack at sapces and special chars". 
            // regex: /[\s\W]+/ matches one or more space or non-word char.

            // However, we need to handle the "Category: " prefix first if it exists, or just treat it generally?
            // User's previous list had "Category: " removed already in my last step, but let's be safe.
            let tempName = cat.name.replace(/^Category: /, "").trim();

            // Split by any non-alphanumeric character (except maybe some we want to keep? No, user said special chars too)
            // simple approach: split by space or non-word.
            // "Plays/Films" -> ["Plays", "Films"]
            const parts = tempName.split(/[^a-zA-Z0-9]+/);
            let cleanName = parts[0];

            if (!cleanName && parts.length > 1) cleanName = parts[1]; // Handle edge case if starts with symbol
            if (!cleanName) cleanName = "Uncategorized"; // Fallback

            // Capitalize first letter Just in case
            cleanName = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);

            if (cleanName !== cat.name) {
                console.log(`Processing: "${cat.name}" -> "${cleanName}"`);

                if (nameToId.has(cleanName)) {
                    // Target exists, merge
                    const targetId = nameToId.get(cleanName)!;
                    const badId = cat.id;
                    console.log(`  Merging ID ${badId} into ${targetId}`);

                    // Move books to target
                    await client.query(`
                        INSERT INTO book_categories (book_id, category_id)
                        SELECT book_id, $1 FROM book_categories WHERE category_id = $2
                        ON CONFLICT DO NOTHING
                    `, [targetId, badId]);

                    // Remove old links
                    await client.query("DELETE FROM book_categories WHERE category_id = $1", [badId]);

                    // Remove old category
                    await client.query("DELETE FROM categories WHERE id = $1", [badId]);

                } else {
                    // Target does not exist, rename
                    console.log(`  Renaming ID ${cat.id}`);
                    await client.query("UPDATE categories SET name = $1 WHERE id = $2", [cleanName, cat.id]);
                    nameToId.set(cleanName, cat.id);
                }
            }
        }
        console.log("Cleanup complete!");
    } catch (error) {
        console.error("Cleanup failed:", error);
    } finally {
        client.release();
        await pool.end();
    }
}

cleanup();
