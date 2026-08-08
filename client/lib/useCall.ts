"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fallbackName,
  ROOM_NAME_PATTERN,
  signalingURL,
  type PeerInfo,
  type SignalMessage,
  type Welcome,
} from "./signaling";

export type CallStatus = "idle" | "connecting" | "reconnecting" | "connected" | "error";

export interface RemotePeer {
  /** The SFU uses the participant id as the MediaStream id. */
  id: string;
  stream: MediaStream;
}

/** Backoff between reconnection attempts, capped so a long outage still retries often. */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 10000;

/**
 * useCall drives one participant's side of a call.
 *
 * The SFU is always the offerer, so this side only ever answers. That is what
 * makes people joining and leaving mid-call work: the server re-offers whenever
 * the set of forwarded tracks changes, and there is no glare to resolve.
 *
 * A dropped connection is retried rather than fatal. The server keeps no session
 * to resume, so reconnecting means rejoining the same room under a new id — but
 * the camera is never released and the call view never goes away, so from the
 * inside it is a stall rather than an ejection.
 */
export function useCall() {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  /** Non-fatal remark, e.g. that we joined without a camera. */
  const [notice, setNotice] = useState<string | null>(null);
  const [room, setRoom] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remotes, setRemotes] = useState<RemotePeer[]>([]);
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  /** Consecutive failed attempts, so the UI can say more than "wait". */
  const [attempt, setAttempt] = useState(0);
  /** Display names by participant id, as last broadcast by the server. */
  const [names, setNames] = useState<Record<string, string>>({});
  const [myName, setMyName] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  // What a reconnection needs to know: which room, under what name, and whether
  // the user has since walked away.
  const roomRef = useRef<string | null>(null);
  const nameRef = useRef("");
  const leftRef = useRef(false);
  const attemptRef = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>();

  // Candidates can arrive before the offer they belong to has been applied.
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const remoteDescriptionSet = useRef(false);

  // Signaling frames are applied one at a time: a renegotiation offer can arrive
  // while the previous one is still being answered, and applying both at once
  // corrupts the negotiation.
  const queue = useRef<Promise<void>>(Promise.resolve());

  // openSession and scheduleReconnect call each other; a ref breaks the cycle.
  const reconnect = useRef<() => void>();

  const send = useCallback((event: string, data: unknown) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event, data }));
    }
  }, []);

  /**
   * Drops the signaling session and everything negotiated through it, keeping the
   * local media. This is what a reconnection tears down; the camera staying on is
   * the difference between a stall and being thrown out.
   */
  const closeSession = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      // Cleared first: this close is ours, and must not look like a lost socket.
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
    }

    pcRef.current?.close();
    pcRef.current = null;

    pendingCandidates.current = [];
    remoteDescriptionSet.current = false;
    queue.current = Promise.resolve();

    // The streams behind these belong to the old peer connection and are dead.
    setRemotes([]);
    setNames({});
  }, []);

  const teardown = useCallback(() => {
    clearTimeout(retryTimer.current);
    closeSession();

    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;

    roomRef.current = null;
    attemptRef.current = 0;

    setLocalStream(null);
    setRoom(null);
    setAttempt(0);
  }, [closeSession]);

  const leave = useCallback(() => {
    leftRef.current = true;
    teardown();
    setStatus("idle");
    setError(null);
    setNotice(null);
  }, [teardown]);

  const trackRemoteStream = useCallback((event: RTCTrackEvent) => {
    const [stream] = event.streams;
    if (!stream) return;

    setRemotes((current) => {
      const existing = current.find((peer) => peer.id === stream.id);
      if (existing?.stream === stream) return current;

      // A recycled m-line can deliver a new MediaStream for a participant we
      // already show, so replace rather than append.
      return [...current.filter((peer) => peer.id !== stream.id), { id: stream.id, stream }];
    });

    const dropIfGone = () => {
      if (stream.getTracks().some((track) => track.readyState === "live")) return;
      setRemotes((current) => current.filter((peer) => peer.id !== stream.id));
    };

    event.track.addEventListener("ended", dropIfGone);
    stream.addEventListener("removetrack", dropIfGone);
  }, []);

  const createPeerConnection = useCallback(
    (welcome: Welcome) => {
      // Tolerate a missing list: the constructor throws on null rather than
      // treating it as "no ICE servers", which is a hard failure this early.
      const pc = new RTCPeerConnection({
        iceServers: welcome.iceServers ?? [],
        // ?relay=1 refuses every direct path, which is the only way to prove the
        // TURN server actually works — otherwise a direct connection hides it.
        iceTransportPolicy: relayOnly() ? "relay" : "all",
      });

      // The server's offer carries recvonly transceivers; these local tracks are
      // what attach to them when we answer, so they must be added up front.
      const stream = localStreamRef.current;
      stream?.getTracks().forEach((track) => pc.addTrack(track, stream));

      pc.onicecandidate = (event) => {
        if (event.candidate) send("candidate", event.candidate.toJSON());
      };

      pc.onconnectionstatechange = () => {
        if (pc !== pcRef.current) return;

        switch (pc.connectionState) {
          case "connected":
            attemptRef.current = 0;
            setAttempt(0);
            setError(null);
            setStatus("connected");
            break;
          case "failed":
            // Media never came up. The socket may be perfectly fine, so nothing
            // else would notice; retry the whole session rather than sit there.
            reconnect.current?.();
            break;
        }
      };

      pc.ontrack = trackRemoteStream;

      return pc;
    },
    [send, trackRemoteStream],
  );

  const applyOffer = useCallback(
    async (pc: RTCPeerConnection, offer: RTCSessionDescriptionInit) => {
      await pc.setRemoteDescription(offer);
      remoteDescriptionSet.current = true;

      const buffered = pendingCandidates.current;
      pendingCandidates.current = [];
      for (const candidate of buffered) {
        await pc.addIceCandidate(candidate);
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send("answer", answer);
    },
    [send],
  );

  const handleMessage = useCallback(
    async (msg: SignalMessage) => {
      switch (msg.event) {
        case "welcome":
          pcRef.current = createPeerConnection(msg.data as Welcome);
          break;

        case "offer": {
          const pc = pcRef.current;
          if (!pc) return;
          await applyOffer(pc, msg.data as RTCSessionDescriptionInit);
          break;
        }

        case "candidate": {
          const candidate = msg.data as RTCIceCandidateInit;
          if (!pcRef.current || !remoteDescriptionSet.current) {
            pendingCandidates.current.push(candidate);
            return;
          }
          await pcRef.current.addIceCandidate(candidate);
          break;
        }

        case "peers": {
          const roster = msg.data as PeerInfo[];
          setNames(
            Object.fromEntries(roster.filter((peer) => peer.name).map((peer) => [peer.id, peer.name as string])),
          );
          break;
        }

        case "error":
          setError(String(msg.data));
          setStatus("error");
          break;
      }
    },
    [applyOffer, createPeerConnection],
  );

  /** Opens a signaling session for the room already in roomRef. */
  const openSession = useCallback(() => {
    const name = roomRef.current;
    if (!name || leftRef.current) return;

    const ws = new WebSocket(signalingURL(name));
    wsRef.current = ws;

    ws.onopen = () => {
      // Announced over the socket rather than in the URL, so a display name
      // never lands in a query string or an access log.
      send("identify", { name: nameRef.current });
    };

    ws.onmessage = (event) => {
      let msg: SignalMessage;
      try {
        msg = JSON.parse(event.data as string) as SignalMessage;
      } catch {
        return;
      }

      queue.current = queue.current
        .then(() => handleMessage(msg))
        .catch((handlingError: unknown) => {
          console.error("signaling failed", handlingError);
          // Negotiation is broken; a fresh session is the only way back.
          reconnect.current?.();
        });
    };

    ws.onerror = () => {
      // The event carries no detail; onclose reports whether we ever connected.
      console.error("signaling socket error");
    };

    ws.onclose = () => {
      // Ignore the close that our own teardown caused.
      if (wsRef.current !== ws) return;
      reconnect.current?.();
    };
  }, [handleMessage, send]);

  /**
   * Drops the broken session and opens a fresh one after a backoff. Retries
   * indefinitely: a call worth having is worth waiting out a lift or a train
   * tunnel, and the user can always leave.
   */
  const scheduleReconnect = useCallback(() => {
    if (leftRef.current || !roomRef.current) return;

    closeSession();
    clearTimeout(retryTimer.current);

    attemptRef.current += 1;
    setAttempt(attemptRef.current);
    setStatus("reconnecting");

    const delay = Math.min(RETRY_BASE_MS * 2 ** (attemptRef.current - 1), RETRY_MAX_MS);
    retryTimer.current = setTimeout(openSession, delay);
  }, [closeSession, openSession]);

  useEffect(() => {
    reconnect.current = scheduleReconnect;
  }, [scheduleReconnect]);

  // A machine that just regained its network should not sit out the rest of the
  // backoff it accumulated while offline.
  useEffect(() => {
    const retryNow = () => {
      if (!roomRef.current || leftRef.current || wsRef.current) return;
      clearTimeout(retryTimer.current);
      openSession();
    };

    window.addEventListener("online", retryNow);
    return () => window.removeEventListener("online", retryNow);
  }, [openSession]);

  const join = useCallback(
    async (roomName: string, displayName: string) => {
      const name = roomName.trim();
      if (!ROOM_NAME_PATTERN.test(name)) {
        setError("Room name must be 1-64 characters of A-Z, a-z, 0-9, _ or -");
        setStatus("error");
        return;
      }

      // getUserMedia is only exposed in a secure context, so plain http on a LAN
      // address fails here rather than at the prompt.
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Camera access needs HTTPS, or the page served from localhost");
        setStatus("error");
        return;
      }

      setError(null);
      setStatus("connecting");

      let stream: MediaStream;
      let mediaNotice: string | null;
      try {
        // Acquired before the socket opens so the tracks exist by the time the
        // server's offer arrives.
        ({ stream, notice: mediaNotice } = await acquireMedia());
      } catch (mediaError) {
        setError(describeMediaError(mediaError));
        setStatus("error");
        return;
      }

      localStreamRef.current = stream;
      setLocalStream(stream);
      setNotice(mediaNotice);
      setMicEnabled(stream.getAudioTracks().length > 0);
      setCamEnabled(stream.getVideoTracks().length > 0);
      setRoom(name);
      setMyName(displayName.trim());

      leftRef.current = false;
      attemptRef.current = 0;
      setAttempt(0);
      roomRef.current = name;
      nameRef.current = displayName.trim();

      openSession();
    },
    [openSession],
  );

  // Release the camera and the peer connection if the page navigates away.
  useEffect(() => teardown, [teardown]);

  // Which controls make sense depends on what the machine actually gave us.
  const hasVideo = (localStream?.getVideoTracks().length ?? 0) > 0;
  const hasAudio = (localStream?.getAudioTracks().length ?? 0) > 0;

  const toggleMic = useCallback(() => {
    const next = !micEnabled;
    localStreamRef.current?.getAudioTracks().forEach((track) => (track.enabled = next));
    setMicEnabled(next);
  }, [micEnabled]);

  const toggleCam = useCallback(() => {
    const next = !camEnabled;
    localStreamRef.current?.getVideoTracks().forEach((track) => (track.enabled = next));
    setCamEnabled(next);
  }, [camEnabled]);

  /** A participant that has not identified itself yet still needs a label. */
  const nameFor = useCallback((id: string) => names[id] || fallbackName(id), [names]);

  return {
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
  };
}

