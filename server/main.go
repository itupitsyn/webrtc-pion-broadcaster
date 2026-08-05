package main

import (
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func main() {
	port := flag.Int("port", 8080, "http server port")
	stunURL := flag.String("stun", "", "STUN server offered to clients, e.g. stun:turn.example.com:3478")
	turnURL := flag.String("turn", "", "TURN server offered to clients, e.g. turn:call.example.com:3478")
	turnSecret := flag.String("turn-secret", "", "coturn static-auth-secret used to mint short-lived client credentials")
	publicAddress := flag.String("public-address", "", "public IP or hostname to advertise in ICE candidates; required when the server is behind NAT")
	udpPort := flag.Int("udp-port", 7881, "single UDP port all media is multiplexed onto (0 for ephemeral ports)")
	origins := flag.String("allowed-origins", "*", "comma-separated list of allowed browser origins, or * for any")
	flag.Parse()

	allowed := parseOrigins(*origins)
	if len(allowed) == 0 {
		log.Print("warning: -allowed-origins is *, so any website can open a signaling connection")
	}

	// Half a TURN configuration silently degrades to no TURN at all, which only
	// shows up as failed calls on restrictive networks. Fail loudly instead.
	if (*turnURL == "") != (*turnSecret == "") {
		log.Fatal("-turn and -turn-secret must be set together")
	}
	if *turnURL == "" {
		log.Print("warning: no TURN configured, so participants behind symmetric NAT will fail to connect")
	}

	natIP, err := resolvePublicAddress(*publicAddress)
	if err != nil {
		// Almost always the container's resolver rather than the zone: Docker's
		// embedded DNS forwards to the host, and a host running a split-horizon
		// resolver answers NXDOMAIN for a name that resolves fine in public DNS.
		log.Printf("resolve -public-address: %v", err)
		log.Fatal("hint: pass an IP in -public-address (PUBLIC_ADDRESS in .env), " +
			"or give the container a resolver that knows this name (dns: in docker-compose.yml)")
	}
	if natIP != "" && natIP != *publicAddress {
		log.Printf("advertising %s in ICE candidates (%s)", natIP, *publicAddress)
	}

	sfu, err := NewSFU(Config{
		STUNURL:    *stunURL,
		TURNURL:    *turnURL,
		TURNSecret: *turnSecret,
		NATIP:      natIP,
		UDPPort:    *udpPort,
	})
	if err != nil {
		log.Fatalf("configure SFU: %v", err)
	}
	log.Printf("media multiplexed on udp/%d", *udpPort)

	hub := NewHub(sfu, originChecker(allowed))

	r := gin.Default()
	r.Use(corsMiddleware(allowed))

	r.GET("/healthz", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})
	// One signaling connection per participant. Everything else — offers,
	// answers, candidates, renegotiation on join and leave — happens over it.
	r.GET("/ws/:room", hub.ServeWS)

	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", *port),
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("listening on %s", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("http server: %v", err)
	}
}

// resolvePublicAddress turns the configured public address into the literal IP
// that goes into ICE candidates. A hostname is accepted so a deployment can be
// configured entirely by domain name, but the candidate itself must carry an
// address — that is the protocol, not a pion limitation — so the name is
// resolved here, once, at startup. An address that changes afterwards is only
// picked up on restart.
func resolvePublicAddress(address string) (string, error) {
	if address == "" {
		return "", nil
	}

	if ip := net.ParseIP(address); ip != nil {
		return address, nil
	}

	ips, err := net.LookupIP(address)
	if err != nil {
		return "", fmt.Errorf("look up %q: %w", address, err)
	}

	// IPv4 only: one address is advertised per candidate type, and the published
	// UDP port this pairs with is reached over v4.
	for _, ip := range ips {
		if v4 := ip.To4(); v4 != nil {
			return v4.String(), nil
		}
	}

	return "", fmt.Errorf("look up %q: no IPv4 address", address)
}

// parseOrigins returns the configured origin allowlist. An empty result means
// "any origin".
func parseOrigins(raw string) []string {
	if strings.TrimSpace(raw) == "*" {
		return nil
	}

	var allowed []string
	for _, origin := range strings.Split(raw, ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			allowed = append(allowed, origin)
		}
	}

	return allowed
}

// originChecker guards the websocket handshake. The browser's same-origin policy
// does not apply to websockets, so without this check any page could open a
// signaling connection on a visitor's behalf.
func originChecker(allowed []string) func(*http.Request) bool {
	return func(req *http.Request) bool {
		if len(allowed) == 0 {
			return true
		}

		origin := req.Header.Get("Origin")
		if origin == "" {
			return true // non-browser client, e.g. a CLI test tool
		}

		return slices.Contains(allowed, origin)
	}
}

func corsMiddleware(allowed []string) gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.Request.Header.Get("Origin")

		switch {
		case len(allowed) == 0:
			c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		case slices.Contains(allowed, origin):
			c.Writer.Header().Set("Access-Control-Allow-Origin", origin)
			c.Writer.Header().Add("Vary", "Origin")
		}

		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")

		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}

		c.Next()
	}
}
