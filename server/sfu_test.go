package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// TestResolvePublicAddress covers the paths that do not need a working resolver:
// an address that is already an IP, an empty one, and a name that cannot resolve.
// The DNS path is deliberately untested — it would assert on whatever the machine
// running the tests happens to resolve.
func TestResolvePublicAddress(t *testing.T) {
	for _, tc := range []struct {
		name    string
		address string
		want    string
		wantErr bool
	}{
		{name: "empty", address: "", want: ""},
		{name: "ipv4 literal", address: "203.0.113.10", want: "203.0.113.10"},
		{name: "ipv6 literal", address: "2001:db8::1", want: "2001:db8::1"},
		// .invalid never resolves; RFC 2606 reserves it for exactly this.
		{name: "unresolvable name", address: "sfu.example.invalid", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolvePublicAddress(tc.address)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("resolvePublicAddress(%q) = %q, want error", tc.address, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolvePublicAddress(%q): %v", tc.address, err)
			}
			if got != tc.want {
				t.Errorf("resolvePublicAddress(%q) = %q, want %q", tc.address, got, tc.want)
			}
		})
	}
}

// TestICEUDPMuxLoopback pins the rule that a 1:1 NAT mapping and a loopback
// listener cannot coexist. With both, gathering collapses them into one candidate
// and registers the agent only with the loopback socket, so media arriving on the
// real interface is dropped without a reply — a deployment that signals correctly
// and then fails every call. See newICEUDPMux.
func TestICEUDPMuxLoopback(t *testing.T) {
	for _, tc := range []struct {
		name         string
		natIP        string
		wantLoopback bool
	}{
		{name: "no mapping keeps loopback", natIP: "", wantLoopback: true},
		{name: "mapping drops loopback", natIP: "203.0.113.10", wantLoopback: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Port 0 gives each interface an ephemeral port; only which addresses
			// are bound matters here.
			mux, err := newICEUDPMux(0, tc.natIP)
			if err != nil {
				t.Fatalf("newICEUDPMux: %v", err)
			}
			t.Cleanup(func() { _ = mux.Close() })

			addresses := mux.GetListenAddresses()
			if len(addresses) == 0 {
				t.Fatal("mux bound no addresses")
			}

			var gotLoopback bool
			for _, address := range addresses {
				udpAddr, ok := address.(*net.UDPAddr)
				if !ok {
					t.Fatalf("listen address is %T, want *net.UDPAddr", address)
				}
				if udpAddr.IP.IsLoopback() {
					gotLoopback = true
				}
			}

			if gotLoopback != tc.wantLoopback {
				t.Errorf("loopback listener present = %v, want %v (addresses: %v)",
					gotLoopback, tc.wantLoopback, addresses)
			}
		})
	}
}

// testServer starts the hub on a loopback listener and returns the ws:// base URL.
func testServer(t *testing.T) string {
	t.Helper()

	gin.SetMode(gin.TestMode)

	// UDPPort 0 keeps the ephemeral-port behaviour, so parallel tests do not
	// fight over one fixed media port.
	sfu, err := NewSFU(Config{})
	if err != nil {
		t.Fatalf("NewSFU: %v", err)
	}

	r := gin.New()
	r.GET("/ws/:room", NewHub(sfu, func(*http.Request) bool { return true }).ServeWS)

	server := httptest.NewServer(r)
	t.Cleanup(server.Close)

	return "ws" + strings.TrimPrefix(server.URL, "http")
}

// testClient stands in for a browser: it publishes an audio and a video track and
// answers whatever the server offers.
type testClient struct {
	id string
	pc *webrtc.PeerConnection
	ws *websocket.Conn

	audio *webrtc.TrackLocalStaticSample
	video *webrtc.TrackLocalStaticSample

	writeMu sync.Mutex

	// Guards everything below.
	mu        sync.Mutex
	remoteSet bool
	pending   []webrtc.ICECandidateInit
	received  map[string]int // "<streamID>/<kind>" -> packets seen
	welcomed  chan struct{}
}

