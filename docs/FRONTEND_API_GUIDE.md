# PagePulse Frontend API Guide

## Table of Contents
1. [Friendship Feature](#friendship-feature)
2. [Notification System](#notification-system)
3. [Friend Actions from Notifications](#friend-actions-from-notifications)
4. [Status Reference](#status-reference)

---

## Friendship Feature

**Base URL:** `http://localhost:3001` (auth-service)

### 1. Search Users (Fuzzy Search)

Search for users by username with trigram fuzzy matching.

```http
GET /users?q={searchTerm}
```

**Response:**
```json
[
  { "user_id": "uuid-1", "username": "alice" },
  { "user_id": "uuid-2", "username": "bob" }
]
```

**Frontend Example:**
```typescript
const searchUsers = async (term: string) => {
  const response = await fetch(`http://localhost:3001/users?q=${encodeURIComponent(term)}`);
  return response.json();
};
```

---

### 2. Send Friend Request

```http
POST /friends
Content-Type: application/json
```

**Request Body:**
```json
{
  "myId": "your-uuid",
  "targetId": "friend-uuid",
  "action": "add"
}
```

**Response:**
```json
{ "success": true, "status": "pending" }
```

**Frontend Example:**
```typescript
const sendFriendRequest = async (myId: string, targetId: string) => {
  const response = await fetch('http://localhost:3001/friends', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ myId, targetId, action: 'add' })
  });
  return response.json();
};
```

---

### 3. Get Friends & Requests

```http
GET /friends?userId={your-uuid}
```

**Response:**
```json
[
  { "user_id": "uuid-1", "username": "alice", "status": "accepted" },
  { "user_id": "uuid-2", "username": "bob", "status": "pending" },
  { "user_id": "uuid-3", "username": "charlie", "status": "blocked" }
]
```

**Frontend Filtering:**
```typescript
const getFriendsData = async (myId: string) => {
  const response = await fetch(`http://localhost:3001/friends?userId=${myId}`);
  const all = await response.json();
  
  return {
    friends: all.filter((f: any) => f.status === 'accepted'),
    pending: all.filter((f: any) => f.status === 'pending'),
    blocked: all.filter((f: any) => f.status === 'blocked')
  };
};
```

---

### 4. Accept Friend Request

```http
PUT /friends
Content-Type: application/json
```

**Request Body:**
```json
{
  "myId": "your-uuid",
  "targetId": "requester-uuid"
}
```

**Response:**
```json
{ "success": true }
```

**Frontend Example:**
```typescript
const acceptFriendRequest = async (myId: string, targetId: string) => {
  const response = await fetch('http://localhost:3001/friends', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ myId, targetId })
  });
  return response.json();
};
```

---

### 5. Block User

```http
POST /friends
Content-Type: application/json
```

**Request Body:**
```json
{
  "myId": "your-uuid",
  "targetId": "user-uuid",
  "action": "block"
}
```

**Response:**
```json
{ "success": true, "status": "blocked" }
```

**Frontend Example:**
```typescript
const blockUser = async (myId: string, targetId: string) => {
  const response = await fetch('http://localhost:3001/friends', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ myId, targetId, action: 'block' })
  });
  return response.json();
};
```

---

## Notification System

**Base URL:** `http://localhost:3007` (notification-service)

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/notifications/:userId` | Get all notifications |
| GET | `/notifications/:userId?unreadOnly=true` | Get unread only |
| GET | `/notifications/:userId/count` | Get unread count (for badge) |
| PUT | `/notifications/:id/read` | Mark one as read |
| PUT | `/notifications/:userId/read-all` | Mark all as read |
| DELETE | `/notifications/:id` | Delete notification |

### Notification Document Schema

```typescript
interface Notification {
  _id: string;              // MongoDB ObjectId
  receiver_id: string;      // Who gets the notification
  sender_id: string;        // Who triggered it (or "system")
  sender_username: string;  // Sender's username
  type: 'friend_requested' | 'friend_accepted' | 'welcome' | 'system';
  message: string;          // Human-readable message
  read: boolean;            // Read status
  created_at: Date;         // Timestamp
}
```

### Message Templates

| Event | Generated Message |
|-------|-------------------|
| `friend.requested` | `{username} wants to add you as a friend` |
| `friend.accepted` | `{username} accepted your friend request` |
| `user.registered` | `Welcome to PagePulse, {username}!` |

### Frontend Examples

```typescript
const NOTIFICATION_API = 'http://localhost:3007';

