# webrtc-broadcast

A small [pion](https://github.com/pion/webrtc) SFU for group calls. Every participant in a room
publishes audio and video over one peer connection and receives everyone else's tracks over the same
connection. The browser front end lives in `../client`.

## Running

```bash
go run . -allowed-origins http://localhost:3000
```

| Flag               | Default                  | Purpose                                                                                                                                |
| ------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `-port`            | `8080`                   | HTTP port for signaling.                                                                                                                 |
| `-udp-port`        | `7881`                   | Single UDP port all media is multiplexed onto. `0` reverts to a fresh ephemeral port per connection, which cannot be published from a container. |
| `-stun`            | _(none)_                 | STUN server; also sent to clients in the `welcome` frame. coturn answers STUN on its own port, so `stun:<TURN host>:3478` is usually right. |
| `-turn`            | _(none)_                 | TURN server offered to clients, e.g. `turn:turn.example.com:3478`.                                                                       |
| `-turn-secret`     | _(none)_                 | coturn `static-auth-secret`. Must be set together with `-turn`.                                                                          |
| `-public-address`  | _(none)_                 | Public IP **or hostname** to advertise in ICE candidates; a hostname is resolved once at startup. **Required when the server is behind NAT** — without it pion only offers its private address. |
| `-allowed-origins` | `*`                      | Comma-separated browser origins allowed to open a signaling connection.                                                                 |

`GET /healthz` returns `ok`. `GET /ws/:room` is the signaling websocket; room names are
`[A-Za-z0-9_-]{1,64}`.

### Display names

A participant announces its name with an `identify` frame once the socket is open, and the server
broadcasts a `peers` roster to the room on every join, leave and rename. Names are sent over the
socket rather than in the URL so they never reach a query string or an access log. They are trimmed
of control characters and capped at 32 runes; a participant that never identifies itself gets a
generated label from the browser.

## Deploying

The single most important thing: **signaling and media take different paths.**

| Traffic                                 | Path                                                          |
| --------------------------------------- | ------------------------------------------------------------- |
| Signaling — HTTP + websocket on `:8080` | Ordinary HTTP through the reverse proxy, as `sfu.<domain>`.    |
| Media — ICE, DTLS, SRTP over UDP        | **Straight to `-udp-port`, never through a proxy.**            |

An HTTP/TCP proxy cannot carry WebRTC media, and UDP routers do not help either:
ICE negotiates on the real addresses in the candidates, and proxying rewrites
exactly those. The media port has to be published on the host and opened in the
firewall.

The repository root holds one `docker-compose.yml` for the whole stack — SFU, front
end and coturn — so both halves build from the same file and the same `.env`. It
publishes host ports for a reverse proxy to forward to — the page on
`WEB_HTTP_PORT`, signaling on `SFU_HTTP_PORT`, media on `MEDIA_UDP_PORT` — and
configures no proxy itself; that part lives outside this repository.

Configuration is by domain name throughout: `APP_DOMAIN` and `SFU_DOMAIN` are all
the stack needs, including for ICE (see `-public-address` below).

```bash
cd ..                   # the compose file lives at the repository root
cp .env.example .env    # fill in APP_DOMAIN and SFU_DOMAIN
docker compose build
docker compose up -d
```

Point the proxy at this host's LAN address on those two ports, terminate TLS for
both domains there, and forward websocket upgrades on the SFU one.

### `-public-address`, and why the SFU resolves a name

An ICE candidate carries an address, never a hostname — so something has to turn
the domain into an IP. The SFU does it itself, at startup, which keeps the literal
address out of the configuration entirely: `-public-address=sfu.example.com`
resolves to whatever the browser's DNS would resolve it to.

It is resolved **once**. On a connection with a dynamic public address, restart the
container after it changes, or set `PUBLIC_ADDRESS` to a literal IP and manage it
the usual way.

### Ports, and why an HTTP front end is not enough

Fronting an HTTP service is the whole answer for HTTP services. It is not, here.
ICE candidates carry a literal address and port, and the browser sends media to
exactly that — so the SFU's media port has to be reachable on the same port number
it thinks it is listening on.

Behind a router with a single public address that means an explicit forward:

| Port            | Proto     | Forward to | For                                  | Needed             |
| --------------- | --------- | ---------- | ------------------------------------ | ------------------ |
| `80`, `443`     | TCP       | the proxy  | the page and the signaling websocket | already in place   |
| `7881`          | UDP       | SFU host   | media                                | **yes**            |
| `3478`          | UDP + TCP | coturn     | TURN, and STUN on the same port      | only with `--profile turn` |
| `49160`–`49200` | UDP       | coturn     | TURN relay range                     | only with `--profile turn` |

**Forward the media port one-to-one.** External 7881 must map to internal 7881: the
number the SFU advertises is the one it binds, so a remapped port cannot work.

### Start without a relay

The SFU only needs to be reachable; it does not need to discover itself. With the
media port forwarded and `SFU_DOMAIN` resolving to the right address, browsers
connect straight to it, and STUN and TURN are both dead weight for the common case. `.env.example` leaves them
empty and `docker compose up -d` starts just the SFU and the front end.

Add the relay only once someone actually cannot connect — a network that blocks UDP
outright, or symmetric NAT on the client side. Fill in `STUN_URL`, `TURN_URL` and
`TURN_SECRET`, forward coturn's ports, then:

```bash
docker compose --profile turn up -d
```

### Testing from inside the LAN

Expect this to be misleading when `SFU_DOMAIN` resolves to the router's WAN
address: from inside, the browser sends media there, and many routers do not
hairpin UDP back to the LAN. A call that fails at your desk but works from a phone
on mobile data is this, not a broken deployment. Split-horizon DNS that answers
with the LAN address inside the network fixes it properly; `PUBLIC_ADDRESS` set to
the LAN address is the blunt version, and then only LAN clients can connect.

### Things that bite

- **The resolved public address must be the one browsers can reach**, not the one
  on the NIC. Behind a home or office router that is the router's WAN address, not
  `192.168.x.y`. Getting it wrong produces a call that connects and then shows
  nothing, because the candidates point somewhere unreachable. The startup log
  prints what it resolved — check it there.
- **The container's DNS view has to match the browser's.** The name is resolved
  inside the container, so a split-horizon answer that differs from what browsers
  get sends media to the wrong place. `PUBLIC_ADDRESS` overrides it when they
  cannot be made to agree.
- **`no such host on 127.0.0.11:53` at startup is the container's resolver, not
  the zone.** `127.0.0.11` is Docker's embedded DNS, which forwards to whatever
  the host uses; a host behind a local or split-horizon resolver returns NXDOMAIN
  for a name that public DNS answers fine. Check both sides —

  ```bash
  getent hosts sfu.example.com                                       # the host
  docker compose run --rm --entrypoint sh sfu -c 'nslookup sfu.example.com'
  ```

  — then either uncomment `dns:` on the `sfu` service to query public resolvers,
  or set `PUBLIC_ADDRESS` to a literal IP and skip the lookup entirely.
- **coturn also needs to know both halves when it is behind NAT**: use
  `--external-ip=<public>/<private>` rather than the public address alone.
- **`NEXT_PUBLIC_SFU_URL` is baked into the front-end bundle at build time**, not
  read at runtime. Pointing the app at a different SFU means `docker compose build`
  again, not just a restart.
- **The app must be served over HTTPS.** `getUserMedia` only exists in a secure
  context, and `http://<host>:<port>` is not one — only `localhost` is exempt. On
  plain HTTP the camera is unavailable no matter what the permission prompt says,
  so the proxy's certificate is what makes the app work at all.
- **`APP_DOMAIN` must match the app's origin exactly**, or the websocket handshake
  is rejected before the call starts. The SFU compares `https://$APP_DOMAIN`
  against the browser's `Origin` header verbatim.
- The SFU runs on the bridge network with one published UDP port. Docker's iptables
  DNAT preserves client source addresses, which is what ICE needs. If media still
  fails, `network_mode: host` for the SFU is the fallback.

### TURN

When enabled, coturn runs in `use-auth-secret` mode: the SFU derives a username
and password from the shared secret for each participant and sends them in the
`welcome` frame. They expire on their own, so a leaked frame is not a permanent
relay account, and there are no per-user accounts to manage. The secret itself
never leaves the server.

```bash
# .env
TURN_DOMAIN=turn.example.com
STUN_URL=stun:turn.example.com:3478
TURN_URL=turn:turn.example.com:3478
TURN_SECRET=$(openssl rand -hex 32)
TURN_EXTERNAL_IP=203.0.113.10        # or <public>/<private> behind NAT

docker compose --profile turn up -d
```

The startup log states what browsers are being offered — `offering TURN … to
clients` — so a missing relay is visible before a user reports it rather than
after.

#### Proving it actually relays

This is the part usually skipped, and it is why broken TURN goes unnoticed for
months: as long as a direct path exists, the relay is never used, so a working
call proves nothing. Open the app with `?relay=1`:

```
https://call.example.com/r/standup?relay=1
```

That sets `iceTransportPolicy: "relay"` in the browser, which refuses every
direct candidate. If the call still connects, the relay works. If it does not,
TURN is broken — and you have found out on your own terms rather than through
the one participant whose office blocks UDP.

Both sides do not need the flag; one is enough to force traffic through the relay
in that direction.

#### Knowing whether anyone actually needs it

`?relay=1` answers "can the relay work". It does not answer "is it working for
real users", and the connection log alone cannot either — a participant that
connected directly and one that was relayed both read as `connection connected`.
So every participant's chosen route is logged as soon as ICE settles, and again
if it changes mid-call:

```
room "standup": 3f2a…: media direct  (remote srflx 203.0.113.7:51957)
room "standup": 9b41…: media relayed (remote relay 198.51.100.4:49164)
```

```bash
docker logs webrtc-sfu | grep -c "media relayed"   # how many needed the relay
docker logs webrtc-sfu | grep -c "media direct"
```

Two things this catches that nothing else does: a relay that has quietly stopped
working (the relayed count drops to zero and stays there), and a deployment where
the relay is carrying everyone — which means direct connectivity is broken and
every call is paying for a detour it should not need.

TLS for TURN (`turns:` on 5349) is not wired up — it needs certificates coturn can
read, which Traefik's ACME storage does not expose directly. Plain 3478 over UDP
and TCP covers everything except networks that inspect or block non-TLS traffic on
those ports.

## Testing

```bash
go test .
```

The tests drive the SFU with pion peers acting as browsers and assert that RTP actually crosses
between them, including the three-participant case and the teardown when someone leaves.

Most of them build the SFU with an ephemeral media port and no address mapping, which is convenient
and nothing like the deployment. `TestDeployedConfigurationExchangesMedia` covers the real thing —
one shared UDP mux plus 1:1 NAT — because a fault reachable only through that combination sails past
every other test and then fails every call in production. That is not hypothetical: it is exactly
what the loopback candidate bug did.

## Design

**The server is always the offerer.** This is the load-bearing decision: renegotiation is what makes
participants joining and leaving mid-call possible, and having a single offerer means offer glare
cannot happen. Clients only ever answer.

Each participant gets one peer connection with two recvonly transceivers, which is what the browser
attaches its microphone and camera to when it answers. Incoming tracks are copied into
`TrackLocalStaticRTP`s that other participants subscribe to.

`Room.signal()` reconciles every participant's senders against the room's track list and re-offers
the ones that changed. A peer that is mid-negotiation cannot be offered to, so it backs off and
retries rather than clobbering the in-flight exchange.

Two things are easy to get wrong and are worth not undoing:

- **Header extensions are stripped when forwarding** (`room.go`). Extension IDs are negotiated per
  m-line, so the publisher's IDs mean something different to each subscriber. Forwarding them makes
  receivers misread descriptors and never assemble a decodable frame — packets arrive, nothing
  decodes.
- **Loopback stays out of the UDP mux whenever a public address is mapped**
  (`sfu.go`). The mux binds a socket per interface, and 1:1 NAT rewrites every host
  candidate to the same mapped address — so loopback and the real interface collapse
  into one candidate, pion keeps the first, and `lo` enumerates first. The agent then
  listens on the loopback socket while media lands on the other one and is dropped
  without a reply. Signaling looks perfect and every call fails. `TestICEUDPMuxLoopback`
  guards it.
- **Keyframes are requested explicitly.** A subscriber joining mid-stream cannot decode anything
  until a keyframe arrives, and pion does not relay a subscriber's PLI across peer connections. The
  server asks the publisher for one when a subscription is added, and relays PLI/FIR after that.

### Devices and muting

Two client-side decisions reach into the server. A participant that turns its camera off releases the
device rather than blanking it, which stops RTP without ending anything — subscribers would otherwise
sit on the last frame that arrived. So participants report their own state over the `media` event and
the server relays it in the roster. It is a claim, not an observation: forwarded RTP says nothing
about why it stopped, and the server never inspects it.

And a participant that joined without a camera has that m-line negotiated inactive, which
`replaceTrack` cannot revive. The browser attaches a track and sends `renegotiate`; `Room.reoffer`
offers that participant unconditionally, because nothing in the room's own track list changed and
`signal()` would send nothing.

## Layout

| File               | Contents                                                        |
| ------------------ | --------------------------------------------------------------- |
| `main.go`          | Flags, HTTP server, CORS and websocket origin checks.           |
| `sfu.go`           | Shared `webrtc.API`: media engine, interceptors, ICE settings.  |
| `hub.go`           | Room registry and one participant's signaling session.          |
| `room.go`          | Track forwarding and renegotiation.                             |
| `participant.go`   | Per-peer state and teardown.                                    |
| `signal.go`        | Signaling protocol and the websocket wrapper.                   |
