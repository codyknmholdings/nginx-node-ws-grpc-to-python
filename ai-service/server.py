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

class LiveCallServicer(voice_pb2_grpc.LiveCallServicer):
    def Check(self, request, context):
        return voice_pb2.HealthCheckResponse(
            status=voice_pb2.HealthCheckResponse.SERVING
        )

    def StreamCall(self, request_iterator, context):
        audio_dir = '/audio'
        os.makedirs(audio_dir, exist_ok=True)
        
        wav_file = None
        wav = None
        total_bytes = 0
        call_id = "unknown"

        print(f"[AI] New connection started")

        try:
            for request in request_iterator:
                if not request.status:
                    print("[AI] Received status=False, ignoring")
                    continue

                if request.HasField('initial_info'):
                    info = request.initial_info
                    call_id = info.call_id
                    print(f"[AI] InitialInfo received: call_id={call_id}, phone={info.customer_phone_number}")
                    
                    # Create WAV file
                    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
                    wav_file = f'{audio_dir}/received_{call_id}_{timestamp}.wav'
                    wav = wave.open(wav_file, 'wb')
                    wav.setnchannels(1)
                    wav.setsampwidth(2) # 16-bit
                    wav.setframerate(16000)
                    print(f"[AI] Recording to {wav_file}")

                elif request.HasField('play_audio'):
                    if wav:
                        chunk = request.play_audio
                        # print(f"[AI] Received audio chunk: {len(chunk.audio_content)} bytes")
                        wav.writeframes(chunk.audio_content)
                        total_bytes += len(chunk.audio_content)

                        # Echo back audio
                        response = voice_pb2.ServerResponse(
                            status=True,
                            audio_output=voice_pb2.ServerAudioChunk(
                                sample_rate=chunk.sample_rate,
                                sample_width=chunk.sample_width,
                                num_channels=chunk.num_channels,
                                duration=chunk.duration,
                                audio_content=chunk.audio_content
                            )
                        )
                        yield response
                    else:
                        print("[AI] Warning: Received audio before InitialInfo")

                elif request.HasField('disconnect'):
                    print(f"[AI] Client requested disconnect for call_id={call_id}")
                    break
        
        except Exception as e:
            print(f"[AI] Error in StreamCall: {e}")
        
        finally:
            if wav:
                wav.close()
                print(f"[AI] Audio saved to {wav_file} ({total_bytes} bytes)")
            print(f"[AI] StreamCall finished for call_id={call_id}")

def serve():
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    voice_pb2_grpc.add_LiveCallServicer_to_server(LiveCallServicer(), server)
    server.add_insecure_port('[::]:50051')
    print("gRPC AI Server running on :50051")
    server.start()
    server.wait_for_termination()

if __name__ == '__main__':
    serve()