func newTestClient(t *testing.T, baseURL, room string) *testClient {
	t.Helper()

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("client peer connection: %v", err)
	}

	c := &testClient{
		pc:       pc,
		received: make(map[string]int),
		welcomed: make(chan struct{}),
	}

	// Add local media before connecting, the same order the browser client uses:
	// the server offers recvonly transceivers and these attach to them.
	c.audio = c.addTrack(t, webrtc.MimeTypeOpus, "audio")
	c.video = c.addTrack(t, webrtc.MimeTypeVP8, "video")

	c.pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		key := remote.StreamID() + "/" + remote.Kind().String()
		buf := make([]byte, rtpBufferSize)
		for {
			n, _, err := remote.Read(buf)
			if err != nil {
				return
			}
			if n == 0 {
				continue
			}

			c.mu.Lock()
			c.received[key]++
			c.mu.Unlock()
		}
	})

	conn, _, err := websocket.DefaultDialer.Dial(baseURL+"/ws/"+room, nil)
	if err != nil {
		t.Fatalf("dial signaling: %v", err)
	}
	c.ws = conn

	c.pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			return
		}
		c.send(eventCandidate, candidate.ToJSON())
	})

	go c.readLoop(t)

	t.Cleanup(func() {
		c.ws.Close()
		c.pc.Close()
	})

	return c
}

func (c *testClient) addTrack(t *testing.T, mimeType, id string) *webrtc.TrackLocalStaticSample {
	t.Helper()

	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: mimeType}, id, "local",
	)
	if err != nil {
		t.Fatalf("new %s track: %v", id, err)
	}
	if _, err := c.pc.AddTrack(track); err != nil {
		t.Fatalf("add %s track: %v", id, err)
	}

	return track
}

func (c *testClient) send(event string, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}

	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.ws.WriteJSON(message{Event: event, Data: data})
}

func (c *testClient) readLoop(t *testing.T) {
	for {
		var msg message
		if err := c.ws.ReadJSON(&msg); err != nil {
			return
		}

		switch msg.Event {
		case eventWelcome:
			var w welcome
			if err := json.Unmarshal(msg.Data, &w); err != nil {
				return
			}
			c.id = w.ID
			close(c.welcomed)

		case eventOffer:
			var offer webrtc.SessionDescription
			if err := json.Unmarshal(msg.Data, &offer); err != nil {
				return
			}
			if err := c.answer(offer); err != nil {
				t.Logf("client %s: answer: %v", c.id, err)
				return
			}

		case eventCandidate:
			var candidate webrtc.ICECandidateInit
			if err := json.Unmarshal(msg.Data, &candidate); err != nil {
				return
			}
			c.mu.Lock()
			if !c.remoteSet {
				c.pending = append(c.pending, candidate)
				c.mu.Unlock()
				continue
			}
			c.mu.Unlock()
			_ = c.pc.AddICECandidate(candidate)
		}
	}
}

func (c *testClient) answer(offer webrtc.SessionDescription) error {
	if err := c.pc.SetRemoteDescription(offer); err != nil {
		return err
	}

	c.mu.Lock()
	pending := c.pending
	c.pending = nil
	c.remoteSet = true
	c.mu.Unlock()

	for _, candidate := range pending {
		_ = c.pc.AddICECandidate(candidate)
	}

	answer, err := c.pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	if err := c.pc.SetLocalDescription(answer); err != nil {
		return err
	}

	c.send(eventAnswer, answer)

	return nil
}

// publish keeps writing samples until the test ends, so there is media to forward.
func (c *testClient) publish(t *testing.T) {
	t.Helper()

	done := make(chan struct{})
	t.Cleanup(func() { close(done) })

	go func() {
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()

		sample := media.Sample{Data: make([]byte, 200), Duration: 20 * time.Millisecond}
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				_ = c.audio.WriteSample(sample)
				_ = c.video.WriteSample(sample)
			}
		}
	}()
}