// Get all notifications
const getNotifications = async (userId: string) => {
  const response = await fetch(`${NOTIFICATION_API}/notifications/${userId}`);
  return response.json();
};

// Get unread count (for notification badge)
const getUnreadCount = async (userId: string) => {
  const response = await fetch(`${NOTIFICATION_API}/notifications/${userId}/count`);
  const { count } = await response.json();
  return count;
};

// Get unread notifications only
const getUnreadNotifications = async (userId: string) => {
  const response = await fetch(`${NOTIFICATION_API}/notifications/${userId}?unreadOnly=true`);
  return response.json();
};

// Mark single notification as read
const markAsRead = async (notificationId: string) => {
  await fetch(`${NOTIFICATION_API}/notifications/${notificationId}/read`, { 
    method: 'PUT' 
  });
};

// Mark all as read
const markAllAsRead = async (userId: string) => {
  await fetch(`${NOTIFICATION_API}/notifications/${userId}/read-all`, { 
    method: 'PUT' 
  });
};

// Delete notification
const deleteNotification = async (notificationId: string) => {
  await fetch(`${NOTIFICATION_API}/notifications/${notificationId}`, { 
    method: 'DELETE' 
  });
};
```

---

## Friend Actions from Notifications

**Base URL:** `http://localhost:3007` (notification-service)

### Action from Notification (using notification `_id`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/notifications/:id/accept` | Accept friend request |
| POST | `/notifications/:id/reject` | Reject/decline request |
| POST | `/notifications/:id/block` | Block the user |

### Direct Actions (without notification)

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/friends/accept` | `{ userId, targetId }` | Accept friend |
| POST | `/friends/reject` | `{ userId, targetId }` | Reject request |
| POST | `/friends/block` | `{ userId, targetId }` | Block user |

### Response Format

```json
{
  "success": true,
  "message": "Friend request accepted",
  "new_status": "accepted"
}
```

### Frontend Examples

```typescript
const NOTIFICATION_API = 'http://localhost:3007';

// === From Notification (when you have notification._id) ===

const acceptFromNotification = async (notificationId: string) => {
  const response = await fetch(`${NOTIFICATION_API}/notifications/${notificationId}/accept`, { 
    method: 'POST' 
  });
  return response.json();
};

const rejectFromNotification = async (notificationId: string) => {
  const response = await fetch(`${NOTIFICATION_API}/notifications/${notificationId}/reject`, { 
    method: 'POST' 
  });
  return response.json();
};

const blockFromNotification = async (notificationId: string) => {
  const response = await fetch(`${NOTIFICATION_API}/notifications/${notificationId}/block`, { 
    method: 'POST' 
  });
  return response.json();
};

// === Direct Actions (without notification) ===

const acceptFriend = async (userId: string, targetId: string) => {
  const response = await fetch(`${NOTIFICATION_API}/friends/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, targetId })
  });
  return response.json();
};

const rejectFriend = async (userId: string, targetId: string) => {
  const response = await fetch(`${NOTIFICATION_API}/friends/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, targetId })
  });
  return response.json();
};

