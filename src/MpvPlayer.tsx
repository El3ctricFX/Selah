// src/MpvPlayer.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  SkipBack,
  SkipForward,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  init,
  command,
  setProperty,
  observeProperties,
  type MpvConfig,
  type MpvObservableProperty,
} from "tauri-plugin-libmpv-api";

const OBSERVED_PROPERTIES = [
  ["pause", "flag"],
  ["time-pos", "double", "none"],
  ["duration", "double", "none"],
  ["eof-reached", "flag"],
  ["volume", "double"],
  ["idle-active", "flag"],
  ["filename", "string", "none"],
] as const satisfies MpvObservableProperty[];

const MPV_CONFIG: MpvConfig = {
  initialOptions: {
    // CRITICAL: this triggers the plugin's audio-only detection, which
    // tells it to skip window embedding (which doesn't work on Linux).
    vid: "no",
    vo: "null",
    "audio-display": "no",
    "force-window": "no",
    idle: "yes",
    "keep-open": "yes",
    "no-terminal": "yes",
    "gapless-audio": "yes",
  },
  observedProperties: OBSERVED_PROPERTIES,
};

function fmtTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Module-level singleton flag so we don't call mpv init twice if two
// players mount at once (which happens in dev with StrictMode).
let mpvInitialized = false;

