/** Signaling protocol shared with the Go SFU. */

export type SignalEvent =
  "welcome" | "offer" | "answer" | "candidate" | "error" | "identify" | "peers" | "media" | "renegotiate";

export interface SignalMessage {
  event: SignalEvent;
  data?: unknown;
}

/** What a participant reports about its own microphone and camera. */
export interface MediaState {
  audio: boolean;
  video: boolean;
}

export const SENDING_EVERYTHING: MediaState = { audio: true, video: true };

/** One entry of the room roster. `name` is absent until that peer identifies itself. */
export interface PeerInfo {
  id: string;
  name?: string;
  /** What that peer says it is sending. Absent from an older server. */
  audio?: boolean;
  video?: boolean;
}

/** Matches the server's cap; longer names are trimmed there anyway. */
export const MAX_NAME_LENGTH = 32;

/** Label to show for a participant that has not given a name. */
export function fallbackName(id: string): string {
  return `Guest ${id.slice(0, 4)}`;
}

/** First frame the server sends: who we are, and which ICE servers to use. */
export interface Welcome {
  id: string;
  room: string;
  iceServers: RTCIceServer[];
}

export const ROOM_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const DEFAULT_SFU_URL = "http://localhost:8080";

/** Builds the websocket URL for a room, upgrading http(s) to ws(s). */
export function signalingURL(room: string): string {
  const url = new URL(`/ws/${encodeURIComponent(room)}`, process.env.NEXT_PUBLIC_SFU_URL || DEFAULT_SFU_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.toString();
}
