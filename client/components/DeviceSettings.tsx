"use client";

import { canChooseSpeaker, devicesOfKind, type DeviceChoice } from "@/lib/devices";
import { useEffect, useState } from "react";

interface DeviceSettingsProps {
  /** Everything the browser will admit to, refreshed as devices come and go. */
  available: MediaDeviceInfo[];
  selected: DeviceChoice;
  /** A device is already being opened; a second one would race it. */
  busy: boolean;
  onSelect: (kind: keyof DeviceChoice, deviceId: string) => void;
}

/**
 * Picks which camera, microphone and speaker the call uses. Switching any of
 * them takes effect immediately, so this is not a form and has nothing to submit.
 */
export function DeviceSettings({ available, selected, busy, onSelect }: DeviceSettingsProps) {
  // Whether the browser can route audio anywhere is decided by the browser, and
  // reading that during render would disagree with the server's markup.
  const [speakerSupported, setSpeakerSupported] = useState(false);
  useEffect(() => setSpeakerSupported(canChooseSpeaker()), []);

  const cameras = devicesOfKind(available, "videoinput");
  const microphones = devicesOfKind(available, "audioinput");
  const speakers = devicesOfKind(available, "audiooutput");

  return (
    <section className="grid w-full gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:grid-cols-3 dark:border-gray-700 dark:bg-gray-800">
      <DeviceSelect
        id="camera"
        label="Camera"
        options={cameras}
        value={selected.camera}
        emptyLabel="No camera found"
        busy={busy}
        onChange={(deviceId) => onSelect("camera", deviceId)}
      />

      <DeviceSelect
        id="microphone"
        label="Microphone"
        options={microphones}
        value={selected.microphone}
        emptyLabel="No microphone found"
        busy={busy}
        onChange={(deviceId) => onSelect("microphone", deviceId)}
      />

      {speakerSupported ? (
        <DeviceSelect
          id="speaker"
          label="Speakers"
          options={speakers}
          value={selected.speaker}
          emptyLabel="No output device found"
          onChange={(deviceId) => onSelect("speaker", deviceId)}
        />
      ) : (
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Speakers</span>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            This browser plays through the system default and cannot be redirected from a page.
          </p>
        </div>
      )}
    </section>
  );
}

interface DeviceSelectProps {
  id: string;
  label: string;
  options: { deviceId: string; label: string }[];
  value: string;
  emptyLabel: string;
  /** Nothing routes through the connection, so the speaker never has to wait. */
  busy?: boolean;
  onChange: (deviceId: string) => void;
}

function DeviceSelect({ id, label, options, value, emptyLabel, busy = false, onChange }: DeviceSelectProps) {
  // A remembered device that is no longer plugged in would leave the select
  // showing nothing, which reads as a broken control rather than a missing
  // device — so say which one is actually in use.
  const missing = value !== "" && !options.some((option) => option.deviceId === value);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-gray-700 dark:text-gray-200">
        {label}
      </label>

      <select
        id={id}
        value={missing ? "" : value}
        disabled={busy || options.length === 0}
        onChange={(event) => onChange(event.target.value)}
        className="w-full truncate rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
      >
        {options.length === 0 ? (
          <option value="">{emptyLabel}</option>
        ) : (
          <>
            {/* Not the same as naming a device: the system default follows the
                machine, so plugging in a headset moves the call with it. */}
            <option value="">System default</option>
            {options.map((option) => (
              <option key={option.deviceId} value={option.deviceId}>
                {option.label}
              </option>
            ))}
          </>
        )}
      </select>

      {missing && <p className="text-xs text-amber-600 dark:text-amber-400">The remembered device is not connected.</p>}
    </div>
  );
}
