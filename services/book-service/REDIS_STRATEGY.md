# Redis Strategy & Architecture 🚀

The **Book Service** leverages Redis as a high-performance caching layer to offload the PostgreSQL database and ensure sub-millisecond response times for read-heavy operations.

## 🏗 Architecture

The system follows a **Cache-Aside** (Lazy Loading) pattern for most data, and a **Write-Through** (Active Update) pattern for trending lists.

```mermaid
graph TD
    User[User Client] -->|GET /books| API[Book Service API]
    API -->|1. Check Key| Redis[(Redis Cache)]
    
    Redis -->|Hit (Data Found)| API
    Redis -->|Miss (No Data)| DB[(Postgres DB)]
    
    DB -->|Return Data| API
    API -->|2. SET Key (TTL)| Redis
    API -->|3. Return JSON| User
```

---

## 🧠 Caching Strategies

### 1. Categories List 🗂️
**Goal**: Serve the navigation menu instantly without touching the DB.
- **Trigger**: `GET /categories`
- **Key**: `categories`
- **TTL**: **1 Hour** (Self-Healing)
- **Logic**: 
    1. Check Redis. 
    2. Hit -> Return JSON.
    3. Miss -> Query DB -> Cache (1h) -> Return.

**Cached Response Schema (JSON):**
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

### 2. Category Content (Full Metadata) 📚
**Goal**: Instant load of books when a user selects a specific category.
- **Trigger**: `GET /books?category=Adventure`
- **Key Format**: `category:{name}` (e.g., `category:adventure`)
- **TTL**: **1 Hour**
- **Logic**:
    1.  User selects "Adventure".
    2.  Check Redis `category:adventure`.
    3.  **If Miss**: Run JOIN Query on DB -> Cache Result (1h) -> Return.
    4.  **If Hit**: Serve full book list immediately.

**Cached Response Schema (JSON):**
```json
[
  {
    "id": 84,
    "title": "Frankenstein; Or, The Modern Prometheus",
    "authors": [{"name": "Shelley, Mary", "birth_year": 1797}],
    "formats": {
        "image/jpeg": "https://www.gutenberg.org/cache/epub/84/pg84.cover.medium.jpg"
    },
    "download_count": 86638
  },
  {
    "id": 1342,
    "title": "Pride and Prejudice",
    "authors": [{"name": "Austen, Jane", "birth_year": 1775}],
    "formats": {
        "image/jpeg": "https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg"
    },
    "download_count": 60000
  }
]
```

### 3. Search Caching (The "Result Store") 🔍
**Goal**: Prevent expensive ILIKE queries on the database for common searches.
- **Trigger**: `GET /books?search=fantasy`
- **Key Format**: `search:{query}` (Lowercased, trimmed, e.g. `search:fantasy`)
- **TTL**: **10 Minutes**
- **Logic**:
    1.  User searches for "fantasy".
    2.  Check Redis `search:fantasy`.
    3.  **If Miss**: Run heavy SQL query -> Store result in Redis (10m) -> Return.
    4.  **If Hit**: Serve immediately.

**Cached Response Schema (JSON):**
```json
[
  {
    "id": 1342,
    "title": "Pride and Prejudice",
    "authors": [{"name": "Austen, Jane", "birth_year": 1775}],
    "download_count": 60000
  }
]
```

### 4. Trending Books (The "Active Queue") 📈
**Goal**: Track what users are actually looking at in real-time.
- **Trigger**: Successful Search or Book View.
- **Endpoint**: `GET /books/trending`
- **Key**: `trending_books`
- **Structure**: **Redis List** (Deque)
- **Logic**:
    - **Startup**: Checks if key exists. If empty, loads **Top 20** from DB (by `download_count`).
    - **Runtime**: Every time a user finds a book, we push it to the list: `LPUSH trending_books {book_json}`.
    - We immediately trim the list to keep only top 20: `LTRIM trending_books 0 19`.
    - `GET /books/trending` simply returns this list: `LRANGE 0 -1`.

**Cached Response Schema (JSON):**
```json
[
  {
    "id": 84,
    "title": "Frankenstein",
    "download_count": 86638
  },
  {
    "id": 11,
    "title": "Alice's Adventures in Wonderland",
    "download_count": 45000
  }
]
```

---

## 🔑 Key Reference Table

| Key Name | Type | TTL | Storage Content | Used By |
|----------|------|-----|-----------------|---------|
| `categories` | String | 1 Hour | JSON Array of strings (Names) | Navigation Bar |
| `category:{name}` | String | 1 Hour | JSON List of Books (Metadata) | Category Page |
| `search:{query}` | String | 10 Mins | JSON Array of Book Objects | Search Results |
| `trending_books` | List | N/A | List of JSON Book Objects | Home Page / Dashboard |