const blockFriend = async (userId: string, targetId: string) => {
  const response = await fetch(`${NOTIFICATION_API}/friends/block`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, targetId })
  });
  return response.json();
};
```

### What Happens After Each Action

| Action | PostgreSQL Update | Notification Update |
|--------|-------------------|---------------------|
| Accept | `status = 'accepted'` | Marked read, message updated |
| Reject | Row **deleted** | Notification deleted |
| Block | `status = 'blocked'` | Notification deleted |

---

## Status Reference

### Friend Status Values

| Status | Meaning | Can Request Again? |
|--------|---------|-------------------|
| `pending` | Request sent, waiting for response | N/A |
| `accepted` | Now friends | N/A (already friends) |
| `blocked` | User is blocked, can't interact | ❌ No |
| `removed` | Request rejected, row deleted from DB | ✅ Yes |

### Key Behavior

- **Reject** = "No thanks, but maybe later" → Row deleted → They can send a new request
- **Block** = "Never contact me" → Row stays as blocked → They cannot request again

This follows standard social media patterns (like Facebook/Instagram).

---

## Implementation Checklist

### ChatListPage - Add Friend Button
- [ ] Add "Add Friend" button in UI
- [ ] Create search modal/popover with input field
- [ ] Integrate `GET /users?q={term}` for search
- [ ] Display search results with "Send Request" button
- [ ] Integrate `POST /friends` with `action: "add"`
- [ ] Show success/error toast notifications

### Header - Notification Button
- [ ] Add notification bell icon in header
- [ ] Fetch unread count with `GET /notifications/:userId/count`
- [ ] Display badge with count (hide if 0)
- [ ] Create notification dropdown/panel
- [ ] Fetch notifications with `GET /notifications/:userId`
- [ ] Display notification list with message, time, read status
- [ ] Add Accept/Reject/Block buttons for `friend_requested` type
- [ ] Integrate friend action endpoints
- [ ] Mark as read when opened or clicked
- [ ] Add "Mark all as read" option

### API Service File (Recommended)

Create a centralized API service file:

```typescript
// src/services/api.ts

const AUTH_API = 'http://localhost:3001';
const NOTIFICATION_API = 'http://localhost:3007';

export const friendshipApi = {
  searchUsers: (term: string) => 
    fetch(`${AUTH_API}/users?q=${encodeURIComponent(term)}`).then(r => r.json()),
  
  sendRequest: (myId: string, targetId: string) =>
    fetch(`${AUTH_API}/friends`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ myId, targetId, action: 'add' })
    }).then(r => r.json()),
  
  getFriends: (userId: string) =>
    fetch(`${AUTH_API}/friends?userId=${userId}`).then(r => r.json()),
  
  acceptRequest: (myId: string, targetId: string) =>
    fetch(`${AUTH_API}/friends`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ myId, targetId })
    }).then(r => r.json()),
  
  blockUser: (myId: string, targetId: string) =>
    fetch(`${AUTH_API}/friends`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ myId, targetId, action: 'block' })
    }).then(r => r.json())
};

export const notificationApi = {
  getAll: (userId: string) =>
    fetch(`${NOTIFICATION_API}/notifications/${userId}`).then(r => r.json()),
  
  getUnreadCount: (userId: string) =>
    fetch(`${NOTIFICATION_API}/notifications/${userId}/count`).then(r => r.json()),
  
  markAsRead: (notificationId: string) =>
    fetch(`${NOTIFICATION_API}/notifications/${notificationId}/read`, { method: 'PUT' }),
  
  markAllAsRead: (userId: string) =>
    fetch(`${NOTIFICATION_API}/notifications/${userId}/read-all`, { method: 'PUT' }),
  
  delete: (notificationId: string) =>
    fetch(`${NOTIFICATION_API}/notifications/${notificationId}`, { method: 'DELETE' }),
  
  acceptFriend: (notificationId: string) =>
    fetch(`${NOTIFICATION_API}/notifications/${notificationId}/accept`, { method: 'POST' }).then(r => r.json()),
  
  rejectFriend: (notificationId: string) =>
    fetch(`${NOTIFICATION_API}/notifications/${notificationId}/reject`, { method: 'POST' }).then(r => r.json()),
  
  blockUser: (notificationId: string) =>
    fetch(`${NOTIFICATION_API}/notifications/${notificationId}/block`, { method: 'POST' }).then(r => r.json())
};
```
