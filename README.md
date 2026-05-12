# SyncStream

LAN-synced video streaming for up to 4 users.

## Requirements

- Node.js 18+
- Same Wi-Fi network for all devices

## Setup

Copy [.env.example](.env.example) to a local `.env` file if you want to override the default ports or server URL.

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

## Optional: HLS (HTTP Live Streaming) via ffmpeg
If you want to pre-transcode a video into HLS segments for more resilient streaming or adaptive delivery, you can generate an HLS playlist with `ffmpeg`:

```bash
ffmpeg -i input.mp4 \
	-profile:v baseline \
	-level 3.0 \
	-start_number 0 \
	-hls_time 10 \
	-hls_list_size 0 \
	-f hls index.m3u8
```

Place the generated `index.m3u8` and `.ts` segment files in your server `uploads` directory and serve them from `/video/` or a static route. Using HLS avoids byte-range seeking issues on some clients and makes streaming across networks more robust.

### Or start both from the repo root

If you prefer a single command from the workspace root:

```bash
npm run dev
```

This starts the server and client together using the root `package.json`.

## Deployment note

The Socket.IO + upload server must run on a normal Node host (LAN or VPS). If you deploy the Next.js client to a platform like Vercel, set `NEXT_PUBLIC_SERVER_URL` to the server base URL and ensure the server is reachable.
