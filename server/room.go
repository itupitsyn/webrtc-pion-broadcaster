package main

import (
	"errors"
	"fmt"
	"io"
	"log"
	"sync"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const (
	// rtpBufferSize must be at least the MTU of the incoming packets. A smaller
	// buffer makes TrackRemote.Read fail with io.ErrShortBuffer and silently
	// truncate media.
	rtpBufferSize = 1500

	// A peer that is already mid-negotiation cannot be offered to, so signal()
	// backs off and retries instead of dropping the update on the floor.
	signalAttempts = 25
	signalBackoff  = 100 * time.Millisecond
)

// publishedTrack is one media track forwarded on behalf of the participant that
// published it. owner lets us avoid echoing a participant's own media back.
type publishedTrack struct {
	owner string
	local *webrtc.TrackLocalStaticRTP

	// requestKeyFrame asks the publisher for a fresh keyframe. A subscriber that
	// joins mid-stream cannot decode anything until one arrives, and pion does not
	// relay a subscriber's PLI across peer connections by itself. nil for audio.
	requestKeyFrame func()
}

// Room is an SFU for a single call: every participant publishes audio and video
// and subscribes to everyone else's.
//
// participants and tracks are guarded by mu. Methods that mutate either one
// release mu before calling signal(), which takes it again.
type Room struct {
	name string

	mu           sync.Mutex
	participants map[string]*participant
	tracks       map[string]publishedTrack
}

func newRoom(name string) *Room {
	return &Room{
		name:         name,
		participants: make(map[string]*participant),
		tracks:       make(map[string]publishedTrack),
	}
}

// join registers p and renegotiates every peer so the newcomer starts receiving
// the tracks already in flight.
func (r *Room) join(p *participant) {
	r.mu.Lock()
	r.participants[p.id] = p
	count := len(r.participants)
	r.mu.Unlock()

	log.Printf("room %q: %s joined (%d in room)", r.name, p.id, count)

	// Async so the caller can get to its read loop and answer our offer; a
	// signal() that is busy retrying for other peers must not delay that.
	go r.signal()
	go r.broadcastRoster()
}

// broadcastRoster tells everyone who else is in the room, and what each of them
// says its microphone and camera are doing. It runs on every join and leave, and
// again whenever someone identifies itself or mutes something, since all of that
// arrives after the connection is already up.
func (r *Room) broadcastRoster() {
	r.mu.Lock()
	roster := make([]peerInfo, 0, len(r.participants))
	targets := make([]*participant, 0, len(r.participants))
	for _, p := range r.participants {
		roster = append(roster, p.info())
		targets = append(targets, p)
	}
	r.mu.Unlock()

	// Sent outside the lock: a participant that stopped reading must not hold up
	// the room while its write times out.
	for _, p := range targets {
		if err := p.ws.write(eventPeers, roster); err != nil {
			log.Printf("room %q: %s: %v", r.name, p.id, err)
		}
	}
}

// leave removes p and renegotiates the peers that were subscribed to it.
func (r *Room) leave(p *participant) {
	r.mu.Lock()
	delete(r.participants, p.id)
	// Drop everything p was publishing. The forward loops exit on their own, but
	// doing it here means the renegotiation below already sees the final state.
	for id, track := range r.tracks {
		if track.owner == p.id {
			delete(r.tracks, id)
		}
	}
	count := len(r.participants)
	r.mu.Unlock()

	log.Printf("room %q: %s left (%d in room)", r.name, p.id, count)
	if count > 0 {
		r.signal()
		go r.broadcastRoster()
	}
}

// forward copies a participant's incoming track into a local track that other
// peers can subscribe to, and pumps RTP until the publisher goes away.
//
// The read loop starts immediately rather than waiting for a subscriber, so
// nothing accumulates in pion's internal buffers while the room is still empty.
func (r *Room) forward(p *participant, remote *webrtc.TrackRemote) {
	// Namespaced so two participants publishing the same track ID cannot collide.
	// The stream ID is the participant ID, which is how the browser groups a
	// participant's audio and video into one MediaStream.
	id := p.id + "/" + remote.ID()

	local, err := webrtc.NewTrackLocalStaticRTP(remote.Codec().RTPCodecCapability, id, p.id)
	if err != nil {
		log.Printf("room %q: %s: create local track: %v", r.name, p.id, err)
		return
	}

	var requestKeyFrame func()
	if remote.Kind() == webrtc.RTPCodecTypeVideo {
		ssrc := uint32(remote.SSRC())
		requestKeyFrame = func() {
			if err := p.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: ssrc}}); err != nil {
				log.Printf("room %q: %s: request keyframe: %v", r.name, p.id, err)
			}
		}
	}

	r.addTrack(id, publishedTrack{owner: p.id, local: local, requestKeyFrame: requestKeyFrame})
	defer r.removeTrack(id)

	log.Printf("room %q: %s publishing %s (%s)", r.name, p.id, remote.Kind(), remote.Codec().MimeType)

	buf := make([]byte, rtpBufferSize)
	packet := &rtp.Packet{}

	for {
		n, _, err := remote.Read(buf)
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrClosedPipe) {
				log.Printf("room %q: %s: read %s: %v", r.name, p.id, remote.Kind(), err)
			}
			return
		}

		if err := packet.Unmarshal(buf[:n]); err != nil {
			log.Printf("room %q: %s: unmarshal %s packet: %v", r.name, p.id, remote.Kind(), err)
			return
		}

		// Header extension IDs are negotiated per m-line, so the publisher's IDs
		// mean something different to every subscriber. Forwarding them makes the
		// receiver misread descriptors and never assemble a decodable frame —
		// packets arrive, nothing decodes. Subscribers do not need them.
		packet.Header.Extension = false
		packet.Header.Extensions = nil

		if err := local.WriteRTP(packet); err != nil && !errors.Is(err, io.ErrClosedPipe) {
			log.Printf("room %q: %s: forward %s: %v", r.name, p.id, remote.Kind(), err)
			return
		}
	}
}

