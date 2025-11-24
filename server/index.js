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

    // Path pattern: /live-call/websocket/{call_id}/{phone}
    const match = pathname.match(/^\/live-call\/websocket\/([^\/]+)\/([^\/]+)$/);

    if (match) {
        console.log('[Server] WebSocket upgrade matched. Call ID:', match[1], 'Phone:', match[2]);
        const callId = match[1];
        const phone = match[2];
        const token = query.token;

        // Hardcoded token check
        if (token === HARDCODED_TOKEN) {
            wss.handleUpgrade(request, socket, head, (ws) => {
                ws.callId = callId;
                ws.phone = phone;
                ws.tenantId = query.tenant_id || 'tenant_001';
                ws.speakerId = query.speaker_id || 'speaker_001';
                ws.env = query.env || 'dev';
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
    // console.log('[WebSocket] Client connected');

    const connectionId = crypto.randomUUID();
    const callId = ws.callId || crypto.randomUUID();
    const phone = ws.phone || '+84-987-654-321';
    const tenantId = ws.tenantId || 'tenant_001';
    const speakerId = ws.speakerId || 'speaker_001';
    const env = ws.env || 'dev';
    let callInitialized = false;
    let audioChunkCount = 0;

    // Tạo gRPC bidirectional stream
    const stream = client.StreamCall((error, response) => {
        if (error) {
            console.error('[gRPC] Stream callback error:', error.message);
        }
    });

    // Log stream events
    // stream.on('prolog', () => console.log('[gRPC] Stream prolog'));
    // stream.on('headers', (headers) => console.log('[gRPC] Stream headers received'));

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
        // console.log('[gRPC] Received ServerResponse - status:', serverResponse.status);

        if (!serverResponse.status) {
            // Error response
            if (serverResponse.error) {
                console.error('[gRPC] Error:', serverResponse.error.message);
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({
                        error: serverResponse.error
                    }));

                    // Close connection if gRPC reports error (e.g. initial_info failed)
                    setTimeout(() => {
                        if (ws.readyState === 1) {
                            ws.close(1008, `gRPC logic error: ${serverResponse.error.message}`);
                        }
                    }, 100);
                }
            }
            return;
        }

        // Handle different response types
        if (serverResponse.audio_output) {
            const audioChunk = serverResponse.audio_output;
            // console.log(`[gRPC] Received audio output: ${audioChunk.audio_content.length} bytes`);

            if (ws.readyState === 1) { // OPEN
                // audioChunk.audio_content is already Base64 string
                const base64Audio = audioChunk.audio_content;
                const responseMessage = {
                    ws_audio_output: {
                        audio_content: base64Audio
                    }
                };
                ws.send(JSON.stringify(responseMessage));
                // console.log(`[WebSocket] Sent audio chunk to client: ${audioChunk.audio_content.length} bytes`);
            }
        } else if (serverResponse.signal) {
            const signal = serverResponse.signal;

            if (signal.end_call) {
                // console.log('[gRPC] Received end_call signal for:', signal.end_call.call_id);
                if (ws.readyState === 1) {
                    const endCallMessage = {
                        ws_signal: {
                            end_call: {
                                call_id: signal.end_call.call_id
                            }
                        }
                    };
                    // console.log('[WebSocket] Sending end_call signal to client');
                    ws.send(JSON.stringify(endCallMessage));
                    // Close connection after sending the message
                    setTimeout(() => {
                        if (ws.readyState === 1) {
                            ws.close(1000, 'Call ended by server');
                        }
                    }, 100);
                }
            } else if (signal.transfer_call) {
                // console.log('[gRPC] Received transfer_call signal');
                if (ws.readyState === 1) {
                    const transferCallMessage = {
                        ws_signal: {
                            transfer_call: {
                                call_id: signal.transfer_call.call_id,
                                customer_phone_number: signal.transfer_call.customer_phone_number,
                                target_staff: signal.transfer_call.target_staff || []
                            }
                        }
                    };
                    // console.log('[WebSocket] Sending transfer_call signal to client');
                    ws.send(JSON.stringify(transferCallMessage));
                }
            } else {
                // Other signal types
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ ws_signal: signal }));
                }
            }
        }
    });

    // WebSocket → gRPC (receive client messages)
    ws.on('message', (data, isBinary) => {
        try {
            if (!isBinary) {
                const message = JSON.parse(data.toString());
                // console.log('[WebSocket] Received message type:', Object.keys(message)[0]);

                if (message.ws_initial_call) {
                    // console.log('[gRPC] Sending initial_info to gRPC');
                    const initialRequest = {
                        status: true,
                        initial_info: {
                            workspace_id: message.ws_initial_call.tenant_id || tenantId,
                            call_id: message.ws_initial_call.call_id || callId,
                            customer_phone_number: message.ws_initial_call.phone || phone,
                            type_call: message.ws_initial_call.type_call || 'inbound',
                            hotline: message.ws_initial_call.hotline || HOTLINE,
                            url_audio_file: message.ws_initial_call.url_audio_file || ""
                        }
                    };

                    console.log('[gRPC] InitialInfo request:', JSON.stringify(initialRequest, null, 2));
                    stream.write(initialRequest);
                    callInitialized = true;
                } else if (message.ws_audio_input) {
                    if (!callInitialized) {
                        console.log('[WebSocket] ⚠ Stream not initialized yet, discarding audio chunk');
                        return;
                    }

                    const audioInput = message.ws_audio_input;
                    // Decode Base64 to Buffer
                    const audioContent = Buffer.from(audioInput.audio_content, 'base64');

                    const clientRequest = {
                        status: true,
                        play_audio: {
                            sample_rate: audioInput.sample_rate || 16000,
                            sample_width: audioInput.sample_width || 16,
                            num_channels: audioInput.num_channels || 1,
                            duration: audioInput.duration || (audioContent.length / (16000 * 2)),
                            audio_content: audioInput.audio_content
                        }
                    };

                    // console.log(`[gRPC] Sending audio chunk: ${audioContent.length} bytes (chunk #${audioChunkCount++})`);
                    stream.write(clientRequest);
                } else if (message.ws_disconnect) {
                    // console.log('[gRPC] Sending disconnect message');
                    const disconnectRequest = {
                        status: true,
                        disconnect: message.ws_disconnect
                    };
                    stream.write(disconnectRequest);
                }
            } else {
                // console.log('[WebSocket] Received binary data, ignoring (expecting JSON)');
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

            // console.log('[gRPC] Sending disconnect message');
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