/** Whether this tab was told to refuse direct connections; see the TURN section of the README. */
function relayOnly() {
  if (typeof window === "undefined") return false;

  return new URLSearchParams(window.location.search).get("relay") === "1";
}

/**
 * Tries for camera and microphone, then falls back to whatever the machine
 * actually has. A desktop with a microphone but no webcam fails the combined
 * request outright with NotFoundError, and that is not a reason to refuse the
 * call. Returns a notice when we got less than we asked for.
 */
async function acquireMedia(): Promise<{ stream: MediaStream; notice: string | null }> {
  const attempts: { constraints: MediaStreamConstraints; notice: string | null }[] = [
    { constraints: { video: true, audio: true }, notice: null },
    { constraints: { video: false, audio: true }, notice: "No camera found — you joined with audio only." },
    { constraints: { video: true, audio: false }, notice: "No microphone found — you joined without audio." },
  ];

  let lastError: unknown;

  for (const attempt of attempts) {
    try {
      return { stream: await navigator.mediaDevices.getUserMedia(attempt.constraints), notice: attempt.notice };
    } catch (error) {
      lastError = error;

      // Asking for less will not change a denied permission.
      if (error instanceof DOMException && error.name === "NotAllowedError") break;
    }
  }

  throw lastError;
}

function describeMediaError(error: unknown): string {
  if (!(error instanceof DOMException)) return "Could not access the camera or microphone";

  switch (error.name) {
    case "NotAllowedError":
      return "Camera and microphone access was denied";
    case "NotFoundError":
      return "No camera or microphone found";
    case "NotReadableError":
      return "The camera or microphone is already in use by another application";
    default:
      return `Could not access the camera or microphone: ${error.name}`;
  }
}
