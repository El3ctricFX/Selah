// src/DmArchive.tsx
import { createReactBlockSpec } from "@blocknote/react";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  ImagePlus,
  Link as LinkIcon,
  Loader2,
  MessageCircle,
  X,
} from "lucide-react";
import { useNoteMode } from "./useNoteMode";
import { useNoteContext } from "./NoteContext";
import PhotoLightbox from "./PhotoLightbox";
import { assetUrlToAbsolutePath, saveImageToNoteAssets } from "./imageAssets";

const SRC_SEP = "\u001E";

function parseSrcs(raw: string): string[] {
  if (!raw) return [];
  return raw.split(SRC_SEP).filter(Boolean);
}

function joinSrcs(list: string[]): string {
  return list.filter(Boolean).join(SRC_SEP);
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.slice(i + 1);
}

function sortByFilenameNatural(paths: string[]): string[] {
  return [...paths].sort((a, b) =>
    basename(a).localeCompare(basename(b), undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );
}

function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^mailto:/i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(s)) return `https://${s}`;
  return s;
}

const PLATFORMS = {
  discord:   { label: "Discord",   accent: "#5865f2" },
  instagram: { label: "Instagram", accent: "#e1306c" },
  imessage:  { label: "iMessage",  accent: "#34c759" },
  whatsapp:  { label: "WhatsApp",  accent: "#25d366" },
  twitter:   { label: "Twitter",   accent: "#1d9bf0" },
  messenger: { label: "Messenger", accent: "#0084ff" },
  telegram:  { label: "Telegram",  accent: "#229ed9" },
  signal:    { label: "Signal",    accent: "#3a76f0" },
  reddit:    { label: "Reddit",    accent: "#ff4500" },
  other:     { label: "Message",   accent: "#8b5cf6" },
} as const;

type PlatformKey = keyof typeof PLATFORMS;

function platformInfo(key: string) {
  if (key in PLATFORMS) return PLATFORMS[key as PlatformKey];
  return PLATFORMS.other;
}

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

