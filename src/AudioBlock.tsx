// src/AudioBlock.tsx
import { createReactBlockSpec } from "@blocknote/react";
import { useEffect, useRef, useState } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { Music, ExternalLink, X, Loader2, AlertTriangle, Volume2, VolumeX, Play, Pause } from "lucide-react";
import { useNoteMode } from "./useNoteMode";
import { useNoteContext } from "./NoteContext";
import { assetUrlToAbsolutePath } from "./imageAssets";

function mimeForAudioExt(ext: string): string {
    switch (ext.toLowerCase()) {
        case "mp3": return "audio/mpeg";
        case "wav": return "audio/wav";
        case "ogg":
        case "oga":
        case "opus": return "audio/ogg";
        case "m4a": return "audio/mp4";
        case "aac": return "audio/aac";
        case "flac": return "audio/flac";
        case "weba": return "audio/webm";
        default: return "application/octet-stream";
    }
}
// A valid, 0-sample WAV data URI. Renders the native audio controls at
// normal size with nothing to play. Swapped out on first click.
const SILENT_WAV =
"data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";
function resolveToAbsolute(src: string, noteDir: string): string {
    if (!src) return "";
    const fromAsset = assetUrlToAbsolutePath(src);
    if (fromAsset) return fromAsset;
    if (/^([a-zA-Z]:[\\/]|\/)/.test(src)) return src;
    if (noteDir) {
        let decoded = src;
        try { decoded = decodeURIComponent(src); } catch {}
        const sep = noteDir.includes("\\") ? "\\" : "/";
        return noteDir.replace(/[\\/]+$/, "") + sep + decoded;
    }
    return src;
}

