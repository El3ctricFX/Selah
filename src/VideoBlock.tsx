// src/VideoBlock.tsx
import { createReactBlockSpec } from "@blocknote/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { readFile, exists } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Video as VideoIcon,
  ExternalLink,
  X,
  Loader2,
  Wand2,
  AlertTriangle,
} from "lucide-react";
import { useNoteMode } from "./useNoteMode";
import { useNoteContext } from "./NoteContext";
import { assetUrlToAbsolutePath } from "./imageAssets";

const PROBE_TIMEOUT_MS = 4000;

// ── In-flight proxy conversions ─────────────────────────────────────────────
// Module-level so it survives component remounts (note navigation). Keyed by
// the proxy's absolute output path. If a conversion is already running for
// that path, new callers just join the existing promise instead of starting
// a second ffmpeg.
const inflightProxies = new Map<string, Promise<void>>();

function ensureProxy(input: string, output: string): Promise<void> {
  const existing = inflightProxies.get(output);
  if (existing) return existing;
  const p = (async () => {
    try {
      await invoke("convert_to_webm", { input, output });
    } finally {
      inflightProxies.delete(output);
    }
  })();
  inflightProxies.set(output, p);
  return p;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function mimeForVideoExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case "webm": return "video/webm";
    case "ogv":  return "video/ogg";
    case "mp4":  case "m4v": return "video/mp4";
    case "mov":  return "video/quicktime";
    case "mkv":  return "video/x-matroska";
    case "avi":  return "video/x-msvideo";
    default:     return "application/octet-stream";
  }
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.substring(0, i);
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.substring(i + 1);
}

function proxyPathFor(absOriginal: string): string {
  const dir = dirname(absOriginal);
  const name = basename(absOriginal);
  const sep = absOriginal.includes("\\") ? "\\" : "/";
  return `${dir}${sep}proxy videos${sep}${name}.webm`;
}

async function makeBlobUrl(absPath: string): Promise<string> {
  const bytes = await readFile(absPath);
  const ext = absPath.split(".").pop()?.toLowerCase() || "mp4";
  const blob = new Blob([bytes], { type: mimeForVideoExt(ext) });
  return URL.createObjectURL(blob);
}

function maybeNeedsProxy(absPath: string): boolean {
  const ext = absPath.split(".").pop()?.toLowerCase() || "";
  return ext !== "webm" && ext !== "ogv";
}

function fmtEta(s: number): string {
  if (s < 0) return "estimating…";
  if (s < 15) return "almost done";
  if (s < 60) return `~${s}s left`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `~${m}m ${sec.toString().padStart(2, "0")}s left`;
}

/**
 * Turn whatever is in the block's `src` prop into an absolute filesystem
 * path. Handles every shape we might see:
 *
 *   - `asset://localhost/<encoded>` (Linux/macOS)
 *   - `http://asset.localhost/<encoded>` (Windows)
 *   - `/abs/path/file.webm` (already absolute)
 *   - `assets/September 27, 2026/test1.webm` (relative to the note dir)
 *   - `test1.webm` (relative, filename only)
 */
function resolveToAbsolute(src: string, noteDir: string): string {
  if (!src) return "";

  const fromAsset = assetUrlToAbsolutePath(src);
  if (fromAsset) return fromAsset;

  if (/^([a-zA-Z]:[\\/]|\/)/.test(src)) return src;

  if (noteDir) {
    const decoded = src.replace(/%20/g, " ");
    const sep = noteDir.includes("\\") ? "\\" : "/";
    return noteDir.replace(/[\\/]+$/, "") + sep + decoded;
  }

  return src;
}

type Phase = "loading" | "ready" | "unplayable" | "generating" | "fatal";

interface ProgressPayload {
  output: string;
  percent: number;
  eta_sec: number;
}