func (c *testClient) packets(key string) int {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.received[key]
}

// waitFor polls until cond holds or the deadline passes.
func waitFor(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}

	t.Fatalf("timed out waiting for %s", what)
}

// TestTurnCredentials checks the shape coturn's use-auth-secret mode expects:
// the username is the expiry timestamp and the password is its HMAC-SHA1.
func TestTurnCredentials(t *testing.T) {
	const secret = "shared-secret"

	username, credential := turnCredentials(secret, time.Hour)

	expiry, err := strconv.ParseInt(username, 10, 64)
	if err != nil {
		t.Fatalf("username %q is not a unix timestamp: %v", username, err)
	}
	if remaining := time.Until(time.Unix(expiry, 0)); remaining <= 0 {
		t.Errorf("credential expires in %v, want a future time", remaining)
	}

	raw, err := base64.StdEncoding.DecodeString(credential)
	if err != nil {
		t.Fatalf("credential is not base64: %v", err)
	}
	if len(raw) != sha1.Size {
		t.Errorf("credential is %d bytes, want %d for HMAC-SHA1", len(raw), sha1.Size)
	}

	// A different secret must not produce the same password for the same user.
	other := hmac.New(sha1.New, []byte("another-secret"))
	other.Write([]byte(username))
	if credential == base64.StdEncoding.EncodeToString(other.Sum(nil)) {
		t.Error("credential does not depend on the secret")
	}
}

func TestClientICEServers(t *testing.T) {
	cases := []struct {
		name      string
		cfg       Config
		wantURLs  []string
		wantCreds bool
	}{
		{"stun only", Config{STUNURL: "stun:example:3478"}, []string{"stun:example:3478"}, false},
		{
			"stun and turn",
			Config{STUNURL: "stun:example:3478", TURNURL: "turn:example:3478", TURNSecret: "s"},
			[]string{"stun:example:3478", "turn:example:3478"},
			true,
		},
		// A TURN URL without a secret cannot be authenticated against, so it is
		// dropped rather than handed to browsers as a broken entry.
		{"turn without secret", Config{TURNURL: "turn:example:3478"}, nil, false},
		{"nothing configured", Config{}, nil, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sfu, err := NewSFU(tc.cfg)
			if err != nil {
				t.Fatalf("NewSFU: %v", err)
			}

			servers := sfu.ClientICEServers()

			// Must never be nil: that marshals to JSON null and makes the browser
			// throw when constructing its peer connection.
			if servers == nil {
				t.Fatal("ClientICEServers returned nil, want an empty slice")
			}
			if encoded, err := json.Marshal(servers); err != nil {
				t.Fatalf("marshal: %v", err)
			} else if string(encoded) == "null" {
				t.Error("ICE servers marshalled to null, want []")
			}

			var gotURLs []string
			for _, server := range servers {
				gotURLs = append(gotURLs, server.URLs...)
			}
			if strings.Join(gotURLs, ",") != strings.Join(tc.wantURLs, ",") {
				t.Errorf("urls = %v, want %v", gotURLs, tc.wantURLs)
			}

			for _, server := range servers {
				isTURN := strings.HasPrefix(server.URLs[0], "turn")
				hasCreds := server.Username != "" && server.Credential != ""

				if isTURN && !hasCreds {
					t.Errorf("TURN server %v has no credentials", server.URLs)
				}
				if !isTURN && hasCreds {
					t.Errorf("STUN server %v should not carry credentials", server.URLs)
				}
			}

			if tc.wantCreds && len(servers) < 2 {
				t.Errorf("expected a TURN entry, got %d servers", len(servers))
			}
		})
	}
}

