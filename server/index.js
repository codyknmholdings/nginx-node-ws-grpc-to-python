// server/index.js
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { client } = require('./grpc-client');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/client.html');
});

app.get('/audio-processor.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(__dirname + '/audio-processor.js');
});

wss.on('connection', (ws) => {
    console.log('Client connected');
    let sequenceNumber = 0;

    // Tạo gRPC stream
    const stream = client.StreamAudio((error, response) => {
        if (error) console.error('gRPC error:', error);
    });

    // WebSocket → gRPC (raw PCM binary)
    ws.on('message', (data, isBinary) => {
        if (isBinary && data instanceof Buffer) {
            console.log(`[Server] Received raw PCM: ${data.length} bytes`);

            const chunk = {
                data: data,  // raw PCM Int16 binary
                timestamp: Date.now(),
                sequence: sequenceNumber++
            };
            stream.write(chunk);
        } else {
            console.log('[Server] Received non-binary data, ignoring');
        }
    });

    // gRPC → WebSocket (echo back raw PCM binary)
    stream.on('data', (response) => {
        console.log(`[Server] Sending back to client: ${response.data.length} bytes`);
        if (ws.readyState === 1) { // OPEN
            ws.send(response.data, { binary: true });
        }
    });

    stream.on('error', (err) => {
        console.error('gRPC stream error:', err);
        if (ws.readyState === 1) {
            ws.close();
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        stream.end();
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        stream.end();
    });
});

server.listen(8080, () => {
    console.log('WebSocket server running on ws://localhost:8080');
});