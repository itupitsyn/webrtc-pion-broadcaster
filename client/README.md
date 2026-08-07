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

### Room links

Every room has an address of its own — `/r/<room>` — and **Copy link** in the call header puts it on
the clipboard. Opening one lands on the join form with the room already filled in and the cursor in
the name field, so with a remembered name joining is a single click. The link carries the room name
and nothing else: no identity, no token, so it is exactly as secret as the room name is.

Joining from `/` rewrites the address to the room's own through `history.replaceState`, and leaving
puts it back to `/`. Deliberately not a router navigation — that would remount the page and tear down
the call that had just started.

Only a tab that has actually been in a call cleans the address up on the way out. A link that was
just opened keeps its room in the bar until you join or leave the page, because scrubbing it there
would lose the room on the next reload.

Nothing about a room exists on the server until someone is in it, so a link works before the room
does; the first person through it creates the room by joining.

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

### Per-participant volume

Each remote tile carries its own volume slider and a mute button, like Discord or TeamSpeak. Both are
purely local: they set `volume` and `muted` on that participant's `<video>` element, nothing is
signalled, and the person being turned down is never told. The slider is squared before it reaches
the element — a linear one crams every useful step into its bottom third, because perceived loudness
rises much more slowly than amplitude.

The control is hidden on the local preview, which plays nothing by design, and on participants who
joined without a microphone, who have nothing to turn down.

The slider runs to 200%, and how it gets there is the interesting part. A media element's `volume`
stops at 1, so anything past 100% has to go through WebAudio: the stream is fed to a `GainNode` and a
limiter (`source → gain → limiter → destination`), and the element is muted while that graph plays.
Two things shape the implementation:

- **The graph is built on the first boost and never before it.** A `MediaStreamAudioSourceNode` fed by
  a _remote_ stream has a long history of yielding silence on Safari and iOS, so a call that leaves
  the slider alone touches no `AudioContext` at all. If building it does fail, the slider caps itself
  at 100% and says so — a quiet participant, not a silent one.
- **The element stays attached to the stream, just muted.** Chrome has never reliably delivered remote
  audio to WebAudio from a stream that is not also attached to a live media element.

The limiter is not decoration: 200% is +12 dB, which would tear on an already loud speaker.
One `AudioContext` is shared by the whole page, since browsers cap how many a document may hold.

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
