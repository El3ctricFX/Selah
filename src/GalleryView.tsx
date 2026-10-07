// src/GalleryView.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import {
  readTextFile, writeTextFile, mkdir, copyFile, exists,
  rename as fsRename, remove,
} from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Plus, Trash2, Image as ImageIcon, Pencil, BookOpen,
  ChevronLeft, ChevronRight, Upload, X, Calendar, Clock,
  Maximize2, ZoomIn, ZoomOut, BookMarked, Search, Tag, Filter,
  LayoutGrid, Rows3, Smile, Palette, Sliders, Link as LinkIcon,
  Sparkles, ExternalLink, Loader2, GitBranch, ListChecks,
} from "lucide-react";
import EmojiPicker, { Theme, EmojiStyle } from "emoji-picker-react";
import { useModal } from "./Modal";
import { useNoteMode } from "./useNoteMode";
import { moveToTrash } from "./trash";

interface GalleryLink {
  id: string;
  url: string;
  title: string;
}

interface ProgressEntry {
  id: string;
  date: string;
  note: string;
  image: string | null;
}

interface VersionEntry {
  id: string;
  label: string;
  date: string;
  image: string;
  note: string;
}

interface GalleryItem {
  id: string;
  title: string;
  backstory: string;
  dateMade: string;
  time: string;
  mainImages: string[];
  referenceImages: string[];
  tags: string[];
  links: GalleryLink[];
  progress: ProgressEntry[];
  versions: VersionEntry[];
}

interface GalleryViewProps {
  sectionDir: string;
  sectionName: string;
}

type GalleryViewMode = "grid" | "gallery" | "list";
const VIEW_MODE_KEY = "gallery-view-mode";

const COVER_GRADIENTS = [
  { id: "sunset",   label: "Sunset",   value: "linear-gradient(135deg, #ff9a9e 0%, #fad0c4 100%)" },
  { id: "peach",    label: "Peach",    value: "linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)" },
  { id: "ocean",    label: "Ocean",    value: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)" },
  { id: "forest",   label: "Forest",   value: "linear-gradient(135deg, #134e5e 0%, #71b280 100%)" },
  { id: "dawn",     label: "Dawn",     value: "linear-gradient(135deg, #f6d365 0%, #fda085 100%)" },
  { id: "dusk",     label: "Dusk",     value: "linear-gradient(135deg, #4e54c8 0%, #8f94fb 100%)" },
  { id: "midnight", label: "Midnight", value: "linear-gradient(135deg, #232526 0%, #414345 100%)" },
  { id: "rose",     label: "Rose",     value: "linear-gradient(135deg, #ee9ca7 0%, #ffdde1 100%)" },
  { id: "sky",      label: "Sky",      value: "linear-gradient(135deg, #56ccf2 0%, #2f80ed 100%)" },
  { id: "sand",     label: "Sand",     value: "linear-gradient(135deg, #e6dada 0%, #274046 100%)" },
];

interface SectionMeta {
  icon?: string;
  coverType?: "color" | "image" | "";
  coverValue?: string;
  coverPosX?: number;
  coverPosY?: number;
  coverOpacity?: number;
  coverBlur?: number;
  coverRadius?: number;
  coverTextShadow?: boolean;
}

const DEFAULT_META: SectionMeta = {
  icon: "",
  coverType: "",
  coverValue: "",
  coverPosX: 50,
  coverPosY: 50,
  coverOpacity: 100,
  coverBlur: 0,
  coverRadius: 0,
  coverTextShadow: true,
};

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function nowIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtDateTime(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString("en-US", {
      year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch { return iso; }
}

function yearOf(iso?: string): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})/);
  return m ? m[1] : "";
}

function preview(text: string, max = 140): string {
  const t = (text || "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  return t.length > max ? t.slice(0, max).trimEnd() + "…" : t;
}

function splitFilename(name: string): { base: string; ext: string } {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, idx), ext: name.slice(idx + 1) };
}

function sanitizeFileName(name: string): string {
  const { base, ext } = splitFilename(name);
  const safeBase =
    base.replace(/[\\/:*?"<>|]/g, "-").replace(/-+/g, "-").trim() || "image";
  const safeExt =
    (ext || "png").replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "png";
  return `${safeBase}.${safeExt}`;
}

async function uniqueNameIn(dir: string, baseName: string): Promise<string> {
  let candidate = baseName;
  let counter = 1;
  while (await exists(await join(dir, candidate))) {
    const { base, ext } = splitFilename(baseName);
    candidate = `${base}-${counter}${ext ? "." + ext : ""}`;
    counter++;
    if (counter > 500) {
      candidate = `${base}-${Date.now()}${ext ? "." + ext : ""}`;
      break;
    }
  }
  return candidate;
}

function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function migrateTime(it: any): string {
  if (typeof it.time === "string" && it.time.trim()) return it.time;
  const s = typeof it.timeStarted === "string" ? it.timeStarted.trim() : "";
  const e = typeof it.timeEnded === "string" ? it.timeEnded.trim() : "";
  const fmt = (v: string) => {
    if (!v) return "";
    try {
      const [h, m] = v.split(":").map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) return v;
      const d = new Date();
      d.setHours(h, m, 0, 0);
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    } catch { return v; }
  };
  const fs = fmt(s);
  const fe = fmt(e);
  if (fs && fe) return `${fs} – ${fe}`;
  if (fs) return `From ${fs}`;
  if (fe) return `Until ${fe}`;
  return "";
}

// ─── Flexible date parsing ──────────────────────────────────────────────────
const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function monthIndexFromName(name: string): number {
  const n = name.toLowerCase().replace(/\./g, "");
  const exact = MONTH_NAMES.findIndex((m) => m === n);
  if (exact !== -1) return exact;
  if (n.length >= 3) {
    const idx = MONTH_NAMES.findIndex((m) => m.startsWith(n));
    if (idx !== -1) return idx;
  }
  return -1;
}

function ymd(y: number, mo: number, d: number): string {
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function isValidYmd(y: number, mo: number, d: number): boolean {
  if (!y || !Number.isFinite(y)) return false;
  if (mo < 1 || mo > 12) return false;
  if (d < 1) return false;
  const test = new Date(y, mo - 1, d);
  return test.getFullYear() === y && test.getMonth() === mo - 1 && test.getDate() === d;
}

/**
 * ISO yyyy-mm-dd → MM/DD/YYYY for display. Also handles full ISO timestamps
 * (2026-06-18T00:00:00Z) by matching the leading date portion and ignoring
 * the time suffix.
 */
function isoToDisplay(iso: string): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

function parseFlexibleDate(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;

  const today = new Date();
  if (s === "today" || s === "now") {
    return ymd(today.getFullYear(), today.getMonth() + 1, today.getDate());
  }
  if (s === "yesterday") {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  if (s === "tomorrow") {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (isValidYmd(y, mo, d)) return ymd(y, mo, d);
  }

  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const mo = Number(m[1]), d = Number(m[2]);
    if (isValidYmd(y, mo, d)) return ymd(y, mo, d);
  }

  m = s.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,\s]+(\d{2,4})$/);
  if (m) {
    const idx = monthIndexFromName(m[1]);
    if (idx >= 0) {
      let y = Number(m[3]);
      if (y < 100) y += 2000;
      const d = Number(m[2]);
      if (isValidYmd(y, idx + 1, d)) return ymd(y, idx + 1, d);
    }
  }

  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?[,\s]+(\d{2,4})$/);
  if (m) {
    const idx = monthIndexFromName(m[2]);
    if (idx >= 0) {
      let y = Number(m[3]);
      if (y < 100) y += 2000;
      const d = Number(m[1]);
      if (isValidYmd(y, idx + 1, d)) return ymd(y, idx + 1, d);
    }
  }

  m = s.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/);
  if (m) {
    const idx = monthIndexFromName(m[1]);
    if (idx >= 0) {
      const y = today.getFullYear();
      const d = Number(m[2]);
      if (isValidYmd(y, idx + 1, d)) return ymd(y, idx + 1, d);
    }
  }

  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?$/);
  if (m) {
    const idx = monthIndexFromName(m[2]);
    if (idx >= 0) {
      const y = today.getFullYear();
      const d = Number(m[1]);
      if (isValidYmd(y, idx + 1, d)) return ymd(y, idx + 1, d);
    }
  }

  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) {
    const y = today.getFullYear();
    const mo = Number(m[1]), d = Number(m[2]);
    if (isValidYmd(y, mo, d)) return ymd(y, mo, d);
  }

  return null;
}

// ─── Date field ─────────────────────────────────────────────────────────────
function DateField({
  value,
  onChange,
  className,
  placeholder,
}: {
  value: string;
  onChange: (ymdValue: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(isoToDisplay(value || ""));
  const [focused, setFocused] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focused) setDraft(isoToDisplay(value || ""));
  }, [value, focused]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      onChange("");
      setFocused(false);
      return;
    }
    const parsed = parseFlexibleDate(trimmed);
    if (parsed) {
      onChange(parsed);
      setDraft(isoToDisplay(parsed));
    } else {
      setDraft(isoToDisplay(value || ""));
    }
    setFocused(false);
  };

  const openNativePicker = () => {
    const el = pickerRef.current;
    if (!el) return;
    try {
      (el as any).showPicker?.();
    } catch {}
    el.focus();
    el.click();
  };

  return (
    <span className={`relative inline-flex items-center gap-1 ${className || ""}`}>
      <input
        type="text"
        value={focused ? draft : isoToDisplay(value || "")}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => {
          setFocused(true);
          setDraft(isoToDisplay(value || ""));
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setDraft(isoToDisplay(value || ""));
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        placeholder={placeholder || "MM/DD/YYYY"}
        className="bg-transparent border-none outline-none"
      />
      <button
        type="button"
        onClick={openNativePicker}
        tabIndex={-1}
        className="text-gray-500 hover:text-gray-200 p-0.5 flex-shrink-0"
        title="Pick a date"
      >
        <Calendar size={11} />
      </button>
      <input
        ref={pickerRef}
        type="date"
        value={value || ""}
        onChange={(e) => {
          onChange(e.target.value);
          setDraft(isoToDisplay(e.target.value));
        }}
        className="absolute left-0 top-full w-px h-px opacity-0 pointer-events-none"
        tabIndex={-1}
        aria-hidden="true"
      />
    </span>
  );
}

// ─── Path helpers ───────────────────────────────────────────────────────────
async function scopedAssetPath(
  sectionDir: string,
  itemId: string,
  fileName: string
): Promise<string> {
  const scoped = await join(sectionDir, "assets", itemId, fileName);
  try {
    if (await exists(scoped)) return scoped;
  } catch {}
  return await join(sectionDir, "assets", fileName);
}

