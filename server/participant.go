package main

import (
	"fmt"
	"log"
	"sync"

	"github.com/pion/webrtc/v4"
)

// participant is one browser attached to a room: its peer connection plus the
// signaling channel used to negotiate with it.
type participant struct {
	id string
	pc *webrtc.PeerConnection
	ws *wsConn

	// The browser starts trickling candidates as soon as it has our offer, which
	// can be before its answer reaches us. pion rejects AddICECandidate until the
	// remote description is set, so hold them until it is.
	candidatesMu sync.Mutex
	remoteSet    bool
	pending      []webrtc.ICECandidateInit

	// Set from the read loop, read whenever the roster is broadcast.
	stateMu sync.Mutex
	name    string
	media   mediaState

	closeOnce sync.Once
	done      chan struct{}
}

func (p *participant) setName(name string) {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()

	p.name = name
}

// setMedia records what the participant says its microphone and camera are
// doing. Nothing on the server depends on it; it exists to be relayed.
func (p *participant) setMedia(state mediaState) {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()

	p.media = state
}

// info is this participant's roster entry. Name is empty until it has
// identified itself, and the browser falls back to a generated label.
func (p *participant) info() peerInfo {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()

	return peerInfo{ID: p.id, Name: p.name, Audio: p.media.Audio, Video: p.media.Video}
}

func newParticipant(id string, pc *webrtc.PeerConnection, ws *wsConn) *participant {
	return &participant{
		id: id,
		pc: pc,
		ws: ws,
		// Assumed sending until told otherwise: a participant is only ever
		// announced to the room once it has media to announce.
		media: mediaState{Audio: true, Video: true},
		done:  make(chan struct{}),
	}
}

// setRemoteDescription applies the browser's answer and flushes any candidates
// that arrived ahead of it.
func (p *participant) setRemoteDescription(desc webrtc.SessionDescription) error {
	if err := p.pc.SetRemoteDescription(desc); err != nil {
		return fmt.Errorf("set remote description: %w", err)
	}

	p.candidatesMu.Lock()
	pending := p.pending
	p.pending = nil
	p.remoteSet = true
	p.candidatesMu.Unlock()

	for _, candidate := range pending {
		if err := p.pc.AddICECandidate(candidate); err != nil {
			return fmt.Errorf("add buffered candidate: %w", err)
		}
	}

	return nil
}

// addRemoteCandidate adds a trickled candidate, buffering it if the answer has
// not been applied yet.
func (p *participant) addRemoteCandidate(candidate webrtc.ICECandidateInit) error {
	p.candidatesMu.Lock()
	if !p.remoteSet {
		p.pending = append(p.pending, candidate)
		p.candidatesMu.Unlock()
		return nil
	}
	p.candidatesMu.Unlock()

	if err := p.pc.AddICECandidate(candidate); err != nil {
		return fmt.Errorf("add candidate: %w", err)
	}

	return nil
}

// close tears down the peer connection and the socket. It is idempotent, which
// matters because it is reached from the read loop, from OnConnectionStateChange
// and from the room's signaling loop. Closing the socket is also what unblocks a
// read loop parked in ReadJSON.
func (p *participant) close() {
	p.closeOnce.Do(func() {
		close(p.done)

		if err := p.pc.Close(); err != nil {
			log.Printf("%s: close peer connection: %v", p.id, err)
		}
		if err := p.ws.close(); err != nil {
			log.Printf("%s: close websocket: %v", p.id, err)
		}
	})
}
