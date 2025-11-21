// server/index.js
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { client } = require('./grpc-client');
const crypto = require('crypto');
const url = require('url');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const HARDCODED_TOKEN = '3k659sdg98gkn3d9ghhg977';

// Function to check gRPC connection
async function checkGrpcConnection() {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000; // 5 second timeout
        client.waitForReady(deadline, (error) => {
            if (error) {
                reject(new Error(`[gRPC Connection Error] Cannot connect to ${process.env.GRPC_SERVER || '192.168.1.36:50051'}: ${error.message}`));
            } else {
                resolve(true);
                console.log(`[gRPC Connection] ✓ Successfully connected to ${process.env.GRPC_SERVER || '192.168.1.36:50051'}`);
            }
        });
    });
}

// Configuration
const WORKSPACE_ID = 'workspace_001';
const HOTLINE = '+84987654321';

// Serve static files
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/client.html');
});

app.get('/audio-processor.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(__dirname + '/audio-processor.js');
});

server.on('upgrade', (request, socket, head) => {
    const parsedUrl = url.parse(request.url, true);
    const { pathname, query } = parsedUrl;
    console.log('[Server] Upgrade request for:', pathname);
    console.log('[Server] Query parameters:', query);

    // Path pattern: /live-call/websocket/{call_id}/{customer_phone_number}
    const match = pathname.match(/^\/live-call\/websocket\/([^\/]+)\/([^\/]+)$/);

    if (match) {
        console.log('[Server] WebSocket upgrade matched. Call ID:', match[1], 'Customer Phone Number:', match[2]);
        const callId = match[1];
        const customerPhoneNumber = match[2];
        const token = query.token;

        // Hardcoded token check
        if (token === HARDCODED_TOKEN) {
            wss.handleUpgrade(request, socket, head, (ws) => {
                ws.callId = callId;
                ws.customerPhoneNumber = customerPhoneNumber;
                wss.emit('connection', ws, request);
            });
        } else {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
        }
    } else {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
    }
});

