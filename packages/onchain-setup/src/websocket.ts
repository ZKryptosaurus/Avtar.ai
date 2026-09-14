import WebSocket from 'ws';

// Install Node ws before SDK imports capture a WebSocket implementation.
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
