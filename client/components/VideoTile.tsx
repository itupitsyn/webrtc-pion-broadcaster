"use client";

import { useEffect, useRef, useState } from "react";

interface VideoTileProps {
  stream: MediaStream;
  label: string;
  /** Always mute the local preview, otherwise the microphone feeds back. */
  muted?: boolean;
  /** Local camera switched off by the user; the track is live but sends nothing. */
  videoOff?: boolean;
}

export function VideoTile({ stream, label, muted = false, videoOff = false }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hasVideo = useHasVideoTrack(stream);

  // srcObject holds an object, so it cannot be passed through JSX.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || video.srcObject === stream) return;

    video.srcObject = stream;
  }, [stream]);

  const showPlaceholder = !hasVideo || videoOff;

  return (
    <div className="relative overflow-hidden rounded-xl bg-gray-900 shadow-md ring-1 ring-black/10">
      {/* Kept mounted even with nothing to show: this element plays the audio. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={`aspect-video w-full object-cover ${showPlaceholder ? "invisible" : ""}`}
      />

      {showPlaceholder && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-16 items-center justify-center rounded-full bg-gray-700 text-xl font-semibold uppercase text-gray-200">
            {label.slice(0, 1)}
          </span>
        </div>
      )}

      <span className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
        {label}
        {!hasVideo && " · no camera"}
      </span>
    </div>
  );
}

/** Tracks whether the stream currently carries live video, which can change mid-call. */
function useHasVideoTrack(stream: MediaStream) {
  const [hasVideo, setHasVideo] = useState(() => stream.getVideoTracks().length > 0);

  useEffect(() => {
    const update = () => setHasVideo(stream.getVideoTracks().some((track) => track.readyState === "live"));
    update();

    stream.addEventListener("addtrack", update);
    stream.addEventListener("removetrack", update);

    return () => {
      stream.removeEventListener("addtrack", update);
      stream.removeEventListener("removetrack", update);
    };
  }, [stream]);

  return hasVideo;
}
