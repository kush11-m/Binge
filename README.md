# SyncStream

LAN-synced video streaming for up to 4 users.

## Requirements

- Node.js 18+
- Same Wi-Fi network for all devices

## Setup

### 1) Start the server

```bash
cd server
npm install
npm run dev
```

The server runs on http://<host-ip>:3002

### 2) Start the client

```bash
cd client
npm install
npm run dev
```

Open http://<host-ip>:3000 in a browser on the LAN.

## Deployment note

The Socket.IO + upload server must run on a normal Node host (LAN or VPS). If you deploy the Next.js client to a platform like Vercel, set `NEXT_PUBLIC_SERVER_URL` to the server base URL and ensure the server is reachable.