wss.on('connection', (ws, request) => {
    console.log('[WebSocket] Client connected');

    const connectionId = crypto.randomUUID();
    const callId = ws.callId || crypto.randomUUID();
    const customerPhoneNumber = ws.customerPhoneNumber || '+84-987-654-321';
    let callInitialized = false;
    let audioChunkCount = 0;

    // Tạo gRPC bidirectional stream
    const stream = client.StreamCall((error, response) => {
        if (error) {
            console.error('[gRPC] Stream callback error:', error.message);
        }
    });

    // Log stream events
    stream.on('prolog', () => console.log('[gRPC] Stream prolog'));
    stream.on('headers', (headers) => console.log('[gRPC] Stream headers received'));

    // Handle stream errors immediately
    stream.on('error', (err) => {
        console.error('[gRPC] Stream error event:', err.message);
        console.error('[gRPC] Error code:', err.code);
        console.error('[gRPC] Error details:', err.details);
        if (ws.readyState === 1) {
            ws.close(1011, `gRPC error: ${err.message}`);
        }
    });

    // gRPC → WebSocket (receive server responses)
    stream.on('data', (serverResponse) => {
        console.log('[gRPC] Received ServerResponse - status:', serverResponse.status);

        if (!serverResponse.status) {
            // Error response
            if (serverResponse.error) {
                console.error('[gRPC] Error:', serverResponse.error.message);
            }
            return;
        }

        // Handle different response types
        if (serverResponse.audio_output) {
            const audioChunk = serverResponse.audio_output;
            console.log(`[gRPC] Received audio output: ${audioChunk.audio_content.length} bytes`);

            if (ws.readyState === 1) { // OPEN
                ws.send(audioChunk.audio_content, { binary: true });
                console.log(`[WebSocket] Sent audio chunk to client: ${audioChunk.audio_content.length} bytes`);
            }
        } else if (serverResponse.signal) {
            const signal = serverResponse.signal;
            if (signal.end_call) {
                console.log('[gRPC] Received end_call signal for:', signal.end_call.call_id);
                if (ws.readyState === 1) {
                    ws.close(1000, 'Call ended by server');
                }
            } else if (signal.transfer_call) {
                console.log('[gRPC] Received transfer_call signal');
                // Handle call transfer if needed
            }
        }
    });

    // Send InitialInfo immediately
    console.log('[gRPC] Sending InitialInfo to gRPC (first message)');

    // Create ClientRequest with InitialInfo
    const initialRequest = {
        status: true,
        initial_info: {
            workspace_id: WORKSPACE_ID,
            call_id: callId,
            customer_phone_number: customerPhoneNumber,
            type_call: 'inbound',
            hotline: HOTLINE,
            url_audio_file: ""
        }
    };
    console.log('[gRPC] InitialInfo request:', JSON.stringify(initialRequest, null, 2));

    try {
        stream.write(initialRequest);
        callInitialized = true;
        console.log('[gRPC] ✓ InitialInfo sent successfully');
    } catch (err) {
        console.error('[gRPC] ✗ Error writing InitialInfo:', err.message);
        if (ws.readyState === 1) {
            ws.close(1011, 'Failed to send InitialInfo to gRPC');
        }
    }

    // WebSocket → gRPC (receive client messages)
    ws.on('message', (data, isBinary) => {
        if (isBinary && data instanceof Buffer) {
            // Only send if stream is initialized
            if (!callInitialized) {
                console.log('[WebSocket] ⚠ Stream not initialized yet, discarding audio chunk');
                return;
            }

            // Send audio chunk
            console.log(`[WebSocket] Received audio: ${data.length} bytes`);

            // Convert Float32 (from client) to Int16 (for gRPC)
            // Data is Float32 (4 bytes), so length/4 = number of samples
            const float32Buffer = new Float32Array(data.buffer, data.byteOffset, data.length / 4);
            const int16Buffer = new Int16Array(float32Buffer.length);

            for (let i = 0; i < float32Buffer.length; i++) {
                const s = Math.max(-1, Math.min(1, float32Buffer[i]));
                int16Buffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }

            const audioContent = Buffer.from(int16Buffer.buffer);

            const clientRequest = {
                status: true,
                play_audio: {
                    sample_rate: 16000,
                    sample_width: 16,
                    num_channels: 1,
                    duration: audioContent.length / (16000 * 2), // Int16 = 2 bytes per sample
                    audio_content: audioContent
                }
            };

            console.log(`[gRPC] Sending audio chunk: ${audioContent.length} bytes (chunk #${audioChunkCount++})`);
            try {
                stream.write(clientRequest);
            } catch (err) {
                console.error('[gRPC] Error sending audio chunk:', err.message);
            }
        } else {
            console.log('[WebSocket] Received non-binary data, ignoring');
        }
    });

    ws.on('close', () => {
        console.log('[WebSocket] Client disconnected');

        // Send disconnect message if stream is still active and writable
        if (callInitialized && stream.writable) {
            const disconnectRequest = {
                status: true,
                disconnect: {}
            };

            console.log('[gRPC] Sending disconnect message');
            try {
                stream.write(disconnectRequest);
            } catch (err) {
                console.error('[gRPC] Error sending disconnect message:', err.message);
            }
        }

        stream.end();
    });

    ws.on('error', (err) => {
        console.error('[WebSocket] Error:', err);
        stream.end();
    });
});

const PORT = process.env.PORT || 8080;

// Check gRPC connection before starting server
checkGrpcConnection()
    .then(() => {
        server.listen(PORT, () => {
            console.log(`[Server] WebSocket server running on ws://localhost:${PORT}`);
            console.log(`[Server] gRPC client connecting to: ${process.env.GRPC_SERVER}`);
        });
    })
    .catch((error) => {
        console.error(error.message);
        process.exit(1);
    });