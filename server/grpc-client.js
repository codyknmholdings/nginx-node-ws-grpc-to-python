// server/grpc-client.js
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const packageDef = protoLoader.loadSync('./proto/voice.proto', {});
const grpcObject = grpc.loadPackageDefinition(packageDef);
const liveCallPackage = grpcObject.live_call;

const GRPC_SERVER = process.env.GRPC_SERVER || '192.168.1.36:50051';

const client = new liveCallPackage.LiveCall(GRPC_SERVER, grpc.credentials.createInsecure());

console.log(`[gRPC Client] Initialized for server: ${GRPC_SERVER}`);

module.exports = { client };