func TestSanitizeName(t *testing.T) {
	long := strings.Repeat("я", maxNameLength+10)

	cases := []struct {
		name string
		in   string
		want string
	}{
		{"trims surrounding space", "  Alex  ", "Alex"},
		{"keeps inner space", "Alex B", "Alex B"},
		{"keeps non-ascii", "Вася Пупкин", "Вася Пупкин"},
		{"strips control characters", "Alex\r\n B", "Alex B"},
		{"caps length in runes, not bytes", long, strings.Repeat("я", maxNameLength)},
		{"empty stays empty", "   ", ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := sanitizeName(tc.in)
			if got != tc.want {
				t.Errorf("sanitizeName(%q) = %q, want %q", tc.in, got, tc.want)
			}
			if utf8.RuneCountInString(got) > maxNameLength {
				t.Errorf("sanitizeName(%q) returned %d runes, over the %d cap", tc.in, utf8.RuneCountInString(got), maxNameLength)
			}
		})
	}
}

// TestTwoParticipantsExchangeMedia is the case the old HTTP handler could never
// support: both peers publish and both receive, which requires the server to
// renegotiate an already-connected peer when the second one joins.
func TestTwoParticipantsExchangeMedia(t *testing.T) {
	baseURL := testServer(t)

	alice := newTestClient(t, baseURL, "testroom")
	<-alice.welcomed
	alice.publish(t)

	// Join second so the server has to re-offer to an established connection.
	bob := newTestClient(t, baseURL, "testroom")
	<-bob.welcomed
	bob.publish(t)

	waitFor(t, 20*time.Second, "alice to receive bob's audio and video", func() bool {
		return alice.packets(bob.id+"/audio") > 0 && alice.packets(bob.id+"/video") > 0
	})
	waitFor(t, 20*time.Second, "bob to receive alice's audio and video", func() bool {
		return bob.packets(alice.id+"/audio") > 0 && bob.packets(alice.id+"/video") > 0
	})

	// Nobody should ever be sent their own media back.
	if got := alice.packets(alice.id + "/audio"); got != 0 {
		t.Errorf("alice received %d packets of her own audio, want 0", got)
	}
	if got := bob.packets(bob.id + "/video"); got != 0 {
		t.Errorf("bob received %d packets of his own video, want 0", got)
	}
}

// TestThirdParticipantJoins covers renegotiating two established peers at once.
func TestThirdParticipantJoins(t *testing.T) {
	baseURL := testServer(t)

	clients := make([]*testClient, 0, 3)
	for range 3 {
		c := newTestClient(t, baseURL, "trio")
		<-c.welcomed
		c.publish(t)
		clients = append(clients, c)
	}

	for i, c := range clients {
		for j, other := range clients {
			if i == j {
				continue
			}

			key := other.id + "/video"
			waitFor(t, 30*time.Second, "client "+c.id+" to receive "+key, func() bool {
				return c.packets(key) > 0
			})
		}
	}
}

// TestParticipantLeaveRemovesTracks checks the teardown path: when a publisher
// disconnects its tracks must be removed from the remaining peers.
func TestParticipantLeaveRemovesTracks(t *testing.T) {
	baseURL := testServer(t)

	alice := newTestClient(t, baseURL, "leaveroom")
	<-alice.welcomed
	alice.publish(t)

	bob := newTestClient(t, baseURL, "leaveroom")
	<-bob.welcomed
	bob.publish(t)

	waitFor(t, 20*time.Second, "alice to receive bob's video", func() bool {
		return alice.packets(bob.id+"/video") > 0
	})

	bob.ws.Close()
	bob.pc.Close()

	// Bob's media must stop reaching alice, while alice's own connection survives.
	key := bob.id + "/video"
	waitFor(t, 20*time.Second, "bob's media to stop reaching alice", func() bool {
		before := alice.packets(key)
		time.Sleep(500 * time.Millisecond)

		return alice.packets(key) == before
	})

	if state := alice.pc.ConnectionState(); state != webrtc.PeerConnectionStateConnected {
		t.Errorf("alice's connection is %s after bob left, want connected", state)
	}
}
