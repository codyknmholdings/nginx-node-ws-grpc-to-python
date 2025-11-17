// server/grpc-client.js
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const packageDef = protoLoader.loadSync('./proto/voice.proto', {});
const grpcObject = grpc.loadPackageDefinition(packageDef);
const voicePackage = grpcObject.voice;

const client = new voicePackage.VoiceStreaming('ai-service:50051', grpc.credentials.createInsecure());

module.exports = { client };