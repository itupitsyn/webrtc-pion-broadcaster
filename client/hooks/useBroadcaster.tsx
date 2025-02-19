import { PeerConnectionState } from "@/src/types";
import { destroyStream, log, processPCError } from "@/src/utils";
import axios from "axios";
import { RefObject, useCallback, useEffect, useRef, useState } from "react";

export const useBroadcaster = (ref: RefObject<HTMLVideoElement>) => {
  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection>();
  const [stream, setStream] = useState<MediaStream>();
  const connStateRef = useRef<PeerConnectionState>(PeerConnectionState.None);

  const startBroadcasting = useCallback(
    async (streamId: string) => {
      if (!ref.current) return;

      if (!streamId) {
        log("Error: empty streamId");
        return;
      }

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

          const localDescription = JSON.stringify(pc.localDescription);
          const response = await axios.post(
            `${process.env.NEXT_PUBLIC_API_URL}/${streamId}?caster=true`,
            btoa(localDescription),
          );
          const remoteSessionDescription = atob(response.data);
          pc.setRemoteDescription(JSON.parse(remoteSessionDescription));
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
        try {
          newStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch {
          newStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        ref.current.srcObject = newStream;
        newStream.getTracks().forEach((track) => {
          pc.addTrack(track, newStream);
        });
        setStream(newStream);
      } catch (e) {
        log("error getting access to user media");
        log("check permissions");
        processPCError(e, pc, ref);
        setPeerConnection(undefined);
      }

      try {
        log("creating offer");

        const d = await pc.createOffer();
        pc.setLocalDescription(d);

        log("looking for a candidate to connect");
      } catch (e) {
        processPCError(e, pc, ref);
        setPeerConnection(undefined);
      }
    },
    [ref],
  );

  const stopBroadcasting = useCallback(() => {
    if (peerConnection) {
      destroyStream(peerConnection, ref);
      setPeerConnection(undefined);
    }
    stream?.getTracks().forEach((track) => track.stop());
  }, [peerConnection, ref, stream]);

  useEffect(() => {
    if (!peerConnection) {
      connStateRef.current = PeerConnectionState.None;
    }
  }, [peerConnection]);

  return { startBroadcasting, stopBroadcasting, isBroadcasting: !!peerConnection };
};
