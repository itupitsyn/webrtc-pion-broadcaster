import { destroyStream, log, processPCError } from "@/utils";
import axios from "axios";
import { RefObject, useCallback, useState } from "react";

export const useWatcher = (ref: RefObject<HTMLVideoElement>, streamId: string) => {
  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection>();

  const startWatching = useCallback(async () => {
    log("started");

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.onconnectionstatechange = (e) => {
      log(pc.iceConnectionState);
      if (pc.iceConnectionState === "closed" || pc.iceConnectionState === "disconnected") {
        destroyStream(pc, ref);
        log("stream has been destroyed");
      }
    };

    pc.onicecandidate = async (event) => {
      log("looking for an appropriate candidate");
      if (event.candidate === null) {
        try {
          log("found an appropriate candidate");
          const response = await axios.post(
            `${process.env.NEXT_PUBLIC_API_URL}/${streamId}`,
            btoa(JSON.stringify(pc.localDescription)),
          );
          const remoteSessionDescription = response.data;
          pc.setRemoteDescription(JSON.parse(atob(remoteSessionDescription)));
          setPeerConnection(pc);
        } catch (e) {
          processPCError(e, pc, ref);
        }
      }
    };

    try {
      pc.addTransceiver("video");
      pc.addTransceiver("audio");
      const d = await pc.createOffer();
      pc.setLocalDescription(d);

      pc.ontrack = (e) => {
        if (!ref.current) return;

        const curr = e.streams[0];
        ref.current.srcObject = curr;
        ref.current.autoplay = true;
        ref.current.controls = true;
      };
    } catch (e) {
      processPCError(e, pc, ref);
    }
  }, [ref, streamId]);

  const stopWatching = useCallback(() => {
    if (peerConnection) {
      destroyStream(peerConnection, ref);
    }
  }, [peerConnection, ref]);

  return { startWatching, stopWatching, isWatching: !!peerConnection };
};
