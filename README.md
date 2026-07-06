# Binge

Minimal synced watch rooms with two delivery modes:

- Nearby Wi-Fi: direct HTTP media streaming from the local Node server with tight playback sync.
- Internet: public Socket.IO sync plus WebRTC host relay when available, with server-media fallback.

The app also includes a browser camera/mic call so people can watch and talk in the same room.

## Reality Check

No browser app can guarantee literal zero latency or perfect quality across arbitrary networks. Binge is built for ultra-low-latency sync and source-quality playback where the network allows it. For reliable internet rooms, deploy the server on public HTTPS and configure a TURN server.

## Requirements

- Node.js 18+
- A modern browser with WebRTC support
- HTTPS or localhost for camera/mic access
- A public Node host for internet rooms
- A TURN server for restrictive NATs/firewalls

## Local Setup

Install dependencies:

```bash
npm install
npm --prefix client install
npm --prefix server install
```

Start both services:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The backend defaults to [http://localhost:3002](http://localhost:3002).

## Modes

### Nearby Wi-Fi

Use this when everyone is on the same network. The host uploads a browser-compatible video, shares the room link, and viewers stream from the local backend.

For phones or other devices on the LAN, open the app with the host machine IP, for example:

```text
http://192.168.1.20:3000
```

The host screen includes an editable backend URL. When sharing from `localhost`, replace it with the host machine LAN address, for example `http://192.168.1.20:3002`, before copying the invite link.

The home screen also lets viewers paste a backend URL before joining by room code. This is useful when the app shell is open locally but the room lives on a LAN machine or public internet server.

When the backend can see a local network address, the app shows a `Use Wi-Fi address` shortcut that fills the backend URL for LAN phones and tablets.

### Internet

Use this when viewers are outside the local network. Deploy the Node backend somewhere reachable from the public internet, then set the client to that URL:

```bash
NEXT_PUBLIC_SERVER_URL=https://your-sync-server.example.com
```

Internet mode works best with TURN:

```bash
NEXT_PUBLIC_TURN_URL=turn:turn.example.com:3478
NEXT_PUBLIC_TURN_USERNAME=your-user
NEXT_PUBLIC_TURN_CREDENTIAL=your-password
```

You can also provide the full ICE list as JSON:

```bash
NEXT_PUBLIC_ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"your-user","credential":"your-password"}]'
```

Without TURN, WebRTC may fail on some networks. The room keeps the server media URL available as a fallback, but latency and buffering will depend on server bandwidth and viewer distance.

Invite links include the selected backend URL as a `server` query parameter, so viewers connect to the intended public sync server even when the client app is served separately.

For high-bandwidth deployments, tune the browser relay ceiling:

```bash
NEXT_PUBLIC_STREAM_RELAY_VIDEO_BITRATE=12000000
```

The value is bits per second and is clamped between 1 Mbps and 30 Mbps in the client.

## Media Notes

- Best video compatibility: MP4 with H.264 video and AAC audio.
- WebM works in most Chromium-based browsers.
- The host screen checks the selected file against the backend upload limit before starting the transfer.
- Optional subtitles: `.vtt` or `.srt`; SRT uploads are converted to VTT.
- Camera/mic requires HTTPS except on localhost.

## Deployment Notes

- The server must be a normal long-running Node process because it handles uploads, byte-range media serving, Socket.IO, and WebRTC signaling.
- If the Next client is deployed separately, set `NEXT_PUBLIC_SERVER_URL` to the public backend origin.
- If you use the compose stack below, Caddy publishes both the app host and the backend host over HTTPS.
- Configure CORS/proxy limits on your host for large video uploads.
- Keep uploaded files on persistent storage if rooms should survive server restarts.

### Backend Health Checks

The Node backend exposes small operational endpoints:

```text
GET /health       process health, room count, TURN configured flag
GET /ready        upload directory writability
GET /diagnostics  non-secret runtime summary
GET /network      local IPv4 backend URL candidates for Wi-Fi setup
GET /internet-readiness public HTTPS/TURN readiness summary
```

Use `/ready` for platform readiness checks and `/health` for uptime checks.

### Backend Docker Image

Build and run the server container:

```bash
cd server
docker build -t binge-server .
docker run --rm -p 3002:3002 -v binge_uploads:/data/uploads \
  -e NEXT_PUBLIC_TURN_URL=turn:turn.example.com:3478 \
  -e NEXT_PUBLIC_TURN_USERNAME=your-user \
  -e NEXT_PUBLIC_TURN_CREDENTIAL=your-password \
  binge-server
```

Point the client at the deployed backend with:

```bash
NEXT_PUBLIC_SERVER_URL=https://your-sync-server.example.com
```

### Internet Stack Example

`deploy/docker-compose.internet.yml` contains the Next.js app, the public backend, a Caddy HTTPS reverse proxy, and a coturn relay example. Copy `deploy/.env.internet.example` to `deploy/.env`, set real domains and credentials, then start the stack from the repository root.

```bash
npm run verify:internet-env -- deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.internet.yml up --build
```

The compose file intentionally requires real values for:

```text
PUBLIC_APP_HOST      public app domain, for example app.example.com
PUBLIC_BACKEND_HOST  sync backend domain, for example sync.example.com
PUBLIC_URL           public HTTPS backend origin, for example https://sync.example.com
CORS_ORIGIN          app origin allowed to call the backend
TURN_REALM           TURN domain/realm
NEXT_PUBLIC_TURN_URL TURN relay URL
NEXT_PUBLIC_TURN_USERNAME / NEXT_PUBLIC_TURN_CREDENTIAL
```

Open these ports on the host:

```text
80/tcp        Caddy HTTP challenge and redirect
443/tcp       public HTTPS app and backend
3478/tcp+udp  TURN
5349/tcp      TURN over TLS, if certificates are configured
49160-49200/udp TURN relay range from the compose example
```

Point DNS records for both `PUBLIC_APP_HOST` and `PUBLIC_BACKEND_HOST` to the deployment host. The client image bakes `NEXT_PUBLIC_SERVER_URL` at build time from `PUBLIC_URL`, so rebuild the client container after changing backend or TURN values.

## Verification

Run the server protocol suite:

```bash
npm --prefix server test
```

Run the client production build:

```bash
npm --prefix client run build
```

Verify a deployed backend from your laptop:

```bash
npm run verify:internet-env -- deploy/.env
npm run verify:deploy -- https://your-sync-server.example.com --require-internet
```

The env verifier catches example domains, missing HTTPS, placeholder TURN credentials, invalid bitrate/upload limits, and app/backend origin mismatches before you launch the stack. The deployment verifier checks `/health`, `/ready`, `/diagnostics`, `/internet-readiness`, a WebSocket room join, and a polling room join. `--require-internet` fails unless `/internet-readiness` reports public HTTPS and TURN are ready. `--require-turn` is also available when you only want to enforce relay configuration.
