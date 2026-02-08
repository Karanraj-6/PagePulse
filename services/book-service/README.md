### 7. Get Ingestion Status (`GET /books/:id/ingestion-status`)
Checks the ingestion progress for a specific book. Useful for polling the backend to see if a book's content is ready for reading.

- **Endpoint**: `GET /books/:id/ingestion-status`
- **Description**: Returns the current ingestion status for the book. Status can be `not_started`, `processing`, `complete`, or `failed`.

**Possible Response Schemas:**

*Ingestion not started:*
```json
{
  "status": "not_started"
}
```

*Ingestion in progress:*
```json
{
  "status": "processing",
  "message": "Book is being ingested..."
}
```

*Ingestion complete:*
```json
{
  "status": "complete",
  "page_count": 450
}
```

*Ingestion failed:*
```json
{
  "status": "failed",
  "error": "Download error from Gutendex"
}
```
# Book Service 📚

The **Book Service** is the central library content manager for PagePulse. It handles book ingestion from Gutendex, stores EPUB content (parsed into pages), maintains categories, and tracks trending books.

## 🏗 Architecture

- **Language**: TypeScript (Node.js/Express)
- **Database**: PostgreSQL (`books`, `categories`, `book_pages`)
- **Caching**: Redis (Trending lists, Categories, Search results)
- **Ingestion**: Background worker using `axios` (download) and `epub` (parsing).

---

## 🗄️ Database Schema

### 1. `books`
Stores metadata fetched from Gutendex.
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER (PK) | Gutenberg ID |
| `title` | TEXT | Book Title |
| `authors` | JSONB | List of authors with birth/death years |
| `formats` | JSONB | Links to EPUB, MDF, JPEG covers |
| `subjects` | TEXT[] | List of subject tags |
| `bookshelves` | TEXT[] | List of bookshelves |
| `languages` | TEXT[] | Language codes (e.g. ['en']) |
| `copyright` | BOOLEAN | Copyright status |
| `media_type` | TEXT | e.g. "Text" |
| `download_count` | INTEGER | Popularity metric |

### 2. `categories`
normalized list of book subjects/bookshelves.
| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL (PK) | Internal ID |
| `name` | TEXT | Category Name (Unique) |

### 3. `book_pages`
Stores the actual content of the books, split by page for reading.
| Column | Type | Description |
|--------|------|-------------|
| `book_id` | INTEGER (FK) | Reference to `books.id` |
| `page_number` | INTEGER | Page sequence order |
| `html` | TEXT | Raw HTML content of the page |

*(Composite PK: `book_id` + `page_number`)*

### 4. `trending_books`
A dedicated table for high-performance trending queries (synced with Redis).
| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL (PK) | - |
| `book_id` | INTEGER | Reference to `books.id` |
| `download_count` | INTEGER | Snapshot of download count during insertion |

---

## 🚀 API Reference

### 0. Service Health Check (`GET /`)
Returns a simple message indicating the Book Service is running. Useful for health checks and deployment verification.

- **Endpoint**: `GET /`
- **Response**: Plain text message.

**Example Response:**
```
Book Service is Running (Production Mode)
```

### 1. Get Books List (`GET /books`)
Retrieves a list of books with optional filtering.

- **Endpoint**: `GET /books`
- **Query Params**:
  - `page`: Page number (Default: 1).
  - `category`: Filter by category name (e.g., "Fiction").
  - `search`: Search by title or author.
- **Caching**: 
  - Search: Redis `search:{query}` (10m).
  - Category: Redis `category:{name}` (1h).

**Response Schema:**
```json
[
  {
    "id": 84,
    "title": "Frankenstein; Or, The Modern Prometheus",
    "authors": [
      {
        "name": "Shelley, Mary Wollstonecraft",
        "birth_year": 1797,
        "death_year": 1851
      }
    ],
    "subjects": [
      "Science fiction",
      "Horror tales",
      "Gothic fiction",
      "Scientists -- Fiction",
      "Monsters -- Fiction"
    ],
    "bookshelves": [
      "Science Fiction",
      "Gothic Fiction",
      "Movie Books"
    ],
    "languages": [ "en" ],
    "copyright": false,
    "media_type": "Text",
    "formats": {
      "application/epub+zip": "https://www.gutenberg.org/ebooks/84.epub3.images",
      "image/jpeg": "https://www.gutenberg.org/cache/epub/84/pg84.cover.medium.jpg",
      "text/html": "https://www.gutenberg.org/ebooks/84.html.images.inline"
    },
    "download_count": 86638
  }
]
```