// addTrack publishes a track to the room. Renegotiation runs in its own goroutine
// on purpose: the caller is forward(), which must reach its read loop immediately.
// Blocking here for the length of a retrying signal() would let RTP pile up in
// pion's buffers exactly the way waiting for a subscriber used to.
func (r *Room) addTrack(id string, track publishedTrack) {
	r.mu.Lock()
	r.tracks[id] = track
	r.mu.Unlock()

	go r.signal()
}

func (r *Room) removeTrack(id string) {
	r.mu.Lock()
	delete(r.tracks, id)
	remaining := len(r.participants)
	r.mu.Unlock()

	if remaining > 0 {
		r.signal()
	}
}

// signal reconciles every participant's outbound tracks with the room's track
// list and sends a fresh offer to the ones whose track set changed. Safe to call
// from any goroutine.
func (r *Room) signal() {
	r.mu.Lock()
	defer r.mu.Unlock()

	for range signalAttempts {
		if r.syncLocked() {
			return
		}

		// Someone is mid-negotiation. Release the lock so their answer can be
		// applied, then look again.
		r.mu.Unlock()
		time.Sleep(signalBackoff)
		r.mu.Lock()
	}

	log.Printf("room %q: renegotiation did not settle after %d attempts", r.name, signalAttempts)
}

// reoffer sends p a fresh offer whether or not its track set changed.
//
// A browser turning its camera back on has to attach a track to an m-line that
// was negotiated inactive, and replaceTrack cannot revive one — that needs an
// offer, and the server is the only side that offers. Nothing in the room's own
// state changed, so signal() would look at p, see the same senders as before,
// and send nothing.
func (r *Room) reoffer(p *participant) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for range signalAttempts {
		if p.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
			return
		}

		if p.pc.SignalingState() == webrtc.SignalingStateStable {
			if err := r.offerLocked(p); err != nil {
				log.Printf("room %q: %s: reoffer: %v", r.name, p.id, err)
			}

			return
		}

		// Mid-negotiation. That offer may well be the one this request is chasing,
		// but it was built before the browser attached its track, so wait it out
		// rather than assume.
		r.mu.Unlock()
		time.Sleep(signalBackoff)
		r.mu.Lock()
	}

	log.Printf("room %q: %s: reoffer did not settle after %d attempts", r.name, p.id, signalAttempts)
}

