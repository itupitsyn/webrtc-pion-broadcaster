package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/gorilla/websocket"
)

// Signaling events. The server is always the offerer: it sends offer, the browser
// replies with answer, and both sides trickle candidate as they gather.
const (
	eventWelcome   = "welcome"
	eventOffer     = "offer"
	eventAnswer    = "answer"
	eventCandidate = "candidate"
	eventError     = "error"

	// identify carries the display name a participant chose; peers carries the
	// resulting roster back to everyone in the room.
	eventIdentify = "identify"
	eventPeers    = "peers"

	// media is a participant reporting whether its microphone and camera are
	// currently sending, relayed to the room through the roster.
	eventMedia = "media"

	// renegotiate is a participant asking for a fresh offer. Needed after the
	// browser attaches a track to an m-line that was negotiated inactive: only
	// the server offers, so the browser cannot revive it by itself.
	eventRenegotiate = "renegotiate"
)

// maxNameLength bounds a display name so one participant cannot wreck everyone
// else's layout.
const maxNameLength = 32

const (
	writeTimeout   = 10 * time.Second
	pongTimeout    = 60 * time.Second
	pingInterval   = 25 * time.Second
	maxMessageSize = 64 * 1024 // an SDP is a few KB at most
)

// message is the envelope for every frame in both directions.
type message struct {
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data,omitempty"`
}

// welcome tells the browser who it is and which ICE servers to use, so the client
// does not have to hardcode either.
type welcome struct {
	ID         string      `json:"id"`
	Room       string      `json:"room"`
	ICEServers []iceServer `json:"iceServers"`
}

// identify is what a participant sends to announce its display name.
type identify struct {
	Name string `json:"name"`
}

// mediaState is what a participant reports about its own devices. Both default
// to true, so a participant that never reports is taken to be sending whatever
// it negotiated.
//
// This is a claim, not an observation: the server forwards RTP without looking
// at it, and a stopped camera is indistinguishable from a stalled one down at
// that level. It exists so the other browsers can show a placeholder instead of
// the last frame that happened to arrive.
type mediaState struct {
	Audio bool `json:"audio"`
	Video bool `json:"video"`
}

// peerInfo is one entry of the roster. Name is empty until that participant has
// identified itself, and the browser falls back to a generated label.
type peerInfo struct {
	ID    string `json:"id"`
	Name  string `json:"name,omitempty"`
	Audio bool   `json:"audio"`
	Video bool   `json:"video"`
}

// sanitizeName trims a display name to something safe to render and log. React
// escapes the text on the way out, so this is about length and control
// characters rather than markup.
func sanitizeName(raw string) string {
	name := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}

		return r
	}, raw)

	name = strings.TrimSpace(name)

	if runes := []rune(name); len(runes) > maxNameLength {
		name = strings.TrimSpace(string(runes[:maxNameLength]))
	}

	return name
}

// iceServer mirrors the browser's RTCIceServer. webrtc.ICEServer is not used
// directly because it marshals extra fields that are not part of the JS dictionary.
type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// wsConn serializes writes to a websocket. gorilla permits only one concurrent
// writer, and here the room's signaling loop, the ICE gathering callback and the
// ping ticker all write from different goroutines.
type wsConn struct {
	conn *websocket.Conn

	mu     sync.Mutex
	closed bool
}

func newWSConn(conn *websocket.Conn) *wsConn {
	conn.SetReadLimit(maxMessageSize)

	return &wsConn{conn: conn}
}

// write marshals payload and sends it as a single frame. The deadline matters:
// the room holds its lock while offering, so a peer that stopped reading must not
// be able to stall the whole call.
func (c *wsConn) write(event string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal %s payload: %w", event, err)
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.closed {
		return fmt.Errorf("write %s: connection closed", event)
	}

	if err := c.conn.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		return fmt.Errorf("set write deadline: %w", err)
	}

	if err := c.conn.WriteJSON(message{Event: event, Data: data}); err != nil {
		return fmt.Errorf("write %s: %w", event, err)
	}

	return nil
}

// writeError reports a problem to the browser. Failures are ignored on purpose:
// the caller is already on an error path and the connection is about to go away.
func (c *wsConn) writeError(reason string) {
	_ = c.write(eventError, reason)
}

func (c *wsConn) ping() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.closed {
		return fmt.Errorf("ping: connection closed")
	}

	return c.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeTimeout))
}

func (c *wsConn) close() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.closed {
		return nil
	}
	c.closed = true

	return c.conn.Close()
}
