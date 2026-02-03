const axios = require('axios');

async function checkIngestion() {
    const bookId = 2000; // Don Quixote (Large book)
    const url = `http://localhost:30003/books/${bookId}/pages?limit=1`;
    const start = Date.now();

    console.log(`Checking book ${bookId}...`);

    for (let i = 0; i < 10; i++) {
        try {
            const res = await axios.get(url, { validateStatus: false });
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);

            console.log(`[${elapsed}s] Status: ${res.status}`);

            if (res.status === 200) {
                console.log(`\nSUCCESS! Ingestion complete in ~${elapsed} seconds.`);
                console.log(`Pages: ${res.data.total_pages}`);
                break;
            }
        } catch (err) {
            console.log('Error:', err.message);
        }

        // Wait 2s
        await new Promise(r => setTimeout(r, 2000));
    }
}

checkIngestion();
