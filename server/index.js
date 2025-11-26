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

// Audio resampling configuration
const INPUT_SAMPLE_RATE = 24000;  // gRPC server output rate
const OUTPUT_SAMPLE_RATE = 8000; // Target rate for WebSocket client

/**
 * Resample Int16 PCM audio from one sample rate to another using linear interpolation
 * @param {Buffer|string} audioData - Base64 encoded Int16 PCM audio
 * @param {number} fromRate - Source sample rate (e.g., 24000)
 * @param {number} toRate - Target sample rate (e.g., 8000)
 * @returns {string} Base64 encoded resampled Int16 PCM audio
 */
function resampleAudio(audioData, fromRate, toRate) {
    // Decode base64 to buffer
    const inputBuffer = Buffer.from(audioData, 'base64');

    // Convert buffer to Int16Array
    const inputSamples = new Int16Array(inputBuffer.buffer, inputBuffer.byteOffset, inputBuffer.length / 2);

    // Calculate output length
    const ratio = fromRate / toRate;
    const outputLength = Math.floor(inputSamples.length / ratio);
    const outputSamples = new Int16Array(outputLength);

    // Linear interpolation resampling
    for (let i = 0; i < outputLength; i++) {
        const srcIndex = i * ratio;
        const srcIndexFloor = Math.floor(srcIndex);
        const srcIndexCeil = Math.min(srcIndexFloor + 1, inputSamples.length - 1);
        const fraction = srcIndex - srcIndexFloor;

        // Linear interpolation between two adjacent samples
        const sample = inputSamples[srcIndexFloor] * (1 - fraction) + inputSamples[srcIndexCeil] * fraction;
        outputSamples[i] = Math.round(sample);
    }

    // Convert back to base64
    const outputBuffer = Buffer.from(outputSamples.buffer);
    return outputBuffer.toString('base64');
}

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

    // Auto-send initial_info to gRPC immediately upon WebSocket connection
    // Using parameters from URL path and query string
    console.log('[gRPC] Auto-sending initial_info to gRPC');
    const initialRequest = {
        status: true,
        initial_info: {
            workspace_id: tenantId,
            call_id: callId,
            customer_phone_number: phone,
            type_call: 'inbound',
            hotline: HOTLINE,
            url_audio_file: ""
        }
    };

    console.log('[gRPC] InitialInfo request:', JSON.stringify(initialRequest, null, 2));
    stream.write(initialRequest);
    callInitialized = true;

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
                    // Convert gRPC error to WebSocket format (doc v0.3)
                    ws.send(JSON.stringify({
                        signal: {
                            error_code: serverResponse.error.error_code || 80100,
                            internal_error_code: serverResponse.error.internal_error_code || 500,
                            message: serverResponse.error.message
                        }
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
            const inputRate = audioChunk.sample_rate || INPUT_SAMPLE_RATE;

            if (ws.readyState === 1) { // OPEN
                try {
                    // Resample audio from gRPC rate (24kHz) to client rate (8kHz)
                    const resampledAudio = resampleAudio(audioChunk.audio_content, inputRate, OUTPUT_SAMPLE_RATE);

                    // Convert gRPC audio_output to WebSocket format (doc v0.3)
                    const responseMessage = {
                        audio_output: {
                            audio_content: resampledAudio
                        }
                    };
                    ws.send(JSON.stringify(responseMessage));
                    // console.log(`[WebSocket] Sent resampled audio: ${inputRate}Hz -> ${OUTPUT_SAMPLE_RATE}Hz`);
                } catch (err) {
                    console.error('[WebSocket] Error resampling audio:', err.message);
                }
            }
        } else if (serverResponse.signal) {
            const signal = serverResponse.signal;

            if (signal.end_call) {
                // console.log('[gRPC] Received end_call signal for:', signal.end_call.call_id);
                if (ws.readyState === 1) {
                    // Convert gRPC signal to WebSocket format (doc v0.3)
                    const endCallMessage = {
                        signal: {
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
                    // Convert gRPC signal to WebSocket format (doc v0.3)
                    const transferCallMessage = {
                        signal: {
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
                    ws.send(JSON.stringify({ signal: signal }));
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

                // Handle initial_info message (doc v0.3) - IGNORED since server auto-sends it
                if (message.initial_info) {
                    console.log('[WebSocket] Received initial_info from client - IGNORED (server already sent it automatically)');
                    // Do nothing - server already initialized the call
                }
                // Handle play_audio message (doc v0.3)
                else if (message.play_audio) {
                    const audioInput = message.play_audio;

                    // Validate required fields
                    if (!audioInput.audio_content) {
                        console.error('[WebSocket] ⚠ Missing audio_content in play_audio');
                        return;
                    }

                    // Get audio params from client (doc v0.3)
                    const sampleRate = audioInput.sample_rate;
                    const sampleWidth = audioInput.sample_width; // bits (16 for Int16)
                    const numChannels = audioInput.num_channels;
                    const duration = audioInput.duration;

                    // Log first few chunks for debugging
                    if (audioChunkCount < 3) {
                        console.log(`[WebSocket] Audio params from client: rate=${sampleRate}, width=${sampleWidth}, channels=${numChannels}, duration=${duration?.toFixed(4)}`);
                    }

                    // Convert WebSocket play_audio to gRPC format
                    const clientRequest = {
                        status: true,
                        play_audio: {
                            sample_rate: sampleRate,
                            sample_width: sampleWidth,
                            num_channels: numChannels,
                            duration: duration,
                            audio_content: audioInput.audio_content
                        }
                    };

                    audioChunkCount++;
                    // console.log(`[gRPC] Sending audio chunk: ${audioContent.length} bytes (chunk #${audioChunkCount})`);
                    stream.write(clientRequest);
                }
                // Handle disconnect message (doc v0.3)
                else if (message.disconnect !== undefined) {
                    console.log('[WebSocket] Received disconnect message from client');
                    // Convert WebSocket disconnect to gRPC format
                    const disconnectRequest = {
                        status: true,
                        disconnect: {}
                    };
                    stream.write(disconnectRequest);
                }
                // Legacy support: ws_audio_input (backward compatibility)
                else if (message.ws_audio_input) {
                    const audioInput = message.ws_audio_input;

                    if (!audioInput.audio_content) {
                        console.error('[WebSocket] ⚠ Missing audio_content in ws_audio_input');
                        return;
                    }

                    const clientRequest = {
                        status: true,
                        play_audio: {
                            sample_rate: audioInput.sample_rate,
                            sample_width: audioInput.sample_width,
                            num_channels: audioInput.num_channels,
                            duration: audioInput.duration,
                            audio_content: audioInput.audio_content
                        }
                    };

                    audioChunkCount++;
                    stream.write(clientRequest);
                }
                // Legacy support: ws_disconnect (backward compatibility)
                else if (message.ws_disconnect) {
                    console.log('[WebSocket] Received ws_disconnect (legacy) message');
                    const disconnectRequest = {
                        status: true,
                        disconnect: message.ws_disconnect
                    };
                    stream.write(disconnectRequest);
                }
                else {
                    console.warn('[WebSocket] Unknown message type:', Object.keys(message)[0]);
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