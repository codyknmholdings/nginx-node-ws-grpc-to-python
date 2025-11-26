// AudioWorklet processor for capturing PCM audio
class AudioCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = [];
        this.bufferSize = 1024; // Buffer size in samples (về 0.128s ở 8kHz)
        this.processCount = 0;
        this.silenceCount = 0;
        this.gain = 1.0; // 100% = 1.0

        // Downsampling setup
        this.targetSampleRate = 8000;
        this.sourceSampleRate = sampleRate; // Global variable in AudioWorklet
        this.downsampleRatio = this.sourceSampleRate / this.targetSampleRate;
        this.nextSampleIndex = 0;

        console.log(`AudioProcessor initialized: ${this.sourceSampleRate}Hz -> ${this.targetSampleRate}Hz (Ratio: ${this.downsampleRatio})`);
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        this.processCount++;

        if (input.length > 0) {
            const channelData = input[0]; // mono channel

            // Pass through audio to output (for visualization/monitoring)
            if (output.length > 0 && channelData) {
                output[0].set(channelData);
            }

            if (channelData && channelData.length > 0) {
                // Apply gain and downsample
                for (let i = 0; i < channelData.length; i++) {
                    // Simple downsampling: only take samples when we cross the threshold
                    if (i >= this.nextSampleIndex) {
                        const amplified = channelData[i] * this.gain;
                        // Clamp to [-1, 1]
                        const clamped = Math.max(-1, Math.min(1, amplified));
                        this.buffer.push(clamped);

                        // Advance to next target sample
                        this.nextSampleIndex += this.downsampleRatio;
                    }
                }

                // Adjust index relative to the current block for the next block
                this.nextSampleIndex -= channelData.length;

                // Send when buffer is full
                if (this.buffer.length >= this.bufferSize) {
                    const dataToSend = this.buffer.slice(0, this.bufferSize);
                    this.buffer = this.buffer.slice(this.bufferSize);

                    // Send raw Float32 (32-bit float) to server
                    // Client sends "audio byte data" (raw binary)
                    const float32Array = new Float32Array(dataToSend);

                    // Send to main thread
                    this.port.postMessage({
                        audio: float32Array.buffer
                    }, [float32Array.buffer]); // Transfer ownership for performance
                }
            }
        }

        return true; // Keep processor alive
    }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
