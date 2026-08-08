"use client";

import { useCall } from "@/lib/useCall";
import { useEffect, useRef, useState } from "react";
import { JoinForm } from "./JoinForm";
import { VideoTile } from "./VideoTile";

/** Where a room lives, and what gets pasted into a chat to invite someone. */
function roomPath(room: string) {
  return `/r/${encodeURIComponent(room)}`;
}

interface CallProps {
  /** Set when the page was opened through a room link. */
  initialRoom?: string;
}

export function Call({ initialRoom }: CallProps) {
  const {
    status,
    error,
    notice,
    attempt,
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

  // Whether this tab has been in a call, which is what separates "left the room"
  // from "arrived through a link and has not joined yet".
  const joined = useRef(false);

  // Keep the address bar on the room, so the tab can simply be shared, and drop
  // it again on the way out. Deliberately not a router navigation: that would
  // remount this component and tear down the call it just started. Next supports
  // history directly for exactly this case.
  useEffect(() => {
    if (room) {
      joined.current = true;
    } else if (!joined.current) {
      // A freshly opened link: leave it alone. Scrubbing the room here would
      // lose it on reload, before anyone had the chance to join.
      return;
    }

    // The query string carries options like ?relay=1 and must survive this.
    const path = (room ? roomPath(room) : "/") + window.location.search;
    if (window.location.pathname + window.location.search !== path) {
      window.history.replaceState(null, "", path);
    }
  }, [room]);

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

      {status === "reconnecting" && (
        <p
          role="status"
          className="w-full rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/60 dark:text-amber-200"
        >
          Connection lost — reconnecting{attempt > 1 ? ` (attempt ${attempt})` : ""}…
          {/* Past a few tries this is not a blip, and the reason is worth naming. */}
          {attempt >= 3 && " Check the network; a call across a restrictive one needs a TURN server."}
        </p>
      )}

      {!inCall && <JoinForm busy={status === "connecting"} initialRoom={initialRoom} onJoin={join} />}

      {inCall && (
        <>
          <header className="flex w-full flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{room}</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {status === "connected" &&
                  `${remotes.length + 1} ${remotes.length === 0 ? "participant" : "participants"}`}
                {status === "reconnecting" && "Reconnecting…"}
                {status !== "connected" && status !== "reconnecting" && "Connecting…"}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <CopyLinkButton />
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
              Waiting for someone else to join <span className="font-mono">{room}</span>. Send them the link.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Copies the room link. The clipboard API needs a secure context, which the app
 * needs anyway for the camera — but it can still be refused, and a button that
 * quietly does nothing is worse than one that admits it, so a failure falls back
 * to showing the address to copy by hand.
 */
function CopyLinkButton() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("failed");
    }
  };

  if (state === "failed") {
    return (
      <input
        readOnly
        value={window.location.href}
        aria-label="Room link"
        onFocus={(event) => event.target.select()}
        className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
      />
    );
  }

  return (
    <button
      onClick={copy}
      className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 transition hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
    >
      {state === "copied" ? "Link copied" : "Copy link"}
    </button>
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
