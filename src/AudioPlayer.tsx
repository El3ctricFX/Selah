// src/AudioPlayer.tsx
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, Volume2, VolumeX } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { loadAbbaNoteAssetBlob, abbaNoteAssetPath } from "./abbaAssets";

export default function AudioPlayer({
  abbaDir,
  section,
  noteId,
  fileName,
  displayName,
}: {
  abbaDir: string;
  section: string;
  noteId: string;
  fileName: string;
  displayName: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [ready, setReady] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setError(null);
    setReady(false);
    loadAbbaNoteAssetBlob(abbaDir, section, noteId, fileName).then((url) => {
      if (cancelled) return;
      if (!url) {
        setError("Could not read the audio file.");
        return;
      }
      setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [abbaDir, section, noteId, fileName]);

  // Force WebKit to load the blob immediately so the native controls stop
  // showing a spinner before the user presses play.
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !src) return;
    try {
      el.load();
    } catch (e) {
      console.warn("[audio] load() failed:", e);
    }
  }, [src]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.volume = volume / 100;
    el.muted = muted;
  }, [volume, muted, src]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const openExternal = () => {
    openPath(abbaNoteAssetPath(abbaDir, section, noteId, fileName)).catch((e) =>
      console.error("[audio] openPath failed:", e)
    );
  };

  const changeVolume = (v: number) => {
    const clamped = Math.max(0, Math.min(100, v));
    setVolume(clamped);
    if (muted && clamped > 0) setMuted(false);
  };

  const toggleMute = () => setMuted((m) => !m);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const W = 240;
    const H = 90;
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - W - 8),
      y: Math.min(e.clientY, window.innerHeight - H - 8),
    });
  };

  if (error) {
    return (
      <div className="mt-3 flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
        <AlertTriangle size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-red-300 font-medium">
            Could not load audio player.
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

  return (
    <div className="mt-3 rounded-lg border border-[#2a3136] bg-[#161a1d] p-3">
      <div className="text-xs text-gray-300 truncate mb-2">{displayName}</div>

      <div onContextMenu={handleContextMenu}>
        {src ? (
          <audio
            ref={audioRef}
            controls
            preload="auto"
            src={src}
            onLoadedMetadata={() => setReady(true)}
            onCanPlay={() => setReady(true)}
            onError={() => setError("The browser could not play this file.")}
            className="w-full"
            style={{ height: 40, opacity: ready ? 1 : 0.6 }}
          />
        ) : (
          <div className="h-10 bg-[#0f1315] rounded animate-pulse" />
        )}
      </div>

      <p className="mt-2 text-[10px] text-gray-600">
        Right-click the player for volume options
      </p>

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-[300] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-2xl p-3 w-[240px]"
          style={{ top: menu.y, left: menu.x }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
            Volume
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleMute}
              className="p-1.5 rounded text-gray-400 hover:text-gray-100 hover:bg-[#2a3136] transition-colors flex-shrink-0"
              title={muted ? "Unmute" : "Mute"}
            >
              {muted || volume === 0 ? (
                <VolumeX size={14} />
              ) : (
                <Volume2 size={14} />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={muted ? 0 : volume}
              onChange={(e) => changeVolume(Number(e.target.value))}
              className="flex-1 accent-blue-500 cursor-pointer"
              title={`Volume: ${muted ? 0 : volume}%`}
            />
            <span className="text-[10px] text-gray-400 tabular-nums w-8 text-right flex-shrink-0">
              {muted ? 0 : volume}%
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setMenu(null);
              openExternal();
            }}
            className="mt-3 w-full flex items-center gap-1.5 text-[11px] text-gray-400 hover:text-gray-200 hover:bg-[#2a3136] px-2 py-1.5 rounded transition-colors"
          >
            <ExternalLink size={11} /> Open in system player
          </button>
        </div>
      )}
    </div>
  );
}