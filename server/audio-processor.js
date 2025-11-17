// AudioWorklet processor for capturing PCM audio
class AudioCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = [];
        this.bufferSize = 2048; // Buffer size in samples (về 0.128s ở 16kHz)
        this.processCount = 0;
        this.silenceCount = 0;
        this.gain = 1.0; // 100% = 1.0
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        this.processCount++;

        if (input.length > 0) {
            const channelData = input[0]; // mono channel

            if (channelData && channelData.length > 0) {
                // Apply gain and add to buffer
                for (let i = 0; i < channelData.length; i++) {
                    const amplified = channelData[i] * this.gain;
                    // Clamp to [-1, 1]
                    const clamped = Math.max(-1, Math.min(1, amplified));
                    this.buffer.push(clamped);
                }

                // Send when buffer is full
                if (this.buffer.length >= this.bufferSize) {
                    const dataToSend = this.buffer.slice(0, this.bufferSize);
                    this.buffer = this.buffer.slice(this.bufferSize);

                    // Convert Float32 to Int16 PCM
                    const int16Array = new Int16Array(dataToSend.length);
                    for (let i = 0; i < dataToSend.length; i++) {
                        const s = dataToSend[i];
                        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }

                    // Send to main thread
                    this.port.postMessage({
                        audio: int16Array.buffer
                    }, [int16Array.buffer]); // Transfer ownership for performance
                }
            }
        }

        return true; // Keep processor alive
    }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
