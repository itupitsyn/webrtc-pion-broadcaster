"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_DEVICES, loadDeviceChoice, saveDeviceChoice, useMediaDevices, type DeviceChoice } from "./devices";
import {
  fallbackName,
  ROOM_NAME_PATTERN,
  SENDING_EVERYTHING,
  signalingURL,
  type MediaState,
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
  /** What we are sending: `audio` is the microphone unmuted, `video` a live camera. */
  const [media, setMedia] = useState<MediaState>(SENDING_EVERYTHING);
  /** Whether we hold a microphone at all, which is not the same as an unmuted one. */
  const [hasAudio, setHasAudio] = useState(false);
  /** Consecutive failed attempts, so the UI can say more than "wait". */
  const [attempt, setAttempt] = useState(0);
  /** Display names by participant id, as last broadcast by the server. */
  const [names, setNames] = useState<Record<string, string>>({});
  /** What each peer says it is sending, so a stopped camera is not a frozen frame. */
  const [peerMedia, setPeerMedia] = useState<Record<string, MediaState>>({});
  const [myName, setMyName] = useState("");
  const [devices, setDevices] = useState<DeviceChoice>(DEFAULT_DEVICES);
  /** A device is being opened, so the controls that would open another are held. */
  const [switching, setSwitching] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  // Our own senders, by kind. Kept here rather than looked up on the peer
  // connection: a sender whose track was replaced with null has nothing left to
  // identify it by, and the connection is full of other senders anyway — every
  // peer we subscribe to adds one.
  const senders = useRef<{ audio: RTCRtpSender | null; video: RTCRtpSender | null }>({ audio: null, video: null });

  // What a reconnection needs to know: which room, under what name, and whether
  // the user has since walked away.
  const roomRef = useRef<string | null>(null);
  const nameRef = useRef("");
  const leftRef = useRef(false);
  const attemptRef = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>();

  // Read by callbacks that must not be rebuilt whenever either one changes.
  const mediaRef = useRef<MediaState>(SENDING_EVERYTHING);
  const devicesRef = useRef<DeviceChoice>(DEFAULT_DEVICES);

  // Opening a device is serialized; this is the tail of that chain.
  const deviceQueue = useRef<Promise<void>>(Promise.resolve());

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
   * Records what we are sending and tells the room. The server relays this
   * verbatim: it forwards RTP without inspecting it, so a camera that stopped
   * and one that stalled look identical to everyone downstream unless we say
   * which it was.
   */
  const reportMedia = useCallback(
    (next: MediaState) => {
      mediaRef.current = next;
      setMedia(next);
      send("media", next);
    },
    [send],
  );

  // The device list is only meaningful once permission has been granted, which
  // joining is what does.
  const available = useMediaDevices(localStream !== null);

  // Read after mount, not during render: localStorage does not exist on the
  // server, and joining needs the stored choice before any UI shows it.
  useEffect(() => {
    const stored = loadDeviceChoice();
    devicesRef.current = stored;
    setDevices(stored);
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
    senders.current = { audio: null, video: null };

    pendingCandidates.current = [];
    remoteDescriptionSet.current = false;
    queue.current = Promise.resolve();

    // The streams behind these belong to the old peer connection and are dead.
    setRemotes([]);
    setNames({});
    setPeerMedia({});
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
    setHasAudio(false);
    mediaRef.current = SENDING_EVERYTHING;
    setMedia(SENDING_EVERYTHING);
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
      // what attach to them when we answer, so they must be added up front. A
      // kind we have nothing for gets no sender, and turning that device on later
      // is what needs a renegotiation.
      senders.current = { audio: null, video: null };
      const stream = localStreamRef.current;
      stream?.getTracks().forEach((track) => {
        senders.current[track.kind as "audio" | "video"] = pc.addTrack(track, stream);
      });

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
          setPeerMedia(
            // A server that predates the media report says nothing about either
            // device, and a peer is far more often sending than not.
            Object.fromEntries(
              roster.map((peer) => [peer.id, { audio: peer.audio ?? true, video: peer.video ?? true }]),
            ),
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
      // A reconnection rejoins under a new id, so whatever we told the room
      // before is gone with it.
      send("media", mediaRef.current);
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
        ({ stream, notice: mediaNotice } = await acquireMedia(devicesRef.current));
      } catch (mediaError) {
        setError(describeMediaError(mediaError));
        setStatus("error");
        return;
      }

      localStreamRef.current = stream;
      setLocalStream(stream);
      setNotice(mediaNotice);
      setHasAudio(stream.getAudioTracks().length > 0);
      mediaRef.current = {
        audio: stream.getAudioTracks().length > 0,
        video: stream.getVideoTracks().length > 0,
      };
      setMedia(mediaRef.current);
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

  /**
   * Puts `track` on the wire as this side's audio or video, releasing whatever
   * was there before.
   *
   * replaceTrack whenever a sender already exists: it swaps what is sent without
   * renegotiating, so changing camera mid-call costs nobody an SDP exchange. The
   * first track of a kind is the exception — joining without a camera leaves that
   * m-line negotiated inactive, and reviving it takes an offer, which only the
   * server ever sends.
   */
  const setLocalTrack = useCallback(
    async (kind: "audio" | "video", track: MediaStreamTrack | null) => {
      const stream = localStreamRef.current;
      if (!stream) {
        track?.stop();
        return;
      }

      // The stream is mutated rather than replaced: the local tile's <video>
      // keeps the same srcObject, so a camera swap does not blank the preview or
      // restart the element.
      const previous = kind === "video" ? stream.getVideoTracks() : stream.getAudioTracks();
      for (const old of previous) {
        stream.removeTrack(old);
        // Stopped, not just detached: this is what turns the camera light off.
        old.stop();
      }
      if (track) stream.addTrack(track);

      if (kind === "audio") setHasAudio(track !== null);

      const pc = pcRef.current;
      if (!pc) return;

      const sender = senders.current[kind];
      if (sender) {
        await sender.replaceTrack(track);
        return;
      }

      if (!track) return;

      senders.current[kind] = pc.addTrack(track, stream);
      send("renegotiate", null);
    },
    [send],
  );

  /** Muting leaves the microphone open, which is what makes unmuting instant. */
  const toggleMic = useCallback(() => {
    const audio = !mediaRef.current.audio;
    localStreamRef.current?.getAudioTracks().forEach((track) => (track.enabled = audio));
    reportMedia({ ...mediaRef.current, audio });
  }, [reportMedia]);

  /**
   * Runs device work one piece at a time. Opening a device takes long enough to
   * click again, and two overlapping switches race over the same sender: the
   * slower one wins the wire while the faster one leaves a camera open that
   * nothing is sending.
   */
  const enqueue = useCallback((work: () => Promise<void>) => {
    setSwitching(true);

    const queued: Promise<void> = deviceQueue.current
      .then(work)
      .catch((workError: unknown) => setNotice(describeMediaError(workError)))
      .finally(() => {
        // Only whatever ended up last in the chain clears the flag; anything
        // before it still has work queued behind.
        if (deviceQueue.current === queued) setSwitching(false);
      });

    deviceQueue.current = queued;
  }, []);

  /**
   * Turns the camera off by releasing it, not by blanking it: `enabled = false`
   * keeps the device open, its light on, and black frames going out. The price is
   * that switching back on reopens the device, which takes a moment and can fail.
   */
  const toggleCam = useCallback(() => {
    enqueue(async () => {
      if (mediaRef.current.video) {
        await setLocalTrack("video", null);
        reportMedia({ ...mediaRef.current, video: false });
        return;
      }

      const track = await openTrack("video", devicesRef.current.camera);
      await setLocalTrack("video", track);
      reportMedia({ ...mediaRef.current, video: true });
      // Whatever the notice said about the camera, it no longer holds.
      setNotice(null);
    });
  }, [enqueue, reportMedia, setLocalTrack]);

  /**
   * Switches one device. The speaker is applied by the elements that play the
   * audio and needs nothing from the connection; a camera or microphone is
   * reopened and swapped onto the sender that is already there.
   */
  const selectDevice = useCallback(
    (kind: keyof DeviceChoice, deviceId: string) => {
      const next = { ...devicesRef.current, [kind]: deviceId };
      devicesRef.current = next;
      setDevices(next);
      saveDeviceChoice(next);

      if (kind === "speaker" || !localStreamRef.current) return;

      const track = kind === "camera" ? "video" : "audio";

      enqueue(async () => {
        const opened = await openTrack(track, deviceId);
        // A microphone picked while muted must not start sending.
        opened.enabled = track === "audio" ? mediaRef.current.audio : true;

        await setLocalTrack(track, opened);
        // Picking a camera is also how you turn one back on.
        if (track === "video") reportMedia({ ...mediaRef.current, video: true });
        setNotice(null);
      });
    },
    [enqueue, reportMedia, setLocalTrack],
  );

  /** A participant that has not identified itself yet still needs a label. */
  const nameFor = useCallback((id: string) => names[id] || fallbackName(id), [names]);

  /** What a peer says it is sending; assume both until it has told us otherwise. */
  const mediaFor = useCallback((id: string) => peerMedia[id] ?? SENDING_EVERYTHING, [peerMedia]);

  return {
    status,
    error,
    notice,
    attempt,
    room,
    myName,
    nameFor,
    mediaFor,
    localStream,
    remotes,
    micEnabled: media.audio,
    camEnabled: media.video,
    hasAudio,
    switching,
    devices,
    available,
    join,
    leave,
    toggleMic,
    toggleCam,
    selectDevice,
  };
}

/** Whether this tab was told to refuse direct connections; see the TURN section of the README. */
function relayOnly() {
  if (typeof window === "undefined") return false;

  return new URLSearchParams(window.location.search).get("relay") === "1";
}

/**
 * Opens one device as a single track.
 *
 * `exact` is deliberate: this is only reached from an explicit choice, and a
 * browser that quietly hands back a different camera would leave the menu naming
 * one device while another is on the air.
 */
async function openTrack(kind: "audio" | "video", deviceId: string): Promise<MediaStreamTrack> {
  const constraint: MediaTrackConstraints = deviceId ? { deviceId: { exact: deviceId } } : {};
  const stream = await navigator.mediaDevices.getUserMedia(
    kind === "video" ? { video: constraint } : { audio: constraint },
  );

  const [track] = stream.getTracks();
  if (!track) throw new DOMException("device produced no track", "NotFoundError");

  return track;
}

/**
 * Tries for camera and microphone, then falls back to whatever the machine
 * actually has. A desktop with a microphone but no webcam fails the combined
 * request outright with NotFoundError, and that is not a reason to refuse the
 * call. Returns a notice when we got less than we asked for.
 *
 * A remembered device is a preference here rather than a requirement: ids do not
 * survive a webcam being unplugged, and a stale one must not be the reason a call
 * cannot start.
 */
async function acquireMedia(devices: DeviceChoice): Promise<{ stream: MediaStream; notice: string | null }> {
  const video: MediaTrackConstraints = devices.camera ? { deviceId: devices.camera } : {};
  const audio: MediaTrackConstraints = devices.microphone ? { deviceId: devices.microphone } : {};

  const attempts: { constraints: MediaStreamConstraints; notice: string | null }[] = [
    { constraints: { video, audio }, notice: null },
    { constraints: { video: false, audio }, notice: "No camera found — you joined with audio only." },
    { constraints: { video, audio: false }, notice: "No microphone found — you joined without audio." },
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
  // Matched on name rather than type: OverconstrainedError is its own interface
  // and not a DOMException, so an `instanceof` check would miss exactly the case
  // a remembered device id produces.
  const name =
    typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
  if (!name) return "Could not access the camera or microphone";

  switch (name) {
    case "NotAllowedError":
      return "Camera and microphone access was denied";
    case "NotFoundError":
      return "No camera or microphone found";
    case "OverconstrainedError":
      return "That device is no longer available";
    case "NotReadableError":
      return "The camera or microphone is already in use by another application";
    default:
      return `Could not access the camera or microphone: ${name}`;
  }
}
