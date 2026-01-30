# Chat Service

The **Chat Service** handles real-time messaging for PagePulse. It supports two distinct modes of communication: **Private Chats** (persistent) and **Reading Sessions** (ephemeral).

## Architecture

The service uses **Socket.io** for real-time bidirectional communication and **PostgreSQL** for storing persistent data (private chats). Reading sessions are managed entirely in-memory for low-latency broadcast.

```mermaid
graph TD
    Client[Frontend Client]
    WS[WebSocket Server / Chat Service]
    DB[(PostgreSQL)]
    
    subgraph "Private Chat Mode"
        Client -- "join_private_chat" --> WS
        Client -- "send_private_message" --> WS
        WS -- "INSERT message" --> DB
        WS -- "receive_private_message" --> Client
    end

    subgraph "Reading Session Mode"
        Client -- "join_reading_session" --> WS
        Client -- "reading_message" --> WS
        WS -- "reading_message (Broadcast)" --> Client
        WS -- "session_ended (Host leaves)" --> Client
    end
```

## Chat Modes

### 1. Private Chat 🔒
- **Purpose**: 1-on-1 text messaging between friends (WhatsApp style).
- **Storage**: Persistent. All messages are saved to the `messages` table in Postgres.
- **Lifecycle**: Permanent. The conversation history remains available forever.

### 2. Reading Session 📖
- **Purpose**: Live, transient chat overlay for users reading the same book together.
- **Storage**: **None**. Messages are ephemeral and exist only during the session.
- **Lifecycle**: Temporary. The session is destroyed when the **Host** disconnects.

## HTTP API

The service provides REST endpoints to initiate conversations. Use these to get a `conversationId` before connecting via WebSocket.

### 1. Initiate Private Chat 🔒
- **Endpoint**: `POST /private`
- **Body**: `{ "myId": "UUID", "targetUserId": "UUID" }`
- **Response**: `{ "conversationId": "UUID", "created": boolean }`
- **Description**: Finds an existing private chat with the target user or creates a new one. **Enforces Blocking Checks.**

### 2. Initiate Reading Session 📖
- **Endpoint**: `POST /reading`
- **Body**: `{ "myId": "UUID", "bookId": 123, "friendUsername": "optional_string" }`
- **Response**: `{ "conversationId": "UUID" }`
- **Description**: Creates a NEW book session. The caller becomes the **Host**. Optionally invites a friend immediately.

## WebSocket API

Connect to the service via: `ws://localhost:4000` (or via API Gateway at `/api/chat`).

### Events

> [!IMPORTANT]
> The **Event Names** below are **FIXED** in the backend code. Frontend implementation **MUST** use these exact strings.

#### ➤ Private Chat

| Event | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `join_private_chat` | Client -> Server | `conversationId` (string) | Joins a unified room for a persistent chat. |
| `send_private_message` | Client -> Server | `{ conversation_id, sender_id, content }` | Sends a message. Saved to DB. |
| `receive_private_message` | Server -> Client | `{ message_id, conversation_id, sender_id, content, sent_at }` | Broadcasts the new message to participants. |

#### ➤ Reading Session

| Event | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `join_reading_session` | Client -> Server | `{ conversationId, userId, bookId }` | Joins a live session. First joiner becomes **Host**. |
| `reading_message` | Client -> Server | `{ conversationId, sender, content }` | Sends a live chat message. **NOT saved to DB.** |
| `reading_message` | Server -> Client | `{ sender, content, time }` | Broadcasts the live message to the room. |
| `session_ended` | Server -> Client | `null` | Sent when the **Host** disconnects. Clients should close the chat UI. |

## Database Schema

```sql
-- Conversations (Both Private and Book types)
CREATE TABLE conversations (
    conversation_id UUID PRIMARY KEY,
    type TEXT CHECK (type IN ('private', 'book')),
    book_id INT NULL,
    host_user_id UUID NULL, -- Active host for book sessions
    created_at TIMESTAMP
);

-- Messages (Only for Private chats)
CREATE TABLE messages (
    message_id UUID PRIMARY KEY,
    conversation_id UUID REFERENCES conversations,
    sender_id UUID,
    sent_at TIMESTAMP
);
```

## Client Integration Flow

The Frontend is **dumb**. It relies on the Backend to do all the work.

### 1. Private Chat Flow
When user clicks "Chat with Alice":
1. **Frontend**: Call `POST /private` with `{ targetUserId: "..." }`.
2. **Backend**: Finds Alice, checks if chat exists, or creates one. Returns `conversationId`.
3. **Frontend**: Connects WebSocket and emits `join_private_chat` with that ID.

```javascript
// 1. Ask Backend to setup the chat
const res = await fetch('http://localhost:4000/private', {
    method: 'POST',
    body: JSON.stringify({ myId: "...", targetUserId: "..." })
});
const { conversationId } = await res.json();

// 2. Connect & Join
socket.emit("join_private_chat", conversationId);
```

### 2. Reading Session Flow
When user opens a book or invites a friend:
1. **Frontend**: Call `POST /reading` with `{ bookId: 84 }`.
2. **Backend**: Creates session, sets you as Host. Returns `conversationId`.
3. **Frontend**: Connects WebSocket and emits `join_reading_session`.

```javascript
// 1. Ask Backend to start session
const res = await fetch('http://localhost:4000/reading', {
    method: 'POST',
    body: JSON.stringify({ myId: "...", bookId: 84 })
});
const { conversationId } = await res.json();

// 2. Connect & Join
socket.emit("join_reading_session", { conversationId, userId: "..." });
```
