import { destroyStream, log, processPCError } from "@/utils";
import axios from "axios";
import { RefObject, useCallback, useState } from "react";

export const useBroadcaster = (ref: RefObject<HTMLVideoElement>, streamId: string) => {
  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection>();
  const [stream, setStream] = useState<MediaStream>();

  const startBroadcasting = useCallback(async () => {
    if (!ref.current) return;

    log("started");
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    let newStream: MediaStream;

    pc.onconnectionstatechange = () => {
      log(pc.iceConnectionState);
      if (pc.iceConnectionState === "closed" || pc.iceConnectionState === "disconnected") {
        newStream?.getTracks().forEach((track) => track.stop());
        destroyStream(pc, ref);
        log("stream has been destroyed");
      }
    };

    pc.onicecandidate = async (event) => {
      log("looking for an appropriate candidate");
      if (event.candidate === null) {
        log("found an appropriate candidate");
        try {
          const localDescription = JSON.stringify(pc.localDescription);
          // log(localDescription);
          const response = await axios.post(
            `${process.env.NEXT_PUBLIC_API_URL}/${streamId}?caster=true`,
            btoa(localDescription),
          );
          const remoteSessionDescription = atob(response.data);
          pc.setRemoteDescription(JSON.parse(remoteSessionDescription));
          setPeerConnection(pc);
        } catch (e) {
          processPCError(e, pc, ref);
        }
      }
    };

    try {
      newStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      ref.current.srcObject = newStream;
      newStream.getTracks().forEach((track) => {
        pc.addTrack(track, newStream);
      });
      setStream(newStream);
    } catch (e) {
      log("error getting access to user media");
      log("check permissions");
      processPCError(e, pc, ref);
    }

    try {
      log("creating offer");
      const d = await pc.createOffer();
      pc.setLocalDescription(d);
    } catch (e) {
      processPCError(e, pc, ref);
    }
  }, [ref, streamId]);

  const stopBroadcasting = useCallback(() => {
    if (peerConnection) {
      destroyStream(peerConnection, ref);
      setPeerConnection(undefined);
    }
    stream?.getTracks().forEach((track) => track.stop());
  }, [peerConnection, ref, stream]);

  return { startBroadcasting, stopBroadcasting, isBroadcasting: !!peerConnection };
};
