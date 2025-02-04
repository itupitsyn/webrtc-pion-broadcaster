"use client";

import { destroyStream, log, processPCError } from "@/utils";
import axios from "axios";
import { Button, TextInput } from "flowbite-react";
import { FC, useCallback, useEffect, useRef, useState } from "react";

type BroadcasterProps = {
  onBackClick: () => void;
};

export const Broadcaster: FC<BroadcasterProps> = ({ onBackClick }) => {
  const [room, setRoom] = useState("");
  const ref = useRef<HTMLVideoElement>(null);
  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection>();
  const [stream, setStream] = useState<MediaStream>();

  const start = useCallback(async () => {
    if (!ref.current) return;

    log("started");
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        // { urls: "stun:stun.l.google.com:5349" },
        // { urls: "stun:stun1.l.google.com:3478" },
        // { urls: "stun:stun1.l.google.com:5349" },
        // { urls: "stun:stun2.l.google.com:19302" },
        // { urls: "stun:stun2.l.google.com:5349" },
        // { urls: "stun:stun3.l.google.com:3478" },
        // { urls: "stun:stun3.l.google.com:5349" },
        // { urls: "stun:stun4.l.google.com:19302" },
        // { urls: "stun:stun4.l.google.com:5349" },
      ],
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
            `https://webrtc-api.super-shy.ru/${room}?caster=true`,
            btoa(localDescription),
          );
          const remoteSessionDescription = atob(response.data);
          // log(remoteSessionDescription);
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
  }, [room]);

  return (
    <>
      <Button
        gradientDuoTone="purpleToBlue"
        outline
        onClick={() => {
          onBackClick();
          if (peerConnection) {
            destroyStream(peerConnection, ref);
            stream?.getTracks().forEach((track) => track.stop());
          }
        }}
      >
        Back
      </Button>

      <div className="flex gap-4">
        <TextInput className="grow" value={room} onChange={(e) => setRoom(e.target.value)} />
        <Button gradientDuoTone="purpleToBlue" onClick={start}>
          Start
        </Button>
        {peerConnection && (
          <Button
            gradientDuoTone="purpleToBlue"
            outline
            onClick={() => {
              destroyStream(peerConnection, ref);
              setPeerConnection(undefined);
              stream?.getTracks().forEach((track) => track.stop());
            }}
          >
            Stop
          </Button>
        )}
      </div>

      <video ref={ref} width="640" height="480" autoPlay muted></video>
    </>
  );
};
