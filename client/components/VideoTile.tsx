"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface VideoTileProps {
  stream: MediaStream;
  label: string;
  /** Always mute the local preview, otherwise the microphone feeds back. */
  muted?: boolean;
  /** Camera switched off at the sending end, so whatever arrived last is stale. */
  videoOff?: boolean;
  /** Microphone muted at the sending end. */
  micOff?: boolean;
  /** Output device to play through; empty means the system default. */
  sinkId?: string;
}

/** Slider maximum, in percent. Past 100 the element cannot help and WebAudio takes over. */
const MAX_LEVEL = 2;

export function VideoTile({
  stream,
  label,
  muted = false,
  videoOff = false,
  micOff = false,
  sinkId = "",
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hasVideo = useHasTrack(stream, "video");
  const hasAudio = useHasTrack(stream, "audio");

  // How loudly this participant plays, and whether they play at all. Both are
  // local to this browser: no signaling, and the sender never learns about it.
  const [level, setLevel] = useState(1);
  const [silenced, setSilenced] = useState(false);
  // Destructured: the hook returns a fresh object each render, and the effect
  // below must not re-run for that alone.
  const { setGain, boostUnavailable } = useAudioBoost(stream);

  // srcObject holds an object, so it cannot be passed through JSX.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || video.srcObject === stream) return;

    video.srcObject = stream;
  }, [stream]);

  const silent = muted || silenced;

  // volume and muted are properties rather than attributes, and React is known
  // to miss `muted` on the first render, so both are set here too.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Squared, because a linear slider crams every useful step into its bottom
    // third: perceived loudness rises far more slowly than amplitude. The curve
    // continues past unity unchanged, so crossing 100% is not a step.
    const gain = silent ? 0 : level * level;

    // While the gain node carries the audio the element must not play it too.
    const boosting = setGain(gain);

    video.volume = Math.min(gain, 1);
    video.muted = silent || boosting;
  }, [level, silent, setGain]);

  // Leaving the slider above what the element can play would be silence rather
  // than a quiet participant.
  useEffect(() => {
    if (boostUnavailable) setLevel((current) => Math.min(current, 1));
  }, [boostUnavailable]);

  // Both paths have to be redirected: the element plays everything up to 100%,
  // and the boost graph plays the rest through the AudioContext, which routes
  // entirely separately.
  useEffect(() => {
    routeAudioContext(sinkId);

    const video = videoRef.current;
    if (!video || !("setSinkId" in video)) return;

    void video.setSinkId(sinkId).catch((sinkError: unknown) => {
      console.error("could not switch output device", sinkError);
    });
  }, [sinkId]);

  const showPlaceholder = !hasVideo || videoOff;
  // The local preview plays nothing by design, and a participant who joined
  // without a microphone has nothing to turn down.
  const showVolume = !muted && hasAudio;
  const percent = Math.round(level * 100);

  return (
    <div className="relative overflow-hidden rounded-xl bg-gray-900 shadow-md ring-1 ring-black/10">
      {/* Kept mounted even with nothing to show: this element plays the audio,
          and WebAudio needs it attached even when it plays nothing itself. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={silent}
        className={`aspect-video w-full object-cover ${showPlaceholder ? "invisible" : ""}`}
      />

      {showPlaceholder && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-16 items-center justify-center rounded-full bg-gray-700 text-xl font-semibold uppercase text-gray-200">
            {label.slice(0, 1)}
          </span>
        </div>
      )}

      <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
        {micOff && <MicOffIcon />}
        {label}
        {videoOff ? " · camera off" : !hasVideo && " · no camera"}
      </span>

      {showVolume && (
        <div className="absolute bottom-2 right-2 flex items-center gap-1.5 rounded bg-black/60 px-1.5 py-1">
          <button
            type="button"
            onClick={() => setSilenced((current) => !current)}
            aria-pressed={silenced}
            aria-label={silenced ? `Unmute ${label}` : `Mute ${label}`}
            title={silenced ? `Unmute ${label}` : `Mute ${label}`}
            className="rounded p-0.5 text-white transition hover:bg-white/20"
          >
            <SpeakerIcon muted={silenced} />
          </button>

          <input
            type="range"
            min={0}
            max={(boostUnavailable ? 1 : MAX_LEVEL) * 100}
            step={5}
            value={percent}
            onChange={(event) => setLevel(Number(event.target.value) / 100)}
            disabled={silenced}
            aria-label={`Volume for ${label}`}
            aria-valuetext={`${percent}%`}
            title={
              boostUnavailable
                ? `${percent}% — this browser refused to boost past 100%`
                : `${percent}%${percent > 100 ? " (boosted)" : ""}`
            }
            className="h-1 w-20 cursor-pointer accent-white disabled:cursor-not-allowed disabled:opacity-40"
          />

          {/* Always rendered: the row is anchored to the right edge, so dropping
              this label would shrink the box and shove the slider sideways. */}
          <span
            className={`w-9 shrink-0 text-right text-[10px] tabular-nums ${percent > 100 ? "text-amber-300" : "text-gray-300"}`}
          >
            {percent}%
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Plays a stream through a gain node so it can go louder than the media element
 * allows, which stops at 1.
 *
 * The graph is built on the first boost and never before it. Everything up to
 * 100% is the element's own volume, so a call that leaves the slider alone
 * touches no AudioContext at all — which matters because a
 * MediaStreamAudioSourceNode fed by a *remote* stream has a long history of
 * producing silence on Safari and iOS. There it degrades to a slider capped at
 * 100% rather than to a call with no sound.
 *
 * The element stays attached to the stream throughout, muted while the graph
 * plays: Chrome has never reliably delivered audio to WebAudio from a remote
 * stream that is not also attached to a live media element.
 */
function useAudioBoost(stream: MediaStream) {
  const graph = useRef<{ source: MediaStreamAudioSourceNode; gain: GainNode } | null>(null);
  const [boostUnavailable, setBoostUnavailable] = useState(false);

  useEffect(() => {
    return () => {
      graph.current?.source.disconnect();
      graph.current?.gain.disconnect();
      graph.current = null;
    };
  }, [stream]);

  /** Returns whether the graph now carries the audio, meaning the element must stay muted. */
  const setGain = useCallback(
    (gain: number): boolean => {
      if (gain <= 1) {
        // Left connected on purpose: dragging across 100% repeatedly would
        // otherwise rebuild the graph on every crossing.
        if (graph.current) graph.current.gain.gain.value = 0;
        return false;
      }

      if (!graph.current) {
        if (boostUnavailable) return false;

        try {
          const context = audioContext();
          const source = context.createMediaStreamSource(stream);
          const boostGain = context.createGain();

          // +12 dB on an already loud speaker would tear; the limiter keeps the
          // peaks in range so the boost stays usable rather than just louder.
          const limiter = context.createDynamicsCompressor();
          limiter.threshold.value = -3;
          limiter.knee.value = 0;
          limiter.ratio.value = 20;
          limiter.attack.value = 0.003;
          limiter.release.value = 0.25;

          source.connect(boostGain).connect(limiter).connect(context.destination);
          graph.current = { source, gain: boostGain };
        } catch (error) {
          console.error("audio boost unavailable", error);
          setBoostUnavailable(true);
          return false;
        }
      }

      graph.current.gain.gain.value = gain;
      return true;
    },
    [stream, boostUnavailable],
  );

  return { setGain, boostUnavailable };
}

let sharedContext: AudioContext | null = null;

/** The chosen output device, remembered for a context that does not exist yet. */
let preferredSink = "";

/** An AudioContext that can be pointed at an output device; not every browser's can. */
type RoutableAudioContext = AudioContext & { setSinkId(id: string): Promise<void> };

/**
 * Sends the boost graph to the chosen output device. Stored either way: the
 * context is built lazily on the first boost, which is usually long after the
 * device was picked.
 */
function routeAudioContext(sinkId: string) {
  preferredSink = sinkId;

  if (!sharedContext || !("setSinkId" in sharedContext)) return;

  void (sharedContext as RoutableAudioContext).setSinkId(sinkId).catch((error: unknown) => {
    console.error("could not route boosted audio", error);
  });
}

/**
 * One AudioContext for the page. Browsers cap how many a document may hold, and
 * a room with several participants would otherwise want one per tile.
 */
function audioContext(): AudioContext {
  if (!sharedContext) {
    sharedContext = new AudioContext();
    routeAudioContext(preferredSink);
  }

  // The autoplay policy starts a context suspended unless a gesture created it.
  // Every call here comes from the slider, which is one.
  if (sharedContext.state === "suspended") void sharedContext.resume();

  return sharedContext;
}

/** Marks a participant whose microphone is muted at their end. */
function MicOffIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      role="img"
      aria-label="Microphone muted"
      className="size-3.5 shrink-0 text-red-300"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V5a3 3 0 0 1 6 0v4m0 3a3 3 0 0 1-4.5 2.6" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 0 1-10.9 5.8M5 11a7 7 0 0 0 2 4.9M12 19v3" />
      <path strokeLinecap="round" d="M3 3l18 18" />
    </svg>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden className="size-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M11 5 6 9H3v6h3l5 4V5Z" />
      {muted ? (
        <path strokeLinecap="round" d="m16 9 5 6m0-6-5 6" />
      ) : (
        <path strokeLinecap="round" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a9 9 0 0 1 0 12" />
      )}
    </svg>
  );
}

/** Tracks whether the stream currently carries a live track of a kind, which can change mid-call. */
function useHasTrack(stream: MediaStream, kind: "audio" | "video") {
  const [hasTrack, setHasTrack] = useState(() => tracksOfKind(stream, kind).length > 0);

  useEffect(() => {
    const update = () => setHasTrack(tracksOfKind(stream, kind).some((track) => track.readyState === "live"));
    update();

    stream.addEventListener("addtrack", update);
    stream.addEventListener("removetrack", update);

    return () => {
      stream.removeEventListener("addtrack", update);
      stream.removeEventListener("removetrack", update);
    };
  }, [stream, kind]);

  return hasTrack;
}

function tracksOfKind(stream: MediaStream, kind: "audio" | "video") {
  return kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
}
