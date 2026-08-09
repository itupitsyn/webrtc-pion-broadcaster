"use client";

import { useEffect, useState } from "react";

/**
 * Which device each kind of media should come from. An empty string means "let
 * the browser decide", which is not the same as any particular device: the
 * default follows the operating system, so unplugging a headset moves with it.
 */
export interface DeviceChoice {
  camera: string;
  microphone: string;
  speaker: string;
}

export const DEFAULT_DEVICES: DeviceChoice = { camera: "", microphone: "", speaker: "" };

const STORAGE_KEY = "webrtc-broadcaster:devices";

/**
 * Reads the stored choice. Must not run while rendering: localStorage does not
 * exist on the server, and a value read during render would not match the
 * server's markup anyway.
 */
export function loadDeviceChoice(): DeviceChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_DEVICES;

    const parsed = JSON.parse(stored) as Partial<DeviceChoice>;

    // Ids are opaque strings that a browser may rotate or scope to an origin, so
    // a stored one can simply stop existing. Nothing validates them here; the
    // constraint is applied as a preference, and a stale id falls back.
    return {
      camera: typeof parsed.camera === "string" ? parsed.camera : "",
      microphone: typeof parsed.microphone === "string" ? parsed.microphone : "",
      speaker: typeof parsed.speaker === "string" ? parsed.speaker : "",
    };
  } catch {
    return DEFAULT_DEVICES;
  }
}

export function saveDeviceChoice(choice: DeviceChoice) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Private mode, a full quota, or storage turned off. Remembering the choice
    // is a convenience; losing it is not worth failing the call over.
  }
}

/**
 * Whether this browser can route playback to a chosen output device. Chromium
 * can; Firefox and Safari play through the system default and offer no way to
 * change it from a page, so the control is hidden there rather than shown broken.
 */
export function canChooseSpeaker(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

/**
 * The devices this browser will admit to. Only useful once permission has been
 * granted: before that the labels are empty and the ids are blank, so there is
 * nothing to put in a menu.
 *
 * Re-enumerates on devicechange, which fires when a headset is plugged in or a
 * webcam is unplugged mid-call.
 */
export function useMediaDevices(enabled: boolean): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    if (!enabled || !navigator.mediaDevices?.enumerateDevices) return;

    let cancelled = false;

    const refresh = () => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((list) => {
          if (!cancelled) setDevices(list);
        })
        .catch((error: unknown) => console.error("could not list devices", error));
    };

    refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);

    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener("devicechange", refresh);
    };
  }, [enabled]);

  return devices;
}

/** The devices of one kind, with a usable label for each. */
export function devicesOfKind(devices: MediaDeviceInfo[], kind: MediaDeviceKind) {
  return devices
    .filter((device) => device.kind === kind && device.deviceId !== "")
    .map((device, index) => ({
      deviceId: device.deviceId,
      // A device can be listed without a label even after permission is granted,
      // and an unlabelled entry in a menu is unpickable.
      label: device.label || `${describeKind(kind)} ${index + 1}`,
    }));
}

function describeKind(kind: MediaDeviceKind): string {
  switch (kind) {
    case "videoinput":
      return "Camera";
    case "audioinput":
      return "Microphone";
    default:
      return "Speaker";
  }
}
