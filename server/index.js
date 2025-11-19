// server/index.js
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { client } = require('./grpc-client');
const crypto = require('crypto');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Configuration
const WORKSPACE_ID = 'workspace_001';
const HOTLINE = '+84-123-456-789';

// Serve static files
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/client.html');
});

app.get('/audio-processor.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(__dirname + '/audio-processor.js');
});

wss.on('connection', (ws) => {
    console.log('[WebSocket] Client connected');

    const connectionId = crypto.randomUUID();
    const callId = crypto.randomUUID();
    let callInitialized = false;
    let audioChunkCount = 0;

    // Tạo gRPC bidirectional stream
    const stream = client.StreamCall((error, response) => {
        if (error) {
            console.error('[gRPC] Stream error:', error);
        }
    });

    // gRPC → WebSocket (receive server responses)
    stream.on('data', (serverResponse) => {
        console.log('[gRPC] Received ServerResponse - status:', serverResponse.status);

        if (!serverResponse.status) {
            // Error response
            if (serverResponse.data.error) {
                console.error('[gRPC] Error:', serverResponse.data.error.message);
            }
            return;
        }

        // Handle different response types
        if (serverResponse.data.audio_output) {
            const audioChunk = serverResponse.data.audio_output;
            console.log(`[gRPC] Received audio output: ${audioChunk.audio_content.length} bytes`);

            if (ws.readyState === 1) { // OPEN
                ws.send(audioChunk.audio_content, { binary: true });
            }
        } else if (serverResponse.data.signal) {
            const signal = serverResponse.data.signal;
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
        if (isBinary && data instanceof Buffer) {
            // Send initial call info if not yet initialized
            if (!callInitialized) {
                console.log('[WebSocket] First audio chunk received, sending InitialInfo');

                const clientRequest = {
                    status: true,
                    data: {
                        initial_info: {
                            workspace_id: WORKSPACE_ID,
                            call_id: callId,
                            customer_phone_number: '+84-987-654-321',
                            type_call: 1, // INBOUND
                            hotline: HOTLINE,
                            url_audio_file: null
                        }
                    }
                };

                console.log('[gRPC] Sending InitialInfo:', clientRequest.data.initial_info);
                stream.write(clientRequest);
                callInitialized = true;
            }

            // Send audio chunk
            console.log(`[WebSocket] Received audio: ${data.length} bytes`);

            const audioChunk = {
                sample_rate: 16000,
                sample_width: 16,
                num_channels: 1,
                duration: data.length / (16000 * 2), // Int16 = 2 bytes per sample
                audio_content: data
            };

            const clientRequest = {
                status: true,
                data: {
                    play_audio: audioChunk
                }
            };

            console.log(`[gRPC] Sending audio chunk: ${data.length} bytes (chunk #${audioChunkCount++})`);
            stream.write(clientRequest);
        } else {
            console.log('[WebSocket] Received non-binary data, ignoring');
        }
    });

    stream.on('error', (err) => {
        console.error('[gRPC] Stream error:', err);
        if (ws.readyState === 1) {
            ws.close(1011, 'gRPC stream error');
        }
    });

    ws.on('close', () => {
        console.log('[WebSocket] Client disconnected');

        // Send disconnect message if stream is still active
        if (callInitialized) {
            const disconnectRequest = {
                status: true,
                data: {
                    disconnect: {}
                }
            };

            console.log('[gRPC] Sending disconnect message');
            stream.write(disconnectRequest);
        }

        stream.end();
    });

    ws.on('error', (err) => {
        console.error('[WebSocket] Error:', err);
        stream.end();
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`[Server] WebSocket server running on ws://localhost:${PORT}`);
    console.log(`[Server] gRPC client connecting to: 192.168.1.36:50051`);
});