export const createAudio = createReactBlockSpec(
    {
        type: "audio",
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
            const isRead = mode === "read";
            const noteCtx = useNoteContext();
            const noteDir = noteCtx?.noteDir || "";

            const [playable, setPlayable] = useState("");
            const [loading, setLoading] = useState(false);
            const [error, setError] = useState("");
            const audioRef = useRef<HTMLAudioElement>(null);
            const blobUrlRef = useRef<string | null>(null);
            const pendingPlayRef = useRef(false);

            // Custom playback state — native <audio controls> in WebKitGTK
            // requires a drag-then-release to seek instead of click-to-seek,
            // and offers no way to fix that. We render our own controls.
            const [playing, setPlaying] = useState(false);
            const [currentTime, setCurrentTime] = useState(0);
            const [duration, setDuration] = useState(0);
            const [volume, setVolume] = useState(100);
            const [muted, setMuted] = useState(false);
            const seekingRef = useRef(false);

            const abs = src ? resolveToAbsolute(src, noteDir) : "";

            // On mount we do NOT fetch anything for local files. We just
            // validate the path and hand the native player a silent WAV so
            // the controls render at full size. Nothing touches the disk
            // until the user clicks play — that's what removes the
            // open-the-note freeze for large WAVs.
            useEffect(() => {
                setPlayable("");
                setError("");
                setLoading(false);

                if (!src) return;

                // External / inline URL — no need to fetch, WebKit has it.
                if (/^(https?:|data:|blob:)/i.test(src) &&
                    !/^https?:\/\/asset\.localhost\//i.test(src)) {
                    setPlayable(src);
                    return;
                }

                if (!abs || !/^([a-zA-Z]:[\\/]|\/)/.test(abs)) {
                    setError("Could not resolve audio path.");
                    return;
                }
                // Local file: stay lazy. loadAudio() will handle it.
            }, [src, abs]);

            // Revoke the blob URL loadAudio created when we unmount or
            // when the block switches to a different file. Also disarm
            // any pending auto-play so it can't fire against a stale
            // element.
            useEffect(() => {
                return () => {
                    pendingPlayRef.current = false;
                    if (blobUrlRef.current) {
                        URL.revokeObjectURL(blobUrlRef.current);
                        blobUrlRef.current = null;
                    }
                };
            }, [src]);

            const loadAudio = async () => {
                if (playable || !abs || loading) return;
                setLoading(true);
                setError("");
                try {
                    const assetUrl = convertFileSrc(abs);
                    const res = await fetch(assetUrl);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const bytes = await res.arrayBuffer();
                    const ext = abs.split(".").pop() || "";
                    const url = URL.createObjectURL(
                        new Blob([bytes], { type: mimeForAudioExt(ext) })
                    );
                    if (blobUrlRef.current) {
                        URL.revokeObjectURL(blobUrlRef.current);
                    }
                    blobUrlRef.current = url;
                    // Arm auto-play; `onCanPlay` on the remounted <audio>
                    // fires once the blob is decoded and calls play().
                    pendingPlayRef.current = true;
                    setPlayable(url);
                } catch (e: any) {
                    setError(e?.message ?? String(e));
                    pendingPlayRef.current = false;
                } finally {
                    setLoading(false);
                }
            };

            const tryPendingPlay = () => {
                if (!pendingPlayRef.current) return;
                const el = audioRef.current;
                if (!el) return;
                // Force-set volume/mute right before playback. WebKitGTK
                // sometimes drops the earlier assignment on a remounted
                // element until a play() has been issued, which made the
                // label read 100% while the actual output was quieter.
                el.volume = volume / 100;
                el.muted = muted;
                el.play().then(() => {
                    pendingPlayRef.current = false;
                }).catch(() => {
                    // Not ready yet — the next canplay/loadeddata retries.
                });
            };

            // Push state TO the element whenever it changes.
            useEffect(() => {
                const el = audioRef.current;
                if (!el) return;
                el.volume = volume / 100;
                el.muted = muted;
            }, [volume, muted, playable]);

            // Sync state FROM the element's own events. One effect covers
            // everything so `playable` changes remount cleanly — the new
            // element's initial play/pause/duration/volume all feed back
            // into React without needing a second pass.
            useEffect(() => {
                const el = audioRef.current;
                if (!el) return;

                const onPlay = () => setPlaying(true);
                const onPause = () => setPlaying(false);
                const onEnded = () => setPlaying(false);
                const onTime = () => {
                    if (!seekingRef.current) setCurrentTime(el.currentTime || 0);
                };
                const onDur = () => setDuration(isFinite(el.duration) ? el.duration : 0);
                const onVol = () => {
                    setVolume(Math.round(el.volume * 100));
                    setMuted(el.muted);
                };

                el.addEventListener("play", onPlay);
                el.addEventListener("pause", onPause);
                el.addEventListener("ended", onEnded);
                el.addEventListener("timeupdate", onTime);
                el.addEventListener("durationchange", onDur);
                el.addEventListener("loadedmetadata", onDur);
                el.addEventListener("volumechange", onVol);

                // Read initial values immediately.
                setPlaying(!el.paused);
                setCurrentTime(el.currentTime || 0);
                setDuration(isFinite(el.duration) ? el.duration : 0);
                setVolume(Math.round(el.volume * 100));
                setMuted(el.muted);

                return () => {
                    el.removeEventListener("play", onPlay);
                    el.removeEventListener("pause", onPause);
                    el.removeEventListener("ended", onEnded);
                    el.removeEventListener("timeupdate", onTime);
                    el.removeEventListener("durationchange", onDur);
                    el.removeEventListener("loadedmetadata", onDur);
                    el.removeEventListener("volumechange", onVol);
                };
            }, [playable]);

            // Reset playback state when the audio element remounts.
            useEffect(() => {
                setCurrentTime(0);
                setDuration(0);
                setPlaying(false);
            }, [playable]);

            const fmtTime = (s: number): string => {
                if (!isFinite(s) || s < 0) return "0:00";
                const total = Math.floor(s);
                const h = Math.floor(total / 3600);
                const m = Math.floor((total % 3600) / 60);
                const sec = total % 60;
                if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
                return `${m}:${String(sec).padStart(2, "0")}`;
            };

            const seekToClientX = (clientX: number, target: HTMLElement) => {
                const el = audioRef.current;
                if (!el || !duration || !isFinite(duration)) return;
                const rect = target.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                const t = pct * duration;
                el.currentTime = t;
                setCurrentTime(t);
            };

            const handleSeekPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
                if (!duration || !isFinite(duration)) return;
                e.preventDefault();
                e.stopPropagation();
                const target = e.currentTarget;
                seekingRef.current = true;
                seekToClientX(e.clientX, target);

                const onMove = (ev: PointerEvent) => seekToClientX(ev.clientX, target);
                const onUp = () => {
                    seekingRef.current = false;
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                    window.removeEventListener("pointercancel", onUp);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
                window.addEventListener("pointercancel", onUp);
            };

            const togglePlay = () => {
                if (loading) return;
                if (!playable) { loadAudio(); return; }
                const el = audioRef.current;
                if (!el) return;
                if (el.paused) {
                    el.play().catch((e) => console.warn("[audio] play failed:", e));
                } else {
                    el.pause();
                }
            };

            const update = (patch: Record<string, any>) => {
                try { props.editor.updateBlock(props.block.id, { props: patch }); }
                catch (e) { console.error("[audio] updateBlock failed:", e); }
            };

            const openExternal = () => {
                if (abs) openPath(abs).catch((e) => console.error("[audio] openPath failed:", e));
            };

                const stopRightClick = (e: React.MouseEvent) => {
                    if (e.button === 2) { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); }
                };

                if (!src) {
                    return (
                        <div
                        className="my-2 w-full rounded-md border border-dashed border-[#30363d] bg-[#0f1315] py-6 flex flex-col items-center gap-2 text-gray-500 text-xs"
                        contentEditable={false}
                        onMouseDown={stopRightClick}
                        >
                        <Music size={20} className="opacity-50" />
                        <span>Empty audio block — upload a file from the / menu</span>
                        </div>
                    );
                }

                const showFooter = !isRead || !!caption;

                return (
                    <div
                    className="my-2 w-full rounded-md border border-[#2a3136] bg-[#161a1d] overflow-hidden"
                    contentEditable={false}
                    onMouseDown={stopRightClick}
                    >
                    <div className="p-3">
                    <div className="flex items-center gap-2 mb-2 min-w-0">
                    <Music size={12} className="text-blue-400 flex-shrink-0" />
                    <span className="text-xs text-gray-300 truncate flex-1" title={fileName}>
                    {fileName || "Audio"}
                    </span>
                    <button
                    type="button"
                    onClick={openExternal}
                    className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-[#2a3136] transition-colors"
                    title="Open in system player"
                    >
                    <ExternalLink size={11} />
                    </button>
                    {!isRead && (
                        <button
                        type="button"
                        onClick={() => update({ src: "", fileName: "", caption: "" })}
                        className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-[#2a3136] transition-colors"
                        title="Remove audio"
                        >
                        <X size={11} />
                        </button>
                    )}
                    </div>


                    {error && (
                        <div className="flex items-start gap-2 text-xs text-red-300">
                        <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
                        <span className="break-words">{error}</span>
                        </div>
                    )}

                    {!error && (
                        <div
                            data-no-marquee
                            className="relative"
                        >
                            {/* Hidden audio element. No native controls — the
                                custom controls below drive it. `key` forces a
                                remount when the blob URL lands, which is what
                                makes onCanPlay fire and kick off playback. */}
                            <div
                                style={{
                                    position: "absolute",
                                    width: 0,
                                    height: 0,
                                    overflow: "hidden",
                                    opacity: 0,
                                    pointerEvents: "none",
                                }}
                            >
                                <audio
                                    key={playable || "silent"}
                                    ref={audioRef}
                                    preload={playable ? "auto" : "none"}
                                    src={playable || SILENT_WAV}
                                    onError={() => { if (playable) setError("This audio format can't be played here."); }}
                                    onLoadedMetadata={() => {
                                        const audio = audioRef.current;
                                        if (audio && (audio.duration === Infinity || isNaN(audio.duration))) {
                                            audio.currentTime = 1e101;
                                            setTimeout(() => {
                                                audio.currentTime = 0;
                                            }, 100);
                                        }
                                    }}
                                    onCanPlay={tryPendingPlay}
                                    onLoadedData={tryPendingPlay}
                                />
                            </div>

                            {/* Custom controls — a real seek bar that seeks
                                on pointerdown instead of grabbing the thumb,
                                plus always-visible volume. */}
                            <div
                                data-no-marquee
                                className="flex items-center gap-2 select-none"
                                onMouseDown={(e) => e.stopPropagation()}
                            >
                                <button
                                    type="button"
                                    onClick={togglePlay}
                                    disabled={loading}
                                    className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white transition-colors flex-shrink-0"
                                    title={loading ? "Loading…" : playing ? "Pause" : "Play"}
                                >
                                    {loading
                                        ? <Loader2 size={13} className="animate-spin" />
                                        : playing
                                            ? <Pause size={13} fill="currentColor" />
                                            : <Play size={13} fill="currentColor" className="ml-0.5" />}
                                </button>

                                <span className="text-[10px] text-gray-400 tabular-nums flex-shrink-0 w-10 text-right">
                                    {fmtTime(currentTime)}
                                </span>

                                <div
                                    onPointerDown={handleSeekPointerDown}
                                    className="relative flex-1 h-1.5 bg-[#2a3136] rounded-full cursor-pointer group touch-none"
                                    title="Click or drag to seek"
                                >
                                    <div
                                        className="absolute inset-y-0 left-0 bg-blue-500 rounded-full pointer-events-none"
                                        style={{ width: `${duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0}%` }}
                                    />
                                    <div
                                        className="absolute top-1/2 w-3 h-3 bg-white rounded-full shadow -translate-x-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                                        style={{ left: `${duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0}%` }}
                                    />
                                </div>

                                <span className="text-[10px] text-gray-400 tabular-nums flex-shrink-0 w-10">
                                    {fmtTime(duration)}
                                </span>

                                <button
                                    type="button"
                                    onClick={() => setMuted((m) => !m)}
                                    className="p-1 rounded text-gray-400 hover:text-gray-100 hover:bg-[#2a3136] transition-colors flex-shrink-0"
                                    title={muted ? "Unmute" : "Mute"}
                                >
                                    {muted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
                                </button>
                                <input
                                    type="range"
                                    min={0}
                                    max={100}
                                    step={1}
                                    value={muted ? 0 : volume}
                                    onChange={(e) => {
                                        const v = Number(e.target.value);
                                        setVolume(v);
                                        if (muted && v > 0) setMuted(false);
                                    }}
                                    className="w-16 accent-blue-500 cursor-pointer flex-shrink-0"
                                    title={`Volume: ${muted ? 0 : volume}%`}
                                />
                            </div>
                        </div>
                    )}
                    </div>

                    {showFooter && (
                        <div className="px-3 py-1.5 border-t border-[#2a3136] bg-[#1a1e21]">
                        {isRead ? (
                            <div className="text-xs text-gray-300">{caption}</div>
                        ) : (
                            <input
                            type="text"
                            value={caption}
                            onChange={(e) => update({ caption: e.target.value })}
                            placeholder="Caption (optional)…"
                            className="w-full bg-transparent border-none outline-none text-xs text-gray-200 placeholder-gray-600"
                            />
                        )}
                        </div>
                    )}


                    </div>
                );
        },
    }
);
