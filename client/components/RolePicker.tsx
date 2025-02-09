"use client";

import { Button, ButtonGroup } from "flowbite-react";
import { FC, useState } from "react";
import { Broadcaster } from "./Broadcaster";
import { Watcher } from "./Watcher";
import { clearLog } from "@/utils";
import { Meet } from "./Meet";

export const RolePicker: FC = () => {
  const [role, setRole] = useState<"watching" | "streaming" | "meet" | null>(null);
  return (
    <div className="flex flex-col gap-4">
      {!role && (
        <ButtonGroup>
          <Button gradientDuoTone="purpleToBlue" outline onClick={() => setRole("streaming")}>
            Streaming
          </Button>
          <Button gradientDuoTone="purpleToBlue" outline onClick={() => setRole("watching")}>
            Watching
          </Button>
          <Button gradientDuoTone="purpleToBlue" outline onClick={() => setRole("meet")}>
            Meet
          </Button>
        </ButtonGroup>
      )}
      {role === "streaming" && (
        <Broadcaster
          onBackClick={() => {
            clearLog();
            setRole(null);
          }}
        />
      )}
      {role === "watching" && (
        <Watcher
          onBackClick={() => {
            clearLog();
            setRole(null);
          }}
        />
      )}
      {role === "meet" && (
        <Meet
          onBackClick={() => {
            clearLog();
            setRole(null);
          }}
        />
      )}
    </div>
  );
};
