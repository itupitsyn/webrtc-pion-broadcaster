package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"strconv"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/intervalpli"
	"github.com/pion/webrtc/v4"
)

// turnCredentialTTL is how long the credentials handed to a browser stay valid.
// They only need to outlive the ICE gathering at the start of a call.
const turnCredentialTTL = 12 * time.Hour

// Config collects everything the SFU needs to describe itself to the network.
type Config struct {
	// STUNURL is offered to browsers and used by the server's own agent.
	STUNURL string

	// TURNURL and TURNSecret enable relaying for browsers that cannot reach the
	// server directly. The secret is coturn's `static-auth-secret`; it never
	// leaves the server, only the derived short-lived credentials do.
	TURNURL    string
	TURNSecret string

	// NATIP is the address the server advertises in its host candidates. Required
	// whenever the server sits behind NAT — a container, a cloud VM with a mapped
	// address — because pion otherwise offers only the private address.
	NATIP string

	// UDPPort is the single port all media is multiplexed onto. Without it pion
	// picks a fresh ephemeral port per peer connection, which cannot be published
	// from a container.
	UDPPort int
}

// newICEUDPMux binds the media port so every participant in every room shares it.
// One port is what makes the deployment publishable: `-p <port>:<port>/udp` and
// nothing else.
//
// Whether loopback belongs in the mux depends on natIP, and getting this wrong
// breaks the deployment in a way that looks like a network fault. The mux binds
// one socket per interface address, and gathering then rewrites every host
// candidate to the mapped address — so with a mapping, loopback and the real
// interface produce an identical candidate. pion discards the second as a
// duplicate and only ever registers the agent's ufrag with the first, and
// interfaces enumerate with lo first. The surviving registration is then the
// loopback socket, and packets arriving on the real one are dropped without a
// reply: signaling completes, ICE dies, and nothing is logged.
//
// Without a mapping the addresses stay distinct, nothing is deduplicated, and
// both sockets work — which is why local development and the tests never see it.
//
// The same duplicate-collapse applies to a host with several usable interfaces:
// only the first would receive media. In a container there is exactly one.
func newICEUDPMux(port int, natIP string) (*ice.MultiUDPMuxDefault, error) {
	var opts []ice.UDPMuxFromPortOption
	if natIP == "" {
		// Local development and the tests: without a 127.0.0.1 candidate nothing
		// on the same machine can connect.
		opts = append(opts, ice.UDPMuxFromPortWithLoopback())
	}

	return ice.NewMultiUDPMuxFromPort(port, opts...)
}

// SFU holds the shared WebRTC API used to build every peer connection. Building
// the MediaEngine and interceptor registry once and reusing the API is the
// supported pattern; a fresh MediaEngine per connection would re-run codec
// registration on every join.
type SFU struct {
	api *webrtc.API
	cfg Config

	// serverICEServers is what the server's own agent uses. TURN is deliberately
	// absent: the server is the reachable side, so relaying its own traffic would
	// only burn relay bandwidth.
	serverICEServers []webrtc.ICEServer
}

// NewSFU configures the media engine, interceptors and ICE settings.
func NewSFU(cfg Config) (*SFU, error) {
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		return nil, fmt.Errorf("register default codecs: %w", err)
	}

	interceptorRegistry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, interceptorRegistry); err != nil {
		return nil, fmt.Errorf("register default interceptors: %w", err)
	}

	// Ask publishers for a keyframe on a fixed interval. Without this a peer that
	// subscribes mid-stream sees nothing until the encoder happens to emit one.
	intervalPliFactory, err := intervalpli.NewReceiverInterceptor()
	if err != nil {
		return nil, fmt.Errorf("create interval PLI interceptor: %w", err)
	}
	interceptorRegistry.Add(intervalPliFactory)

	settingEngine := webrtc.SettingEngine{}

	if cfg.NATIP != "" {
		settingEngine.SetNAT1To1IPs([]string{cfg.NATIP}, webrtc.ICECandidateTypeHost)
	}

	if cfg.UDPPort > 0 {
		udpMux, err := newICEUDPMux(cfg.UDPPort, cfg.NATIP)
		if err != nil {
			return nil, fmt.Errorf("listen for media on udp/%d: %w", cfg.UDPPort, err)
		}
		settingEngine.SetICEUDPMux(udpMux)
	}

	sfu := &SFU{
		api: webrtc.NewAPI(
			webrtc.WithMediaEngine(mediaEngine),
			webrtc.WithInterceptorRegistry(interceptorRegistry),
			webrtc.WithSettingEngine(settingEngine),
		),
		cfg: cfg,
	}
	if cfg.STUNURL != "" {
		sfu.serverICEServers = []webrtc.ICEServer{{URLs: []string{cfg.STUNURL}}}
	}

	return sfu, nil
}

// ClientICEServers is what a browser is told to use. TURN credentials are minted
// per call and expire, so a leaked welcome frame does not hand out a permanent
// relay account.
func (s *SFU) ClientICEServers() []iceServer {
	// Non-nil on purpose: a nil slice marshals to JSON null, and
	// `new RTCPeerConnection({iceServers: null})` throws in the browser rather
	// than falling back to a default. With nothing configured this must be [].
	servers := []iceServer{}

	if s.cfg.STUNURL != "" {
		servers = append(servers, iceServer{URLs: []string{s.cfg.STUNURL}})
	}

	if s.cfg.TURNURL != "" && s.cfg.TURNSecret != "" {
		username, credential := turnCredentials(s.cfg.TURNSecret, turnCredentialTTL)
		servers = append(servers, iceServer{
			URLs:       []string{s.cfg.TURNURL},
			Username:   username,
			Credential: credential,
		})
	}

	return servers
}

// turnCredentials implements coturn's `use-auth-secret` scheme: the username is
// an expiry timestamp and the password is its HMAC under the shared secret, so
// coturn can validate without storing per-user accounts.
//
// SHA-1 here is coturn's fixed choice for this mechanism, and HMAC-SHA1 is not
// affected by the collision attacks that retired bare SHA-1.
func turnCredentials(secret string, ttl time.Duration) (username, credential string) {
	username = strconv.FormatInt(time.Now().Add(ttl).Unix(), 10)

	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))

	return username, base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// NewPeerConnection builds a peer connection with two recvonly transceivers, one
// for audio and one for video. The server is always the offerer, so these
// transceivers are what the browser attaches its microphone and camera to when
// it answers.
func (s *SFU) NewPeerConnection() (*webrtc.PeerConnection, error) {
	pc, err := s.api.NewPeerConnection(webrtc.Configuration{ICEServers: s.serverICEServers})
	if err != nil {
		return nil, fmt.Errorf("new peer connection: %w", err)
	}

	for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeAudio, webrtc.RTPCodecTypeVideo} {
		if _, err := pc.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionRecvonly,
		}); err != nil {
			pc.Close()
			return nil, fmt.Errorf("add %s transceiver: %w", kind, err)
		}
	}

	return pc, nil
}
