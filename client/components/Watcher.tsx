"use client";

import { destroyStream, log, processPCError } from "@/utils";
import axios from "axios";
import { Button, TextInput } from "flowbite-react";
import { FC, useCallback, useRef, useState } from "react";

type WatcherProps = {
  onBackClick: () => void;
};

export const Watcher: FC<WatcherProps> = ({ onBackClick }) => {
  const [room, setRoom] = useState("");
  const ref = useRef<HTMLVideoElement>(null);
  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection>();

  const start = useCallback(async () => {
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
            `https://webrtc-api.super-shy.ru/${room}`,
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
  }, [room]);

  return (
    <>
      <Button
        onClick={() => {
          onBackClick();
          if (peerConnection) {
            destroyStream(peerConnection, ref);
          }
        }}
        gradientDuoTone="purpleToBlue"
        outline
      >
        Back
      </Button>

      <div className="flex gap-4">
        <TextInput className="grow" value={room} onChange={(e) => setRoom(e.target.value)} />
        <Button gradientDuoTone="purpleToBlue" onClick={start}>
          Watch
        </Button>
      </div>

      <video ref={ref} width="640" height="480" autoPlay></video>
    </>
  );
};
