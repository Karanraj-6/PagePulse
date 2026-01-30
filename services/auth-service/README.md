# Auth Service

The **Auth Service** manages user identities, friends, and book preferences.

## API Reference

### 1. Authentication

#### ➤ Register
Create a new user.
- **POST** `/auth/register`
- **Body**: `{ "username": "alice", "email": "alice@example.com", "password": "password123" }`
- **Response**: `{ "userId": "UUID", "username": "alice" }`

#### ➤ Login
Authenticate existing user.
- **POST** `/auth/login`
- **Body**: `{ "username": "alice", "password": "password123" }`
- **Response**: `{ "token": "jwt...", "user": { "id": "...", "name": "alice" } }`

---

### 2. User & Social

#### ➤ Search Users
Find users to add as friends.
- **GET** `/users?q=alice`
- **Response**: `[ { "user_id": "...", "username": "alice" } ]`

#### ➤ List Friends
Get current friends and their status.
- **GET** `/friends?userId=UUID`
- **Response**: `[ { "user_id": "...", "username": "bob", "status": "accepted" } ]`

#### ➤ Manage Relationship
Send friend request or block user.
- **POST** `/friends`
- **Body**: `{ "myId": "UUID", "targetId": "UUID", "action": "add" | "block" }`

#### ➤ Accept Request
Accept a pending friend request.
- **PUT** `/friends`
- **Body**: `{ "myId": "UUID", "targetId": "UUID" }`
