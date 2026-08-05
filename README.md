# webrtc-broadcast

Group video calls: a [pion](https://github.com/pion/webrtc) SFU and the browser front end that talks
to it, in one repository.

| Directory | Contents                                                       |
| --------- | -------------------------------------------------------------- |
| `server/` | The SFU — signaling websocket and track forwarding. Go.        |
| `client/` | The front end — Next.js on bun.                                |

Each half has its own README with the details; this file only covers running them together.

## Development

Two terminals. The SFU first, since it serves the signaling socket:

```bash
cd server && go run . -allowed-origins http://localhost:3000
```

```bash
cd client && bun install && bun run dev
```

Then open http://localhost:3000, and the same room in a second tab to have someone to talk to.

## Deployment

One compose file at the root builds and runs both halves plus an optional coturn. Everything is
configured by domain name — `APP_DOMAIN` for the page, `SFU_DOMAIN` for signaling — and the browser
only ever talks to those two names over HTTPS.

The compose file itself brings no proxy: it publishes the page on `WEB_HTTP_PORT` (3300) and
signaling on `SFU_HTTP_PORT` (8080) for a reverse proxy elsewhere on the LAN to forward to, plus
media on `MEDIA_UDP_PORT` (7881/udp), which nothing may proxy.

```bash
cp .env.example .env    # APP_DOMAIN and SFU_DOMAIN; the relay bits only with --profile turn
docker compose build
docker compose up -d
```

Three things this stack does not let you skip:

- **Media does not go through any HTTP proxy** — only signaling can. The SFU's UDP port must be
  reachable one-to-one, on the same port number it binds. See `server/README.md`.
- **ICE candidates carry an address, not a name.** The SFU resolves `SFU_DOMAIN` itself at startup
  so the configuration stays domain-only, but that means the container's DNS answer has to match
  what browsers get, and a dynamic address needs a restart to be picked up.
- **The camera needs a secure context**, so both domains must be served over HTTPS. On plain HTTP
  `getUserMedia` does not exist and there is no call, whatever the permission prompt says.
