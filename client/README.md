# webrtc-broadcaster

Browser front end for the pion SFU in `../server`. Everyone in a room publishes audio and
video and subscribes to everyone else's.

Package manager and runtime are [bun](https://bun.sh), in development and in the image alike.

## Running

The SFU has to be up first — it serves the signaling websocket:

```bash
cd ../server
go run . -allowed-origins http://localhost:3000
```

Then:

```bash
bun install
bun run dev
```

Open http://localhost:3000, type your name and a room name, and join. Open the same room in another
tab or on another machine to have someone to talk to.

Your name is remembered in `localStorage` and pre-filled next time. It is sent over the signaling
socket, never in the URL, and the server broadcasts the room roster so everyone sees everyone else's
name on their tile.

### Configuration

`NEXT_PUBLIC_*` values are inlined into the client bundle **at build time**, so in a
container this is a build argument, not a runtime environment variable — changing it
means rebuilding the image. See the deployment section of `../server/README.md`.

| Variable              | Default                 | Purpose                                                                             |
| --------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SFU_URL` | `http://localhost:8080` | Where the SFU is reachable. `http`/`https` is upgraded to `ws`/`wss` automatically. |

Put it in `.env.local`:

```
NEXT_PUBLIC_SFU_URL=https://sfu.example.com
```

The ICE servers are **not** configured here — the SFU sends them in its `welcome` frame, so there is
one place to change them.

### Machines without a camera

Asking for a camera and a microphone together fails outright with `NotFoundError` when either one is
missing — a desktop with no webcam gets nothing, not just no video. So `acquireMedia` in
`lib/useCall.ts` falls back: camera + mic, then mic only, then camera only. You join with whatever
the machine has, a notice explains what was dropped, and controls for a device you never got are
hidden. A denied permission is not retried, since asking for less will not change it.

Participants with no camera show a placeholder tile and are still heard; their `<video>` element
stays mounted because that is what plays their audio.

### Testing from another device

`getUserMedia` is only available in a secure context, so a plain `http://192.168.x.x:3000` page
cannot reach the camera no matter what the permission prompt says. Either serve both halves over
HTTPS, or tunnel to `localhost`.

## How it works

The SFU is always the offerer. This side only ever answers, which is what makes people joining and
leaving mid-call work: the server re-offers whenever the set of forwarded tracks changes, and there
is no offer glare to resolve.

```
browser                                  SFU
   |  GET /ws/:room  (websocket upgrade)  |
   |------------------------------------->|
   |  welcome {id, room, iceServers}      |
   |<-------------------------------------|
   |  offer {type, sdp}                   |
   |<-------------------------------------|
   |  answer {type, sdp}                  |
   |------------------------------------->|
   |  candidate {...}  (both directions)  |
   |<------------------------------------>|
   |                                      |
   |  offer  <- again on every join/leave |
   |<-------------------------------------|
```

- `lib/signaling.ts` — protocol types and the websocket URL.
- `lib/useCall.ts` — one participant's peer connection and signaling loop.
- `components/Call.tsx` — join form, video grid, mute and camera controls.

Signaling frames are applied one at a time. A renegotiation offer can arrive while the previous one
is still being answered, and applying both concurrently corrupts the negotiation.
