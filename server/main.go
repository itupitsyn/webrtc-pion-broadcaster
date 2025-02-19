package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/intervalpli"
	"github.com/pion/webrtc/v4"
)

func main() {
	var port = flag.Int("port", 8080, "http server port")
	flag.Parse()

	peerConnectionMapChan := make(map[string]chan *webrtc.TrackLocalStaticRTP)
	peerConnectionMap := make(map[string][]*webrtc.TrackLocalStaticRTP)

	peerConnectionConfig := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}},
	}

	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		fmt.Println(err)
	}

	settingEngine := webrtc.SettingEngine{}
	settingEngine.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})

	interceptorRegistry := &interceptor.Registry{}

	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, interceptorRegistry); err != nil {
		fmt.Println(err)
	}

	intervalPliFactory, err := intervalpli.NewReceiverInterceptor()
	if err != nil {
		fmt.Println(err)
	}
	interceptorRegistry.Add(intervalPliFactory)

	api := webrtc.NewAPI(
		webrtc.WithSettingEngine(settingEngine),
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(interceptorRegistry),
	)

	r := gin.Default()
	r.Use(CORSMiddleware())

	r.POST("/:room", func(c *gin.Context) {
		room := c.Param("room")
		isCaster := c.Query("caster") == "true"

		buf := new(bytes.Buffer)
		buf.ReadFrom(c.Request.Body)
		sdp := buf.String()

		offer := webrtc.SessionDescription{}
		decode(sdp, &offer)

		peerConnection, err := api.NewPeerConnection(peerConnectionConfig)
		if err != nil {
			fmt.Println(err)
		}

		currentChan, exists := peerConnectionMapChan[room]
		if exists && isCaster {
			c.String(http.StatusConflict, "somebody already streaiming")
			return
		}

		if !exists && !isCaster {
			c.String(http.StatusConflict, "nobody streaming")
			return
		}

		if isCaster {
			if _, err = peerConnection.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo); err != nil {
				fmt.Println(err)
			}

			peerConnection.OnTrack(func(remoteTrack *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
				localTrack, newTrackErr := webrtc.NewTrackLocalStaticRTP(remoteTrack.Codec().RTPCodecCapability, remoteTrack.Codec().MimeType, "pion")
				if newTrackErr != nil {
					fmt.Println("New track error")
					processError(peerConnectionMapChan, peerConnectionMap, peerConnection, room, newTrackErr)
					return
				}
				if existingChan, ok := peerConnectionMapChan[room]; ok {
					// feed the exsiting track from user with this track
					existingChan <- localTrack
				} else {
					peerConnectionMapChan[room] = make(chan *webrtc.TrackLocalStaticRTP)
					peerConnectionMapChan[room] <- localTrack
				}

				rtpBuf := make([]byte, 1400)
				for {
					i, _, readErr := remoteTrack.Read(rtpBuf)
					if readErr != nil {
						fmt.Println("Reading remote track error")
						processError(peerConnectionMapChan, peerConnectionMap, peerConnection, room, readErr)
						return
					}

					if _, err = localTrack.Write(rtpBuf[:i]); err != nil && !errors.Is(err, io.ErrClosedPipe) {
						fmt.Println("Writing remote track error")
						processError(peerConnectionMapChan, peerConnectionMap, peerConnection, room, err)
						return
					}
				}
			})

			err = peerConnection.SetRemoteDescription(offer)
			if err != nil {
				fmt.Println(err)
			}

			answer, err := peerConnection.CreateAnswer(nil)
			if err != nil {
				fmt.Println(err)
			}

			gatherComplete := webrtc.GatheringCompletePromise(peerConnection)

			err = peerConnection.SetLocalDescription(answer)
			if err != nil {
				fmt.Println(err)
			}

			peerConnection.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
				if state == webrtc.PeerConnectionStateClosed || state == webrtc.PeerConnectionStateDisconnected {
					fmt.Printf("Connection closed: \"%s\"\n", room)
					delete(peerConnectionMapChan, room)
					delete(peerConnectionMap, room)
				}
			})

			<-gatherComplete

			result := encode(peerConnection.LocalDescription())

			c.String(http.StatusOK, result)
		} else {
			currentTracks := peerConnectionMap[room]
			if currentTracks == nil {
				currentTracks = []*webrtc.TrackLocalStaticRTP{}

				for i := 0; i < 2; i++ {
					select {
					case track, ok := <-currentChan:
						if ok {
							rtpSender, err := peerConnection.AddTrack(track)
							if err != nil {
								fmt.Println(err)
								c.Error(err)
							}
							currentTracks = append(currentTracks, track)

							go func() {
								rtcpBuf := make([]byte, 1500)
								for {
									if _, _, rtcpErr := rtpSender.Read(rtcpBuf); rtcpErr != nil {
										fmt.Println(rtcpErr)
										return
									}
								}
							}()
						} else {
							fmt.Println("track channel closed")
						}
					default:
						fmt.Println("no track 1")
					}
				}
				peerConnectionMap[room] = currentTracks
			}

			err = peerConnection.SetRemoteDescription(offer)
			if err != nil {
				fmt.Println(err)
				c.Error(err)
			}

			answer, err := peerConnection.CreateAnswer(nil)
			if err != nil {
				fmt.Println(err)
				c.Error(err)
			}

			gatherComplete := webrtc.GatheringCompletePromise(peerConnection)

			err = peerConnection.SetLocalDescription(answer)
			if err != nil {
				fmt.Println(err)
				c.Error(err)
			}

			<-gatherComplete

			result := encode(peerConnection.LocalDescription())
			c.String(http.StatusOK, result)
		}

	})

	r.GET("/interlocutor", func(c *gin.Context) {
		keys := make([]string, len(peerConnectionMapChan))

		i := 0
		for k := range peerConnectionMapChan {
			keys[i] = k
			i++
		}

		c.JSON(http.StatusOK, keys)
	})

	r.Run(fmt.Sprintf(":%d", *port))
}

func encode(obj *webrtc.SessionDescription) string {
	b, err := json.Marshal(obj)
	if err != nil {
		fmt.Println(err)
	}

	return base64.StdEncoding.EncodeToString(b)
}

func decode(in string, obj *webrtc.SessionDescription) {
	b, err := base64.StdEncoding.DecodeString(in)
	if err != nil {
		fmt.Println(err)
	}

	if err = json.Unmarshal(b, obj); err != nil {
		fmt.Println(err)
	}
}

func CORSMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, accept, origin, Cache-Control, X-Requested-With")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT, PATCH, DELETE")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

		c.Next()
	}
}

func processError(pcmc map[string]chan *webrtc.TrackLocalStaticRTP, pcm map[string][]*webrtc.TrackLocalStaticRTP, pc *webrtc.PeerConnection, room string, err error) {
	fmt.Println(err)

	delete(pcmc, room)
	delete(pcm, room)
	if cErr := pc.Close(); cErr != nil {
		fmt.Printf("cannot close peerConnection: %v\n", cErr)
	}
}
