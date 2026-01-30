# Redis Caching & Search Strategy

## Infrastructure 
- **Redis Service**: `redis:alpine` exposed on port `6379`.
- **Client**: `ioredis`.

## Features

### 1. Categories Caching 🗂️
- **Endpoint**: `GET /categories`
- **Logic**:
    1. Check `redis.get('categories')`.
    2. Hit -> Return JSON.
    3. Miss -> Query DB -> Cache (1 Hour) -> Return.

### 2. Multi-Layer Search 🔍
- **Endpoint**: `GET /books?search=query`
- **Logic**:
    1. **Redis Cache**: Check `search:{query}`. Hit -> Return.
    2. **Database**: Query `books` table (ILIKE). Hit -> Cache (10m) -> Add to Trending -> Return.
    3. **Gutendex API**: Fallback fetch. Hit -> Cache (10m) -> Add to Trending -> Return.

### 3. Trending Books (Deque) 📈
- **Endpoint**: `GET /books/trending`
- **Storage**: Redis List `trending_books`.
- **Logic**:
    - Stores the last **20** successfully searched/retrieved books.
    - Used to show "Recent searches" or "Trending now" on the frontend.
    - Operations: `LPUSH` + `LTRIM 0 19`.
