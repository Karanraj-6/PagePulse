# Notification Service

The **Notification Service** manages all user notifications and invitations for PagePulse. It handles real-time push (via gRPC to chat-service), email delivery, and persistent storage (MongoDB). It also provides REST APIs for notification and invitation management.

---

## Database Schema

### MongoDB Collections

#### 1. `notifications`
| Field           | Type    | Description                                 |
|-----------------|---------|---------------------------------------------|
| _id             | ObjectId| Primary key                                 |
| receiver_id     | String  | User receiving the notification             |
| sender_id       | String  | User who triggered the notification         |
| sender_username | String  | Username of sender                         |
| type            | String  | Notification type (see below)               |
| message         | String  | Notification message                        |
| read            | Boolean | Read status (default: false)                |
| invitation_id   | String  | Linked invitation (optional)                |
| created_at      | Date    | Creation timestamp                          |

**Notification Types:**
- `friend_requested`: Sent when a user receives a friend request
- `friend_accepted`: Sent when a friend request is accepted
- `welcome`: Sent when a user registers
- `system`: System messages
- `invitation`: Book reading session invitation

#### 2. `invitations`
| Field           | Type    | Description                                 |
|-----------------|---------|---------------------------------------------|
| _id             | ObjectId| Primary key                                 |
| receiver_id     | String  | User being invited                          |
| sender_id       | String  | User sending the invitation                 |
| sender_username | String  | Username of sender                         |
| book_id         | String  | Book being invited to                       |
| book_title      | String  | Title of the book                           |
| created_at      | Date    | Creation timestamp                          |

**Invitation Usage:**
- Created when a user invites another to a book session
- Linked to a notification and email

---

## REST API Reference


### 1. Create Invitation
- **Endpoint:** `POST /invitations`
- **Body:**
	```json
	{
		"sender_id": "string",
		"receiver_id": "string",
		"book_id": "string",
		"book_title": "string"
	}
	```
- **Response:**
	```json
	{ "success": true, "invitationId": "string", "notificationId": "string" }
	```
- **Description:** Creates an invitation and a linked notification. Sends real-time push and email to the receiver.

### 2. List Invitations for a User
- **Endpoint:** `GET /invitations/:userId`
- **Response:**
	```json
	[
		{
			"_id": "string",
			"receiver_id": "string",
			"sender_id": "string",
			"sender_username": "string",
			"book_id": "string",
			"book_title": "string",
			"created_at": "2024-01-01T12:00:00.000Z"
		}
	]
	```
- **Description:** Lists all invitations received by a user (max 50, newest first).

### 3. Delete Invitation
- **Endpoint:** `DELETE /invitations/:id`
- **Response:**
	```json
	{ "success": true }
	```
- **Description:** Deletes an invitation and any linked notifications.

### 4. Get Notifications for a User
- **Endpoint:** `GET /notifications/:userId`
- **Query Params:**
	- `unreadOnly` (optional, boolean): Only return unread notifications
- **Response:**
	```json
	[
		{
			"_id": "string",
			"receiver_id": "string",
			"sender_id": "string",
			"sender_username": "string",
			"type": "string",
			"message": "string",
			"read": false,
			"invitation_id": "string",
			"created_at": "2024-01-01T12:00:00.000Z"
		}
	]
	```
- **Description:** Lists notifications for a user (max 50, newest first).

### 5. Get Unread Notification Count
- **Endpoint:** `GET /notifications/:userId/count`
- **Response:**
	```json
	{ "count": 3 }
	```
- **Description:** Returns the number of unread notifications for a user.

### 6. Mark Notification as Read
- **Endpoint:** `PUT /notifications/:id/read`
- **Response:**
	```json
	{ "success": true }
	```
- **Description:** Marks a notification as read.

### 7. Mark All Notifications as Read
- **Endpoint:** `PUT /notifications/:userId/read-all`
- **Response:**
	```json
	{ "success": true }
	```
- **Description:** Marks all notifications for a user as read.

### 8. Delete Notification
- **Endpoint:** `DELETE /notifications/:id`
- **Response:**
	```json
	{ "success": true }
	```
- **Description:** Deletes a notification. If linked to an invitation, deletes the invitation as well.

### 9. Accept Friend Request (from notification)
- **Endpoint:** `POST /notifications/:id/accept`
- **Response:**
	```json
	{ "success": true, "message": "Accepted", "new_status": "string", "deleted": true }
	```
- **Description:** Accepts a friend request via gRPC, deletes the notification if successful.

### 10. Block User (from notification)
- **Endpoint:** `POST /notifications/:id/block`
- **Response:**
	```json
	{ "success": true, "message": "Blocked", "new_status": "string", "deleted": true }
	```
- **Description:** Blocks a user via gRPC, deletes the notification if successful.

### 11. Reject Friend Request (from notification)
- **Endpoint:** `POST /notifications/:id/reject`
- **Response:**
	```json
	{ "success": true, "message": "Rejected", "new_status": "string", "deleted": true }
	```
- **Description:** Rejects a friend request via gRPC, deletes the notification if successful.

### 12. Accept Friend Request (direct)
- **Endpoint:** `POST /friends/accept`
- **Body:**
	```json
	{ "userId": "string", "targetId": "string" }
	```
- **Response:**
	```json
	{ "success": true, "message": "Accepted", "new_status": "string" }
	```
- **Description:** Accepts a friend request directly (not via notification).

### 13. Block User (direct)
- **Endpoint:** `POST /friends/block`
- **Body:**
	```json
	{ "userId": "string", "targetId": "string" }
	```
- **Response:**
	```json
	{ "success": true, "message": "Blocked", "new_status": "string" }
	```
- **Description:** Blocks a user directly (not via notification).

### 14. Reject Friend Request (direct)
- **Endpoint:** `POST /friends/reject`
- **Body:**
	```json
	{ "userId": "string", "targetId": "string" }
	```
- **Response:**
	```json
	{ "success": true, "message": "Rejected", "new_status": "string" }
	```
- **Description:** Rejects a friend request directly (not via notification).

---

## Email Templates


### Welcome Email
- **Trigger:** When a user registers (event: `user.registered`)
- **Template:** Personalized welcome message with PagePulse branding.

### Friend Request Email
- **Trigger:** When a user receives a friend request (event: `friend.requested`)
- **Template:** Sender's name, accept link, and description of friend features.

### Invitation Email
- **Trigger:** When a user is invited to a book reading session (via `/invitations`)
- **Template:** Sender's name, book title, book cover, and link to join PagePulse.

See `src/email.ts` for full HTML template details.

---
