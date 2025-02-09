"use client";

import { useWatcher } from "@/hooks/useWatcher";
import { Button, TextInput } from "flowbite-react";
import { FC, useRef, useState } from "react";

type WatcherProps = {
  onBackClick: () => void;
};

export const Watcher: FC<WatcherProps> = ({ onBackClick }) => {
  const [room, setRoom] = useState("");
  const ref = useRef<HTMLVideoElement>(null);

  const { startWatching, stopWatching, isWatching } = useWatcher(ref, room);

  return (
    <>
      <div className="flex gap-4 self-center">
        <Button
          onClick={() => {
            stopWatching();
            onBackClick();
          }}
          gradientDuoTone="purpleToBlue"
          outline
        >
          Back
        </Button>
        <TextInput className="grow" value={room} onChange={(e) => setRoom(e.target.value)} />
        <Button gradientDuoTone="purpleToBlue" onClick={startWatching}>
          Watch
        </Button>
        {isWatching && (
          <Button gradientDuoTone="purpleToBlue" outline onClick={stopWatching}>
            Disconnect
          </Button>
        )}
      </div>

      <video ref={ref} width="640" height="480" autoPlay></video>
    </>
  );
};
