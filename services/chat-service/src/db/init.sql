CREATE TABLE IF NOT EXISTS conversations (
    conversation_id UUID PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('private', 'book')),
    book_id INT NULL, 
    host_user_id UUID NULL, -- For book sessions
    created_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_participants (
    conversation_id UUID NOT NULL REFERENCES conversations(conversation_id),
    user_id UUID NOT NULL,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    message_id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(conversation_id),
    sender_id UUID NOT NULL,
    content TEXT NOT NULL,
    sent_at TIMESTAMP NOT NULL
);