// syncLocked brings every participant up to date and reports whether the room is
// fully in sync. It must be called with mu held.
func (r *Room) syncLocked() bool {
	settled := true

	for id, p := range r.participants {
		if p.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
			delete(r.participants, id)
			continue
		}

		// Offering now would clobber an in-flight negotiation; retry instead.
		if p.pc.SignalingState() != webrtc.SignalingStateStable {
			settled = false
			continue
		}

		changed, err := r.syncSendersLocked(p)
		if err != nil {
			log.Printf("room %q: %s: %v", r.name, id, err)
			delete(r.participants, id)
			p.close()
			continue
		}

		// A peer with no local description has never negotiated, so it needs an
		// offer even when there is nothing to forward yet — that first exchange is
		// what brings its connection up and lets it start publishing.
		if !changed && p.pc.LocalDescription() != nil {
			continue
		}

		if err := r.offerLocked(p); err != nil {
			// Nearly always a participant that went away mid-renegotiation; the
			// room simply drops it.
			log.Printf("room %q: dropping %s: %v", r.name, id, err)
			delete(r.participants, id)
			p.close()
		}
	}

	return settled
}

// syncSendersLocked adds senders for tracks p is missing and removes senders whose
// publisher has gone. It reports whether anything changed, i.e. whether p needs a
// new offer. It must be called with mu held.
func (r *Room) syncSendersLocked(p *participant) (changed bool, err error) {
	subscribed := make(map[string]struct{}, len(r.tracks))

	for _, sender := range p.pc.GetSenders() {
		track := sender.Track()
		if track == nil {
			continue
		}

		if _, live := r.tracks[track.ID()]; live {
			subscribed[track.ID()] = struct{}{}
			continue
		}

		// Publisher is gone: tear the subscription down.
		if err := p.pc.RemoveTrack(sender); err != nil {
			return changed, fmt.Errorf("remove track %s: %w", track.ID(), err)
		}
		changed = true
	}

	for id, track := range r.tracks {
		if track.owner == p.id {
			continue // never send a participant its own media back
		}
		if _, ok := subscribed[id]; ok {
			continue
		}

		sender, err := p.pc.AddTrack(track.local)
		if err != nil {
			return changed, fmt.Errorf("add track %s: %w", id, err)
		}
		go relayFeedback(sender, track.requestKeyFrame)

		// Nothing this subscriber receives is decodable until a keyframe arrives,
		// so ask for one now rather than waiting up to a full PLI interval.
		if track.requestKeyFrame != nil {
			go track.requestKeyFrame()
		}

		changed = true
	}

	return changed, nil
}

// relayFeedback consumes the RTCP a subscriber sends back and turns its keyframe
// requests into keyframe requests on the publisher. The read itself also matters:
// unread RTCP never reaches pion's interceptors. Returns when the sender closes.
func relayFeedback(sender *webrtc.RTPSender, requestKeyFrame func()) {
	for {
		packets, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}

		if requestKeyFrame == nil {
			continue
		}

		for _, packet := range packets {
			switch packet.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				requestKeyFrame()
			}
		}
	}
}

// offerLocked creates an offer for p and sends it over the signaling channel. The
// server is always the offerer, which is what makes adding and removing tracks
// mid-call possible at all — and it means offer glare cannot happen.
func (r *Room) offerLocked(p *participant) error {
	offer, err := p.pc.CreateOffer(nil)
	if err != nil {
		return fmt.Errorf("create offer: %w", err)
	}

	if err := p.pc.SetLocalDescription(offer); err != nil {
		return fmt.Errorf("set local description: %w", err)
	}

	// Candidates are trickled separately via OnICECandidate, so we send the
	// offer immediately instead of waiting for gathering to complete.
	if err := p.ws.write(eventOffer, offer); err != nil {
		return fmt.Errorf("send offer: %w", err)
	}

	return nil
}
