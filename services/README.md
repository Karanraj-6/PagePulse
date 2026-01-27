# PagePulse Microservices Architecture

PagePulse is a book rental and reading platform built using a **Microservices Architecture**. This document details the system design, communication patterns, and service responsibilities.

## 🏗 Detailed System Architecture

The following diagram illustrates the complete flow of data, from the user's browser to the database, including synchronous (gRPC) and asynchronous (RabbitMQ) patterns.

```mermaid
graph TD
    %% Actors
    User((User))
    
    %% Gateway Layer
    subgraph "Edge Layer"
        Gateway["Nginx API Gateway<br/>(Load Balancer & Proxy)"]
    end

    %% Web Application
    subgraph "Frontend"
        Client[React Web Client]
    end

    %% Services Layer
    subgraph "Microservices Cluster"
        Auth["Auth Service<br/>(Express + gRPC)"]
        Book["Book Service<br/>(Express + gRPC + RabbitMQ)"]
        Payment["Payment Service<br/>(Express + gRPC)"]
        Chat["Chat Service<br/>(Socket.io + gRPC)"]
        Notif["Notification Service<br/>(Worker)"]
    end

    %% Infrastructure Layer
    subgraph "Data & Infra"
        DB_Auth[("Postgres: AuthDB")]
        DB_Book[("Postgres: BookDB")]
        DB_Pay[("Postgres: PayDB")]
        RabbitMQ{RabbitMQ Bus}
        Redis[(Redis Cache)]
    end

    %% Flows
    User -->|HTTPS Request| Client
    Client -->|REST API| Gateway
    Client -->|WebSocket| Gateway

    Gateway -->|/api/auth/*| Auth
    Gateway -->|/api/books/*| Book
    Gateway -->|/socket.io| Chat
    Gateway -->|/api/payment/*| Payment

    %% Synchronous Inter-Service (gRPC)
    Book -- "1. Validate Token (gRPC)" --> Auth
    Chat -- "1. Validate Token (gRPC)" --> Auth
    Book -- "2. Process Pay (gRPC)" --> Payment

    %% Database interactions
    Auth --> DB_Auth
    Book --> DB_Book
    Payment --> DB_Pay

    %% Asynchronous (Events)
    Book -- "3. Publish 'book.rented'" --> RabbitMQ
    RabbitMQ -.->|"Consume"| Notif
    Notif -.->|"Send Email"| User
```

## 🔄 Detailed Request Flows

### 1. Book Rental Flow (Synchronous Orchestration)
When a user clicks "Rent Book", the system performs a multi-step synchronous transaction across three services.

```mermaid
sequenceDiagram
    participant Client as React Client
    participant GW as API Gateway
    participant Book as Book Service
    participant Auth as Auth Service
    participant Pay as Payment Service
    participant RMQ as RabbitMQ
    
    Client->>GW: POST /api/books/rent/123 <br/>(Auth Header: Bearer xyz)
    GW->>Book: Forward Request
    
    activate Book
    note right of Book: 1. Validate User
    Book->>Auth: gRPC ValidateToken(xyz)
    Auth-->>Book: UserID: 456 (Valid)
    
    note right of Book: 2. Process Payment
    Book->>Pay: gRPC ProcessPayment(456, $10.99)
    Pay-->>Book: TxID: 999 (Success)
    
    note right of Book: 3. Finalize
    Book->>RMQ: Publish "book.rented" {req_id: 999}
    Book-->>GW: 200 OK {success: true}
    deactivate Book
    GW-->>Client: Rental Confirmed
```

### 2. Chat Connection Flow (WebSocket + gRPC)
Chat requires instant authentication during the WebSocket handshake.

```mermaid
sequenceDiagram
    participant Client as React Client
    participant GW as API Gateway
    participant Chat as Chat Service
    participant Auth as Auth Service

    Client->>GW: WebSocket Handshake <br/>(Query: token=xyz)
    GW->>Chat: Upgrade Connection
    
    activate Chat
    note right of Chat: Middleware Check
    Chat->>Auth: gRPC ValidateToken(xyz)
    
    alt Token Invalid
        Auth-->>Chat: {valid: false}
        Chat-->>Client: Disconnect (401)
    else Token Valid
        Auth-->>Chat: {valid: true, email: user@test.com}
        Chat-->>Client: Connection Established
    end
    deactivate Chat
```

## 🔌 Communication Patterns

### 1. External Communication (REST/WebSocket)
*   **API Gateway (Nginx)**: The single entry point for all client requests. It routes traffic based on URL paths (`/api/auth`, `/api/books`) to the appropriate backend service.
*   **Web Client**: Built with React (Vite). Connects to the Gateway for REST API calls and establishes a WebSocket connection for Chat.

### 2. Synchronous Inter-Service (gRPC)
Used when a service needs an immediate answer from another service. **These calls happen directly between services (Service-to-Service) and do NOT pass through the API Gateway.**
*   **Book Service -> Auth Service**: Validates user tokens included in requests.
*   **Book Service -> Payment Service**: Processes payments synchronously during a book rental transaction.
*   **Chat Service -> Auth Service**: Validates user tokens immediately upon WebSocket connection handshake.

### 3. Asynchronous Events (RabbitMQ)
Used for background tasks and decoupling.
*   **Event**: `book.rented`
    *   **Publisher**: `book-service`
    *   **Consumer**: `notification-service` (Sends email confirmation)

## 📦 Service Breakdown

| Service Name | Tech Stack | Responsibility | Port (Internal) |
| :--- | :--- | :--- | :--- |
| **Auth Service** | Express, JWT, gRPC | User management, Token generation & validation. | 3000 (HTTP), 50051 (gRPC) |
| **Book Service** | Express, gRPC Client | Book catalog, Rental logic. Orchestrates Auth & Payment calls. | 3000 (HTTP), 50052 (gRPC) |
| **Payment Service** | Express, gRPC Server | Payment processing logic. | 3000 (HTTP), 50053 (gRPC) |
| **Chat Service** | Socket.io, gRPC Client | Real-time messaging where users can discuss books. | 3000 (HTTP) |
| **Notification** | Node Worker, RabbitMQ | Listens for events and sends notifications. | N/A (Worker) |