export const createDmArchive = createReactBlockSpec(
  {
    type: "dmarchive",
    propSchema: {
      platform: { default: "discord" },
      who: { default: "" },
      link: { default: "" },
      date: { default: "" },
      caption: { default: "" },
      collapsed: { default: true },
      srcs: { default: "" },
    },
    content: "none",
  },
  {
    render: (props) => {
      const live = props.editor.getBlock(props.block.id) ?? props.block;
      const platform = (live.props.platform as string) || "discord";
      const who = (live.props.who as string) || "";
      const link = (live.props.link as string) || "";
      const date = (live.props.date as string) || "";
      const caption = (live.props.caption as string) || "";
      const srcsRaw = (live.props.srcs as string) || "";

      const defaultCollapsed = live.props.collapsed !== false;

      const { mode } = useNoteMode();
      const isEdit = mode === "edit";
      const noteCtx = useNoteContext();
      const notePath = noteCtx?.notePath || "";
      const noteDir = noteCtx?.noteDir || "";

      // Renamed from `open` → `viewOpen` so it doesn't shadow the `open`
      // import from @tauri-apps/plugin-dialog. That collision caused
      // `open({…})` inside pickFiles to call a boolean.
      const [viewOpen, setViewOpen] = useState<boolean>(!defaultCollapsed);

      const [busy, setBusy] = useState(false);
      const [pendingPick, setPendingPick] = useState<string[] | null>(null);

      const [linkEditing, setLinkEditing] = useState(false);
      const [linkDraft, setLinkDraft] = useState("");

      const [dragIdx, setDragIdx] = useState<number | null>(null);
      const [hoverIdx, setHoverIdx] = useState<number | null>(null);
      const suppressClickRef = useRef(false);
      const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

      const srcs = useMemo(() => parseSrcs(srcsRaw), [srcsRaw]);
      const info = platformInfo(platform);

      const update = (patch: Record<string, any>) => {
        try {
          props.editor.updateBlock(props.block.id, { props: patch });
        } catch (e) {
          console.error("[dmarchive] updateBlock failed:", e);
        }
      };

      const resolveSrc = (src: string) => {
        const abs = resolveToAbsolute(src, noteDir);
        if (!abs) return "";
        try {
          return convertFileSrc(abs);
        } catch {
          return abs;
        }
      };

      const resolvedSrcs = useMemo(
        () => srcs.map((s) => resolveSrc(s)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [srcsRaw, noteDir]
      );

      const toggleDefault = () => {
        const next = !defaultCollapsed;
        update({ collapsed: next });
        setViewOpen(!next);
      };

      const toggleView = () => setViewOpen((o) => !o);

      const openLinkEditor = () => {
        setLinkDraft(link);
        setLinkEditing(true);
      };

      const cancelLinkEditor = () => {
        setLinkEditing(false);
        setLinkDraft("");
      };

      const saveLink = () => {
        const normalized = normalizeUrl(linkDraft);
        update({ link: normalized });
        setLinkEditing(false);
        setLinkDraft("");
      };

      const clearLink = () => {
        update({ link: "" });
        setLinkEditing(false);
        setLinkDraft("");
      };

      const openLink = () => {
        if (!link) return;
        openUrl(link).catch((e) =>
          console.error("[dmarchive] openUrl failed:", e)
        );
      };

      const pickFiles = async () => {
        if (!notePath || busy) return;
        try {
          const picked = await open({
            multiple: true,
            filters: [
              {
                name: "Image",
                extensions: [
                  "png", "jpg", "jpeg", "webp", "gif", "avif", "bmp",
                ],
              },
            ],
          });
          if (!picked) return;
          const paths = Array.isArray(picked) ? picked : [picked];
          const valid = paths.filter((p): p is string => typeof p === "string");
          if (valid.length === 0) return;
          setPendingPick(valid);
        } catch (e) {
          console.error("[dmarchive] picker failed:", e);
        }
      };

      const commitPick = async (sortByName: boolean) => {
        if (!pendingPick || !notePath || busy) return;
        const ordered = sortByName
          ? sortByFilenameNatural(pendingPick)
          : pendingPick;

        setBusy(true);
        try {
          const added: string[] = [];
          for (const src of ordered) {
            try {
              const dest = await saveImageToNoteAssets(notePath, src);
              added.push(convertFileSrc(dest));
            } catch (e) {
              console.error("[dmarchive] save failed:", e);
            }
          }
          if (added.length > 0) {
            update({ srcs: joinSrcs([...srcs, ...added]) });
            setViewOpen(true);
          }
        } finally {
          setBusy(false);
          setPendingPick(null);
        }
      };

      const cancelPick = () => {
        if (busy) return;
        setPendingPick(null);
      };

      const removeOne = (idx: number) => {
        const next = srcs.filter((_, i) => i !== idx);
        update({ srcs: joinSrcs(next) });
      };

      const openExternal = (src: string) => {
        const abs = resolveToAbsolute(src, noteDir);
        if (abs) {
          openPath(abs).catch((e) =>
            console.error("[dmarchive] openPath failed:", e)
          );
        }
      };

      const handleDragStart = (i: number) => (e: React.DragEvent) => {
        suppressClickRef.current = true;
        setDragIdx(i);
        try {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(i));
        } catch {}
      };

      const handleDragOver = (i: number) => (e: React.DragEvent) => {
        if (dragIdx === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (hoverIdx !== i) setHoverIdx(i);
      };

      const handleDragLeave = (i: number) => (e: React.DragEvent) => {
        const related = e.relatedTarget as Node | null;
        if (related && (e.currentTarget as Node).contains(related)) return;
        if (hoverIdx === i) setHoverIdx(null);
      };

      const handleDrop = (i: number) => (e: React.DragEvent) => {
        e.preventDefault();
        const from =
          dragIdx ?? Number(e.dataTransfer.getData("text/plain"));
        setDragIdx(null);
        setHoverIdx(null);
        if (!Number.isFinite(from) || from === i) return;
        const next = [...srcs];
        const [moved] = next.splice(from, 1);
        next.splice(i, 0, moved);
        update({ srcs: joinSrcs(next) });
      };

      const handleDragEnd = () => {
        setDragIdx(null);
        setHoverIdx(null);
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      };

      const handleImageClick = (i: number) => (e: React.MouseEvent) => {
        if (suppressClickRef.current) return;
        const t = e.target as HTMLElement;
        if (t.closest("button") || t.closest("a")) return;
        e.stopPropagation();
        setLightboxIdx(i);
      };

      // ────────────────────────────────────────────────────────────────
      // Confirmation strip
      // ────────────────────────────────────────────────────────────────
      if (pendingPick) {
        const preview = pendingPick.slice(0, 3).map(basename);
        const extra = pendingPick.length - preview.length;
        return (
          <div
            className="my-2 w-full rounded-lg border border-blue-500/40 bg-[#161a1d] overflow-hidden"
            contentEditable={false}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-2 border-b border-[#2a3136] bg-[#1a1e21]">
              <div className="text-xs text-gray-100 font-medium">
                Add {pendingPick.length} screenshot
                {pendingPick.length === 1 ? "" : "s"} to this archive?
              </div>
              <div className="text-[10px] text-gray-500 mt-1">
                Pick how to order them.
              </div>
            </div>

            <div className="px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">
                Files
              </div>
              <div className="rounded border border-[#2a3136] bg-[#0f1315] p-2 max-h-24 overflow-y-auto">
                {preview.map((name, i) => (
                  <div
                    key={i}
                    className="text-[11px] text-gray-400 font-mono truncate"
                    title={name}
                  >
                    {name}
                  </div>
                ))}
                {extra > 0 && (
                  <div className="text-[11px] text-gray-600 italic mt-0.5">
                    + {extra} more…
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1.5 mt-3">
                <button
                  type="button"
                  onClick={() => commitPick(true)}
                  disabled={busy}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded transition-colors font-medium"
                >
                  {busy ? (
                    <>
                      <Loader2 size={11} className="animate-spin" />
                      <span>Adding…</span>
                    </>
                  ) : (
                    <span>Yes — sort by filename (18, 19, 20…)</span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => commitPick(false)}
                  disabled={busy}
                  className="w-full px-3 py-1.5 text-xs bg-[#2a3136] hover:bg-[#30363d] disabled:opacity-40 border border-[#30363d] text-gray-200 rounded transition-colors"
                >
                  No — keep the order I picked them in
                </button>
                <button
                  type="button"
                  onClick={cancelPick}
                  disabled={busy}
                  className="w-full px-3 py-1.5 text-xs text-gray-500 hover:text-gray-300 disabled:opacity-40 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        );
      }

      // ────────────────────────────────────────────────────────────────
      // Empty state
      // ────────────────────────────────────────────────────────────────
      if (srcs.length === 0) {
        return (
          <div
            className="my-2 w-full rounded-lg border border-dashed border-[#30363d] bg-[#0f1315] py-6 flex flex-col items-center justify-center gap-2"
            contentEditable={false}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {isEdit ? (
              <button
                type="button"
                onClick={pickFiles}
                disabled={busy || !notePath}
                className="flex flex-col items-center gap-2 text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
              >
                <ImagePlus size={20} />
                <span className="text-xs">Add DM screenshots</span>
              </button>
            ) : (
              <>
                <MessageCircle size={20} className="text-gray-600" />
                <span className="text-xs text-gray-600">Empty archive</span>
              </>
            )}
          </div>
        );
      }

      // ────────────────────────────────────────────────────────────────
      // Populated archive
      // ────────────────────────────────────────────────────────────────
      const Chevron = viewOpen ? ChevronDown : ChevronRight;

      return (
        <>
          <div
            className="my-2 w-full rounded-lg overflow-hidden border border-[#2a3136] bg-[#161a1d]"
            contentEditable={false}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center gap-2 px-2.5 py-1.5 select-none"
              style={{
                background: `linear-gradient(to right, ${info.accent}26, transparent 60%)`,
              }}
            >
              <button
                type="button"
                onClick={toggleView}
                className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-black/30 text-gray-400 hover:text-gray-100 transition-colors"
                title={viewOpen ? "Collapse (just for now)" : "Expand (just for now)"}
              >
                <Chevron size={13} />
              </button>

              {isEdit ? (
                <select
                  value={platform}
                  onChange={(e) => update({ platform: e.target.value })}
                  className="flex-shrink-0 rounded-full text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 outline-none cursor-pointer"
                  style={{
                    backgroundColor: `${info.accent}22`,
                    color: info.accent,
                    border: `1px solid ${info.accent}55`,
                  }}
                  title="Source platform"
                >
                  {(Object.keys(PLATFORMS) as PlatformKey[]).map((k) => (
                    <option
                      key={k}
                      value={k}
                      style={{ background: "#1e2327", color: "#e5e7eb" }}
                    >
                      {PLATFORMS[k].label}
                    </option>
                  ))}
                </select>
              ) : (
                <span
                  className="flex-shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider font-semibold"
                  style={{
                    backgroundColor: `${info.accent}22`,
                    color: info.accent,
                    border: `1px solid ${info.accent}55`,
                  }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: info.accent }}
                  />
                  {info.label}
                </span>
              )}

              {isEdit ? (
                <input
                  type="text"
                  value={who}
                  onChange={(e) => update({ who: e.target.value })}
                  placeholder="With… (name / handle)"
                  className="flex-1 min-w-0 bg-transparent border-none outline-none text-xs text-gray-200 placeholder-gray-600"
                />
              ) : link ? (
                <a
                  href={link}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openLink();
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="text-xs text-blue-300 hover:text-blue-200 truncate flex-1 min-w-0 underline decoration-blue-400/40 hover:decoration-blue-300 cursor-pointer"
                  title={link}
                >
                  {who || "Conversation"}
                </a>
              ) : (
                <span className="text-xs text-gray-200 truncate flex-1 min-w-0">
                  {who || "Conversation"}
                </span>
              )}

              {isEdit && (
                <button
                  type="button"
                  onClick={() =>
                    linkEditing ? cancelLinkEditor() : openLinkEditor()
                  }
                  className={`flex-shrink-0 p-1 rounded transition-colors ${
                    link
                      ? "text-blue-300 hover:text-blue-200 hover:bg-black/30"
                      : "text-gray-500 hover:text-gray-200 hover:bg-black/30"
                  }`}
                  title={link ? `Link: ${link}` : "Add a link to this name"}
                >
                  <LinkIcon size={12} />
                </button>
              )}

              {isEdit ? (
                <input
                  type="text"
                  value={date}
                  onChange={(e) => update({ date: e.target.value })}
                  placeholder="Date"
                  className="w-20 bg-transparent border-none outline-none text-[11px] text-gray-400 placeholder-gray-600 text-right"
                />
              ) : (
                date && (
                  <span className="text-[10px] text-gray-500 flex-shrink-0">
                    {date}
                  </span>
                )
              )}

              <span
                className="flex-shrink-0 text-[10px] text-gray-500 tabular-nums px-1.5 py-0.5 rounded bg-black/20"
                title={`${srcs.length} screenshot${srcs.length === 1 ? "" : "s"}`}
              >
                {srcs.length}
              </span>

              {isEdit && (
                <>
                  <button
                    type="button"
                    onClick={toggleDefault}
                    className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors whitespace-nowrap ${
                      defaultCollapsed
                        ? "bg-black/30 text-gray-400 hover:text-gray-100"
                        : "bg-blue-500/25 text-blue-200 hover:bg-blue-500/35"
                    }`}
                    title={
                      defaultCollapsed
                        ? "When this note is opened, this archive starts collapsed. Click to start expanded instead."
                        : "When this note is opened, this archive starts expanded. Click to start collapsed instead."
                    }
                  >
                    {defaultCollapsed ? "closed by default" : "open by default"}
                  </button>

                  <button
                    type="button"
                    onClick={pickFiles}
                    disabled={busy || !notePath}
                    className="flex-shrink-0 p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-black/30 transition-colors disabled:opacity-40"
                    title="Add more screenshots"
                  >
                    {busy
                      ? <Loader2 size={12} className="animate-spin" />
                      : <ImagePlus size={12} />}
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      update({
                        srcs: "",
                        who: "",
                        link: "",
                        date: "",
                        caption: "",
                      })
                    }
                    className="flex-shrink-0 p-1 rounded text-gray-500 hover:text-red-400 hover:bg-black/30 transition-colors"
                    title="Delete entire archive"
                  >
                    <X size={12} />
                  </button>
                </>
              )}
            </div>

            {isEdit && linkEditing && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-[#2a3136] bg-[#0f1315]">
                <LinkIcon size={11} className="text-gray-500 flex-shrink-0" />
                <input
                  autoFocus
                  type="text"
                  value={linkDraft}
                  onChange={(e) => setLinkDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      saveLink();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelLinkEditor();
                    }
                  }}
                  placeholder="https://… (paste a URL, Enter to save)"
                  className="flex-1 min-w-0 bg-transparent border-none outline-none text-xs text-gray-200 placeholder-gray-600 font-mono"
                />
                <button
                  type="button"
                  onClick={saveLink}
                  disabled={!linkDraft.trim() && !link}
                  className="flex-shrink-0 p-1 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors disabled:opacity-40"
                  title="Save link (Enter)"
                >
                  <Check size={12} />
                </button>
                {(link || linkDraft.trim()) && (
                  <button
                    type="button"
                    onClick={clearLink}
                    className="flex-shrink-0 p-1 rounded text-gray-500 hover:text-red-400 hover:bg-[#1e2327] transition-colors"
                    title="Remove link"
                  >
                    <X size={12} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={cancelLinkEditor}
                  className="flex-shrink-0 text-[10px] text-gray-500 hover:text-gray-300 px-1.5"
                  title="Cancel (Esc)"
                >
                  cancel
                </button>
              </div>
            )}

            {viewOpen && (
              <div className="border-t border-[#2a3136] bg-black/20">
                <div className="max-h-[70vh] overflow-y-auto">
                  {srcs.map((src, idx) => {
                    const url = resolvedSrcs[idx];
                    const isDragging = dragIdx === idx;
                    const isHover =
                      hoverIdx === idx && dragIdx !== null && dragIdx !== idx;
                    return (
                      <div
                        key={`${src}-${idx}`}
                        draggable={isEdit}
                        onDragStart={isEdit ? handleDragStart(idx) : undefined}
                        onDragOver={isEdit ? handleDragOver(idx) : undefined}
                        onDragLeave={isEdit ? handleDragLeave(idx) : undefined}
                        onDrop={isEdit ? handleDrop(idx) : undefined}
                        onDragEnd={isEdit ? handleDragEnd : undefined}
                        onClick={handleImageClick(idx)}
                        className={`group relative bg-[#0f1315] flex justify-center transition-all cursor-zoom-in ${
                          isDragging
                            ? "opacity-40"
                            : isHover
                              ? "ring-2 ring-inset ring-blue-400"
                              : ""
                        } ${isEdit ? "active:cursor-grabbing" : ""}`}
                      >
                        {url ? (
                          <img
                            src={url}
                            alt={`Screenshot ${idx + 1}`}
                            loading="lazy"
                            draggable={false}
                            className="max-w-full h-auto block pointer-events-none"
                          />
                        ) : (
                          <div className="py-10 text-xs text-gray-600">
                            Could not resolve image
                          </div>
                        )}

                        <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openExternal(src);
                            }}
                            className="p-1.5 rounded bg-black/70 hover:bg-black/90 text-white transition-colors"
                            title="Open in system viewer"
                          >
                            <ExternalLink size={11} />
                          </button>
                          {isEdit && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeOne(idx);
                              }}
                              className="p-1.5 rounded bg-black/70 hover:bg-red-600 text-white transition-colors"
                              title="Remove this screenshot"
                            >
                              <X size={11} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {isEdit && srcs.length > 1 && (
                  <div className="px-3 py-1.5 border-t border-[#2a3136] bg-[#1a1e21]">
                    <p className="text-[10px] text-gray-500">
                      Click to open fullscreen · drag to reorder
                    </p>
                  </div>
                )}

                {(isEdit || caption) && (
                  <div className="px-3 py-2 border-t border-[#2a3136]">
                    {isEdit ? (
                      <input
                        type="text"
                        value={caption}
                        onChange={(e) => update({ caption: e.target.value })}
                        placeholder="Context / why this matters (optional)…"
                        className="w-full bg-transparent border-none outline-none text-xs text-gray-300 placeholder-gray-600"
                      />
                    ) : (
                      <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap">
                        {caption}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {!viewOpen && caption && (
              <div className="px-3 py-1.5 border-t border-[#2a3136]">
                <p className="text-[11px] text-gray-500 truncate" title={caption}>
                  {caption}
                </p>
              </div>
            )}
          </div>

          {lightboxIdx !== null &&
            createPortal(
              <PhotoLightbox
                srcs={resolvedSrcs}
                index={lightboxIdx}
                onClose={() => setLightboxIdx(null)}
                onIndexChange={(i) => setLightboxIdx(i)}
              />,
              document.body
            )}
        </>
      );
    },
  }
);