async function itemAssetsDir(sectionDir: string, itemId: string): Promise<string> {
  const dir = await join(sectionDir, "assets", itemId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Write a text file atomically: write to a `.tmp` sibling, then rename into
 * place. Prevents the file from being left in a truncated state if the app
 * is killed mid-write — which, for `gallery.meta.json`, would silently reset
 * the section cover/icon on next launch.
 */
async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeTextFile(tmp, contents);
  try {
    await fsRename(tmp, path);
  } catch (e) {
    try { await remove(tmp); } catch {}
    throw e;
  }
}

// ─── Backstory markdown renderer (inline images only) ───────────────────────
type BackstoryPart =
  | { kind: "text"; value: string }
  | { kind: "img"; alt: string; file: string };

function parseBackstory(text: string): BackstoryPart[] {
  const parts: BackstoryPart[] = [];
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push({ kind: "text", value: text.slice(last, m.index) });
    }
    parts.push({ kind: "img", alt: m[1], file: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    parts.push({ kind: "text", value: text.slice(last) });
  }
  return parts;
}

function BackstoryRenderer({
  text,
  sectionDir,
  itemId,
  onImageClick,
}: {
  text: string;
  sectionDir: string;
  itemId: string;
  onImageClick: (fileName: string) => void;
}) {
  const parts = useMemo(() => parseBackstory(text), [text]);
  if (!text.trim()) return null;

  return (
    <div className="space-y-3">
      {parts.map((p, i) => {
        if (p.kind === "text") {
          if (!p.value.trim()) return null;
          return (
            <div key={i} className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
              {p.value}
            </div>
          );
        }
        return (
          <div
            key={i}
            className="rounded-md overflow-hidden border border-[#2a3136] bg-[#0f1315] cursor-zoom-in"
            onClick={() => onImageClick(p.file)}
          >
            <AssetImage
              sectionDir={sectionDir}
              itemId={itemId}
              filename={p.file}
              className="w-full h-auto block"
            />
          </div>
        );
      })}
    </div>
  );
}

// ─── Lightbox ───────────────────────────────────────────────────────────────
function Lightbox({
  srcs, index, onClose, onIndexChange,
}: {
  srcs: string[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    startX: number; startY: number; panX: number; panY: number; moved: boolean;
  } | null>(null);

  const current = srcs[index];

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      else if (e.key === "ArrowRight" && index < srcs.length - 1)
        onIndexChange(index + 1);
      else if (e.key === "+" || e.key === "=")
        setZoom((z) => Math.min(z * 1.25, 8));
      else if (e.key === "-") {
        setZoom((z) => {
          const next = Math.max(z / 1.25, 1);
          if (next === 1) setPan({ x: 0, y: 0 });
          return next;
        });
      } else if (e.key === "0") {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, srcs.length, onClose, onIndexChange]);

  const zoomBy = (factor: number) => {
    setZoom((z) => {
      const next = Math.max(1, Math.min(z * factor, 8));
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return;
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      panX: pan.x, panY: pan.y, moved: false,
    };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (!d.moved) return;
    setPan({ x: d.panX + dx, y: d.panY + dy });
  };

  const onMouseUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.moved) return;
    if (zoom === 1) zoomBy(2);
  };

  useEffect(() => {
    const up = () => { dragRef.current = null; };
    document.addEventListener("mouseup", up);
    return () => document.removeEventListener("mouseup", up);
  }, []);

  if (!current) return null;

  return (
    <div
      className="fixed inset-0 z-[500] bg-black/95 flex items-center justify-center overflow-hidden"
      onClick={onClose}
    >
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); zoomBy(1 / 1.25); }}
          disabled={zoom <= 1}
          className="p-2 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors disabled:opacity-30"
          title="Zoom out (-)"
        >
          <ZoomOut size={18} />
        </button>
        <span className="text-white/70 text-xs tabular-nums px-2">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); zoomBy(1.25); }}
          className="p-2 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors"
          title="Zoom in (+)"
        >
          <ZoomIn size={18} />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setZoom(1); setPan({ x: 0, y: 0 }); }}
          className="p-2 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors text-[10px] font-bold"
          title="Reset (0)"
        >
          1×
        </button>
        <button
          type="button"
          onClick={onClose}
          className="p-2 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors"
          title="Close (Esc)"
        >
          <X size={18} />
        </button>
      </div>

      {srcs.length > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (index > 0) onIndexChange(index - 1); }}
            disabled={index === 0}
            className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed z-10"
            title="Previous (←)"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (index < srcs.length - 1) onIndexChange(index + 1); }}
            disabled={index === srcs.length - 1}
            className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed z-10"
            title="Next (→)"
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}

      <div
        className="w-full h-full flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        style={{ cursor: zoom > 1 ? (dragRef.current ? "grabbing" : "grab") : "zoom-in" }}
      >
        <img
          src={current}
          alt=""
          draggable={false}
          className="select-none"
          style={{
            maxWidth: "80vw",
            maxHeight: "78vh",
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "center center",
            transition: dragRef.current?.moved ? "none" : "transform 120ms ease-out",
            userSelect: "none",
          }}
        />
      </div>

      {srcs.length > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/70 bg-black/60 px-3 py-1.5 rounded-full">
          {index + 1} / {srcs.length}
        </div>
      )}

      {zoom === 1 && (
        <div className="absolute bottom-4 right-4 text-[10px] text-white/50 bg-black/60 px-2 py-1 rounded">
          click to zoom · scroll to scale · drag to pan
        </div>
      )}
    </div>
  );
}

// ─── Asset image ────────────────────────────────────────────────────────────
function AssetImage({
  sectionDir, itemId, filename, className,
}: {
  sectionDir: string;
  itemId: string;
  filename: string;
  className?: string;
}) {
  const [src, setSrc] = useState<string>("");

  useEffect(() => {
    let mounted = true;
    (async () => {
      const full = await scopedAssetPath(sectionDir, itemId, filename);
      if (mounted) setSrc(convertFileSrc(full));
    })();
    return () => { mounted = false; };
  }, [sectionDir, itemId, filename]);

  if (!src) {
    return <div className={className ? `${className} bg-[#0f1315]` : "bg-[#0f1315]"} />;
  }
  return <img src={src} alt={filename} className={className} />;
}

function FramedPhoto({
  sectionDir,
  itemId,
  filename,
  className,
}: {
  sectionDir: string;
  itemId: string;
  filename: string;
  className: string;
}) {
  return (
    <AssetImage
      sectionDir={sectionDir}
      itemId={itemId}
      filename={filename}
      className={className}
    />
  );
}

