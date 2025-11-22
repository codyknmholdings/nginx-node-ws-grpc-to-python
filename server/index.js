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
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({
                        error: serverResponse.error
                    }));
                }
            }
            return;
        }

        // Handle different response types
        if (serverResponse.audio_output) {
            const audioChunk = serverResponse.audio_output;
            console.log(`[gRPC] Received audio output: ${audioChunk.audio_content.length} bytes`);

            if (ws.readyState === 1) { // OPEN
                // Convert Buffer to Base64
                const base64Audio = audioChunk.audio_content.toString('base64');
                const responseMessage = {
                    audio_output: {
                        audio_content: base64Audio
                    }
                };
                ws.send(JSON.stringify(responseMessage));
                console.log(`[WebSocket] Sent audio chunk to client: ${audioChunk.audio_content.length} bytes`);
            }
        } else if (serverResponse.signal) {
            const signal = serverResponse.signal;
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({ signal: signal }));
            }

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

    // WebSocket → gRPC (receive client messages)
    ws.on('message', (data, isBinary) => {
        try {
            if (!isBinary) {
                const message = JSON.parse(data.toString());
                console.log('[WebSocket] Received message type:', Object.keys(message)[0]);

                if (message.initial_info) {
                    console.log('[gRPC] Sending InitialInfo to gRPC');
                    const initialRequest = {
                        status: true,
                        initial_info: message.initial_info
                    };
                    // Ensure required fields are present or fallback to URL params
                    if (!initialRequest.initial_info.call_id) initialRequest.initial_info.call_id = callId;
                    if (!initialRequest.initial_info.customer_phone_number) initialRequest.initial_info.customer_phone_number = customerPhoneNumber;
                    if (!initialRequest.initial_info.workspace_id) initialRequest.initial_info.workspace_id = WORKSPACE_ID;
                    if (!initialRequest.initial_info.hotline) initialRequest.initial_info.hotline = HOTLINE;

                    console.log('[gRPC] InitialInfo request:', JSON.stringify(initialRequest, null, 2));
                    stream.write(initialRequest);
                    callInitialized = true;
                } else if (message.play_audio) {
                    if (!callInitialized) {
                        console.log('[WebSocket] ⚠ Stream not initialized yet, discarding audio chunk');
                        return;
                    }

                    const playAudio = message.play_audio;
                    // Decode Base64 to Buffer
                    const audioContent = Buffer.from(playAudio.audio_content, 'base64');

                    const clientRequest = {
                        status: true,
                        play_audio: {
                            sample_rate: playAudio.sample_rate || 16000,
                            sample_width: playAudio.sample_width || 16,
                            num_channels: playAudio.num_channels || 1,
                            duration: playAudio.duration || (audioContent.length / (16000 * 2)),
                            audio_content: audioContent
                        }
                    };

                    console.log(`[gRPC] Sending audio chunk: ${audioContent.length} bytes (chunk #${audioChunkCount++})`);
                    stream.write(clientRequest);
                } else if (message.disconnect) {
                    console.log('[gRPC] Sending disconnect message');
                    const disconnectRequest = {
                        status: true,
                        disconnect: message.disconnect
                    };
                    stream.write(disconnectRequest);
                }
            } else {
                console.log('[WebSocket] Received binary data, ignoring (expecting JSON)');
            }
        } catch (err) {
            console.error('[WebSocket] Error processing message:', err.message);
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