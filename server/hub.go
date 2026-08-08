package main

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

// Room names end up in log lines and in client URLs, so keep them boring.
var roomNamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// roomEntry refcounts a room so it is torn down exactly when the last participant
// goes. A plain "delete when empty" check would race with a participant that has
// taken the room but not yet joined it.
type roomEntry struct {
	room *Room
	refs int
}

// Hub owns the set of live rooms and accepts signaling connections.
type Hub struct {
	sfu      *SFU
	upgrader websocket.Upgrader

	mu    sync.Mutex
	rooms map[string]*roomEntry
}

func NewHub(sfu *SFU, allowOrigin func(*http.Request) bool) *Hub {
	return &Hub{
		sfu: sfu,
		upgrader: websocket.Upgrader{
			CheckOrigin: allowOrigin,
		},
		rooms: make(map[string]*roomEntry),
	}
}

// acquire returns the named room, creating it if needed, and takes a reference.
// Every acquire must be paired with a release.
func (h *Hub) acquire(name string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()

	entry, ok := h.rooms[name]
	if !ok {
		entry = &roomEntry{room: newRoom(name)}
		h.rooms[name] = entry
	}
	entry.refs++

	return entry.room
}

func (h *Hub) release(name string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	entry, ok := h.rooms[name]
	if !ok {
		return
	}

	entry.refs--
	if entry.refs <= 0 {
		delete(h.rooms, name)
		log.Printf("room %q: closed", name)
	}
}

// ServeWS upgrades the request and drives one participant's signaling session for
// as long as the socket lives.
func (h *Hub) ServeWS(c *gin.Context) {
	name := c.Param("room")
	if !roomNamePattern.MatchString(name) {
		c.String(http.StatusBadRequest, "room name must be 1-64 characters of A-Z, a-z, 0-9, _ or -")
		return
	}

	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		// Upgrade has already written a response.
		log.Printf("room %q: websocket upgrade: %v", name, err)
		return
	}
	ws := newWSConn(conn)

	pc, err := h.sfu.NewPeerConnection()
	if err != nil {
		log.Printf("room %q: %v", name, err)
		ws.writeError("could not create peer connection")
		ws.close()
		return
	}

	p := newParticipant(uuid.NewString(), pc, ws)
	room := h.acquire(name)

	defer func() {
		p.close()
		room.leave(p)
		h.release(name)
	}()

	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			return // gathering finished
		}
		if err := ws.write(eventCandidate, candidate.ToJSON()); err != nil {
			log.Printf("room %q: %s: %v", name, p.id, err)
		}
	})

	// How a participant's media actually reaches us is otherwise invisible: the
	// log says connected either way, so a TURN server carrying half the calls and
	// one that quietly stopped working look identical. Fires again if the route
	// changes mid-call.
	if ice := pc.SCTP().Transport().ICETransport(); ice != nil {
		ice.OnSelectedCandidatePairChange(func(pair *webrtc.ICECandidatePair) {
			if pair == nil || pair.Local == nil || pair.Remote == nil {
				return
			}

			route := "direct"
			if pair.Local.Typ == webrtc.ICECandidateTypeRelay || pair.Remote.Typ == webrtc.ICECandidateTypeRelay {
				route = "relayed"
			}

			log.Printf("room %q: %s: media %s (remote %s %s:%d)",
				name, p.id, route, pair.Remote.Typ, pair.Remote.Address, pair.Remote.Port)
		})
	}

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("room %q: %s: connection %s", name, p.id, state)

		switch state {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			// Closing the socket unblocks readLoop, which runs the deferred cleanup.
			p.close()
		}
	})

	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		room.forward(p, remote)
	})

	if err := ws.write(eventWelcome, welcome{
		ID:         p.id,
		Room:       name,
		ICEServers: h.sfu.ClientICEServers(),
	}); err != nil {
		log.Printf("room %q: %s: %v", name, p.id, err)
		return
	}

	room.join(p)

	go h.keepalive(p)
	h.readLoop(room, p)
}

// keepalive pings the browser so a half-open connection is noticed instead of
// holding a peer connection and its tracks open forever.
func (h *Hub) keepalive(p *participant) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-p.done:
			return
		case <-ticker.C:
			if err := p.ws.ping(); err != nil {
				return
			}
		}
	}
}

// readLoop handles answers and trickled candidates until the socket closes.
func (h *Hub) readLoop(room *Room, p *participant) {
	conn := p.ws.conn

	if err := conn.SetReadDeadline(time.Now().Add(pongTimeout)); err != nil {
		log.Printf("room %q: %s: set read deadline: %v", room.name, p.id, err)
		return
	}
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongTimeout))
	})

	for {
		var msg message
		if err := conn.ReadJSON(&msg); err != nil {
			// A participant closing a tab produces any of these, including a bare
			// 1005/1006 with no close frame. None of them mean something is wrong.
			if !websocket.IsCloseError(err,
				websocket.CloseNormalClosure,
				websocket.CloseGoingAway,
				websocket.CloseNoStatusReceived,
				websocket.CloseAbnormalClosure,
			) {
				log.Printf("room %q: %s: read: %v", room.name, p.id, err)
			}
			return
		}

		switch msg.Event {
		case eventAnswer:
			var answer webrtc.SessionDescription
			if err := json.Unmarshal(msg.Data, &answer); err != nil {
				p.ws.writeError("malformed answer")
				continue
			}

			if err := p.setRemoteDescription(answer); err != nil {
				log.Printf("room %q: %s: %v", room.name, p.id, err)
				return
			}

			// The peer is stable again. Re-run the reconciliation in case a track
			// appeared while this negotiation was in flight. Async so this loop
			// stays free to receive the peer's trickled candidates.
			go room.signal()

		case eventIdentify:
			var ident identify
			if err := json.Unmarshal(msg.Data, &ident); err != nil {
				p.ws.writeError("malformed identify")
				continue
			}

			p.setName(sanitizeName(ident.Name))
			go room.broadcastRoster()

		case eventCandidate:
			var candidate webrtc.ICECandidateInit
			if err := json.Unmarshal(msg.Data, &candidate); err != nil {
				p.ws.writeError("malformed candidate")
				continue
			}

			if err := p.addRemoteCandidate(candidate); err != nil {
				log.Printf("room %q: %s: %v", room.name, p.id, err)
			}

		default:
			log.Printf("room %q: %s: unknown event %q", room.name, p.id, msg.Event)
			p.ws.writeError("unknown event " + msg.Event)
		}
	}
}
