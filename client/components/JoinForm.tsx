"use client";

import { MAX_NAME_LENGTH } from "@/lib/signaling";
import { useEffect, useState, type FormEvent } from "react";

const NAME_STORAGE_KEY = "webrtc-broadcaster:name";

interface JoinFormProps {
  busy: boolean;
  /** Set when the room came from the URL; still editable, since the link may be wrong. */
  initialRoom?: string;
  onJoin: (room: string, name: string) => void;
}

export function JoinForm({ busy, initialRoom = "", onJoin }: JoinFormProps) {
  const [room, setRoom] = useState(initialRoom);
  const [name, setName] = useState("");

  // Read after mount, not during render: localStorage does not exist on the
  // server and reading it while rendering would break hydration.
  useEffect(() => {
    setName(localStorage.getItem(NAME_STORAGE_KEY) ?? "");
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();

    const trimmed = name.trim();
    localStorage.setItem(NAME_STORAGE_KEY, trimmed);
    onJoin(room, trimmed);
  };

  const field =
    "rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-800 dark:text-white";
  const labelStyle = "text-sm font-medium text-gray-700 dark:text-gray-200";

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-3">
      <label htmlFor="name" className={labelStyle}>
        Your name
      </label>
      <input
        id="name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Alex"
        autoComplete="nickname"
        maxLength={MAX_NAME_LENGTH}
        disabled={busy}
        // Arriving through a link, the name is the only thing left to fill in.
        autoFocus={initialRoom !== ""}
        className={field}
      />

      <label htmlFor="room" className={labelStyle}>
        Room name
      </label>
      <input
        id="room"
        value={room}
        onChange={(event) => setRoom(event.target.value)}
        placeholder="standup"
        autoComplete="off"
        disabled={busy}
        className={field}
      />

      <button
        type="submit"
        disabled={busy || room.trim() === "" || name.trim() === ""}
        className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500/50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Joining…" : "Join call"}
      </button>
    </form>
  );
}
