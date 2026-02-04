-- Enable trigram extension for fuzzy text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY,
    title TEXT,
    subjects TEXT[],
    authors JSONB,
    summaries TEXT[],
    translators JSONB,
    bookshelves TEXT[],
    languages TEXT[],
    copyright BOOLEAN,
    media_type TEXT,
    formats JSONB,
    download_count INTEGER
);

CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS book_categories (
    book_id INTEGER REFERENCES books(id),
    category_id INTEGER REFERENCES categories(id),
    PRIMARY KEY (book_id, category_id)
);

CREATE TABLE IF NOT EXISTS book_pages (
    book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    html TEXT NOT NULL,
    PRIMARY KEY (book_id, page_number)
);

CREATE TABLE IF NOT EXISTS trending_books (
    id SERIAL PRIMARY KEY,
    book_id INTEGER REFERENCES books(id) UNIQUE,
    download_count INTEGER
);
