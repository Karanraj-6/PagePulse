# Auth Service

The **Auth Service** manages user identities, authentication, friends, notifications, avatars, and favorite books.

---

## Databases & Table Schemas

### PostgreSQL Tables

- **users**: User accounts (UUID PK)
- **friends**: Friend relationships (user_id, friend_id, status)
- **favorite_books**: User's favorite books (user_id, gutenberg_id)
- **notifications**: User notifications (id, user_id, message, created_at)
- **profile_photos**: User avatars (user_id, photo_url)

#### Relationships
- `friends.user_id` and `friends.friend_id` reference `users.user_id`
- `favorite_books.user_id` references `users.user_id`
- `notifications.user_id` references `users.user_id`
- `profile_photos.user_id` references `users.user_id`

### Table Schemas

```sql
CREATE TABLE users (
    user_id UUID PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
);

CREATE TABLE friends (
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    friend_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    status VARCHAR(20) CHECK (status IN ('pending', 'accepted', 'blocked')),
    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, friend_id),
    CHECK (user_id <> friend_id)
);

CREATE TABLE favorite_books (
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    gutenberg_id INT,
    PRIMARY KEY (user_id, gutenberg_id)
);

CREATE TABLE notifications (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE profile_photos (
    user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    photo_url TEXT
);
```

---

## REST API Reference

### Authentication

- **POST /auth/register**  
  Register a new user.  
  **Body:** `{ username, email, password }`  
  **Response:** `{ userId, username, token, message }`

- **POST /auth/login**  
  Login user.  
  **Body:** `{ username, password }`  
  **Response:** `{ token, user: { id, name, email, avatar } }`

- **POST /auth/logout**  
  Logout user (clears cookie).  
  **Response:** `{ success: true }`

- **GET /auth/me**  
  Get current user info (from cookie).  
  **Response:** `{ id, username, email, avatar }`

### User & Social

- **GET /users?q=**  
  Search users by username.  
  **Response:** `[ { user_id, username, avatar } ]`

- **GET /addfriends?q=&userId=**  
  Search users to add as friends (excluding existing friends/requests).  
  **Response:** `[ { user_id, username, avatar } ]`

- **GET /friends?userId=**  
  List friends and status.  
  **Response:** `[ { user_id, username, status, avatar } ]`

- **POST /friends**  
  Send friend request or block user.  
  **Body:** `{ myId, targetId, action: "add" | "block" }`  
  **Response:** `{ success, status }`

- **PUT /friends**  
  Accept friend request.  
  **Body:** `{ myId, targetId }`  
  **Response:** `{ success }`

- **GET /friends/accept?userId=&targetId=**  
  Accept friend request via link (for email).  
  **Response:** HTML

### Notifications

- **GET /notifications?userId=**  
  List notifications.  
  **Response:** `[ { id, message, created_at } ]`

- **DELETE /notifications/:id**  
  Delete notification.  
  **Response:** `{ success: true }`

### Favorites

- **GET /favorites**  
  List favorite book IDs (JWT cookie required).  
  **Response:** `[ gutenberg_id, ... ]`

- **POST /favorites/:bookId**  
  Add book to favorites.  
  **Response:** `{ success, message }`

- **DELETE /favorites/:bookId**  
  Remove book from favorites.  
  **Response:** `{ success, message }`

### Avatars

- **POST /users/avatar**  
  Upload avatar (multipart/form-data, field: avatar).  
  **Response:** `{ success, avatarUrl }`

- **GET /avatar/:userId**  
  Get avatar image (returns image bytes, not JSON).

---
