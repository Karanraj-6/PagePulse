# Book Service

The **Book Service** is the content engine of PagePulse. It handles fetching books from Gutendex, parsing EPUBs, and serving paginated content to the reader.

## Core Features

- **Ingestion Pipeline**: Automatically fetches books from Project Gutenberg (Gutendex).
- **EPUB Parsing**: Unzips and processes EPUB files into HTML.
- **Pagination**: Splits HTML content into reliable "pages" (~1500 characters) for consistent rendering across devices.
- **Trending System**: Tracks download counts to show popular books.

## API Reference

### 1. Books

#### ➤ List Books
Get a paginated list of books, optionally filtered by category.
- **GET** `/books`
- **Query Params**:
    - `page` (default: 1)
    - `category` (optional: e.g., "Fiction")
    - `search` (optional: title/author)
- **Response**: `[ { "id": 84, "title": "Frankenstein", "authors": "..." } ]`

#### ➤ Get Book Details
- **GET** `/books/:id`
- **Response**: `{ "id": 84, "title": "Frankenstein", "formats": { ... } }`

#### ➤ Get Book Pages (Reader)
Returns the parsed HTML pages for the reader. If pages don't exist, it triggers ingestion.
- **GET** `/books/:id/pages`
- **Response**:
    ```json
    {
      "bookId": "84",
      "totalPages": 320,
      "pages": [
        { "pageNumber": 1, "content": "<div>...</div>" }
      ]
    }
    ```

### 2. Categories

#### ➤ List Categories
Get all available book categories.
- **GET** `/categories`
- **Response**: `[ "Science Fiction", "Romance", "Mystery", ... ]`

### 3. Trending

#### ➤ Get Trending Books
Get the top downloaded books.
- **GET** `/books/trending`
- **Response**: `[ { "id": 1342, "download_count": 50000 } ]`

## Ingestion Worker

The service includes a background worker `src/ingestion/worker.ts` that:
1.  Polls Gutendex for popular books.
2.  Downloads the `.epub` file.
3.  Uses `epub` library to extract chapters.
4.  Uses `jsdom` to split chapters into pages.
5.  Saves pages to `book_pages` table in Postgres.
