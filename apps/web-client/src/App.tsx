import React from 'react';

function App() {
    return (
        <div style={{ fontFamily: 'sans-serif', padding: '20px' }}>
            <h1>PagePulse</h1>
            <p>Welcome to the microservices demo.</p>
            <ul>
                <li><a href="/books">Browse Books</a></li>
                <li><a href="/chat">Chat</a></li>
            </ul>
        </div>
    );
}

export default App;