// ── Block ───────────────────────────────────────────────────────────────────
export const createVideo = createReactBlockSpec(
  {
    type: "video",
    propSchema: {
      src: { default: "" },
      caption: { default: "" },
      fileName: { default: "" },
    },
    content: "none",
  },
  {
    render: (props) => {
      const live = props.editor.getBlock(props.block.id) ?? props.block;
      const src = (live.props.src as string) || "";
      const caption = (live.props.caption as string) || "";
      const fileName = (live.props.fileName as string) || "";

      const { mode } = useNoteMode();
      const isReadMode = mode === "read";
      const noteCtx = useNoteContext();
      const noteDir = noteCtx?.noteDir || "";

      const [playable, setPlayable] = useState<string>("");
      const [usingProxy, setUsingProxy] = useState(false);
      const [phase, setPhase] = useState<Phase>("loading");
      const [errorMsg, setErrorMsg] = useState<string>("");
      const [progress, setProgress] = useState<{ percent: number; etaSec: number }>({
        percent: 0,
        etaSec: -1,
      });

      const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

      const absOriginal = src ? resolveToAbsolute(src, noteDir) : "";
      const proxyPath = absOriginal ? proxyPathFor(absOriginal) : "";

      const clearProbe = () => {
        if (probeTimerRef.current) {
          clearTimeout(probeTimerRef.current);
          probeTimerRef.current = null;
        }
      };

      // ── Load: prefer proxy if it exists, else the original ──────────────
      useEffect(() => {
        let cancelled = false;
        let revoked: string | null = null;

        clearProbe();
        setPlayable("");
        setUsingProxy(false);
        setErrorMsg("");
        setProgress({ percent: 0, etaSec: -1 });

        console.log("[video] load", {
          src,
          noteDir,
          absOriginal,
          proxyPath,
        });

        if (!src) {
          setPhase("ready");
          return;
        }

        // Conversion already running? Show progress immediately.
        if (proxyPath && inflightProxies.has(proxyPath)) {
          setPhase("generating");
          return;
        }

        // Remote URL — hand straight to <video>, no probe.
        if (
          /^https?:\/\//i.test(src) &&
          !/^https?:\/\/asset\.localhost\//i.test(src)
        ) {
          setPlayable(src);
          setPhase("ready");
          return;
        }
        if (/^(data|blob):/i.test(src)) {
          setPlayable(src);
          setPhase("ready");
          return;
        }

        // If we couldn't turn src into an absolute path, fail loudly.
        if (!absOriginal || !/^([a-zA-Z]:[\\/]|\/)/.test(absOriginal)) {
          console.error("[video] could not resolve src to absolute path:", {
            src,
            noteDir,
            absOriginal,
          });
          setErrorMsg(
            noteDir
              ? `Could not resolve video path: ${src}`
              : "Note directory unavailable — try reopening the note."
          );
          setPhase("fatal");
          return;
        }

        (async () => {
          try {
            let toLoad = absOriginal;
            let isProxy = false;
            try {
              if (await exists(proxyPath)) {
                toLoad = proxyPath;
                isProxy = true;
              }
            } catch {}

            if (cancelled) return;
            console.log("[video] reading", toLoad);
            const url = await makeBlobUrl(toLoad);
            if (cancelled) { URL.revokeObjectURL(url); return; }
            revoked = url;
            setPlayable(url);
            setUsingProxy(isProxy);
            setPhase("ready");

            clearProbe();
            probeTimerRef.current = setTimeout(() => {
              probeTimerRef.current = null;
              if (isProxy) {
                setPhase("fatal");
                setErrorMsg("Playback copy failed to decode.");
              } else if (maybeNeedsProxy(absOriginal)) {
                setPhase("unplayable");
              } else {
                setPhase("fatal");
                setErrorMsg("This file could not be played.");
              }
            }, PROBE_TIMEOUT_MS);
          } catch (e: any) {
            console.error("[video] could not read file:", e);
            if (cancelled) return;
            setErrorMsg(e?.message ?? String(e));
            setPhase("fatal");
          }
        })();

        return () => {
          cancelled = true;
          clearProbe();
          if (revoked) URL.revokeObjectURL(revoked);
        };
      }, [src, absOriginal, proxyPath, noteDir]);

      // ── Subscribe to progress events while generating ───────────────────
      useEffect(() => {
        if (phase !== "generating" || !proxyPath) return;
        let unlisten: UnlistenFn | null = null;
        let cancelled = false;

        (async () => {
          const un = await listen<ProgressPayload>("proxy-progress", (evt) => {
            if (evt.payload.output !== proxyPath) return;
            setProgress({
              percent: evt.payload.percent,
              etaSec: evt.payload.eta_sec,
            });
          });
          if (cancelled) {
            un();
          } else {
            unlisten = un;
          }
        })();

        return () => {
          cancelled = true;
          if (unlisten) unlisten();
        };
      }, [phase, proxyPath]);

      const onVideoLoadedMetadata = useCallback(() => {
        clearProbe();
      }, []);

      const onVideoError = useCallback(() => {
        clearProbe();
        if (usingProxy) {
          setPhase("fatal");
          setErrorMsg("Playback copy failed to decode.");
          return;
        }
        if (maybeNeedsProxy(absOriginal)) {
          setPhase("unplayable");
        } else {
          setPhase("fatal");
          setErrorMsg("This file could not be played.");
        }
      }, [usingProxy, absOriginal]);

      // ── Generate the proxy ──────────────────────────────────────────────
      const generateProxy = useCallback(async () => {
        if (!absOriginal || !proxyPath) return;
        clearProbe();
        setProgress({ percent: 0, etaSec: -1 });
        setPhase("generating");
        console.log("[video] generate start:", { absOriginal, proxyPath });

        let settled = false;

        const finalize = async () => {
          if (settled) return;
          settled = true;
          try {
            console.log("[video] reading proxy blob…");
            const url = await makeBlobUrl(proxyPath);
            console.log("[video] proxy blob ready");
            setPlayable(url);
            setUsingProxy(true);
            setPhase("ready");
            clearProbe();
            probeTimerRef.current = setTimeout(() => {
              probeTimerRef.current = null;
              setPhase("fatal");
              setErrorMsg("Playback copy failed to decode.");
            }, PROBE_TIMEOUT_MS);
          } catch (e: any) {
            console.error("[video] proxy read failed:", e);
            setErrorMsg(e?.message ?? String(e));
            setPhase("fatal");
          }
        };

        // Fire the conversion. Don't block on it — in some environments the
        // invoke promise doesn't resolve back to JS even though Rust finished,
        // so polling the file is the reliable signal.
        const conversion = ensureProxy(absOriginal, proxyPath);

        // Poll for the output file. 500ms cadence, up to ~30 minutes.
        // Fire-and-forget: we don't await this because the conversion
        // promise below is the one whose resolution we care about for
        // error reporting. The poller exists only as a fallback for
        // environments where the invoke promise doesn't come back.
        void (async () => {
          for (let i = 0; i < 3600; i++) {
            if (settled) return;
            await new Promise((r) => setTimeout(r, 500));
            if (settled) return;
            try {
              if (await exists(proxyPath)) {
                console.log("[video] proxy file found after", i + 1, "polls");
                await finalize();
                return;
              }
            } catch {}
          }
          if (!settled) {
            settled = true;
            setErrorMsg("Conversion timed out.");
            setPhase("fatal");
          }
        })();

        // Also await the conversion itself for error reporting.
        try {
          await conversion;
          console.log("[video] invoke resolved");
          await finalize();
        } catch (e: any) {
          console.error("[video] ensureProxy rejected:", e);
          if (!settled) {
            settled = true;
            setErrorMsg(e?.message ?? String(e));
            setPhase("fatal");
          }
        }
      }, [absOriginal, proxyPath]);

      const update = (patch: Record<string, any>) => {
        try {
          props.editor.updateBlock(props.block.id, { props: patch });
        } catch (e) {
          console.error("[video] updateBlock failed:", e);
        }
      };

      const openExternal = () => {
        if (!absOriginal) return;
        openPath(absOriginal).catch((e) =>
          console.error("[video] openPath failed:", e)
        );
      };

      if (!src) {
        return (
          <div
            className="my-2 w-full rounded-md border border-dashed border-[#30363d] bg-[#0f1315] py-10 flex flex-col items-center justify-center text-gray-500 gap-2 text-xs"
            contentEditable={false}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <VideoIcon size={22} className="opacity-50" />
            <span>Empty video block — upload a file from the / menu</span>
          </div>
        );
      }

      const showFooter = !isReadMode || !!caption;

      return (
        <div
          className="my-2 w-full rounded-md border border-[#2a3136] bg-[#0f1315] overflow-hidden relative group"
          contentEditable={false}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {phase === "loading" && (
            <div className="w-full h-40 bg-black/40 flex items-center justify-center">
              <Loader2 size={20} className="animate-spin text-gray-600" />
            </div>
          )}

          {phase === "generating" && (
            <div className="w-full py-7 px-5 flex flex-col items-center gap-3 text-xs">
              <div className="flex items-center gap-2 text-gray-300">
                <Loader2 size={14} className="animate-spin text-blue-400" />
                <span className="font-medium">
                  {progress.percent >= 100
                    ? "Loading into player…"
                    : "Generating playback copy…"}
                </span>
              </div>

              <div className="w-full max-w-md h-1.5 rounded-full bg-[#2a3136] overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-[width] duration-300 ease-out"
                  style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
                />
              </div>

              <div className="flex items-center gap-3 text-[11px] text-gray-500 tabular-nums">
                <span className="text-gray-300 font-medium">
                  {progress.percent > 0
                    ? `${Math.round(progress.percent)}%`
                    : "starting…"}
                </span>
                <span className="text-gray-700">·</span>
                <span>{fmtEta(progress.etaSec)}</span>
              </div>

              <p className="text-[10px] text-gray-600 text-center max-w-sm leading-relaxed mt-1">
                Your original file is safe. You can navigate away — the
                conversion continues in the background.
              </p>
            </div>
          )}

          {phase === "unplayable" && (
            <div className="w-full py-6 px-4 flex flex-col items-center gap-3 text-xs text-center">
              <div className="flex items-center gap-2 text-amber-300">
                <AlertTriangle size={14} />
                <span className="font-medium">
                  This format can't play inline on this system.
                </span>
              </div>
              <p className="text-[11px] text-gray-400 max-w-md leading-relaxed">
                Your original file is safe and untouched. Generate a playback
                copy just for this system? It's stored in{" "}
                <span className="font-mono">proxy videos/</span> and can be
                deleted any time without affecting the original.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={generateProxy}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
                >
                  <Wand2 size={12} /> Generate playback copy
                </button>
                <button
                  type="button"
                  onClick={openExternal}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200"
                >
                  <ExternalLink size={12} /> Open original
                </button>
              </div>
            </div>
          )}

          {phase === "fatal" && (
            <div className="w-full py-6 px-4 flex flex-col items-center gap-2 text-xs text-red-300 text-center">
              <span className="font-medium">Could not play this video.</span>
              {errorMsg && (
                <span className="text-[10px] text-red-300/60 break-words max-w-md">
                  {errorMsg}
                </span>
              )}
              <button
                type="button"
                onClick={openExternal}
                className="mt-1 flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200"
              >
                <ExternalLink size={12} /> Open original in system player
              </button>
            </div>
          )}

          {phase === "ready" && playable && (
            <video
              src={playable}
              controls
              preload="metadata"
              className="w-full max-h-[520px] bg-black block"
              onLoadedMetadata={onVideoLoadedMetadata}
              onError={onVideoError}
            />
          )}

          {phase === "ready" && !showFooter && (
            <button
              type="button"
              onClick={openExternal}
              className="absolute top-2 right-2 p-1.5 rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
              title="Open original in system player"
            >
              <ExternalLink size={12} />
            </button>
          )}

          {showFooter && (
            <div className="flex items-center gap-2 px-2.5 py-1.5 border-t border-[#2a3136] bg-[#161a1d]">
              <VideoIcon size={12} className="text-blue-400 flex-shrink-0" />

              {isReadMode ? (
                caption ? (
                  <div className="flex-1 min-w-0 text-xs text-gray-300 truncate">
                    {caption}
                  </div>
                ) : (
                  <div className="flex-1" />
                )
              ) : (
                <input
                  type="text"
                  value={caption}
                  onChange={(e) => update({ caption: e.target.value })}
                  placeholder="Caption (optional)…"
                  className="flex-1 min-w-0 bg-transparent border-none outline-none text-xs text-gray-200 placeholder-gray-600"
                />
              )}

              {fileName && (
                <span
                  className="text-[10px] text-gray-500 truncate max-w-[180px] flex-shrink-0"
                  title={fileName}
                >
                  {fileName}
                </span>
              )}

              {usingProxy && (
                <span
                  className="text-[9px] uppercase tracking-wider text-blue-400/70 flex-shrink-0"
                  title="Playing a generated copy; original is untouched"
                >
                  proxy
                </span>
              )}

              <button
                type="button"
                onClick={openExternal}
                className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-[#2a3136] transition-colors"
                title="Open original in system player"
              >
                <ExternalLink size={11} />
              </button>

              {!isReadMode && (
                <button
                  type="button"
                  onClick={() => update({ src: "", fileName: "", caption: "" })}
                  className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-[#2a3136] transition-colors"
                  title="Remove video"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          )}
        </div>
      );
    },
  }
);