function SliderRow({
  label, value, min, max, unit, onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="flex justify-between text-[10px] uppercase tracking-wider text-gray-500 mb-1">
        <span>{label}</span>
        <span className="text-gray-400 normal-case">
          {value}
          {unit}
        </span>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-blue-500"
      />
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────
export default function GalleryView({ sectionDir, sectionName }: GalleryViewProps) {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<
    { srcs: string[]; index: number } | null
  >(null);
  const { modal, promptAsync, confirmAsync } = useModal();
  const { mode, toggle } = useNoteMode();
  const isEdit = mode === "edit";

  const [meta, setMeta] = useState<SectionMeta>(DEFAULT_META);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  const [coverUrlDraft, setCoverUrlDraft] = useState("");
  const coverPickerRef = useRef<HTMLDivElement>(null);
  const iconPickerRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [activeYear, setActiveYear] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  const [linkDraft, setLinkDraft] = useState("");
  const [savingLink, setSavingLink] = useState(false);

  const [progressNoteDraft, setProgressNoteDraft] = useState("");
  const backstoryRef = useRef<HTMLTextAreaElement>(null);

  const [newItemOpen, setNewItemOpen] = useState(false);
  const [newItemTitle, setNewItemTitle] = useState("");
  const [newItemDate, setNewItemDate] = useState<string>(nowIsoDate());
  const [newItemPaths, setNewItemPaths] = useState<string[]>([]);
  const [creatingItem, setCreatingItem] = useState(false);

  const [viewMode, setViewMode] = useState<GalleryViewMode>(() => {
    try {
      const v = localStorage.getItem(VIEW_MODE_KEY);
      if (v === "gallery" || v === "list") return v;
      return "grid";
    } catch { return "grid"; }
  });

  const updateViewMode = (next: GalleryViewMode) => {
    setViewMode(next);
    try { localStorage.setItem(VIEW_MODE_KEY, next); } catch {}
  };

  // ── Meta persistence ────────────────────────────────────────────────────
  const metaPath = async () => join(sectionDir, "gallery.meta.json");

  // Coalesce rapid `saveMeta` calls (sliders fire on every input event).
  const metaWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metaPendingRef = useRef<Partial<SectionMeta> | null>(null);

  const loadMeta = async () => {
    try {
      const raw = await readTextFile(await metaPath());
      const parsed = JSON.parse(raw);
      setMeta({ ...DEFAULT_META, ...parsed });
    } catch {
      setMeta(DEFAULT_META);
    }
  };

  const saveMeta = (patch: Partial<SectionMeta>) => {
    // Optimistic UI update.
    setMeta((prev) => ({ ...prev, ...patch }));

    // Batch the write. If a timer is already pending, merge into it.
    metaPendingRef.current = { ...(metaPendingRef.current || {}), ...patch };
    if (metaWriteTimerRef.current) clearTimeout(metaWriteTimerRef.current);
    metaWriteTimerRef.current = setTimeout(async () => {
      metaWriteTimerRef.current = null;
      const pending = metaPendingRef.current;
      metaPendingRef.current = null;
      if (!pending) return;
      try {
        // Re-read to merge with any concurrent edits (e.g. another window).
        let current: SectionMeta = { ...DEFAULT_META };
        try {
          const raw = await readTextFile(await metaPath());
          current = { ...DEFAULT_META, ...JSON.parse(raw) };
        } catch {}
        const merged = { ...current, ...pending };
        await writeFileAtomic(
          await metaPath(),
          JSON.stringify(merged, null, 2)
        );
      } catch (e) {
        console.error("[gallery] meta save failed:", e);
      }
    }, 200);
  };

  // Flush any pending meta write on unmount so we don't lose the last edit.
  useEffect(() => {
    return () => {
      if (metaWriteTimerRef.current) {
        clearTimeout(metaWriteTimerRef.current);
        metaWriteTimerRef.current = null;
        const pending = metaPendingRef.current;
        metaPendingRef.current = null;
        if (pending) {
          // Fire-and-forget; the component is going away.
          void (async () => {
            try {
              let current: SectionMeta = { ...DEFAULT_META };
              try {
                const raw = await readTextFile(await metaPath());
                current = { ...DEFAULT_META, ...JSON.parse(raw) };
              } catch {}
              await writeFileAtomic(
                await metaPath(),
                JSON.stringify({ ...current, ...pending }, null, 2)
              );
            } catch {}
          })();
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionDir]);

  useEffect(() => {
    if (!iconPickerOpen && !coverPickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (iconPickerRef.current?.contains(t)) return;
      if (coverPickerRef.current?.contains(t)) return;
      setIconPickerOpen(false);
      setCoverPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIconPickerOpen(false);
        setCoverPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [iconPickerOpen, coverPickerOpen]);

  const applyIcon = async (emoji: string) => {
    saveMeta({ icon: emoji });
    setIconPickerOpen(false);
  };

  const uploadCover = async () => {
    try {
      const picked = await open({
        multiple: false,
        filters: [
          { name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg"] },
        ],
      });
      if (!picked || typeof picked !== "string") return;
      const assetsDir = await join(sectionDir, "assets");
      await mkdir(assetsDir, { recursive: true });
      const safe = sanitizeFileName(picked.split(/[/\\]/).pop() || "cover.png");
      const finalName = await uniqueNameIn(assetsDir, safe);
      const destPath = await join(assetsDir, finalName);
      await copyFile(picked, destPath);
      const absPath = destPath.replace(/\\/g, "/");
      saveMeta({ coverType: "image", coverValue: absPath });
    } catch (e) {
      console.error("[gallery] cover upload failed:", e);
    }
  };

  const applyCoverGradient = async (id: string) => {
    saveMeta({ coverType: "color", coverValue: id });
  };

  const applyCoverUrl = async (url: string) => {
    const v = url.trim();
    if (!v) return;
    saveMeta({ coverType: "image", coverValue: v });
    setCoverUrlDraft("");
  };

  const removeCover = async () => {
    saveMeta({
      coverType: "",
      coverValue: "",
      coverPosX: 50,
      coverPosY: 50,
      coverOpacity: 100,
      coverBlur: 0,
      coverRadius: 0,
    });
    setCoverPickerOpen(false);
  };

  const resolveCoverUrl = (value: string): string => {
    if (!value) return "";
    if (/^(https?:|data:|blob:)/i.test(value)) return value;
    try { return convertFileSrc(value); } catch { return value; }
  };

  const hasCover = meta.coverType === "color" || meta.coverType === "image";

  const coverBackground: React.CSSProperties = (() => {
    if (meta.coverType === "color") {
      const preset = COVER_GRADIENTS.find((g) => g.id === meta.coverValue);
      return { backgroundImage: preset?.value || COVER_GRADIENTS[0].value };
    }
    if (meta.coverType === "image") {
      return {
        backgroundImage: `url("${resolveCoverUrl(meta.coverValue || "")}")`,
        backgroundSize: "cover",
        backgroundPosition: `${meta.coverPosX ?? 50}% ${meta.coverPosY ?? 50}%`,
        backgroundRepeat: "no-repeat",
      };
    }
    return {};
  })();

  // ── Persistence plumbing ────────────────────────────────────────────────
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ dir: string; data: GalleryItem[] } | null>(null);

  const writeGallery = (dir: string, data: GalleryItem[]) => {
    void (async () => {
      try {
        const p = await join(dir, "gallery.json");
        await writeFileAtomic(p, JSON.stringify(data, null, 2));
      } catch (e) {
        console.error("[gallery] write failed:", e);
      }
    })();
  };

  const flushPending = () => {
    if (writeTimerRef.current) {
      clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) writeGallery(pending.dir, pending.data);
  };

  const scheduleWrite = (dir: string, data: GalleryItem[]) => {
    pendingRef.current = { dir, data };
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      writeTimerRef.current = null;
      const p = pendingRef.current;
      pendingRef.current = null;
      if (p) writeGallery(p.dir, p.data);
    }, 200);
  };

  useEffect(() => {
    return () => { flushPending(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionDir]);

  const load = async () => {
    try {
      const raw = await readTextFile(await join(sectionDir, "gallery.json"));
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setItems(
          parsed.map((it: any) => {
            let mainImages: string[] = Array.isArray(it.mainImages)
              ? it.mainImages
              : [];
            if (mainImages.length === 0 && typeof it.image === "string" && it.image) {
              mainImages = [it.image];
            }
            const progress: ProgressEntry[] = Array.isArray(it.progress)
              ? it.progress.map((p: any) => ({
                  id: p.id ?? newId("progress"),
                  date: p.date ?? nowIsoDate(),
                  note: p.note ?? "",
                  image: p.image ?? null,
                }))
              : [];
            const versions: VersionEntry[] = Array.isArray(it.versions)
              ? it.versions.map((v: any) => ({
                  id: v.id ?? newId("version"),
                  label: v.label ?? "",
                  date: v.date ?? nowIsoDate(),
                  image: v.image ?? "",
                  note: v.note ?? "",
                })).filter((v: VersionEntry) => v.image)
              : [];
            return {
              id: it.id ?? newId("art"),
              title: it.title ?? "",
              backstory: it.backstory ?? it.description ?? "",
              dateMade: it.dateMade ?? "",
              time: migrateTime(it),
              mainImages,
              referenceImages: Array.isArray(it.referenceImages) ? it.referenceImages : [],
              tags: Array.isArray(it.tags) ? it.tags : [],
              links: Array.isArray(it.links) ? it.links : [],
              progress,
              versions,
            };
          })
        );
      } else {
        setItems([]);
      }
    } catch {
      setItems([]);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionDir]);

  const save = (next: GalleryItem[]) => {
    setItems(next);
    scheduleWrite(sectionDir, next);
  };

  const updateItem = (id: string, patch: Partial<GalleryItem>) => {
    setItems((prev) => {
      const next = prev.map((it) => (it.id === id ? { ...it, ...patch } : it));
      scheduleWrite(sectionDir, next);
      return next;
    });
  };

  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e: MouseEvent) => {
      if (filterRef.current?.contains(e.target as Node)) return;
      setFilterOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [filterOpen]);

  useEffect(() => {
    const el = backstoryRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 72)}px`;
  }, [selectedId, items, isEdit]);

  const years = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) {
      const y = yearOf(it.dateMade);
      if (y) set.add(y);
    }
    return Array.from(set).sort((a, b) => Number(b) - Number(a));
  }, [items]);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) {
      for (const t of it.tags) {
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    return Array.from(counts.entries()).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
  }, [items]);

  const activeFilterCount = (activeYear ? 1 : 0) + (activeTag ? 1 : 0);

  const clearAllFilters = () => {
    setActiveYear(null);
    setActiveTag(null);
  };

  const filtered = useMemo(() => {
    let list = items;
    if (activeYear) {
      list = list.filter((it) => yearOf(it.dateMade) === activeYear);
    }
    if (activeTag) {
      list = list.filter((it) => it.tags.includes(activeTag));
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((it) => {
        const haystack = [it.title, it.backstory, it.dateMade, it.time, ...it.tags]
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }
    return [...list].sort((a, b) => {
      const da = a.dateMade || "";
      const db = b.dateMade || "";
      if (da && db) return db.localeCompare(da);
      if (da) return -1;
      if (db) return 1;
      return 0;
    });
  }, [items, activeYear, activeTag, query]);

  // ── Create item ─────────────────────────────────────────────────────────
  const createItem = async () => {
    const picked = await open({
      multiple: true,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"] }],
    });
    if (!picked) return;
    const arr = Array.isArray(picked) ? picked : [picked];
    const paths = arr.filter((p): p is string => typeof p === "string");
    if (paths.length === 0) return;

    setNewItemPaths(paths);
    setNewItemTitle("");
    setNewItemDate(nowIsoDate());
    setNewItemOpen(true);
  };

  const confirmNewItem = async () => {
    if (newItemPaths.length === 0) return;
    setCreatingItem(true);

    const title = newItemTitle.trim() || "Untitled";
    const dateIso = newItemDate || nowIsoDate();

    const id = newId("art");
    const dir = await itemAssetsDir(sectionDir, id);

    const saved: string[] = [];
    for (const p of newItemPaths) {
      const safe = sanitizeFileName(p.split(/[/\\]/).pop() || "image.png");
      const destName = await uniqueNameIn(dir, safe);
      try {
        await copyFile(p, await join(dir, destName));
        saved.push(destName);
      } catch (e) {
        console.error("[gallery] copy failed:", e);
      }
    }

    if (saved.length === 0) {
      setCreatingItem(false);
      return;
    }

    const item: GalleryItem = {
      id,
      title,
      backstory: "",
      dateMade: dateIso,
      time: "",
      mainImages: saved,
      referenceImages: [],
      tags: [],
      links: [],
      progress: [],
      versions: [],
    };
    save([item, ...items]);
    setSelectedId(id);

    setCreatingItem(false);
    setNewItemOpen(false);
    setNewItemPaths([]);
    setNewItemTitle("");
    setNewItemDate(nowIsoDate());
  };

  const cancelNewItem = () => {
    if (creatingItem) return;
    setNewItemOpen(false);
    setNewItemPaths([]);
    setNewItemTitle("");
    setNewItemDate(nowIsoDate());
  };

  const deleteItem = async (item: GalleryItem) => {
    const ok = await confirmAsync(
      `Delete "${item.title || "this piece"}"? All its image files will be moved to the system trash.`
    );
    if (!ok) return;

    const itemDir = await join(sectionDir, "assets", item.id);
    try {
      if (await exists(itemDir)) await moveToTrash(itemDir);
    } catch (e) {
      console.warn("[gallery] could not trash item folder:", e);
    }

    const files = [
      ...item.mainImages,
      ...item.referenceImages,
      ...item.progress.map((p) => p.image).filter(Boolean) as string[],
      ...item.versions.map((v) => v.image),
    ].filter(Boolean);
    for (const f of files) {
      try {
        const flat = await join(sectionDir, "assets", f);
        if (await exists(flat)) await moveToTrash(flat);
      } catch (e) {
        console.warn("[gallery] could not trash legacy image:", f, e);
      }
    }

    save(items.filter((i) => i.id !== item.id));
    setSelectedId(null);
  };

  const addTagToItem = (item: GalleryItem, raw: string) => {
    const tag = normalizeTag(raw);
    if (!tag) return;
    if (item.tags.includes(tag)) return;
    updateItem(item.id, { tags: [...item.tags, tag].sort() });
  };

  const removeTagFromItem = (item: GalleryItem, tag: string) => {
    updateItem(item.id, { tags: item.tags.filter((t) => t !== tag) });
  };

  const addMainImages = async (item: GalleryItem) => {
    const picked = await open({
      multiple: true,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"] }],
    });
    if (!picked) return;
    const arr = Array.isArray(picked) ? picked : [picked];
    const paths = arr.filter((p): p is string => typeof p === "string");
    if (paths.length === 0) return;

    const dir = await itemAssetsDir(sectionDir, item.id);
    const added: string[] = [];
    for (const p of paths) {
      const safe = sanitizeFileName(p.split(/[/\\]/).pop() || "image.png");
      const destName = await uniqueNameIn(dir, safe);
      try {
        await copyFile(p, await join(dir, destName));
        added.push(destName);
      } catch (e) {
        console.error("[gallery] main image copy failed:", e);
      }
    }
    if (added.length) {
      updateItem(item.id, { mainImages: [...item.mainImages, ...added] });
    }
  };

  const removeMainImage = async (item: GalleryItem, fileName: string) => {
    try {
      const full = await scopedAssetPath(sectionDir, item.id, fileName);
      await moveToTrash(full);
    } catch (e) {
      console.warn("[gallery] could not trash main image:", e);
    }
    updateItem(item.id, {
      mainImages: item.mainImages.filter((f) => f !== fileName),
    });
  };

  const addReferenceImages = async (item: GalleryItem) => {
    const picked = await open({
      multiple: true,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"] }],
    });
    if (!picked) return;
    const arr = Array.isArray(picked) ? picked : [picked];
    const paths = arr.filter((p): p is string => typeof p === "string");
    if (paths.length === 0) return;

    const dir = await itemAssetsDir(sectionDir, item.id);
    const added: string[] = [];
    for (const p of paths) {
      const safe = sanitizeFileName(p.split(/[/\\]/).pop() || "image.png");
      const destName = await uniqueNameIn(dir, safe);
      try {
        await copyFile(p, await join(dir, destName));
        added.push(destName);
      } catch (e) {
        console.error("[gallery] reference image copy failed:", e);
      }
    }
    if (added.length) {
      updateItem(item.id, {
        referenceImages: [...item.referenceImages, ...added],
      });
    }
  };

  const removeReferenceImage = async (item: GalleryItem, fileName: string) => {
    try {
      const full = await scopedAssetPath(sectionDir, item.id, fileName);
      await moveToTrash(full);
    } catch (e) {
      console.warn("[gallery] could not trash reference image:", e);
    }
    updateItem(item.id, {
      referenceImages: item.referenceImages.filter((f) => f !== fileName),
    });
  };

  const insertBackstoryImage = async (item: GalleryItem) => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"] }],
    });
    if (!picked || typeof picked !== "string") return;
    const dir = await itemAssetsDir(sectionDir, item.id);
    const safe = sanitizeFileName(picked.split(/[/\\]/).pop() || "image.png");
    const destName = await uniqueNameIn(dir, safe);
    try {
      await copyFile(picked, await join(dir, destName));
    } catch (e) {
      console.error("[gallery] backstory image copy failed:", e);
      return;
    }

    const token = `\n![](${destName})\n`;
    const ta = backstoryRef.current;
    const current = item.backstory || "";

    // If the textarea has never been focused, selectionStart is 0 rather
    // than null. We only want to insert at the cursor when the user is
    // actively editing; otherwise append to the end.
    const hasFocus = document.activeElement === ta;
    const start = (hasFocus && ta) ? (ta.selectionStart ?? current.length) : current.length;
    const end = (hasFocus && ta) ? (ta.selectionEnd ?? current.length) : current.length;

    const nextText = current.slice(0, start) + token + current.slice(end);
    updateItem(item.id, { backstory: nextText });

    requestAnimationFrame(() => {
      const t = backstoryRef.current;
      if (!t) return;
      const pos = start + token.length;
      t.selectionStart = t.selectionEnd = pos;
      t.focus();
    });
  };

  const removeBackstoryImage = async (item: GalleryItem, fileName: string) => {
    try {
      const full = await scopedAssetPath(sectionDir, item.id, fileName);
      await moveToTrash(full);
    } catch (e) {
      console.warn("[gallery] could not trash backstory image:", e);
    }
    const token = `![](${fileName})`;
    const updated = (item.backstory || "").split(token).join("").replace(/\n{3,}/g, "\n\n");
    updateItem(item.id, { backstory: updated });
  };

  const addProgress = async (item: GalleryItem) => {
    const note = progressNoteDraft.trim();
    if (!note) return;

    const entry: ProgressEntry = {
      id: newId("progress"),
      date: new Date().toISOString(),
      note,
      image: null,
    };
    updateItem(item.id, { progress: [...item.progress, entry] });
    setProgressNoteDraft("");
  };

  const addProgressImage = async (item: GalleryItem, progressId: string) => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"] }],
    });
    if (!picked || typeof picked !== "string") return;
    const dir = await itemAssetsDir(sectionDir, item.id);
    const safe = sanitizeFileName(picked.split(/[/\\]/).pop() || "image.png");
    const destName = await uniqueNameIn(dir, safe);
    try {
      await copyFile(picked, await join(dir, destName));
    } catch (e) {
      console.error("[gallery] progress image copy failed:", e);
      return;
    }
    updateItem(item.id, {
      progress: item.progress.map((p) =>
        p.id === progressId ? { ...p, image: destName } : p
      ),
    });
  };

  const removeProgressImage = async (item: GalleryItem, progressId: string) => {
    const entry = item.progress.find((p) => p.id === progressId);
    if (!entry?.image) return;
    try {
      const full = await scopedAssetPath(sectionDir, item.id, entry.image);
      await moveToTrash(full);
    } catch (e) {
      console.warn("[gallery] could not trash progress image:", e);
    }
    updateItem(item.id, {
      progress: item.progress.map((p) =>
        p.id === progressId ? { ...p, image: null } : p
      ),
    });
  };

  const removeProgress = async (item: GalleryItem, progressId: string) => {
    const entry = item.progress.find((p) => p.id === progressId);
    if (entry?.image) {
      try {
        const full = await scopedAssetPath(sectionDir, item.id, entry.image);
        await moveToTrash(full);
      } catch (e) {
        console.warn("[gallery] could not trash progress image:", e);
      }
    }
    updateItem(item.id, {
      progress: item.progress.filter((p) => p.id !== progressId),
    });
  };

  const addVersion = async (item: GalleryItem) => {
    // Pick the image first, then ask for a label. If the user cancels the
    // picker, no prompt is wasted; if they cancel the prompt, we clean up
    // the just-copied file.
    const picked = await open({
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"] }],
    });
    if (!picked || typeof picked !== "string") return;

    const dir = await itemAssetsDir(sectionDir, item.id);
    const safe = sanitizeFileName(picked.split(/[/\\]/).pop() || "image.png");
    const destName = await uniqueNameIn(dir, safe);
    try {
      await copyFile(picked, await join(dir, destName));
    } catch (e) {
      console.error("[gallery] version image copy failed:", e);
      return;
    }

    const label = await promptAsync("Version label (e.g. 'Rough sketch', 'v1'):");
    if (label === null) {
      // User cancelled the label — clean up the orphaned file.
      try {
        const full = await scopedAssetPath(sectionDir, item.id, destName);
        await moveToTrash(full);
      } catch {}
      return;
    }

    const entry: VersionEntry = {
      id: newId("version"),
      label: label.trim() || `Version ${item.versions.length + 1}`,
      date: new Date().toISOString(),
      image: destName,
      note: "",
    };
    updateItem(item.id, { versions: [...item.versions, entry] });
  };

  const removeVersion = async (item: GalleryItem, versionId: string) => {
    const entry = item.versions.find((v) => v.id === versionId);
    if (entry?.image) {
      try {
        const full = await scopedAssetPath(sectionDir, item.id, entry.image);
        await moveToTrash(full);
      } catch (e) {
        console.warn("[gallery] could not trash version image:", e);
      }
    }
    updateItem(item.id, {
      versions: item.versions.filter((v) => v.id !== versionId),
    });
  };

  const updateVersionLabel = (item: GalleryItem, versionId: string, label: string) => {
    updateItem(item.id, {
      versions: item.versions.map((v) =>
        v.id === versionId ? { ...v, label } : v
      ),
    });
  };

  const addLink = async (item: GalleryItem) => {
    const url = linkDraft.trim();
    if (!url) return;
    setSavingLink(true);

    let title = url;
    try {
      const meta: any = await invoke("fetch_link_metadata", { url });
      if (meta?.title) title = meta.title;
    } catch (e) {
      console.warn("[gallery] metadata fetch failed:", e);
    }

    const l: GalleryLink = {
      id: newId("link"),
      url,
      title,
    };
    updateItem(item.id, { links: [...item.links, l] });
    setLinkDraft("");
    setSavingLink(false);
  };

  const removeLink = (item: GalleryItem, id: string) => {
    updateItem(item.id, { links: item.links.filter((l) => l.id !== id) });
  };

  const openLink = (url: string) => {
    openUrl(url).catch((e) => console.error("[gallery] open link failed:", e));
  };

  const openLightbox = (item: GalleryItem, index: number) => {
    const names = [...item.mainImages, ...item.referenceImages].filter(Boolean);
    Promise.all(
      names.map(async (f) => {
        const full = await scopedAssetPath(sectionDir, item.id, f);
        return convertFileSrc(full);
      })
    ).then((srcs) => setLightbox({ srcs, index }));
  };

  const openLightboxFiles = (item: GalleryItem, filenames: string[], index: number) => {
    Promise.all(
      filenames.map(async (f) => {
        const full = await scopedAssetPath(sectionDir, item.id, f);
        return convertFileSrc(full);
      })
    ).then((srcs) => setLightbox({ srcs, index }));
  };

  const selected = selectedId
    ? items.find((i) => i.id === selectedId) || null
    : null;

  // ── View toggle UI ──────────────────────────────────────────────────────
  const viewToggle = (
    <div className="flex items-center bg-[#0f1315] border border-[#30363d] rounded p-0.5 flex-shrink-0">
      <button
        type="button"
        onClick={() => updateViewMode("grid")}
        className={`flex items-center justify-center w-7 h-7 rounded transition-colors cursor-pointer ${
          viewMode === "grid" ? "bg-[#2a3136] text-gray-100" : "text-gray-500 hover:text-gray-300"
        }`}
        title="Grid — cropped previews"
      >
        <LayoutGrid size={13} />
      </button>
      <button
        type="button"
        onClick={() => updateViewMode("gallery")}
        className={`flex items-center justify-center w-7 h-7 rounded transition-colors cursor-pointer ${
          viewMode === "gallery" ? "bg-[#2a3136] text-gray-100" : "text-gray-500 hover:text-gray-300"
        }`}
        title="Gallery — framed full photos"
      >
        <ImageIcon size={13} />
      </button>
      <button
        type="button"
        onClick={() => updateViewMode("list")}
        className={`flex items-center justify-center w-7 h-7 rounded transition-colors cursor-pointer ${
          viewMode === "list" ? "bg-[#2a3136] text-gray-100" : "text-gray-500 hover:text-gray-300"
        }`}
        title="List — photo with details"
      >
        <Rows3 size={13} />
      </button>
    </div>
  );

  // ── Grid view ───────────────────────────────────────────────────────────
  const renderGridView = () => (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
      {filtered.map((item) => {
        const bsPreview = preview(item.backstory);
        const timeTrim = item.time.trim();
        const cover = item.mainImages[0];
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => setSelectedId(item.id)}
            className="group text-left bg-[#161a1d] border border-[#2a3136] rounded-lg overflow-hidden hover:border-[#3a4147] transition-colors flex flex-col"
          >
            <div className="w-full h-44 bg-[#0f1315] overflow-hidden relative">
              {cover ? (
                <AssetImage
                  sectionDir={sectionDir}
                  itemId={item.id}
                  filename={cover}
                  className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-700">
                  <ImageIcon size={28} />
                </div>
              )}
              {item.dateMade && (
                <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-black/70 text-[10px] text-white/90 font-medium backdrop-blur-sm">
                  {isoToDisplay(item.dateMade)}
                </div>
              )}
              {item.mainImages.length > 1 && (
                <div className="absolute top-2 right-2 px-2 py-0.5 rounded-full bg-black/70 text-[10px] text-white/90 font-medium backdrop-blur-sm flex items-center gap-1">
                  <ImageIcon size={9} /> {item.mainImages.length}
                </div>
              )}
            </div>

            <div className="p-3 flex-1 flex flex-col min-h-[5rem]">
              <div className="text-sm font-medium text-gray-200 truncate">
                {item.title || "Untitled"}
              </div>

              {bsPreview && (
                <div className="text-xs text-gray-500 mt-1 line-clamp-2">
                  {bsPreview}
                </div>
              )}

              <div className="mt-auto pt-2 flex items-end justify-between gap-2">
                {item.tags.length > 0 ? (
                  <div className="flex items-center gap-1 flex-shrink-0 max-w-[65%] overflow-hidden">
                    {item.tags.slice(0, 2).map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-[#1e2327] border border-[#2a3136] text-gray-400 truncate max-w-[80px]"
                        title={tag}
                      >
                        {tag}
                      </span>
                    ))}
                    {item.tags.length > 2 && (
                      <span
                        className="text-[10px] text-gray-500 flex-shrink-0"
                        title={item.tags.join(", ")}
                      >
                        +{item.tags.length - 2}
                      </span>
                    )}
                  </div>
                ) : (
                  <div />
                )}

                <div className="flex items-center gap-3 text-[10px] text-gray-600 min-w-0 flex-shrink justify-end">
                  {timeTrim && (
                    <span className="flex items-center gap-1 truncate">
                      <Clock size={9} className="flex-shrink-0" />
                      <span className="truncate" title={timeTrim}>
                        {timeTrim}
                      </span>
                    </span>
                  )}
                  {item.referenceImages.length > 0 && (
                    <span className="flex items-center gap-1 flex-shrink-0">
                      <ImageIcon size={9} />
                      {item.referenceImages.length}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );

  // ── Gallery view ────────────────────────────────────────────────────────
  const renderGalleryView = () => (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 items-start">
      {filtered.map((item) => {
        const bsPreview = preview(item.backstory);
        const timeTrim = item.time.trim();
        const cover = item.mainImages[0];
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => setSelectedId(item.id)}
            className="group text-left bg-[#161a1d] border border-[#2a3136] rounded-lg overflow-hidden hover:border-[#3a4147] transition-colors flex flex-col"
          >
            <div className="w-full bg-[#0f1315] overflow-hidden relative">
              {cover ? (
                <FramedPhoto
                  sectionDir={sectionDir}
                  itemId={item.id}
                  filename={cover}
                  className="w-full h-auto block border-[3px] border-white rounded-sm group-hover:scale-[1.01] transition-transform duration-300"
                />
              ) : (
                <div className="w-full h-44 flex items-center justify-center text-gray-700">
                  <ImageIcon size={28} />
                </div>
              )}
              {item.dateMade && (
                <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-black/70 text-[10px] text-white/90 font-medium backdrop-blur-sm z-10">
                  {isoToDisplay(item.dateMade)}
                </div>
              )}
              {item.mainImages.length > 1 && (
                <div className="absolute top-2 right-2 px-2 py-0.5 rounded-full bg-black/70 text-[10px] text-white/90 font-medium backdrop-blur-sm z-10 flex items-center gap-1">
                  <ImageIcon size={9} /> {item.mainImages.length}
                </div>
              )}
            </div>

            <div className="p-3 flex-1 flex flex-col min-h-[5rem]">
              <div className="text-sm font-medium text-gray-200 truncate">
                {item.title || "Untitled"}
              </div>

              {bsPreview && (
                <div className="text-xs text-gray-500 mt-1 line-clamp-2">
                  {bsPreview}
                </div>
              )}

              <div className="mt-auto pt-2 flex items-end justify-between gap-2">
                {item.tags.length > 0 ? (
                  <div className="flex items-center gap-1 flex-shrink-0 max-w-[65%] overflow-hidden">
                    {item.tags.slice(0, 2).map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-[#1e2327] border border-[#2a3136] text-gray-400 truncate max-w-[80px]"
                        title={tag}
                      >
                        {tag}
                      </span>
                    ))}
                    {item.tags.length > 2 && (
                      <span
                        className="text-[10px] text-gray-500 flex-shrink-0"
                        title={item.tags.join(", ")}
                      >
                        +{item.tags.length - 2}
                      </span>
                    )}
                  </div>
                ) : (
                  <div />
                )}

                <div className="flex items-center gap-3 text-[10px] text-gray-600 min-w-0 flex-shrink justify-end">
                  {timeTrim && (
                    <span className="flex items-center gap-1 truncate">
                      <Clock size={9} className="flex-shrink-0" />
                      <span className="truncate" title={timeTrim}>
                        {timeTrim}
                      </span>
                    </span>
                  )}
                  {item.referenceImages.length > 0 && (
                    <span className="flex items-center gap-1 flex-shrink-0">
                      <ImageIcon size={9} />
                      {item.referenceImages.length}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );

  // ── List view ───────────────────────────────────────────────────────────
  const renderListView = () => (
    <div className="space-y-3">
      {filtered.map((item) => {
        const timeTrim = item.time.trim();
        const cover = item.mainImages[0];
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => setSelectedId(item.id)}
            className="group w-full text-left bg-[#161a1d] border border-[#2a3136] rounded-lg overflow-hidden hover:border-[#3a4147] transition-colors flex flex-row"
          >
            <div className="w-56 sm:w-64 flex-shrink-0 bg-[#0f1315] flex items-center justify-center overflow-hidden relative min-h-[12rem] max-h-[24rem] p-2">
              {cover ? (
                <FramedPhoto
                  sectionDir={sectionDir}
                  itemId={item.id}
                  filename={cover}
                  className="max-w-full max-h-full w-auto h-auto object-contain block border-[3px] border-white rounded-sm group-hover:scale-[1.02] transition-transform duration-300"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-700">
                  <ImageIcon size={28} />
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0 p-4 flex flex-col">
              <div className="flex items-baseline justify-between gap-3">
                <h4 className="text-base font-medium text-gray-100 truncate">
                  {item.title || "Untitled"}
                </h4>
                {item.dateMade && (
                  <span className="text-[11px] text-gray-500 flex-shrink-0">
                    {isoToDisplay(item.dateMade)}
                  </span>
                )}
              </div>

              {item.backstory.trim() && (
                <p className="text-xs text-gray-400 mt-2 leading-relaxed whitespace-pre-wrap flex-1">
                  {preview(item.backstory, 800)}
                </p>
              )}

              <div className="pt-3 flex items-center gap-3 flex-wrap">
                {timeTrim && (
                  <span className="flex items-center gap-1 text-[10px] text-gray-500">
                    <Clock size={9} />
                    <span>{timeTrim}</span>
                  </span>
                )}
                {item.mainImages.length > 0 && (
                  <span className="flex items-center gap-1 text-[10px] text-gray-500">
                    <ImageIcon size={9} />
                    {item.mainImages.length}
                  </span>
                )}
                {item.referenceImages.length > 0 && (
                  <span className="flex items-center gap-1 text-[10px] text-gray-500">
                    <ImageIcon size={9} />
                    {item.referenceImages.length} reference
                    {item.referenceImages.length === 1 ? "" : "s"}
                  </span>
                )}
                {item.versions.length > 0 && (
                  <span className="flex items-center gap-1 text-[10px] text-gray-500">
                    <GitBranch size={9} />
                    {item.versions.length} version{item.versions.length === 1 ? "" : "s"}
                  </span>
                )}
                {item.links.length > 0 && (
                  <span className="flex items-center gap-1 text-[10px] text-gray-500">
                    <LinkIcon size={9} />
                    {item.links.length} link{item.links.length === 1 ? "" : "s"}
                  </span>
                )}
                {item.tags.length > 0 && (
                  <div className="flex items-center gap-1 ml-auto overflow-hidden">
                    {item.tags.slice(0, 4).map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-[#1e2327] border border-[#2a3136] text-gray-400 truncate max-w-[90px]"
                        title={tag}
                      >
                        {tag}
                      </span>
                    ))}
                    {item.tags.length > 4 && (
                      <span
                        className="text-[10px] text-gray-500 flex-shrink-0"
                        title={item.tags.join(", ")}
                      >
                        +{item.tags.length - 4}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );

  // ── Grid view with header ───────────────────────────────────────────────
  const gridView = (
    <div className="w-full h-full overflow-y-auto bg-[#0f1315]">
      {hasCover && (
        <div className="relative w-full h-52 overflow-hidden">
          <div
            className="absolute inset-0"
            style={{
              ...coverBackground,
              opacity: (meta.coverOpacity ?? 100) / 100,
              filter:
                (meta.coverBlur ?? 0) > 0
                  ? `blur(${meta.coverBlur}px)`
                  : undefined,
              borderRadius:
                (meta.coverRadius ?? 0) > 0
                  ? `${meta.coverRadius}px`
                  : undefined,
            }}
          />
          {meta.coverTextShadow !== false && (
            <div className="absolute inset-0 bg-gradient-to-t from-[#0f1315] via-transparent to-transparent pointer-events-none" />
          )}
        </div>
      )}

      <div className="max-w-6xl mx-auto px-8 py-8">
        <div
          className={`flex items-end justify-between gap-4 mb-6 ${
            hasCover ? "-mt-16 relative z-10" : ""
          }`}
        >
          <div className="flex items-end gap-4 min-w-0">
            <div className="relative flex-shrink-0" ref={iconPickerRef}>
              <button
                type="button"
                onClick={() => setIconPickerOpen((o) => !o)}
                className={`leading-none p-1 rounded transition-colors cursor-pointer hover:bg-white/10 flex items-center justify-center ${
                  meta.icon ? "text-6xl" : "text-3xl text-gray-500 hover:text-gray-300"
                }`}
                style={
                  hasCover && meta.coverTextShadow !== false
                    ? { filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.7))" }
                    : undefined
                }
                title={meta.icon ? "Click to change icon" : "Add an icon"}
              >
                {meta.icon || (
                  <span className="flex items-center gap-1.5 px-2 py-1 text-xs rounded border border-dashed border-[#30363d] hover:border-[#3a4147] whitespace-nowrap">
                    <Smile size={12} /> Add icon
                  </span>
                )}
              </button>

              {iconPickerOpen && (
                <div className="absolute top-full left-0 mt-2 z-[200]">
                  <EmojiPicker
                    theme={Theme.DARK}
                    emojiStyle={EmojiStyle.NATIVE}
                    onEmojiClick={(d) => applyIcon(d.emoji)}
                    width={320}
                    height={400}
                    previewConfig={{ showPreview: false }}
                  />
                </div>
              )}
            </div>

            <h2
              className="text-4xl font-bold truncate"
              style={{
                color: "#4ade80",
                textShadow:
                  hasCover && meta.coverTextShadow !== false
                    ? "0 2px 12px rgba(0,0,0,0.8)"
                    : undefined,
              }}
            >
              {sectionName}
            </h2>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="relative" ref={coverPickerRef}>
              <button
                type="button"
                onClick={() => setCoverPickerOpen((o) => !o)}
                className={`flex items-center justify-center h-8 rounded transition-colors cursor-pointer ${
                  hasCover
                    ? "w-8 text-gray-400 hover:text-gray-100 hover:bg-[#1e2327]"
                    : "px-3 text-xs gap-1.5 border border-dashed border-[#30363d] hover:border-[#3a4147] text-gray-500 hover:text-gray-300"
                }`}
                title="Cover settings"
              >
                {hasCover ? (
                  <Palette size={16} />
                ) : (
                  <>
                    <Palette size={12} /> <span>Add cover</span>
                  </>
                )}
              </button>

              {coverPickerOpen && (
                <div className="absolute right-0 top-full mt-2 z-[200] w-[420px] max-h-[80vh] overflow-y-auto bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a3136] bg-[#1a1e21]">
                    <div className="flex items-center gap-2 text-sm font-medium text-gray-100">
                      <Sliders size={13} />
                      <span>Cover</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCoverPickerOpen(false)}
                      className="text-gray-500 hover:text-gray-300 cursor-pointer"
                      title="Close"
                    >
                      <X size={14} />
                    </button>
                  </div>

                  <div className="p-4 space-y-4">
                    <div className="flex gap-2">
                      <button
                        onClick={uploadCover}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200 whitespace-nowrap"
                      >
                        <Upload size={12} /> Upload
                      </button>
                      <div className="flex-1 flex gap-2">
                        <input
                          type="text"
                          value={coverUrlDraft}
                          onChange={(e) => setCoverUrlDraft(e.target.value)}
                          placeholder="or paste image URL…"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") applyCoverUrl(coverUrlDraft);
                          }}
                          className="flex-1 bg-[#0f1315] border border-[#30363d] rounded px-3 py-1.5 text-xs text-gray-100 outline-none focus:ring-1 focus:ring-blue-500"
                        />
                        <button
                          onClick={() => applyCoverUrl(coverUrlDraft)}
                          className="flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded whitespace-nowrap"
                        >
                          <LinkIcon size={12} /> Apply
                        </button>
                      </div>
                    </div>

                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
                        Gradients
                      </div>
                      <div className="grid grid-cols-5 gap-2">
                        {COVER_GRADIENTS.map((g) => (
                          <button
                            key={g.id}
                            onClick={() => applyCoverGradient(g.id)}
                            className={`aspect-[3/2] rounded cursor-pointer hover:ring-2 hover:ring-blue-500 transition-all ${
                              meta.coverType === "color" && meta.coverValue === g.id
                                ? "ring-2 ring-blue-400"
                                : ""
                            }`}
                            style={{ background: g.value }}
                            title={g.label}
                          />
                        ))}
                      </div>
                    </div>

                    {hasCover && (
                      <div className="space-y-3 pt-2 border-t border-[#2a3136]">
                        <div className="text-[10px] uppercase tracking-wider text-gray-500">
                          Style
                        </div>
                        {meta.coverType === "image" && (
                          <>
                            <SliderRow
                              label="Horizontal"
                              value={meta.coverPosX ?? 50}
                              min={0} max={100} unit="%"
                              onChange={(v) => saveMeta({ coverPosX: v })}
                            />
                            <SliderRow
                              label="Vertical"
                              value={meta.coverPosY ?? 50}
                              min={0} max={100} unit="%"
                              onChange={(v) => saveMeta({ coverPosY: v })}
                            />
                          </>
                        )}
                        <SliderRow
                          label="Opacity"
                          value={meta.coverOpacity ?? 100}
                          min={0} max={100} unit="%"
                          onChange={(v) => saveMeta({ coverOpacity: v })}
                        />
                        <SliderRow
                          label="Blur"
                          value={meta.coverBlur ?? 0}
                          min={0} max={20} unit="px"
                          onChange={(v) => saveMeta({ coverBlur: v })}
                        />
                        <SliderRow
                          label="Corner radius"
                          value={meta.coverRadius ?? 0}
                          min={0} max={40} unit="px"
                          onChange={(v) => saveMeta({ coverRadius: v })}
                        />
                        <label className="flex items-center justify-between text-[11px] text-gray-400 cursor-pointer">
                          <span className="flex items-center gap-1.5">
                            <Sparkles size={11} /> Text shadow
                          </span>
                          <input
                            type="checkbox"
                            checked={meta.coverTextShadow !== false}
                            onChange={(e) => saveMeta({ coverTextShadow: e.target.checked })}
                            className="accent-blue-500"
                          />
                        </label>

                        <button
                          onClick={removeCover}
                          className="w-full text-left text-xs text-red-400 hover:text-red-300 hover:bg-[#2a3136] px-2 py-1.5 rounded transition-colors flex items-center gap-1.5"
                        >
                          <Trash2 size={12} /> Remove cover
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {viewToggle}
            <button
              onClick={createItem}
              className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium"
            >
              <Plus size={14} /> <span>Add Art</span>
            </button>
          </div>
        </div>

        {items.length > 0 && (
          <div className="flex items-center gap-2 mb-3">
            <div className="relative flex-1">
              <Search
                size={13}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by title, tag, date, or back story…"
                className="w-full bg-[#161a1d] border border-[#2a3136] rounded pl-9 pr-3 py-2 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-200 p-1"
                  title="Clear search"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            <div className="relative flex-shrink-0" ref={filterRef}>
              <button
                type="button"
                onClick={() => setFilterOpen((o) => !o)}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs rounded border transition-colors cursor-pointer ${
                  filterOpen || activeFilterCount > 0
                    ? "bg-blue-600/15 border-blue-500/50 text-blue-300"
                    : "bg-[#161a1d] border-[#2a3136] text-gray-400 hover:text-gray-200 hover:border-[#3a4147]"
                }`}
                title="Filter by year or tag"
              >
                <Filter size={13} />
                <span>Filter</span>
                {activeFilterCount > 0 && (
                  <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-blue-600 text-white text-[10px] font-semibold tabular-nums">
                    {activeFilterCount}
                  </span>
                )}
              </button>

              {filterOpen && (
                <div
                  className="absolute right-0 top-full mt-1 z-40 w-[320px] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-2xl overflow-hidden"
                  onClick={(e) => e.stopPropagation()}
                >
                  {years.length > 0 && (
                    <div className="px-3 pt-3 pb-2 border-b border-[#2a3136]">
                      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5">
                        <Calendar size={10} /> Year
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {years.map((y) => {
                          const active = activeYear === y;
                          return (
                            <button
                              key={y}
                              type="button"
                              onClick={() => setActiveYear(active ? null : y)}
                              className={`px-2.5 py-1 rounded-full text-[11px] transition-colors cursor-pointer ${
                                active
                                  ? "bg-blue-600 text-white border border-blue-500"
                                  : "bg-[#0f1315] text-gray-400 hover:text-gray-100 border border-[#2a3136] hover:border-[#3a4147]"
                              }`}
                            >
                              {y}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {allTags.length > 0 && (
                    <div className="px-3 pt-3 pb-2 max-h-56 overflow-y-auto">
                      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5">
                        <Tag size={10} /> Tag
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {allTags.map(([tag, count]) => {
                          const active = activeTag === tag;
                          return (
                            <button
                              key={tag}
                              type="button"
                              onClick={() => setActiveTag(active ? null : tag)}
                              className={`px-2.5 py-1 rounded-full text-[11px] transition-colors cursor-pointer flex items-center gap-1 ${
                                active
                                  ? "bg-blue-600 text-white border border-blue-500"
                                  : "bg-[#0f1315] text-gray-400 hover:text-gray-100 border border-[#2a3136] hover:border-[#3a4147]"
                              }`}
                            >
                              <span>{tag}</span>
                              <span className={active ? "text-blue-100" : "text-gray-600"}>
                                {count}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between px-3 py-2 border-t border-[#2a3136] bg-[#1a1e21]">
                    <span className="text-[10px] text-gray-500">
                      {filtered.length} of {items.length} shown
                    </span>
                    {activeFilterCount > 0 && (
                      <button
                        type="button"
                        onClick={clearAllFilters}
                        className="text-[11px] text-gray-400 hover:text-gray-100 px-2 py-0.5 rounded hover:bg-[#2a3136] transition-colors cursor-pointer"
                      >
                        Clear all
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeFilterCount > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mb-4">
            {activeYear && (
              <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-blue-600/15 border border-blue-500/40 text-blue-300">
                <Calendar size={10} />
                <span>{activeYear}</span>
                <button
                  type="button"
                  onClick={() => setActiveYear(null)}
                  className="text-blue-300/70 hover:text-blue-100 ml-0.5"
                  title="Remove filter"
                >
                  <X size={10} />
                </button>
              </span>
            )}
            {activeTag && (
              <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-blue-600/15 border border-blue-500/40 text-blue-300">
                <Tag size={10} />
                <span>{activeTag}</span>
                <button
                  type="button"
                  onClick={() => setActiveTag(null)}
                  className="text-blue-300/70 hover:text-blue-100 ml-0.5"
                  title="Remove filter"
                >
                  <X size={10} />
                </button>
              </span>
            )}
            <button
              type="button"
              onClick={clearAllFilters}
              className="text-[11px] text-gray-500 hover:text-gray-200 px-1.5 py-0.5 rounded hover:bg-[#1e2327] transition-colors cursor-pointer"
            >
              Clear all
            </button>
          </div>
        )}

        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-gray-500 mt-24">
            <ImageIcon size={32} className="mb-3 opacity-60" />
            <p className="text-sm">No pieces yet. Add your first one.</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-gray-500 mt-24">
            <Search size={28} className="mb-3 opacity-40" />
            <p className="text-sm">No matches.</p>
            <p className="text-xs text-gray-600 mt-1">
              Try clearing the search or filters.
            </p>
          </div>
        ) : viewMode === "grid" ? (
          renderGridView()
        ) : viewMode === "gallery" ? (
          renderGalleryView()
        ) : (
          renderListView()
        )}
      </div>
    </div>
  );

  // ── Detail view ─────────────────────────────────────────────────────────
  const detailView = selected && (() => {
    const hasTags = selected.tags.length > 0;
    const hasBackstory = selected.backstory.trim().length > 0;
    const hasReferences = selected.referenceImages.length > 0;
    const hasLinks = selected.links.length > 0;
    const hasProgress = selected.progress.length > 0;
    const hasVersions = selected.versions.length > 0;
    const timeTrim = selected.time.trim();

    const showTagsPanel = isEdit || hasTags;
    const showBackstoryPanel = isEdit || hasBackstory;
    const showReferencesPanel = isEdit || hasReferences;
    const showLinksPanel = isEdit || hasLinks;
    const showProgressPanel = isEdit || hasProgress;
    const showVersionsPanel = isEdit || hasVersions;
    const showRightColumn = showTagsPanel || showBackstoryPanel;

    const isSingleMain = selected.mainImages.length === 1;

    const backstoryImages = parseBackstory(selected.backstory)
      .filter((p): p is { kind: "img"; alt: string; file: string } => p.kind === "img")
      .map((p) => p.file);

    return (
      <div className="w-full h-full flex flex-col bg-[#0f1315] overflow-hidden">
        {/* ── Top bar ─────────────────────────────────────────────── */}
        <div className="flex-shrink-0 flex items-center justify-between px-6 py-2.5 border-b border-[#2a3136] bg-[#0f1315] gap-2">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-100 transition-colors"
          >
            <ChevronLeft size={14} />
            <span>All Art</span>
          </button>

          <div className="flex items-center gap-2">
            {isEdit && (
              <button
                type="button"
                onClick={() => deleteItem(selected)}
                className="text-gray-500 hover:text-red-400 p-1.5 rounded transition-colors"
                title="Delete this piece"
              >
                <Trash2 size={14} />
              </button>
            )}
            <span className="text-[10px] uppercase tracking-wider text-gray-500">
              {mode === "edit" ? "Editing" : "Reading"}
            </span>
            <button
              type="button"
              onClick={toggle}
              className="flex items-center justify-center w-7 h-7 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer"
              title={mode === "edit" ? "Switch to read mode (Ctrl+E)" : "Switch to edit mode (Ctrl+E)"}
            >
              {mode === "edit" ? <BookOpen size={15} /> : <Pencil size={15} />}
            </button>
          </div>
        </div>

        {/* ── Middle: scrollable content ──────────────────────────── */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-6xl mx-auto px-6 py-4">
            <input
              type="text"
              value={selected.title}
              onChange={(e) => updateItem(selected.id, { title: e.target.value })}
              readOnly={!isEdit}
              placeholder="Untitled piece"
              className={`w-full bg-transparent border-none outline-none text-2xl font-bold tracking-tight px-2 rounded text-center placeholder-gray-700 ${
                isEdit ? "text-gray-100 focus:bg-white/5" : "text-gray-100 cursor-default"
              }`}
            />

            <div className="flex items-center justify-center gap-3 text-xs text-gray-500 mt-1.5 mb-3 flex-wrap">
              {isEdit ? (
                <span className="flex items-center gap-1.5">
                  <DateField
                    value={selected.dateMade}
                    onChange={(v) => updateItem(selected.id, { dateMade: v })}
                    className="text-xs text-gray-400 focus-within:text-gray-200"
                    placeholder="MM/DD/YYYY"
                  />
                </span>
              ) : selected.dateMade ? (
                <span className="flex items-center gap-1.5">
                  <Calendar size={11} className="text-gray-500" />
                  <span>{isoToDisplay(selected.dateMade)}</span>
                </span>
              ) : null}

              {isEdit ? (
                <>
                  <span>•</span>
                  <span className="flex items-center gap-1.5 flex-1 max-w-md">
                    <Clock size={11} className="text-gray-500 flex-shrink-0" />
                    <input
                      type="text"
                      value={selected.time}
                      onChange={(e) => updateItem(selected.id, { time: e.target.value })}
                      placeholder="e.g. 3pm – 5pm, evening, around 8"
                      className="flex-1 min-w-[12rem] bg-transparent border-none outline-none text-xs text-gray-300 placeholder-gray-600 focus:text-gray-100 text-center"
                    />
                  </span>
                </>
              ) : timeTrim ? (
                <>
                  {selected.dateMade && <span>•</span>}
                  <span className="flex items-center gap-1.5">
                    <Clock size={11} className="text-gray-500" />
                    <span>{timeTrim}</span>
                  </span>
                </>
              ) : null}
            </div>

            <div className={`grid grid-cols-1 ${showRightColumn ? "lg:grid-cols-3" : ""} gap-5 items-start`}>
              <div className={showRightColumn ? "lg:col-span-2 space-y-4" : "space-y-4"}>
                <section>
                  {isEdit && (
                    <div className="flex justify-end mb-2">
                      <button
                        type="button"
                        onClick={() => addMainImages(selected)}
                        className="flex items-center gap-1.5 text-xs px-2 py-1 bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200"
                      >
                        <Upload size={11} /> Add images
                      </button>
                    </div>
                  )}

                  {selected.mainImages.length > 0 ? (
                    isSingleMain ? (
                      <div className="flex justify-center">
                        <div
                          className="relative group rounded-sm overflow-hidden cursor-zoom-in inline-block"
                          onClick={() => openLightbox(selected, 0)}
                        >
                          <FramedPhoto
                            sectionDir={sectionDir}
                            itemId={selected.id}
                            filename={selected.mainImages[0]}
                            className="max-h-[min(62vh,calc(100vh_-_400px))] max-w-full w-auto h-auto block border-[4px] border-white rounded-sm"
                          />
                          <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openLightbox(selected, 0);
                              }}
                              className="p-1.5 rounded bg-black/70 text-white hover:bg-black/90 transition-colors"
                              title="View full size"
                            >
                              <Maximize2 size={13} />
                            </button>
                            {isEdit && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeMainImage(selected, selected.mainImages[0]);
                                }}
                                className="p-1.5 rounded bg-black/70 text-white hover:bg-red-600 transition-colors"
                                title="Remove this image"
                              >
                                <X size={13} />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-3 items-start">
                        {selected.mainImages.map((img, idx) => (
                          <div
                            key={img}
                            className="relative group rounded-lg overflow-hidden border border-[#2a3136] bg-[#0f1315] cursor-zoom-in flex items-center justify-center"
                            onClick={() => openLightbox(selected, idx)}
                          >
                            <FramedPhoto
                              sectionDir={sectionDir}
                              itemId={selected.id}
                              filename={img}
                              className="max-h-[min(38vh,calc(100vh_-_520px))] max-w-full w-auto h-auto block border-[4px] border-white rounded-sm"
                            />
                            <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openLightbox(selected, idx);
                                }}
                                className="p-1.5 rounded bg-black/70 text-white hover:bg-black/90 transition-colors"
                                title="View full size"
                              >
                                <Maximize2 size={12} />
                              </button>
                              {isEdit && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeMainImage(selected, img);
                                  }}
                                  className="p-1.5 rounded bg-black/70 text-white hover:bg-red-600 transition-colors"
                                  title="Remove this image"
                                >
                                  <X size={12} />
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  ) : isEdit ? (
                    <button
                      type="button"
                      onClick={() => addMainImages(selected)}
                      className="w-full h-40 rounded-lg border border-dashed border-[#30363d] hover:border-[#3a4147] text-gray-500 hover:text-gray-300 flex flex-col items-center justify-center gap-2 transition-colors"
                    >
                      <Upload size={20} />
                      <span className="text-xs">Add images</span>
                    </button>
                  ) : null}
                </section>

                {showProgressPanel && (
                  <section className="rounded-lg border border-[#2a3136] bg-[#161a1d] p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
                        <ListChecks size={10} /> Progress
                        {hasProgress && (
                          <span className="text-gray-600">· {selected.progress.length}</span>
                        )}
                      </div>
                    </div>

                    {isEdit && (
                      <div className="flex gap-1.5 mb-3">
                        <input
                          type="text"
                          value={progressNoteDraft}
                          onChange={(e) => setProgressNoteDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") addProgress(selected);
                          }}
                          placeholder="What did you do? e.g. 'Finished the trees'"
                          className="flex-1 min-w-0 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
                        />
                        <button
                          type="button"
                          onClick={() => addProgress(selected)}
                          disabled={!progressNoteDraft.trim()}
                          className="flex items-center gap-1 px-2 py-1 text-xs bg-[#2a3136] hover:bg-[#30363d] disabled:opacity-40 border border-[#30363d] rounded text-gray-200 flex-shrink-0"
                        >
                          <Plus size={11} /> Add
                        </button>
                      </div>
                    )}

                    {hasProgress ? (
                      <div className="space-y-2">
                        {[...selected.progress].reverse().map((p) => (
                          <div
                            key={p.id}
                            className="group rounded-md border border-[#2a3136] bg-[#0f1315] p-3"
                          >
                            <div className="flex items-start gap-3">
                              <div className="flex-1 min-w-0">
                                <div className="text-[10px] text-gray-500 mb-1">
                                  {fmtDateTime(p.date)}
                                </div>
                                <div className="text-xs text-gray-200 leading-relaxed whitespace-pre-wrap break-words">
                                  {p.note}
                                </div>
                                {p.image && (
                                  <div
                                    className="mt-2 rounded-md overflow-hidden border border-[#2a3136] bg-black/40 cursor-zoom-in max-w-[240px]"
                                    onClick={() =>
                                      openLightboxFiles(selected, [p.image!], 0)
                                    }
                                  >
                                    <AssetImage
                                      sectionDir={sectionDir}
                                      itemId={selected.id}
                                      filename={p.image}
                                      className="w-full h-auto block"
                                    />
                                  </div>
                                )}
                              </div>
                              {isEdit && (
                                <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                  {!p.image && (
                                    <button
                                      type="button"
                                      onClick={() => addProgressImage(selected, p.id)}
                                      className="p-1 rounded text-gray-500 hover:text-gray-100 hover:bg-[#2a3136]"
                                      title="Attach photo"
                                    >
                                      <ImageIcon size={12} />
                                    </button>
                                  )}
                                  {p.image && (
                                    <button
                                      type="button"
                                      onClick={() => removeProgressImage(selected, p.id)}
                                      className="p-1 rounded text-gray-500 hover:text-gray-100 hover:bg-[#2a3136]"
                                      title="Remove photo"
                                    >
                                      <X size={12} />
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => removeProgress(selected, p.id)}
                                    className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-[#2a3136]"
                                    title="Delete entry"
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500 italic">
                        Track your work as it develops.
                      </p>
                    )}
                  </section>
                )}

                {showReferencesPanel && (
                  <section className="rounded-lg border border-[#2a3136] bg-[#161a1d] p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
                        <ImageIcon size={10} /> Reference photos
                      </div>
                      {isEdit && (
                        <button
                          type="button"
                          onClick={() => addReferenceImages(selected)}
                          className="flex items-center gap-1.5 text-xs px-2 py-1 bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200"
                        >
                          <Upload size={11} /> Add
                        </button>
                      )}
                    </div>
                    {hasReferences ? (
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                        {selected.referenceImages.map((img, idx) => (
                          <div
                            key={img}
                            className="relative group rounded-lg overflow-hidden border border-[#2a3136] bg-[#0f1315] cursor-zoom-in flex items-center justify-center"
                            style={{ height: "8rem" }}
                            onClick={() =>
                              openLightbox(selected, selected.mainImages.length + idx)
                            }
                          >
                            <FramedPhoto
                              sectionDir={sectionDir}
                              itemId={selected.id}
                              filename={img}
                              className="max-w-full max-h-full w-auto h-auto object-contain block border-[2px] border-white rounded-sm"
                            />
                            <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openLightbox(selected, selected.mainImages.length + idx);
                                }}
                                className="p-1 rounded bg-black/70 text-white hover:bg-black/90"
                                title="View full size"
                              >
                                <Maximize2 size={11} />
                              </button>
                              {isEdit && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeReferenceImage(selected, img);
                                  }}
                                  className="p-1 rounded bg-black/70 text-white hover:bg-red-600"
                                  title="Remove"
                                >
                                  <X size={11} />
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500 italic">
                        No reference photos yet.
                      </p>
                    )}
                  </section>
                )}

                {showLinksPanel && (
                  <section className="rounded-lg border border-[#2a3136] bg-[#161a1d] p-4">
                    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-3 flex items-center gap-1.5">
                      <LinkIcon size={10} /> Reference links
                    </div>

                    {hasLinks ? (
                      <div className="space-y-1.5 mb-3">
                        {selected.links.map((l) => (
                          <div
                            key={l.id}
                            className="flex items-center gap-2 px-2 py-1.5 rounded bg-[#0f1315] border border-[#2a3136] group/link"
                          >
                            <LinkIcon size={11} className="text-blue-400 flex-shrink-0" />
                            <button
                              type="button"
                              onClick={() => openLink(l.url)}
                              className="text-xs text-gray-300 hover:text-blue-300 truncate flex-1 text-left"
                              title={l.url}
                            >
                              {l.title || l.url}
                            </button>
                            <button
                              type="button"
                              onClick={() => openLink(l.url)}
                              className="text-gray-500 hover:text-gray-200 p-0.5 flex-shrink-0"
                              title="Open in browser"
                            >
                              <ExternalLink size={11} />
                            </button>
                            {isEdit && (
                              <button
                                type="button"
                                onClick={() => removeLink(selected, l.id)}
                                className="text-gray-500 hover:text-red-400 p-0.5 opacity-0 group-hover/link:opacity-100 transition-opacity flex-shrink-0"
                                title="Remove link"
                              >
                                <X size={11} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500 italic mb-3">
                        No reference links yet.
                      </p>
                    )}

                    {isEdit && (
                      <div className="flex gap-1.5">
                        <input
                          type="text"
                          value={linkDraft}
                          onChange={(e) => setLinkDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") addLink(selected);
                          }}
                          placeholder="Paste a reference URL…"
                          className="flex-1 min-w-0 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
                        />
                        <button
                          type="button"
                          onClick={() => addLink(selected)}
                          disabled={!linkDraft.trim() || savingLink}
                          className="flex items-center gap-1 px-2 py-1 text-xs bg-[#2a3136] hover:bg-[#30363d] disabled:opacity-40 border border-[#30363d] rounded text-gray-200 flex-shrink-0"
                        >
                          {savingLink ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                        </button>
                      </div>
                    )}
                  </section>
                )}
              </div>

              {showRightColumn && (
                <div className="lg:col-span-1 space-y-3">
                  {showTagsPanel && (
                    <section className="rounded-lg border border-[#2a3136] bg-[#161a1d] p-3">
                      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5">
                        <Tag size={10} /> Tags
                      </div>

                      {hasTags ? (
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {selected.tags.map((tag) => (
                            <span
                              key={tag}
                              className="group/tag flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-[#1e2327] border border-[#2a3136] text-gray-300"
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedId(null);
                                  setActiveTag(tag);
                                }}
                                className="hover:text-blue-300"
                                title={`Filter by "${tag}"`}
                              >
                                {tag}
                              </button>
                              {isEdit && (
                                <button
                                  type="button"
                                  onClick={() => removeTagFromItem(selected, tag)}
                                  className="text-gray-500 hover:text-red-400"
                                  title="Remove tag"
                                >
                                  <X size={10} />
                                </button>
                              )}
                            </span>
                          ))}
                        </div>
                      ) : null}

                      {isEdit && (
                        <TagInput
                          existing={allTags.map(([t]) => t)}
                          onSubmit={(raw) => addTagToItem(selected, raw)}
                        />
                      )}
                    </section>
                  )}

                  {showBackstoryPanel && (
                    <section className="rounded-lg border border-[#2a3136] bg-[#161a1d] p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
                          <BookMarked size={10} /> Back story
                        </div>
                        {isEdit && (
                          <button
                            type="button"
                            onClick={() => insertBackstoryImage(selected)}
                            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded text-gray-300 hover:text-gray-100 hover:bg-[#2a3136] transition-colors"
                            title="Upload a photo and insert it at the cursor"
                          >
                            <ImageIcon size={11} /> Insert image
                          </button>
                        )}
                      </div>
                      {isEdit ? (
                        <textarea
                          ref={backstoryRef}
                          value={selected.backstory}
                          onChange={(e) => updateItem(selected.id, { backstory: e.target.value })}
                          placeholder="Where the idea came from, what you were thinking, how it evolved… Use 'Insert image' to add photos."
                          className="w-full bg-transparent border-none outline-none text-sm text-gray-200 leading-relaxed resize-none placeholder-gray-600 focus:outline-none overflow-hidden"
                          style={{ minHeight: "4rem" }}
                        />
                      ) : (
                        <BackstoryRenderer
                          text={selected.backstory}
                          sectionDir={sectionDir}
                          itemId={selected.id}
                          onImageClick={(file) => {
                            const idx = backstoryImages.indexOf(file);
                            openLightboxFiles(
                              selected,
                              backstoryImages,
                              idx >= 0 ? idx : 0
                            );
                          }}
                        />
                      )}

                      {isEdit && backstoryImages.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-[#2a3136]">
                          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
                            Photos in this backstory
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            {backstoryImages.map((f) => (
                              <div
                                key={f}
                                className="relative group rounded-md overflow-hidden border border-[#2a3136] bg-[#0f1315] aspect-square"
                              >
                                <AssetImage
                                  sectionDir={sectionDir}
                                  itemId={selected.id}
                                  filename={f}
                                  className="w-full h-full object-cover"
                                />
                                <button
                                  type="button"
                                  onClick={() => removeBackstoryImage(selected, f)}
                                  className="absolute top-1 right-1 p-1 rounded bg-black/70 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                                  title="Remove photo and its reference from the text"
                                >
                                  <Trash2 size={10} />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </section>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Bottom: pinned timeline ─────────────────────────────── */}
        {showVersionsPanel && (
          <div className="flex-shrink-0 border-t border-[#2a3136] bg-[#161a1d]">
            <div className="max-w-6xl mx-auto px-6 py-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
                  <GitBranch size={10} /> Timeline
                  {hasVersions && (
                    <span className="text-gray-600">· {selected.versions.length}</span>
                  )}
                </div>
                {isEdit && hasVersions && (
                  <button
                    type="button"
                    onClick={() => addVersion(selected)}
                    className="flex items-center gap-1.5 text-xs px-2 py-1 bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200"
                  >
                    <Plus size={11} /> Save version
                  </button>
                )}
              </div>

              {hasVersions || isEdit ? (
                <div
                  className="flex gap-2 overflow-x-auto pb-1 snap-x"
                  style={{ scrollbarWidth: "thin" }}
                >
                  {selected.versions.map((v, idx) => (
                    <div
                      key={v.id}
                      className="group flex-shrink-0 w-28 snap-start"
                    >
                      <div className="relative rounded-md overflow-hidden border border-[#2a3136] bg-[#0f1315]">
                        <div
                          className="w-full aspect-square cursor-zoom-in bg-black/40 flex items-center justify-center"
                          onClick={() =>
                            openLightboxFiles(
                              selected,
                              selected.versions.map((x) => x.image),
                              idx
                            )
                          }
                        >
                          <AssetImage
                            sectionDir={sectionDir}
                            itemId={selected.id}
                            filename={v.image}
                            className="w-full h-full object-contain"
                          />
                        </div>
                        <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-[9px] text-white/80 font-medium tabular-nums backdrop-blur-sm pointer-events-none">
                          {idx + 1}
                        </div>
                        {isEdit && (
                          <button
                            type="button"
                            onClick={() => removeVersion(selected, v.id)}
                            className="absolute top-1 right-1 p-1 rounded bg-black/70 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                            title="Remove version"
                          >
                            <X size={10} />
                          </button>
                        )}
                      </div>
                      <div className="mt-1 min-w-0">
                        {isEdit ? (
                          <input
                            type="text"
                            value={v.label}
                            onChange={(e) =>
                              updateVersionLabel(selected, v.id, e.target.value)
                            }
                            placeholder="Label…"
                            className="w-full bg-transparent border-none outline-none text-[11px] text-gray-200 placeholder-gray-600 truncate"
                          />
                        ) : (
                          <div className="text-[11px] text-gray-200 truncate" title={v.label}>
                            {v.label || "Untitled version"}
                          </div>
                        )}
                        <div className="text-[9px] text-gray-500 mt-0.5 truncate">
                          {fmtDateTime(v.date)}
                        </div>
                      </div>
                    </div>
                  ))}

                  {isEdit && (
                    <button
                      type="button"
                      onClick={() => addVersion(selected)}
                      className="flex-shrink-0 w-28 aspect-square rounded-md border-2 border-dashed border-[#30363d] hover:border-[#3a4147] text-gray-500 hover:text-gray-300 flex flex-col items-center justify-center gap-1 transition-colors snap-start"
                      title="Save a new version"
                    >
                      <Plus size={16} />
                      <span className="text-[10px]">Save version</span>
                    </button>
                  )}
                </div>
              ) : (
                <p className="text-xs text-gray-500 italic">
                  No versions yet. Save snapshots as the piece evolves.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    );
  })();

  return (
    <>
      {modal}
      {lightbox && (
        <Lightbox
          srcs={lightbox.srcs}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndexChange={(i) =>
            setLightbox((prev) => (prev ? { ...prev, index: i } : null))
          }
        />
      )}

      {newItemOpen && (
        <div
          className="fixed inset-0 z-[300] bg-black/70 flex items-center justify-center p-6"
          onClick={cancelNewItem}
        >
          <div
            className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[460px] max-w-[92vw] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a3136] bg-[#1a1e21]">
              <ImageIcon size={14} className="text-blue-400" />
              <span className="text-sm font-medium text-gray-100">New Piece</span>
              <button
                type="button"
                onClick={cancelNewItem}
                disabled={creatingItem}
                className="ml-auto text-gray-500 hover:text-gray-300 p-0.5 disabled:opacity-40"
                title="Close"
              >
                <X size={14} />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5 flex items-center gap-1.5">
                  <ImageIcon size={10} /> Title
                </label>
                <input
                  autoFocus
                  type="text"
                  value={newItemTitle}
                  onChange={(e) => setNewItemTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cancelNewItem();
                  }}
                  placeholder="Untitled"
                  className="w-full bg-[#0f1315] border border-[#30363d] rounded px-3 py-2 text-sm text-gray-100 outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5 flex items-center gap-1.5">
                  <Calendar size={10} /> Date
                </label>
                <div className="w-full bg-[#0f1315] border border-[#30363d] rounded px-3 py-2 focus-within:ring-1 focus-within:ring-blue-500 flex items-center gap-2">
                  <DateField
                    value={newItemDate}
                    onChange={setNewItemDate}
                    className="flex-1 text-sm text-gray-100"
                    placeholder="MM/DD/YYYY"
                  />
                </div>
                <p className="text-[10px] text-gray-500 mt-1.5">
                  {newItemDate
                    ? `Will be saved as ${isoToDisplay(newItemDate)}`
                    : "Type a date or click the calendar to pick."}
                </p>
                <p className="text-[10px] text-gray-700 mt-0.5">
                  Accepts: 09/04/2026 · 9/4/26 · September 4, 2026 · Sep 4 · 2026-09-04 · today · yesterday · tomorrow
                </p>
              </div>

              <div className="text-[11px] text-gray-500 pt-1">
                {newItemPaths.length} image
                {newItemPaths.length === 1 ? "" : "s"} selected
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={cancelNewItem}
                  disabled={creatingItem}
                  className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-[#2a3136] rounded transition-colors disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmNewItem}
                  disabled={creatingItem}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors font-medium"
                >
                  {creatingItem ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />
                      <span>Creating…</span>
                    </>
                  ) : (
                    <span>Create Piece</span>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {selected ? detailView : gridView}
    </>
  );
}

// ─── Tag input ──────────────────────────────────────────────────────────────
function TagInput({
  existing, onSubmit,
}: {
  existing: string[];
  onSubmit: (tag: string) => void;
}) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);

  const suggestions = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return [];
    return existing.filter((t) => t.includes(q)).slice(0, 6);
  }, [value, existing]);

  const commit = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    onSubmit(v);
    setValue("");
  };

  return (
    <div className="relative">
      <div className="flex gap-1.5">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => { setTimeout(() => setFocused(false), 120); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(value);
            } else if (e.key === "Escape") {
              setValue("");
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          placeholder="Add a tag…"
          className="flex-1 min-w-0 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          type="button"
          onClick={() => commit(value)}
          disabled={!value.trim()}
          className="flex items-center gap-1 px-2 py-1 text-xs bg-[#2a3136] hover:bg-[#30363d] disabled:opacity-40 border border-[#30363d] rounded text-gray-200 flex-shrink-0"
        >
          <Plus size={11} />
        </button>
      </div>

      {focused && suggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 z-20 bg-[#1e2327] border border-[#2a3136] rounded-md shadow-xl py-1 max-h-40 overflow-y-auto">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                commit(s);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-[#2a3136]"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}