### 2. Get Book Details (`GET /books/:id`)
Retrieves full metadata for a single book.

- **Endpoint**: `GET /books/:id`
- **Response**: Returns a single Book Object (see schema above).

**Response Schema:**
```json
{
  "id": 1342,
  "title": "Pride and Prejudice",
  "authors": [
    {
      "name": "Austen, Jane",
      "birth_year": 1775,
      "death_year": 1817
    }
  ],
  "subjects": ["Courtship -- Fiction", "Social classes -- Fiction"],
  "bookshelves": ["Best Books Ever Listing"],
  "languages": ["en"],
  "copyright": false,
  "media_type": "Text",
  "formats": {
    "image/jpeg": "https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg"
  },
  "download_count": 60000
}
```

### 3. Get Book Pages (`GET /books/:id/pages`)
Retrieves the paginated HTML content for reading.

- **Endpoint**: `GET /books/:id/pages`
- **Description**: Used by the Reader interface to display book content.

**Response Schema:**
```json
{
  "book_id": 1342,
  "title": "Pride and Prejudice",
  "total_pages": 450,
  "pages": [
    {
      "page": 1,
      "html": "<body><div class='chapter'><h1>Chapter 1</h1><p>It is a truth universally acknowledged...</p></div></body>"
    },
    {
      "page": 2,
      "html": "<body><p>...that a single man in possession of a good fortune, must be in want of a wife.</p></body>"
    }
  ]
}
```

### 4. Get Categories (`GET /categories`)
Retrieves all available book categories.

- **Endpoint**: `GET /categories`
- **Caching**: Redis `categories` (1 Hour).

**Response Schema:**
```json
[
  "Adventure",
  "Banned Books",
  "Classics",
  "Fantasy",
  "Fiction",
  "Horror",
  "Science Fiction"
]
```

### 5. Get Trending Books (`GET /books/trending`)
Retrieves the top 20 most recently accessed/downloaded books.

- **Endpoint**: `GET /books/trending`
- **Source**: Redis List `trending_books` (Deque).

**Response Schema:**
```json
[
  {
    "id": 84,
    "title": "Frankenstein",
    "authors": [{"name": "Shelley, Mary"}],
    "download_count": 86638,
     ... (Full Book Object)
  },
  {
    "id": 11,
    "title": "Alice's Adventures in Wonderland",
    "download_count": 45000,
     ... (Full Book Object)
  }
]
```

### 6. Track Book Click (`POST /books/:id/track`)
Adds a book to the trending list when a user clicks on it (e.g., from SearchPage to BookDetailsPage).

- **Endpoint**: `POST /books/:id/track`
- **Description**: Should be called by the frontend when a user navigates to a book's details. Updates trending books in Redis.
- **Request Body:**
  - `title` (string, required): Book title
  - `authors` (array, optional): List of authors
  - `formats` (object, optional): Book formats (e.g., EPUB, JPEG)
  - `download_count` (number, optional): Download count
  - `summaries` (array, optional): Book summaries

**Example Request:**
```json
POST /books/84/track
{
  "title": "Frankenstein; Or, The Modern Prometheus",
  "authors": [
    { "name": "Shelley, Mary Wollstonecraft", "birth_year": 1797, "death_year": 1851 }
  ],
  "formats": {
    "application/epub+zip": "https://www.gutenberg.org/ebooks/84.epub3.images",
    "image/jpeg": "https://www.gutenberg.org/cache/epub/84/pg84.cover.medium.jpg"
  },
  "download_count": 86638,
  "summaries": ["A classic gothic novel."]
}
```

**Example Response:**
```json
{
  "success": true,
  "message": "Book 84 added to trending"
}
```

---

## ⚡ Redis Strategy

See [REDIS_STRATEGY.md](./REDIS_STRATEGY.md) for a detailed deep-dive into the caching architecture.

| Key | Type | TTL | Description |
|-----|------|-----|-------------|
| `categories` | String (JSON) | 1 Hour | List of all category names. |
| `category:{name}` | String (JSON) | 1 Hour | Full list of books for a category. |
| `trending_books` | List (JSON) | - | Fixed-size list (Top 20) of book objects. |
| `search:{term}` | String (JSON) | 10 Mins | Search results for a specific query. |

---


