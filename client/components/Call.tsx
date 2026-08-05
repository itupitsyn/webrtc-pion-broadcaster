"use client";

import { useCall } from "@/lib/useCall";
import { JoinForm } from "./JoinForm";
import { VideoTile } from "./VideoTile";

export function Call() {
  const {
    status,
    error,
    notice,
    room,
    myName,
    nameFor,
    localStream,
    remotes,
    micEnabled,
    camEnabled,
    hasVideo,
    hasAudio,
    join,
    leave,
    toggleMic,
    toggleCam,
  } = useCall();

  const inCall = localStream !== null;

  return (
    <div className="flex w-full max-w-5xl flex-col items-center gap-6">
      {error && (
        <p
          role="alert"
          className="w-full rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/60 dark:text-red-300"
        >
          {error}
        </p>
      )}

      {notice && (
        <p className="w-full rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
          {notice}
        </p>
      )}

      {!inCall && <JoinForm busy={status === "connecting"} onJoin={join} />}

      {inCall && (
        <>
          <header className="flex w-full flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{room}</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {status === "connected"
                  ? `${remotes.length + 1} ${remotes.length === 0 ? "participant" : "participants"}`
                  : "Connecting…"}
              </p>
            </div>

            <div className="flex gap-2">
              {/* A control for a device we never got would do nothing. */}
              {hasAudio && <ToggleButton active={micEnabled} onClick={toggleMic} onLabel="Mute" offLabel="Unmute" />}
              {hasVideo && (
                <ToggleButton active={camEnabled} onClick={toggleCam} onLabel="Stop video" offLabel="Start video" />
              )}
              <button
                onClick={leave}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700"
              >
                Leave
              </button>
            </div>
          </header>

          <div className="grid w-full gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <VideoTile stream={localStream} label={myName ? `${myName} (you)` : "You"} muted videoOff={!camEnabled} />
            {remotes.map((peer) => (
              <VideoTile key={peer.id} stream={peer.stream} label={nameFor(peer.id)} />
            ))}
          </div>

          {remotes.length === 0 && status === "connected" && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Waiting for someone else to join <span className="font-mono">{room}</span>.
            </p>
          )}
        </>
      )}
    </div>
  );
}

interface ToggleButtonProps {
  active: boolean;
  onClick: () => void;
  onLabel: string;
  offLabel: string;
}

function ToggleButton({ active, onClick, onLabel, offLabel }: ToggleButtonProps) {
  return (
    <button
      onClick={onClick}
      aria-pressed={!active}
      className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 transition hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
    >
      {active ? onLabel : offLabel}
    </button>
  );
}
