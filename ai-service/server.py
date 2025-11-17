# ai-service/server.py
import grpc
import voice_pb2
import voice_pb2_grpc
from concurrent import futures
import time
import wave
import os
import struct
from datetime import datetime

class VoiceStreamingServicer(voice_pb2_grpc.VoiceStreamingServicer):
    def StreamAudio(self, request_iterator, context):
        seq = 0
        
        # Create audio folder if not exists
        audio_dir = '/audio'
        os.makedirs(audio_dir, exist_ok=True)
        
        # Create WAV file with timestamp
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        wav_file = f'{audio_dir}/received_{timestamp}.wav'
        
        # WAV parameters: 16kHz, mono, 16-bit PCM
        wav = wave.open(wav_file, 'wb')
        wav.setnchannels(1)  # mono
        wav.setsampwidth(2)  # 16-bit = 2 bytes
        wav.setframerate(16000)  # 16kHz
        
        print(f"[AI] Recording to {wav_file}")
        total_bytes = 0
        
        try:
            for chunk in request_iterator:
                print(f"[AI] Received chunk {chunk.sequence}, size: {len(chunk.data)} bytes")
                
                # Write to WAV file
                wav.writeframes(chunk.data)
                total_bytes += len(chunk.data)
                
                # Echo lại audio + thêm message
                response = voice_pb2.AudioResponse(
                    data=chunk.data,  # echo
                    timestamp=chunk.timestamp,
                    sequence=seq,
                    message="processed_by_ai"
                )
                seq += 1
                yield response
                time.sleep(0.01)  # simulate AI latency
        finally:
            wav.close()
            print(f"[AI] Audio saved to {wav_file} ({total_bytes} bytes)")

def serve():
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    voice_pb2_grpc.add_VoiceStreamingServicer_to_server(VoiceStreamingServicer(), server)
    server.add_insecure_port('[::]:50051')
    print("gRPC AI Server running on :50051")
    server.start()
    server.wait_for_termination()

if __name__ == '__main__':
    serve()