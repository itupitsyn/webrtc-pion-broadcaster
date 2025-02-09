"use client";

import { useBroadcaster } from "@/hooks/useBroadcaster";
import { Button, TextInput } from "flowbite-react";
import { FC, useRef, useState } from "react";

type BroadcasterProps = {
  onBackClick: () => void;
};

export const Broadcaster: FC<BroadcasterProps> = ({ onBackClick }) => {
  const [room, setRoom] = useState("");
  const ref = useRef<HTMLVideoElement>(null);
  const { startBroadcasting, stopBroadcasting, isBroadcasting } = useBroadcaster(ref, room);

  return (
    <>
      <div className="flex gap-4 self-center">
        <Button
          gradientDuoTone="purpleToBlue"
          outline
          onClick={() => {
            stopBroadcasting();
            onBackClick();
          }}
        >
          Back
        </Button>
        <TextInput className="grow" value={room} onChange={(e) => setRoom(e.target.value)} />
        <Button gradientDuoTone="purpleToBlue" onClick={startBroadcasting}>
          Start
        </Button>
        {isBroadcasting && (
          <Button gradientDuoTone="purpleToBlue" outline onClick={stopBroadcasting}>
            Stop
          </Button>
        )}
      </div>

      <video ref={ref} width="640" height="480" autoPlay muted></video>
    </>
  );
};
