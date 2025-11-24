const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const fs = require('fs');
const path = require('path');

// Load Proto
const PROTO_PATH = path.join(__dirname, 'proto/voice.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});
const voiceProto = grpc.loadPackageDefinition(packageDefinition).live_call;

// Configuration
const PORT = process.env.PORT || '50051';
const RECORDINGS_DIR = path.join(__dirname, 'recordings');

// Ensure recordings directory exists
if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

/**
 * Writes a WAV header to the beginning of a file
 * @param {number} fd File descriptor
 * @param {number} dataLength Total length of audio data in bytes
 * @param {number} sampleRate Sample rate (e.g., 16000)
 * @param {number} numChannels Number of channels (e.g., 1)
 * @param {number} bitsPerSample Bits per sample (e.g., 16)
 */
function writeWavHeader(fd, dataLength, sampleRate, numChannels, bitsPerSample, position = 0) {
    const header = Buffer.alloc(44);

    // RIFF identifier
    header.write('RIFF', 0);
    // file length (data + header - 8)
    header.writeUInt32LE(36 + dataLength, 4);
    // RIFF type
    header.write('WAVE', 8);
    // format chunk identifier
    header.write('fmt ', 12);
    // format chunk length
    header.writeUInt32LE(16, 16);
    // sample format (raw)
    header.writeUInt16LE(1, 20);
    // channel count
    header.writeUInt16LE(numChannels, 22);
    // sample rate
    header.writeUInt32LE(sampleRate, 24);
    // byte rate (sampleRate * blockAlign)
    const blockAlign = numChannels * bitsPerSample / 8;
    header.writeUInt32LE(sampleRate * blockAlign, 28);
    // block align (channel count * bytes per sample)
    header.writeUInt16LE(blockAlign, 32);
    // bits per sample
    header.writeUInt16LE(bitsPerSample, 34);
    // data chunk identifier
    header.write('data', 36);
    // data chunk length
    header.writeUInt32LE(dataLength, 40);

    fs.writeSync(fd, header, 0, 44, position);
}/**
 * Implements the StreamCall RPC method.
 */
function streamCall(call) {
    let callId = null;
    let fileStream = null;
    let fd = null;
    let totalBytesWritten = 0;
    let sampleRate = 16000; // Default
    let numChannels = 1;    // Default
    let bitsPerSample = 16; // Default

    console.log('[gRPC] New stream connection initiated');

    call.on('data', (request) => {
        // Handle InitialInfo
        if (request.initial_info) {
            const info = request.initial_info;
            callId = info.call_id || `unknown_${Date.now()}`;
            console.log(`[gRPC] Received InitialInfo for Call ID: ${callId}`);
            console.log(`       Customer: ${info.customer_phone_number}`);
            console.log(`       Type: ${info.type_call}`);

            const filename = path.join(RECORDINGS_DIR, `${callId}.wav`);

            try {
                // Open file for writing (w+ to allow seeking back to write header)
                fd = fs.openSync(filename, 'w+');

                // Write placeholder header and advance position
                writeWavHeader(fd, 0, sampleRate, numChannels, bitsPerSample, null);

                console.log(`[gRPC] Recording started: ${filename}`);
            } catch (err) {
                console.error('[gRPC] Error creating recording file:', err);
            }
        }

        // Handle Audio Data
        if (request.play_audio) {
            const audio = request.play_audio;

            // Update format info if provided (assuming it doesn't change mid-stream)
            if (audio.sample_rate) sampleRate = audio.sample_rate;
            if (audio.num_channels) numChannels = audio.num_channels;
            if (audio.sample_width) bitsPerSample = audio.sample_width;

            if (audio.audio_content && audio.audio_content.length > 0) {
                if (fd) {
                    // audio.audio_content is now a Base64 string
                    const buffer = Buffer.from(audio.audio_content, 'base64');
                    fs.writeSync(fd, buffer, 0, buffer.length, null); // null position = append
                    totalBytesWritten += buffer.length;
                    // console.log(`[gRPC] Wrote ${buffer.length} bytes`);
                }

                // ECHO FEATURE: Send audio back to client for latency testing
                const echoResponse = {
                    status: true,
                    audio_output: {
                        sample_rate: audio.sample_rate || sampleRate,
                        sample_width: audio.sample_width || bitsPerSample,
                        num_channels: audio.num_channels || numChannels,
                        duration: audio.duration || 0,
                        audio_content: audio.audio_content
                    }
                };
                call.write(echoResponse);
            }
        }

        // Handle Disconnect
        if (request.disconnect) {
            console.log(`[gRPC] Received Disconnect signal for Call ID: ${callId}`);
            call.end();
        }
    });

    call.on('end', () => {
        console.log(`[gRPC] Stream ended for Call ID: ${callId}`);
        if (fd) {
            // Update WAV header with correct length
            console.log(`[gRPC] Finalizing WAV file (Total bytes: ${totalBytesWritten})`);
            writeWavHeader(fd, totalBytesWritten, sampleRate, numChannels, bitsPerSample, 0);
            fs.closeSync(fd);
            console.log(`[gRPC] Recording saved successfully.`);
        }
    });

    call.on('error', (err) => {
        console.error('[gRPC] Stream error:', err);
        if (fd) fs.closeSync(fd);
    });
}

/**
 * Implements the Check RPC method (Health Check).
 */
function check(call, callback) {
    console.log('[gRPC] Health check received');
    callback(null, { status: 'SERVING' });
}

/**
 * Starts the gRPC server.
 */
function main() {
    const server = new grpc.Server();
    server.addService(voiceProto.LiveCall.service, {
        StreamCall: streamCall,
        Check: check
    });

    server.bindAsync(`0.0.0.0:${PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
        if (err) {
            console.error(err);
            return;
        }
        console.log(`[Mock AI Service] gRPC Server running at 0.0.0.0:${port}`);
        // server.start(); // Not needed in newer grpc-js versions, but harmless
    });
}

main();