export default function MpvPlayer({
  filePath,
  fileName,
}: {
  filePath: string;
  fileName: string;
}) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(true);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [scrubValue, setScrubValue] = useState<number | null>(null);

  // Debug state
  const [mpvFilename, setMpvFilename] = useState<string | null>(null);
  const [idleActive, setIdleActive] = useState<boolean | null>(null);

  const unlistenRef = useRef<(() => void) | null>(null);
  const loadedPathRef = useRef<string | null>(null);

  // ---- initialize once, subscribe to properties ----
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!mpvInitialized) {
        mpvInitialized = true;
        try {
          console.log("[mpv] init() starting");
          await init(MPV_CONFIG);
          console.log("[mpv] init() resolved");
        } catch (e: any) {
          console.error("[mpv] init failed:", e);
          mpvInitialized = false;
          if (!cancelled) {
            setError(e?.message ?? String(e));
          }
          return;
        }
      }

      if (cancelled) return;

      // Mark ready as soon as init resolved so the UI works even if
      // property observation lags.
      setReady(true);

      if (!unlistenRef.current) {
        try {
          console.log("[mpv] observeProperties() starting");
          const unlisten = await observeProperties(
            OBSERVED_PROPERTIES,
            ({ name, data }) => {
              switch (name) {
                case "pause":
                  setPaused(Boolean(data));
                  break;
                case "time-pos":
                  setPosition(typeof data === "number" ? data : 0);
                  break;
                case "duration":
                  setDuration(typeof data === "number" ? data : 0);
                  break;
                case "volume":
                  setVolume(typeof data === "number" ? data : 100);
                  break;
                case "eof-reached":
                  if (data === true) setPaused(true);
                  break;
                case "idle-active":
                  setIdleActive(Boolean(data));
                  break;
                case "filename":
                  setMpvFilename(typeof data === "string" ? data : null);
                  break;
              }
            }
          );
          unlistenRef.current = unlisten;
          console.log("[mpv] observeProperties() resolved");
        } catch (e) {
          console.warn("[mpv] observeProperties failed:", e);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // ---- load the file whenever filePath changes ----
  useEffect(() => {
    if (!ready || !filePath) return;
    if (loadedPathRef.current === filePath) return;
    loadedPathRef.current = filePath;

    (async () => {
      try {
        // filePath is now a plain path (no file:// prefix).
        console.log("[mpv] loadfile:", filePath);
        await command("loadfile", [filePath, "replace"]);
        await setProperty("pause", true);
        setPaused(true);
      } catch (e: any) {
        console.error("[mpv] loadfile failed:", e);
        setError(e?.message ?? String(e));
      }
    })();
  }, [ready, filePath]);

  // ---- cleanup on unmount ----
  useEffect(() => {
    return () => {
      (async () => {
        try {
          unlistenRef.current?.();
          unlistenRef.current = null;
          // Do NOT destroy the instance here. In dev, React StrictMode
          // mounts, unmounts, then remounts. Destroying on the first
          // unmount tears down the mpv instance while the second mount's
          // loadfile is still in flight, which leaves mpv in a broken
          // state. We let the instance live for the lifetime of the app.
        } catch (e) {
          console.warn("[mpv] cleanup failed:", e);
        }
      })();
    };
  }, []);

  const togglePlay = useCallback(async () => {
    try {
      const next = !paused;
      await setProperty("pause", next);
      setPaused(next);
    } catch (e) {
      console.error("[mpv] toggle pause failed:", e);
    }
  }, [paused]);

  const seekTo = useCallback(async (seconds: number) => {
    try {
      await command("seek", [seconds, "absolute"]);
      setPosition(seconds);
    } catch (e) {
      console.error("[mpv] seek failed:", e);
    }
  }, []);

  const skip = useCallback(
    async (delta: number) => {
      const target = Math.max(0, Math.min(duration || 0, position + delta));
      await seekTo(target);
    },
    [position, duration, seekTo]
  );

  const changeVolume = useCallback(
    async (v: number) => {
      const clamped = Math.max(0, Math.min(100, v));
      try {
        await setProperty("volume", clamped);
        setVolume(clamped);
        if (muted && clamped > 0) {
          await setProperty("mute", false);
          setMuted(false);
        }
      } catch (e) {
        console.error("[mpv] set volume failed:", e);
      }
    },
    [muted]
  );

  const toggleMute = useCallback(async () => {
    try {
      const next = !muted;
      await setProperty("mute", next);
      setMuted(next);
    } catch (e) {
      console.error("[mpv] toggle mute failed:", e);
    }
  }, [muted]);

  const openExternal = () => {
    // filePath is a plain path now, so we can pass it straight through.
    openPath(filePath).catch((e) =>
      console.error("[mpv] openPath failed:", e)
    );
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    setScrubValue(Number(e.target.value));
  };

  const commitScrub = async (e: React.MouseEvent<HTMLInputElement>) => {
    const v = Number((e.target as HTMLInputElement).value);
    setScrubValue(null);
    await seekTo(v);
  };

  if (error) {
    return (
      <div className="mt-3 flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
        <AlertTriangle size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-red-300 font-medium">
            Could not start audio player.
          </div>
          <div className="text-[10px] text-red-400/70 mt-0.5 break-words">
            {error}
          </div>
        </div>
        <button
          type="button"
          onClick={openExternal}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200 flex-shrink-0"
        >
          <ExternalLink size={11} /> Open externally
        </button>
      </div>
    );
  }

  const shownPosition = scrubValue ?? position;
  const pct = duration > 0 ? (shownPosition / duration) * 100 : 0;

  return (
    <div className="mt-3 rounded-lg border border-[#2a3136] bg-[#161a1d] p-3 select-none">
      <div className="text-xs text-gray-300 truncate mb-2">{fileName}</div>

      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] text-gray-500 tabular-nums w-9 text-right flex-shrink-0">
          {fmtTime(shownPosition)}
        </span>
        <div className="relative flex-1 h-1.5">
          <div className="absolute inset-0 rounded-full bg-[#2a3136]" />
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-blue-500"
            style={{ width: `${pct}%` }}
          />
          <input
            type="range"
            min={0}
            max={Math.max(duration, 1)}
            step={0.1}
            value={shownPosition}
            disabled={!ready || duration <= 0}
            onChange={handleScrub}
            onMouseUp={commitScrub}
            className="absolute inset-0 w-full h-1.5 opacity-0 cursor-pointer disabled:cursor-not-allowed"
          />
        </div>
        <span className="text-[10px] text-gray-500 tabular-nums w-9 flex-shrink-0">
          {fmtTime(duration)}
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => skip(-10)}
          disabled={!ready}
          className="p-2 rounded-full text-gray-400 hover:text-gray-100 hover:bg-[#2a3136] transition-colors disabled:opacity-40"
          title="Back 10s"
        >
          <SkipBack size={14} />
        </button>

        <button
          type="button"
          onClick={togglePlay}
          disabled={!ready}
          className="flex items-center justify-center w-9 h-9 rounded-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white transition-colors flex-shrink-0"
          title={paused ? "Play" : "Pause"}
        >
          {paused ? (
            <Play size={16} fill="currentColor" className="ml-0.5" />
          ) : (
            <Pause size={16} fill="currentColor" />
          )}
        </button>

        <button
          type="button"
          onClick={() => skip(10)}
          disabled={!ready}
          className="p-2 rounded-full text-gray-400 hover:text-gray-100 hover:bg-[#2a3136] transition-colors disabled:opacity-40"
          title="Forward 10s"
        >
          <SkipForward size={14} />
        </button>

        <div className="flex-1" />

        <button
          type="button"
          onClick={openExternal}
          className="p-2 rounded-full text-gray-400 hover:text-gray-100 hover:bg-[#2a3136] transition-colors"
          title="Open in system player"
        >
          <ExternalLink size={13} />
        </button>

        <button
          type="button"
          onClick={toggleMute}
          disabled={!ready}
          className="p-2 rounded-full text-gray-400 hover:text-gray-100 hover:bg-[#2a3136] transition-colors disabled:opacity-40"
          title={muted ? "Unmute" : "Mute"}
        >
          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>

        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={muted ? 0 : volume}
          disabled={!ready}
          onChange={(e) => changeVolume(Number(e.target.value))}
          className="w-20 accent-blue-500 cursor-pointer disabled:cursor-not-allowed"
        />
      </div>

      {/* Debug line — remove once it works */}
      <div className="mt-2 text-[9px] text-gray-600 font-mono truncate">
        ready={String(ready)} idle={String(idleActive)} loaded={mpvFilename || "—"}
      </div>
    </div>
  );
}