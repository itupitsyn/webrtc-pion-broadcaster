import { PeerConnectionState } from "@/src/types";
import { destroyStream, log, processPCError } from "@/src/utils";
import axios from "axios";
import { RefObject, useCallback, useEffect, useRef, useState } from "react";

export const useWatcher = (ref: RefObject<HTMLVideoElement>) => {
  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection>();
  const connStateRef = useRef<PeerConnectionState>(PeerConnectionState.None);

  const startWatching = useCallback(
    async (streamId: string) => {
      if (!streamId) {
        log("Error: empty streamId");
        return;
      }

      log("started");

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      pc.onconnectionstatechange = () => {
        log(pc.iceConnectionState);

        if (pc.iceConnectionState === "closed" || pc.iceConnectionState === "disconnected") {
          destroyStream(pc, ref);
          setPeerConnection(undefined);
          log("stream has been destroyed");
        }
      };

      const connect = async () => {
        if (connStateRef.current !== PeerConnectionState.None) {
          return;
        }

        try {
          connStateRef.current = PeerConnectionState.Connecting;

          const response = await axios.post(
            `${process.env.NEXT_PUBLIC_API_URL}/${streamId}`,
            btoa(JSON.stringify(pc.localDescription)),
          );
          const remoteSessionDescription = response.data;
          pc.setRemoteDescription(JSON.parse(atob(remoteSessionDescription)));
          setPeerConnection(pc);

          connStateRef.current = PeerConnectionState.Connected;
        } catch (e) {
          connStateRef.current = PeerConnectionState.None;

          processPCError(e, pc, ref);
          setPeerConnection(undefined);
        }
      };

      pc.onicecandidate = async (event) => {
        setTimeout(connect, 1000);
      };

      try {
        pc.addTransceiver("video");
        pc.addTransceiver("audio");

        const d = await pc.createOffer();
        pc.setLocalDescription(d);

        log("looking for a candidate to connect");

        pc.ontrack = (e) => {
          if (!ref.current) return;

          const curr = e.streams[0];
          ref.current.srcObject = curr;
          ref.current.autoplay = true;
          ref.current.controls = true;
        };
      } catch (e) {
        processPCError(e, pc, ref);
        setPeerConnection(undefined);
      }
    },
    [ref],
  );

  const stopWatching = useCallback(() => {
    if (peerConnection) {
      destroyStream(peerConnection, ref);
      setPeerConnection(undefined);
    }
  }, [peerConnection, ref]);

  useEffect(() => {
    if (!peerConnection) {
      connStateRef.current = PeerConnectionState.None;
    }
  }, [peerConnection]);

  return { startWatching, stopWatching, isWatching: !!peerConnection };
};
