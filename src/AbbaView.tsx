// src/AbbaView.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  readTextFile, writeTextFile, mkdir, readDir,
  exists as fsExists,
} from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Church, BookOpen, Heart, HandHeart, Link as LinkIcon,
  Plus, Trash2, X, Upload, ExternalLink,
  Music, ListMusic, Image as ImageIcon, User, FileAudio, Save,
  ChevronLeft, ChevronRight, Pencil, BookMarked,
  Search, Clock, Calendar, ZoomIn, ZoomOut,
  Sparkles, Loader2, AlertTriangle, Star, MapPin,
  List as ListIcon, LayoutGrid, Smile,
} from "lucide-react";
import EmojiPicker, { Theme, EmojiStyle } from "emoji-picker-react";

import { useModal } from "./Modal";
import { useNoteMode } from "./useNoteMode";
import AudioPlayer from "./AudioPlayer";
import NoteBody, { type NoteBodyHandle } from "./NoteBody";
import PhotoLightbox from "./PhotoLightbox";
import {
  saveFileToAbbaNote, deleteAbbaNoteAsset, deleteAbbaNoteAssetsFolder,
  loadAbbaNoteAssetBlob, abbaNoteAssetSize,
} from "./abbaAssets";
import { parseNoteFile, serializeNoteFile } from "./noteFormat";
import { moveToTrash } from "./trash";

// ─── URL normalization ──────────────────────────────────────────────────────
function normalizeUrl(raw: string): string {
  if (!raw) return "";
  let s = raw.trim();
  const md = s.match(/\[[^\]]*\]\(\s*(\S+?)\s*\)/);
  if (md) s = md[1];
  s = s.replace(/^<+/, "").replace(/>+$/, "").trim();
  s = s.replace(/[\u00A0\u200B]/g, "").trim();
  s = s.replace(/[.,;:!?]+$/, "");
  return s;
}

function hostnameOf(rawUrl: string): string {
  try {
    return new URL(normalizeUrl(rawUrl)).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ─── Stable (uncontrolled) form fields with manual undo/redo ───────────────
type StableFieldProps = {
  value: string;
  onChange: (v: string) => void;
  as?: "input" | "textarea";
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement> &
    React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange" | "defaultValue"
>;

type HistoryStep = { value: string; start: number; end: number; ts: number };

function StableField({
  value, onChange, as = "textarea", onKeyDown: externalOnKeyDown, ...rest
}: StableFieldProps) {
  const innerRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  const undoRef = useRef<HistoryStep[]>([]);
  const redoRef = useRef<HistoryStep[]>([]);
  const lastValueRef = useRef(value);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    if (document.activeElement === el) return;
    if (el.value === value) return;
    el.value = value;
    lastValueRef.current = value;
    undoRef.current = [];
    redoRef.current = [];
  }, [value]);

  const applyUndo = (): boolean => {
    const el = innerRef.current;
    if (!el) return false;
    const step = undoRef.current.pop();
    if (!step) return false;
    redoRef.current.push({
      value: el.value,
      start: el.selectionStart ?? el.value.length,
      end: el.selectionEnd ?? el.value.length,
      ts: Date.now(),
    });
    el.value = step.value;
    el.selectionStart = step.start;
    el.selectionEnd = step.end;
    lastValueRef.current = step.value;
    onChange(step.value);
    return true;
  };

  const applyRedo = (): boolean => {
    const el = innerRef.current;
    if (!el) return false;
    const step = redoRef.current.pop();
    if (!step) return false;
    undoRef.current.push({
      value: el.value,
      start: el.selectionStart ?? el.value.length,
      end: el.selectionEnd ?? el.value.length,
      ts: 0,
    });
    el.value = step.value;
    el.selectionStart = step.start;
    el.selectionEnd = step.end;
    lastValueRef.current = step.value;
    onChange(step.value);
    return true;
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const el = e.target;
    const newValue = el.value;
    if (newValue === lastValueRef.current) return;
    const now = Date.now();
    const stack = undoRef.current;
    const last = stack[stack.length - 1];
    if (!last || now - last.ts > 600) {
      stack.push({
        value: lastValueRef.current,
        start: el.selectionStart ?? 0,
        end: el.selectionEnd ?? 0,
        ts: now,
      });
      if (stack.length > 200) stack.shift();
    } else {
      last.ts = now;
    }
    redoRef.current = [];
    lastValueRef.current = newValue;
    onChange(newValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    externalOnKeyDown?.(e as any);
    if (e.defaultPrevented) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) {
      if (applyUndo()) e.preventDefault();
    } else if ((k === "z" && e.shiftKey) || k === "y") {
      if (applyRedo()) e.preventDefault();
    }
  };

  const Comp: any = as;
  return (
    <Comp
      ref={innerRef as any}
      defaultValue={value}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      {...rest}
    />
  );
}

// ─── Sections ───────────────────────────────────────────────────────────────
type AbbaSection =
  | "sermons" | "prayers" | "testimonies" | "studies" | "events" | "links";

const SECTION_DIR: Record<AbbaSection, string> = {
  sermons: "sermons", prayers: "prayers", testimonies: "testimonies",
  studies: "studies", events: "events", links: "links",
};

const RICH_SECTIONS = new Set<AbbaSection>([
  "prayers", "testimonies", "events", "studies",
]);

const BODY_FIELD: Record<AbbaSection, string | null> = {
  sermons: "notes", prayers: "body", testimonies: "body",
  studies: "notes", events: "description", links: null,
};

function subPath(dir: string, ...parts: string[]): string {
  const base = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const tail = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return tail ? `${base}/${tail}` : base;
}

function sectionDir(abbaDir: string, section: AbbaSection): string {
  return subPath(abbaDir, SECTION_DIR[section]);
}

function abbaNotePath(abbaDir: string, section: AbbaSection, id: string): string {
  return subPath(abbaDir, SECTION_DIR[section], `${id}.selah`);
}

async function ensureAbbaNoteFile(
  abbaDir: string,
  section: AbbaSection,
  id: string,
  initialFm: Record<string, any>,
): Promise<string> {
  const dir = sectionDir(abbaDir, section);
  await mkdir(dir, { recursive: true });
  const path = abbaNotePath(abbaDir, section, id);
  if (!(await fsExists(path))) {
    await writeTextFile(path, serializeNoteFile(initialFm as any, ""));
  }
  return path;
}

async function writeAbbaEntryIcon(
  abbaDir: string,
  section: AbbaSection,
  id: string,
  icon: string,
): Promise<void> {
  const path = abbaNotePath(abbaDir, section, id);
  try {
    const raw = await readTextFile(path);
    const { frontmatter, body } = parseNoteFile(raw);
    const next: Record<string, any> = { ...frontmatter };
    if (icon) next.icon = icon;
    else delete next.icon;
    await writeTextFile(path, serializeNoteFile(next as any, body));
  } catch (e) {
    console.error("[abba] could not write icon:", path, e);
  }
}

function desiredFileName(_section: AbbaSection, entry: any): string {
  return entry.id || `entry-${Date.now()}`;
}

function decodeLegacyJsonValue(v: any): any {
  if (typeof v === "string" && v.startsWith("json:")) {
    try { return JSON.parse(v.slice(5)); } catch { return v.slice(5); }
  }
  return v;
}

function serializeAbbaNote(section: AbbaSection, entry: any): string {
  const bodyField = BODY_FIELD[section];
  const body = bodyField ? String(entry[bodyField] || "") : "";
  const fm: Record<string, any> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k.startsWith("_")) continue;
    if (bodyField && k === bodyField) continue;
    if (v === undefined || v === null) continue;
    fm[k] = v;
  }
  return serializeNoteFile(fm as any, body);
}

function parseAbbaNote(section: AbbaSection, raw: string): any {
  const { frontmatter, body } = parseNoteFile(raw);
  const out: any = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    out[k] = decodeLegacyJsonValue(v);
  }
  const bodyField = BODY_FIELD[section];
  if (bodyField) out[bodyField] = body.replace(/\s+$/, "");
  return out;
}

// ─── Storage ops ────────────────────────────────────────────────────────────
type WithFile<T> = T & { _fileName?: string };

async function readSection<T extends { id: string }>(
  abbaDir: string, section: AbbaSection,
): Promise<WithFile<T>[]> {
  const dir = sectionDir(abbaDir, section);
  let entries: any[] = [];
  try { entries = await readDir(dir); } catch { return []; }
  const out: WithFile<T>[] = [];
  let failures = 0;
  for (const e of entries) {
    if (!e.name || !e.name.endsWith(".selah")) continue;
    try {
      const raw = await readTextFile(await join(dir, e.name));
      const parsed = parseAbbaNote(section, raw);
      if (!parsed.id) parsed.id = e.name.replace(/\.selah$/, "");
      parsed._fileName = e.name.replace(/\.selah$/, "");
      out.push(parsed as WithFile<T>);
    } catch (err) {
      failures++;
      console.error("[abba] could not read note:", e.name, err);
    }
  }
  if (failures > 0) {
    try {
      window.dispatchEvent(new CustomEvent("abba-read-error", {
        detail: { section, count: failures, total: entries.length },
      }));
    } catch {}
  }
  return out;
}

async function writeSectionNote(abbaDir: string, section: AbbaSection, entry: any): Promise<void> {
  const dir = sectionDir(abbaDir, section);
  await mkdir(dir, { recursive: true });

  const desired = desiredFileName(section, entry);
  const current: string = entry._fileName || "";

  let final = desired;
  if (current !== final) {
    let n = 1;
    while (await fsExists(subPath(dir, `${final}.selah`))) {
      final = `${desired}-${n++}`;
      if (n > 500) { final = `${desired}-${Date.now()}`; break; }
    }
  }

  if (current && current !== final) {
    const oldPath = subPath(dir, `${current}.selah`);
    try { if (await fsExists(oldPath)) await moveToTrash(oldPath); } catch (e) {
      console.warn("[abba] could not trash old note file:", current, e);
    }
  }

  const finalPath = subPath(dir, `${final}.selah`);
  await writeTextFile(finalPath, serializeAbbaNote(section, entry));
  entry._fileName = final;
}

async function deleteSectionNote(
  abbaDir: string, section: AbbaSection,
  entry: { id: string; _fileName?: string },
): Promise<void> {
  const dir = sectionDir(abbaDir, section);
  const name = entry._fileName || entry.id;
  const file = subPath(dir, `${name}.selah`);
  try { if (await fsExists(file)) await moveToTrash(file); } catch {}
}

// ─── Error boundary ─────────────────────────────────────────────────────────
class AbbaErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[abba] render error:", error);
    console.error("[abba] component stack:", info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="w-full h-full flex items-center justify-center p-6 bg-[#0f1315]">
          <div className="max-w-lg text-center">
            <p className="text-sm text-gray-300 mb-3">Something went wrong rendering this section.</p>
            <pre className="text-[11px] text-red-400 bg-[#161a1d] border border-[#2a3136] rounded p-3 text-left overflow-auto max-h-48 whitespace-pre-wrap break-words">
              {this.state.error.message}
            </pre>
            <button type="button" onClick={() => this.setState({ error: null })}
              className="mt-4 px-3 py-1.5 text-xs bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200">
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Scoped asset helpers ───────────────────────────────────────────────────
type AbbaScope = { abbaDir: string; section: AbbaSection; noteId: string };

function AbImage({
  scope, fileName, className, alt,
}: { scope: AbbaScope; fileName: string; className?: string; alt?: string; }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    loadAbbaNoteAssetBlob(scope.abbaDir, scope.section, scope.noteId, fileName).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => { cancelled = true; };
  }, [scope.abbaDir, scope.section, scope.noteId, fileName]);
  if (!url) {
    return <div className={className ? `${className} bg-[#0f1315] animate-pulse` : "bg-[#0f1315]"} />;
  }
  return <img src={url} alt={alt || ""} className={className} />;
}

// ─── Link display (compact, bookmark-only) ──────────────────────────────────
function AbbaLinkDisplay({
  link, isEdit, onRemove,
}: {
  link: AbbaLink; isEdit: boolean;
  onRemove: () => void;
}) {
  const openExternal = (e?: React.MouseEvent) => {
    e?.preventDefault(); e?.stopPropagation();
    if (!link.url) return;
    openUrl(normalizeUrl(link.url)).catch((err) =>
      console.error("[abba] open link failed:", err));
  };

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-[#0f1315] border border-[#2a3136]">
      {link.icon ? (
        <img src={link.icon} alt="" className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
          onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
      ) : (
        <LinkIcon size={11} className="text-gray-500 flex-shrink-0" />
      )}
      <button type="button" onClick={openExternal}
        className="text-xs text-gray-300 hover:text-blue-300 truncate flex-1 text-left"
        title={link.url}>{link.title || link.url}</button>
      {isEdit && (
        <button type="button" onClick={onRemove}
          className="text-gray-500 hover:text-red-400 p-0.5 flex-shrink-0"
          title="Remove"><X size={11} /></button>
      )}
    </div>
  );
}

// ─── Image lightbox ─────────────────────────────────────────────────────────
function Lightbox({
  scope, images, index, onClose, onIndexChange,
}: {
  scope: AbbaScope; images: string[]; index: number;
  onClose: () => void; onIndexChange: (i: number) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number; moved: boolean } | null>(null);
  const current = images[index];

  useEffect(() => {
    let cancelled = false;
    setUrl(null); setZoom(1); setPan({ x: 0, y: 0 });
    if (!current) return;
    loadAbbaNoteAssetBlob(scope.abbaDir, scope.section, scope.noteId, current).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => { cancelled = true; };
  }, [scope.abbaDir, scope.section, scope.noteId, current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      else if (e.key === "ArrowRight" && index < images.length - 1) onIndexChange(index + 1);
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(z * 1.25, 8));
      else if (e.key === "-") setZoom((z) => {
        const next = Math.max(z / 1.25, 1);
        if (next === 1) setPan({ x: 0, y: 0 });
        return next;
      });
      else if (e.key === "0") { setZoom(1); setPan({ x: 0, y: 0 }); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, images.length, onClose, onIndexChange]);

  const zoomBy = (factor: number) => {
    setZoom((z) => {
      const next = Math.max(1, Math.min(z * factor, 8));
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };

  const onWheel = (e: React.WheelEvent) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12); };
  const onMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y, moved: false };
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
    <div className="fixed inset-0 z-[500] bg-black/95 flex items-center justify-center overflow-hidden" onClick={onClose}>
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <button type="button" onClick={(e) => { e.stopPropagation(); zoomBy(1 / 1.25); }}
          disabled={zoom <= 1}
          className="p-2 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white disabled:opacity-30"
          title="Zoom out (-)"><ZoomOut size={18} /></button>
        <span className="text-white/70 text-xs tabular-nums px-2">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={(e) => { e.stopPropagation(); zoomBy(1.25); }}
          className="p-2 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white"
          title="Zoom in (+)"><ZoomIn size={18} /></button>
        <button type="button"
          onClick={(e) => { e.stopPropagation(); setZoom(1); setPan({ x: 0, y: 0 }); }}
          className="p-2 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white text-[10px] font-bold"
          title="Reset (0)">1×</button>
        <button type="button" onClick={onClose}
          className="p-2 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white"
          title="Close (Esc)"><X size={18} /></button>
      </div>
      {images.length > 1 && (
        <>
          <button type="button"
            onClick={(e) => { e.stopPropagation(); if (index > 0) onIndexChange(index - 1); }}
            disabled={index === 0}
            className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed z-10"
            title="Previous (←)"><ChevronLeft size={22} /></button>
          <button type="button"
            onClick={(e) => { e.stopPropagation(); if (index < images.length - 1) onIndexChange(index + 1); }}
            disabled={index === images.length - 1}
            className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed z-10"
            title="Next (→)"><ChevronRight size={22} /></button>
        </>
      )}
      <div className="w-full h-full flex items-center justify-center"
        onClick={(e) => e.stopPropagation()} onWheel={onWheel}
        onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}
        style={{ cursor: zoom > 1 ? (dragRef.current ? "grabbing" : "grab") : "zoom-in" }}>
        {url ? (
          <img src={url} alt="" draggable={false} className="select-none"
            style={{
              maxWidth: "80vw", maxHeight: "78vh",
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "center center",
              transition: dragRef.current?.moved ? "none" : "transform 120ms ease-out",
              userSelect: "none",
            }} />
        ) : (<div className="w-96 h-96 bg-[#161a1d] rounded animate-pulse" />)}
      </div>
      {images.length > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/70 bg-black/60 px-3 py-1.5 rounded-full">
          {index + 1} / {images.length}
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

// ─── Types ──────────────────────────────────────────────────────────────────
interface AbbaLink {
  id: string; url: string; title: string; description: string;
  icon: string; image: string;
  created?: string; modified?: string; _fileName?: string;
}

interface Sermon {
  id: string; date: string; title: string; speaker: string; notes: string;
  songs?: string[]; audioFile: string | null; audioName: string | null;
  images: string[]; links: AbbaLink[];
  icon?: string;
  created?: string; modified?: string; _fileName?: string;
}

interface Prayer {
  id: string; date: string; title: string;
  icon?: string;
  created?: string; modified?: string; _fileName?: string;
}

interface Testimony {
  id: string; date: string; title: string;
  icon?: string;
  created?: string; modified?: string; _fileName?: string;
}

interface Study {
  id: string; date: string; title: string; topic: string;
  links: AbbaLink[];
  icon?: string;
  created?: string; modified?: string; _fileName?: string;
}

interface AbbaEvent {
  id: string; date: string; title: string; location: string;
  links: AbbaLink[];
  icon?: string;
  created?: string; modified?: string; _fileName?: string;
}

type Tab = "sermons" | "prayer" | "testimonies" | "events" | "studies" | "links";
type ViewMode = "list" | "grid";

interface AbbaViewProps {
  abbaDir: string;
  name: string;
  icon?: string;
  focusSection?: string;
  focusNoteId?: string;
}

type ListContextHandler<T> = (e: React.MouseEvent, entity: T) => void;

type ContextMenuState = {
  x: number;
  y: number;
  label: string;
  icon?: string;
  onOpen: () => void;
  onChangeIcon: () => void;
  onDelete: () => void;
} | null;

type IconPickerState = {
  section: AbbaSection;
  id: string;
  top: number;
  left: number;
} | null;

// ─── Utilities ──────────────────────────────────────────────────────────────
const AUDIO_EXT = ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus", "webm"];
const VIEW_MODE_KEY = "abba-view-mode";

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
function nowIso(): string { return new Date().toISOString(); }

function todayLocalInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtDate(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  } catch { return iso; }
}
function fmtShort(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch { return iso; }
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
function byDateDesc<T extends { date: string }>(a: T, b: T): number {
  return new Date(b.date).getTime() - new Date(a.date).getTime();
}
function preview(text: string, max = 140): string {
  const t = (text || "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  return t.length > max ? t.slice(0, max).trimEnd() + "…" : t;
}
function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function dateSearchString(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso.toLowerCase();
    const month = d.toLocaleString("en-US", { month: "long" });
    const monthShort = d.toLocaleString("en-US", { month: "short" });
    const weekday = d.toLocaleString("en-US", { weekday: "long" });
    const year = d.getFullYear();
    const day = d.getDate();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    return [
      iso, `${year}-${mm}-${dd}`, `${mm}/${dd}/${year}`,
      `${month} ${day}, ${year}`, `${monthShort} ${day}, ${year}`,
      `${month} ${year}`, `${monthShort} ${year}`,
      `${month} ${day}`, `${monthShort} ${day}`,
      weekday, String(year), String(day), month, monthShort,
    ].join(" ").toLowerCase();
  } catch { return iso.toLowerCase(); }
}
function songsOf(s: Sermon): string[] { return Array.isArray(s.songs) ? s.songs : []; }

// ─── Grid card ──────────────────────────────────────────────────────────────
function GridCard({
  scope, image, icon, fallbackIcon: FallbackIcon, fallbackTint,
  title, dateText, subtitle, subtitleIcon: SubtitleIcon, subtitleTint,
  previewText, meta, onClick, onContextMenu,
}: {
  scope: AbbaScope; image?: string; icon?: string;
  fallbackIcon: any; fallbackTint: string;
  title: string; dateText: string;
  subtitle?: string; subtitleIcon?: any; subtitleTint?: string;
  previewText?: string; meta?: React.ReactNode;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <button type="button" onClick={onClick} onContextMenu={onContextMenu}
      className="group text-left rounded-lg overflow-hidden bg-[#161a1d] border border-[#2a3136] hover:border-[#3a4147] transition-colors flex flex-col">
      <div className="w-full h-40 bg-[#0f1315] overflow-hidden relative flex items-center justify-center">
        {image ? (
          <AbImage scope={scope} fileName={image}
            className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300" />
        ) : icon ? (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-6xl leading-none select-none">{icon}</span>
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center"
            style={{ background: `radial-gradient(circle at center, ${fallbackTint}22 0%, transparent 70%)` }}>
            <FallbackIcon size={32} style={{ color: fallbackTint, opacity: 0.6 }} />
          </div>
        )}
      </div>
      <div className="p-3 flex-1 flex flex-col min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="text-sm font-medium text-gray-100 truncate">
            {icon && <span className="mr-1">{icon}</span>}{title}
          </h4>
          <span className="text-[10px] text-gray-500 flex-shrink-0">{dateText}</span>
        </div>
        {subtitle && (
          <div className="flex items-center gap-1 text-[11px] mt-0.5 truncate"
            style={{ color: subtitleTint || "#9ca3af" }}>
            {SubtitleIcon && <SubtitleIcon size={10} className="flex-shrink-0" />}
            <span className="truncate">{subtitle}</span>
          </div>
        )}
        {previewText ? (
          <p className="text-xs text-gray-400 mt-2 leading-relaxed line-clamp-3 flex-1">{previewText}</p>
        ) : (<div className="flex-1" />)}
        {meta && <div className="mt-2">{meta}</div>}
      </div>
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main component
// ═══════════════════════════════════════════════════════════════════════════
export default function AbbaView({
  abbaDir,
  name,
  icon,
  focusSection,
  focusNoteId,
}: AbbaViewProps) {  const [tab, setTab] = useState<Tab>("sermons");
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const v = localStorage.getItem(VIEW_MODE_KEY);
      return v === "grid" ? "grid" : "list";
    } catch { return "list"; }
  });
  const { modal, confirmAsync } = useModal();
  const { mode } = useNoteMode();
  const isEdit = mode === "edit";

  const [sermons, setSermons] = useState<Sermon[]>([]);
  const [prayers, setPrayers] = useState<Prayer[]>([]);
  const [testimonies, setTestimonies] = useState<Testimony[]>([]);
  const [studies, setStudies] = useState<Study[]>([]);
  const [events, setEvents] = useState<AbbaEvent[]>([]);
  const [links, setLinks] = useState<AbbaLink[]>([]);

  const [openSermonId, setOpenSermonId] = useState<string | null>(null);
  const [openPrayerId, setOpenPrayerId] = useState<string | null>(null);
  const [openTestimonyId, setOpenTestimonyId] = useState<string | null>(null);
  const [openStudyId, setOpenStudyId] = useState<string | null>(null);
  const [openEventId, setOpenEventId] = useState<string | null>(null);

  const [newSermonDate, setNewSermonDate] = useState<string | null>(null);

  const [lightbox, setLightbox] = useState<
    { scope: AbbaScope; images: string[]; index: number } | null
  >(null);

  const [richLightbox, setRichLightbox] = useState<
    { srcs: string[]; index: number } | null
  >(null);

  const [readErrors, setReadErrors] = useState<
    { section: string; count: number; total: number }[]
  >([]);

  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [optimizePhase, setOptimizePhase] = useState<
    "scanning" | "results" | "deleting" | "done" | "error"
  >("scanning");
  const [optimizeUnused, setOptimizeUnused] = useState<{ file: string; size: number }[]>([]);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const [optimizeDeletedCount, setOptimizeDeletedCount] = useState(0);

  // ── Right-click context menu + icon picker ─────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>(null);
  const [iconPicker, setIconPicker] = useState<IconPickerState>(null);
  const iconPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  useEffect(() => {
    if (!iconPicker) return;
    const onDown = (e: MouseEvent) => {
      if (iconPickerRef.current?.contains(e.target as Node)) return;
      setIconPicker(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIconPicker(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [iconPicker]);

  const openContextMenu = (
    e: React.MouseEvent,
    build: {
      label: string;
      icon?: string;
      onOpen: () => void;
      onChangeIconAt: (x: number, y: number) => void;
      onDelete: () => void;
    },
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const cx = e.clientX;
    const cy = e.clientY;
    const W = 220;
    const H = 140;
    setCtxMenu({
      x: Math.min(cx, window.innerWidth - W - 8),
      y: Math.min(cy, window.innerHeight - H - 8),
      label: build.label,
      icon: build.icon,
      onOpen: build.onOpen,
      onChangeIcon: () => build.onChangeIconAt(cx, cy),
      onDelete: build.onDelete,
    });
  };

  const openIconPicker = (
    section: AbbaSection,
    id: string,
    x: number,
    y: number,
  ) => {
    const W = 340;
    const H = 460;
    const left = Math.min(x, window.innerWidth - W - 12);
    const top = Math.min(y, window.innerHeight - H - 12);
    setIconPicker({
      section, id,
      top: Math.max(12, top),
      left: Math.max(12, left),
    });
    setCtxMenu(null);
  };

  const applyEntryIcon = async (emoji: string) => {
    if (!iconPicker) return;
    const { section, id } = iconPicker;
    setIconPicker(null);

    const patch = { icon: emoji || undefined };

    if (RICH_SECTIONS.has(section)) {
      await writeAbbaEntryIcon(abbaDir, section, id, emoji);
    }

    switch (section) {
      case "sermons":
        commitSermons(sermons.map((s) => s.id === id ? { ...s, ...patch } : s));
        break;
      case "prayers":
        commitPrayers(prayers.map((p) => p.id === id ? { ...p, ...patch } : p));
        break;
      case "testimonies":
        commitTestimonies(testimonies.map((t) => t.id === id ? { ...t, ...patch } : t));
        break;
      case "studies":
        commitStudies(studies.map((s) => s.id === id ? { ...s, ...patch } : s));
        break;
      case "events":
        commitEvents(events.map((e) => e.id === id ? { ...e, ...patch } : e));
        break;
    }
  };

  const writeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const sermonsRef = useRef<Sermon[]>([]);
  useEffect(() => { sermonsRef.current = sermons; }, [sermons]);

  const listForSection = (section: AbbaSection): any[] => {
    switch (section) {
      case "sermons":     return sermons;
      case "prayers":     return prayers;
      case "testimonies": return testimonies;
      case "studies":     return studies;
      case "events":      return events;
      case "links":       return links;
    }
  };

  const queueWrite = (section: AbbaSection, entry: any) => {
    const key = `${section}:${entry.id}`;
    const existing = writeTimers.current.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(async () => {
      try { await writeSectionNote(abbaDir, section, entry); }
      catch (e) { console.error("[abba] write failed:", key, e); }
      writeTimers.current.delete(key);
    }, 350);
    writeTimers.current.set(key, t);
  };

  const cancelWrite = (section: AbbaSection, id: string) => {
    const key = `${section}:${id}`;
    const t = writeTimers.current.get(key);
    if (t) { clearTimeout(t); writeTimers.current.delete(key); }
  };

  useEffect(() => {
    return () => {
      for (const [key, t] of Array.from(writeTimers.current.entries())) {
        clearTimeout(t);
        const [section, id] = key.split(":");
        const list = listForSection(section as AbbaSection);
        const entry = list.find((x: any) => x.id === id);
        if (entry && !RICH_SECTIONS.has(section as AbbaSection)) {
          writeSectionNote(abbaDir, section as AbbaSection, entry).catch((e) =>
            console.error("[abba] flush on unmount failed:", key, e));
        }
      }
      writeTimers.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abbaDir]);

  // ── External focus (home search, wiki links) ─────────────────────────
  // When the app hands us a section folder + note id, switch the tab
  // and open the matching entry. We use a ref so a re-render (e.g. a
  // list update after loading) doesn't re-open the detail view if the
  // user already closed it.
  const lastFocusAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    if (!focusSection || !focusNoteId) return;
    const key = `${focusSection}:${focusNoteId}`;
    if (lastFocusAppliedRef.current === key) return;

    const sectionToTab: Record<string, Tab> = {
      sermons: "sermons",
      prayers: "prayer",
      testimonies: "testimonies",
      studies: "studies",
      events: "events",
      links: "links",
    };
    const nextTab = sectionToTab[focusSection];
    if (!nextTab) return;

    // Confirm the entry actually lives in that tab's list. If not (e.g.
    // still loading), bail — the effect will re-run when the list fills.
    const list: any[] =
    nextTab === "sermons" ? sermons :
    nextTab === "prayer" ? prayers :
    nextTab === "testimonies" ? testimonies :
    nextTab === "studies" ? studies :
    nextTab === "events" ? events :
    nextTab === "links" ? links : [];
    if (!list.some((x) => x.id === focusNoteId)) return;

    lastFocusAppliedRef.current = key;
    setTab(nextTab);
    setOpenSermonId(null);
    setOpenPrayerId(null);
    setOpenTestimonyId(null);
    setOpenStudyId(null);
    setOpenEventId(null);
    if (nextTab === "sermons") setOpenSermonId(focusNoteId);
    else if (nextTab === "prayer") setOpenPrayerId(focusNoteId);
    else if (nextTab === "testimonies") setOpenTestimonyId(focusNoteId);
    else if (nextTab === "studies") setOpenStudyId(focusNoteId);
    else if (nextTab === "events") setOpenEventId(focusNoteId);
    // links have no detail pane
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, focusSection, focusNoteId, sermons, prayers, testimonies, studies, events, links]);

  useEffect(() => {
    const onErr = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d) return;
      setReadErrors((prev) => {
        const next = prev.filter((x) => x.section !== d.section);
        next.push(d);
        return next;
      });
    };
    window.addEventListener("abba-read-error", onErr);
    return () => window.removeEventListener("abba-read-error", onErr);
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      setReadErrors([]);
      try { await mkdir(abbaDir, { recursive: true }); } catch {}

      const [se, pr, te, st, ev, li] = await Promise.all([
        readSection<Sermon>(abbaDir, "sermons"),
        readSection<Prayer>(abbaDir, "prayers"),
        readSection<Testimony>(abbaDir, "testimonies"),
        readSection<Study>(abbaDir, "studies"),
        readSection<AbbaEvent>(abbaDir, "events"),
        readSection<AbbaLink>(abbaDir, "links"),
      ]);

      if (!mounted) return;
      setSermons(se.map((x) => ({
        ...x, title: x.title ?? "", speaker: x.speaker ?? "", notes: x.notes ?? "",
        songs: Array.isArray(x.songs) ? x.songs : [],
        images: Array.isArray(x.images) ? x.images : [],
        links: Array.isArray(x.links) ? x.links : [],
        audioFile: x.audioFile ?? null, audioName: x.audioName ?? null,
        icon: typeof x.icon === "string" && x.icon ? x.icon : undefined,
      })));
      setPrayers(pr.map((x) => ({
        ...x, title: x.title ?? "",
        icon: typeof x.icon === "string" && x.icon ? x.icon : undefined,
      })));
      setTestimonies(te.map((x) => ({
        ...x, title: x.title ?? "",
        icon: typeof x.icon === "string" && x.icon ? x.icon : undefined,
      })));
      setStudies(st.map((x) => ({
        ...x, title: x.title ?? "", topic: x.topic ?? "",
        links: Array.isArray(x.links) ? x.links : [],
        icon: typeof x.icon === "string" && x.icon ? x.icon : undefined,
      })));
      setEvents(ev.map((x) => ({
        ...x, title: x.title ?? "", location: x.location ?? "",
        links: Array.isArray(x.links) ? x.links : [],
        icon: typeof x.icon === "string" && x.icon ? x.icon : undefined,
      })));
      setLinks(li.map((x) => ({
        ...x, url: x.url ?? "", title: x.title ?? "",
        description: x.description ?? "", icon: x.icon ?? "", image: x.image ?? "",
      })));
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [abbaDir]);

  const updateViewMode = (next: ViewMode) => {
    setViewMode(next);
    try { localStorage.setItem(VIEW_MODE_KEY, next); } catch {}
  };

  function diffAndWrite<T extends { id: string }>(
    section: AbbaSection, prev: T[], next: T[], setter: (v: T[]) => void,
  ) {
    setter(next);
    const prevById = new Map(prev.map((x) => [x.id, x]));
    const nextById = new Map(next.map((x) => [x.id, x]));

    for (const [id, prevEntry] of prevById) {
      if (!nextById.has(id)) {
        cancelWrite(section, id);
        if (RICH_SECTIONS.has(section)) {
          const path = abbaNotePath(abbaDir, section, id);
          moveToTrash(path).catch((e) =>
            console.warn("[abba] could not trash rich note:", path, e));
        } else {
          deleteSectionNote(abbaDir, section, prevEntry as any);
        }
        deleteAbbaNoteAssetsFolder(abbaDir, section, id);
      }
    }

    if (RICH_SECTIONS.has(section)) return;

    for (const [id, entry] of nextById) {
      const before = prevById.get(id);
      if (!before || JSON.stringify(before) !== JSON.stringify(entry)) {
        queueWrite(section, entry);
      }
    }
  }

  const commitSermons = (next: Sermon[]) => diffAndWrite<Sermon>("sermons", sermons, next, setSermons);
  const commitPrayers = (next: Prayer[]) => diffAndWrite<Prayer>("prayers", prayers, next, setPrayers);
  const commitTestimonies = (next: Testimony[]) => diffAndWrite<Testimony>("testimonies", testimonies, next, setTestimonies);
  const commitStudies = (next: Study[]) => diffAndWrite<Study>("studies", studies, next, setStudies);
  const commitEvents = (next: AbbaEvent[]) => diffAndWrite<AbbaEvent>("events", events, next, setEvents);
  const commitLinks = (next: AbbaLink[]) => diffAndWrite<AbbaLink>("links", links, next, setLinks);

  const pickAudio = async (): Promise<{ sourcePath: string; name: string } | null> => {
    const picked = await open({
      multiple: false, filters: [{ name: "Audio", extensions: AUDIO_EXT }],
    });
    if (!picked || typeof picked !== "string") return null;
    const name = picked.split(/[/\\]/).pop() || "audio";
    return { sourcePath: picked, name };
  };

  const fetchLinkMeta = async (url: string): Promise<Partial<AbbaLink>> => {
    try {
      const meta: any = await invoke("fetch_link_metadata", { url });
      return {
        title: meta.title || url,
        description: meta.description || "",
        icon: meta.favicon || "",
        image: meta.image || "",
      };
    } catch {
      return { title: url };
    }
  };

  // ── Sermons ──────────────────────────────────────────────────────────────
  const promptNewSermon = () => setNewSermonDate(todayLocalInput());
  const confirmNewSermon = () => {
    if (!newSermonDate) return;
    const iso = new Date(`${newSermonDate}T12:00:00`).toISOString();
    const s: Sermon = {
      id: newId("sermon"), date: iso, title: "", speaker: "", notes: "",
      songs: [], audioFile: null, audioName: null, images: [], links: [],
    };
    commitSermons([s, ...sermons]);
    setNewSermonDate(null);
    setOpenSermonId(s.id);
  };
  const updateSermon = (id: string, patch: Partial<Sermon>) =>
    commitSermons(sermons.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const deleteSermon = async (s: Sermon) => {
    const ok = await confirmAsync(
      `Delete "${sermonTitle(s)}"? This moves audio and photos to the trash.`);
    if (!ok) return;
    commitSermons(sermons.filter((x) => x.id !== s.id));
    if (openSermonId === s.id) setOpenSermonId(null);
  };

  // ── Prayers ──────────────────────────────────────────────────────────────
  const createPrayer = async () => {
    const now = nowIso();
    const p: Prayer = { id: newId("prayer"), date: now, title: "", created: now, modified: now };
    await ensureAbbaNoteFile(abbaDir, "prayers", p.id, {
      id: p.id, date: p.date, title: p.title, created: p.created, modified: p.modified,
    });
    commitPrayers([p, ...prayers]);
    setOpenPrayerId(p.id);
  };
  const updatePrayer = (id: string, patch: Partial<Prayer>) =>
    commitPrayers(prayers.map((p) =>
      p.id === id ? { ...p, ...patch, modified: nowIso() } : p));
  const deletePrayer = async (p: Prayer) => {
    const ok = await confirmAsync(`Delete "${p.title || "this prayer"}"?`);
    if (!ok) return;
    commitPrayers(prayers.filter((x) => x.id !== p.id));
    if (openPrayerId === p.id) setOpenPrayerId(null);
  };

  // ── Testimonies ──────────────────────────────────────────────────────────
  const createTestimony = async () => {
    const now = nowIso();
    const t: Testimony = {
      id: newId("testimony"), date: now, title: "", created: now, modified: now,
    };
    await ensureAbbaNoteFile(abbaDir, "testimonies", t.id, {
      id: t.id, date: t.date, title: t.title, created: t.created, modified: t.modified,
    });
    commitTestimonies([t, ...testimonies]);
    setOpenTestimonyId(t.id);
  };
  const updateTestimony = (id: string, patch: Partial<Testimony>) =>
    commitTestimonies(testimonies.map((t) =>
      t.id === id ? { ...t, ...patch, modified: nowIso() } : t));
  const deleteTestimony = async (t: Testimony) => {
    const ok = await confirmAsync(`Delete "${t.title || "this testimony"}"?`);
    if (!ok) return;
    commitTestimonies(testimonies.filter((x) => x.id !== t.id));
    if (openTestimonyId === t.id) setOpenTestimonyId(null);
  };

  // ── Studies ──────────────────────────────────────────────────────────────
  const createStudy = async () => {
    const now = nowIso();
    const s: Study = {
      id: newId("study"), date: now, title: "", topic: "",
      links: [], created: now, modified: now,
    };
    await ensureAbbaNoteFile(abbaDir, "studies", s.id, {
      id: s.id, date: s.date, title: s.title, topic: s.topic,
      links: [], created: s.created, modified: s.modified,
    });
    commitStudies([s, ...studies]);
    setOpenStudyId(s.id);
  };
  const updateStudy = (id: string, patch: Partial<Study>) =>
    commitStudies(studies.map((s) =>
      s.id === id ? { ...s, ...patch, modified: nowIso() } : s));
  const deleteStudy = async (s: Study) => {
    const ok = await confirmAsync(`Delete "${s.title || "this study"}"?`);
    if (!ok) return;
    commitStudies(studies.filter((x) => x.id !== s.id));
    if (openStudyId === s.id) setOpenStudyId(null);
  };

  // ── Events ───────────────────────────────────────────────────────────────
  const createEvent = async () => {
    const now = nowIso();
    const e: AbbaEvent = {
      id: newId("event"), date: now, title: "", location: "",
      links: [], created: now, modified: now,
    };
    await ensureAbbaNoteFile(abbaDir, "events", e.id, {
      id: e.id, date: e.date, title: e.title, location: e.location,
      links: [], created: e.created, modified: e.modified,
    });
    commitEvents([e, ...events]);
    setOpenEventId(e.id);
  };
  const updateEvent = (id: string, patch: Partial<AbbaEvent>) =>
    commitEvents(events.map((e) =>
      e.id === id ? { ...e, ...patch, modified: nowIso() } : e));
  const deleteEvent = async (e: AbbaEvent) => {
    const ok = await confirmAsync(`Delete "${e.title || "this event"}"?`);
    if (!ok) return;
    commitEvents(events.filter((x) => x.id !== e.id));
    if (openEventId === e.id) setOpenEventId(null);
  };

  // ── Links ────────────────────────────────────────────────────────────────
  const createLink = () => {
    const now = nowIso();
    const l: AbbaLink = {
      id: newId("link"), url: "", title: "", description: "",
      icon: "", image: "", created: now, modified: now,
    };
    commitLinks([l, ...links]);
  };
  const updateLink = (id: string, patch: Partial<AbbaLink>) =>
    commitLinks(links.map((l) =>
      l.id === id ? { ...l, ...patch, modified: nowIso() } : l));
  const deleteLink = async (l: AbbaLink) => {
    const ok = await confirmAsync(`Remove this link?`);
    if (!ok) return;
    commitLinks(links.filter((x) => x.id !== l.id));
  };

  const handleTabChange = (next: Tab) => {
    if (next !== tab) {
      setOpenSermonId(null); setOpenPrayerId(null); setOpenTestimonyId(null);
      setOpenStudyId(null); setOpenEventId(null); setLightbox(null);
    }
    setTab(next);
  };

  const openOptimizer = async () => {
    setOptimizeOpen(true); setOptimizePhase("scanning");
    setOptimizeError(null); setOptimizeUnused([]); setOptimizeDeletedCount(0);
    try {
      const assetsDir = subPath(abbaDir, "assets");
      let entries: any[] = [];
      try { entries = await readDir(assetsDir); } catch { entries = []; }
      const unused: { file: string; size: number }[] = [];
      for (const e of entries) {
        if (!e.name) continue;
        if (e.isDirectory) continue;
        if (e.name.startsWith(".")) continue;
        const size = (await abbaNoteAssetSize(abbaDir, "", "", e.name)) ?? 0;
        unused.push({ file: e.name, size });
      }
      unused.sort((a, b) => b.size - a.size);
      setOptimizeUnused(unused); setOptimizePhase("results");
    } catch (e: any) {
      setOptimizeError(e?.message ?? String(e)); setOptimizePhase("error");
    }
  };

  const deleteAllUnused = async () => {
    setOptimizePhase("deleting");
    let count = 0;
    for (const { file } of optimizeUnused) {
      try {
        const full = subPath(abbaDir, "assets", file);
        if (full) { await moveToTrash(full); count++; }
      } catch (e) { console.error("[abba] could not delete:", file, e); }
    }
    setOptimizeDeletedCount(count); setOptimizeUnused([]); setOptimizePhase("done");
  };

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center text-gray-500 text-sm bg-[#0f1315]">
        Loading {name}…
      </div>
    );
  }

  const TABS: { id: Tab; label: string; icon: any }[] = [
    { id: "sermons",     label: "Sermons",     icon: Church },
    { id: "prayer",      label: "Prayer",      icon: HandHeart },
    { id: "testimonies", label: "Testimonies", icon: Heart },
    { id: "events",      label: "Events",      icon: Star },
    { id: "studies",     label: "Bible Study", icon: BookOpen },
    { id: "links",       label: "Links",       icon: LinkIcon },
  ];

  const showViewToggle = tab !== "links";
  const openSermon = openSermonId ? sermons.find((s) => s.id === openSermonId) || null : null;
  const openPrayer = openPrayerId ? prayers.find((p) => p.id === openPrayerId) || null : null;
  const openTestimony = openTestimonyId ? testimonies.find((t) => t.id === openTestimonyId) || null : null;
  const openStudy = openStudyId ? studies.find((s) => s.id === openStudyId) || null : null;
  const openEvent = openEventId ? events.find((e) => e.id === openEventId) || null : null;

  const totalUnusedBytes = optimizeUnused.reduce((sum, u) => sum + u.size, 0);

  return (
    <AbbaErrorBoundary>
      <div className="w-full h-full flex flex-col bg-[#0f1315] overflow-hidden">
        {modal}

        {lightbox && (
          <Lightbox
            scope={lightbox.scope} images={lightbox.images} index={lightbox.index}
            onClose={() => setLightbox(null)}
            onIndexChange={(i) => setLightbox((prev) => (prev ? { ...prev, index: i } : null))} />
        )}

        {richLightbox && (
          <PhotoLightbox
            srcs={richLightbox.srcs} index={richLightbox.index}
            onClose={() => setRichLightbox(null)}
            onIndexChange={(i) => setRichLightbox((prev) => (prev ? { ...prev, index: i } : null))} />
        )}

        {ctxMenu && (
          <div
            className="fixed z-[400] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-2xl py-1 w-[220px]"
            style={{ top: ctxMenu.y, left: ctxMenu.x }}
            onMouseDown={(e) => { if (e.button === 2) { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); } }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div className="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-gray-500 truncate"
              title={ctxMenu.label}>
              {ctxMenu.label || "Untitled"}
            </div>
            <button
              type="button"
              onClick={() => { const fn = ctxMenu.onOpen; setCtxMenu(null); fn(); }}
              className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
            >
              <BookOpen size={13} /> <span>Open</span>
            </button>
            <button
              type="button"
              onClick={() => { const fn = ctxMenu.onChangeIcon; setCtxMenu(null); fn(); }}
              className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
            >
              <Smile size={13} /> <span>Change icon…</span>
            </button>
            <button
              type="button"
              onClick={() => { const fn = ctxMenu.onDelete; setCtxMenu(null); void fn(); }}
              className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-[#2a3136] flex items-center gap-2 border-t border-[#2a3136]"
            >
              <Trash2 size={13} /> <span>Delete</span>
            </button>
          </div>
        )}

        {iconPicker && createPortal(
          <div
            ref={iconPickerRef}
            className="fixed z-[420] bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl overflow-hidden"
            style={{ top: iconPicker.top, left: iconPicker.left }}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a3136]">
              <span className="text-xs text-gray-400">Choose icon</span>
              <button onClick={() => setIconPicker(null)}
                className="text-gray-500 hover:text-gray-300 p-0.5" title="Close">
                <X size={12} />
              </button>
            </div>
            <EmojiPicker
              theme={Theme.DARK}
              emojiStyle={EmojiStyle.NATIVE}
              onEmojiClick={(d) => applyEntryIcon(d.emoji)}
              width={320}
              height={360}
              previewConfig={{ showPreview: false }}
            />
            <button
              onClick={() => applyEntryIcon("")}
              className="w-full text-left text-xs text-gray-500 hover:text-red-400 hover:bg-[#2a3136] px-3 py-2 border-t border-[#2a3136]"
            >
              Remove icon (use default)
            </button>
          </div>,
          document.body
        )}

        {readErrors.length > 0 && (
          <div className="flex-shrink-0 mx-4 mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-300 flex items-start gap-2">
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-medium">Some entries couldn't be read</div>
              <div className="text-amber-400/70 mt-0.5">
                {readErrors.map((r) => `${r.section}: ${r.count}/${r.total}`).join(" · ")}
                {" — the files may be corrupt."}
              </div>
            </div>
            <button onClick={() => setReadErrors([])}
              className="text-amber-400/70 hover:text-amber-300 p-0.5" title="Dismiss">
              <X size={12} />
            </button>
          </div>
        )}

        <div className="flex items-center justify-between px-6 pt-4 pb-3 border-b border-[#2a3136] flex-shrink-0 gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-300 whitespace-nowrap">
            <span className="text-lg leading-none">{icon || "🙏"}</span>
            <span>{name}</span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={openOptimizer}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-[#2a3136] text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors text-xs font-medium"
              title="Find and delete leftover files in assets/">
              <Sparkles size={12} /><span>Clean up</span>
            </button>
          </div>
        </div>

        <div className="flex items-center px-4 pt-2 pb-0 border-b border-[#2a3136] flex-shrink-0 gap-2">
          <div className="flex items-center gap-1 overflow-x-auto flex-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button key={t.id} type="button" onClick={() => handleTabChange(t.id)}
                  className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t transition-colors whitespace-nowrap ${
                    active ? "text-gray-100 bg-[#161a1d] border-b-2 border-blue-500"
                           : "text-gray-500 hover:text-gray-300"}`}>
                  <Icon size={13} /><span>{t.label}</span>
                </button>
              );
            })}
          </div>
          {showViewToggle && (
            <div className="flex items-center bg-[#0f1315] border border-[#30363d] rounded p-0.5 flex-shrink-0 mb-1">
              <button type="button" onClick={() => updateViewMode("list")}
                className={`flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer ${
                  viewMode === "list" ? "bg-[#2a3136] text-gray-100" : "text-gray-500 hover:text-gray-300"}`}
                title="List view"><ListIcon size={13} /></button>
              <button type="button" onClick={() => updateViewMode("grid")}
                className={`flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer ${
                  viewMode === "grid" ? "bg-[#2a3136] text-gray-100" : "text-gray-500 hover:text-gray-300"}`}
                title="Grid view"><LayoutGrid size={13} /></button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {tab === "sermons" && (
            openSermon ? (
              <SermonDetail key={openSermon.id} sermon={openSermon} abbaDir={abbaDir} isEdit={isEdit}
                onBack={() => setOpenSermonId(null)}
                onUpdate={(patch) => updateSermon(openSermon.id, patch)}
                onDelete={() => deleteSermon(openSermon)}
                pickAudio={pickAudio}
                fetchLinkMeta={fetchLinkMeta} />
            ) : (
              <SermonsList sermons={sermons} viewMode={viewMode} abbaDir={abbaDir}
                onOpen={(id) => setOpenSermonId(id)} onCreate={promptNewSermon}
                onContextMenu={(e, s) => openContextMenu(e, {
                  label: sermonTitle(s), icon: s.icon,
                  onOpen: () => setOpenSermonId(s.id),
                  onChangeIconAt: (x, y) => openIconPicker("sermons", s.id, x, y),
                  onDelete: () => deleteSermon(s),
                })} />
            )
          )}

          {tab === "prayer" && (
            openPrayer ? (
              <RichDetail
                key={openPrayer.id}
                kind="prayers"
                entry={openPrayer}
                abbaDir={abbaDir}
                isEdit={isEdit}
                onBack={() => setOpenPrayerId(null)}
                onUpdate={(patch) => updatePrayer(openPrayer.id, patch)}
                onDelete={() => deletePrayer(openPrayer)}
                onImageClick={(srcs, idx) => setRichLightbox({ srcs, index: idx })}
              />
            ) : (
              <PrayersList prayers={prayers} viewMode={viewMode}
                onOpen={(id) => setOpenPrayerId(id)} onCreate={createPrayer}
                onContextMenu={(e, p) => openContextMenu(e, {
                  label: prayerTitle(p), icon: p.icon,
                  onOpen: () => setOpenPrayerId(p.id),
                  onChangeIconAt: (x, y) => openIconPicker("prayers", p.id, x, y),
                  onDelete: () => deletePrayer(p),
                })} />
            )
          )}

          {tab === "testimonies" && (
            openTestimony ? (
              <RichDetail
                key={openTestimony.id}
                kind="testimonies"
                entry={openTestimony}
                abbaDir={abbaDir}
                isEdit={isEdit}
                onBack={() => setOpenTestimonyId(null)}
                onUpdate={(patch) => updateTestimony(openTestimony.id, patch)}
                onDelete={() => deleteTestimony(openTestimony)}
                onImageClick={(srcs, idx) => setRichLightbox({ srcs, index: idx })}
              />
            ) : (
              <TestimoniesList testimonies={testimonies} viewMode={viewMode}
                onOpen={(id) => setOpenTestimonyId(id)} onCreate={createTestimony}
                onContextMenu={(e, t) => openContextMenu(e, {
                  label: testimonyTitle(t), icon: t.icon,
                  onOpen: () => setOpenTestimonyId(t.id),
                  onChangeIconAt: (x, y) => openIconPicker("testimonies", t.id, x, y),
                  onDelete: () => deleteTestimony(t),
                })} />
            )
          )}

          {tab === "events" && (
            openEvent ? (
              <RichDetail
                key={openEvent.id}
                kind="events"
                entry={openEvent}
                abbaDir={abbaDir}
                isEdit={isEdit}
                onBack={() => setOpenEventId(null)}
                onUpdate={(patch) => updateEvent(openEvent.id, patch)}
                onDelete={() => deleteEvent(openEvent)}
                fetchLinkMeta={fetchLinkMeta}
                onImageClick={(srcs, idx) => setRichLightbox({ srcs, index: idx })}
              />
            ) : (
              <EventsList events={events} viewMode={viewMode}
                onOpen={(id) => setOpenEventId(id)} onCreate={createEvent}
                onContextMenu={(e, ev) => openContextMenu(e, {
                  label: eventTitle(ev), icon: ev.icon,
                  onOpen: () => setOpenEventId(ev.id),
                  onChangeIconAt: (x, y) => openIconPicker("events", ev.id, x, y),
                  onDelete: () => deleteEvent(ev),
                })} />
            )
          )}

          {tab === "studies" && (
            openStudy ? (
              <RichDetail
                key={openStudy.id}
                kind="studies"
                entry={openStudy}
                abbaDir={abbaDir}
                isEdit={isEdit}
                onBack={() => setOpenStudyId(null)}
                onUpdate={(patch) => updateStudy(openStudy.id, patch)}
                onDelete={() => deleteStudy(openStudy)}
                fetchLinkMeta={fetchLinkMeta}
                onImageClick={(srcs, idx) => setRichLightbox({ srcs, index: idx })}
              />
            ) : (
              <StudiesList studies={studies} viewMode={viewMode}
                onOpen={(id) => setOpenStudyId(id)} onCreate={createStudy}
                onContextMenu={(e, s) => openContextMenu(e, {
                  label: studyTitle(s), icon: s.icon,
                  onOpen: () => setOpenStudyId(s.id),
                  onChangeIconAt: (x, y) => openIconPicker("studies", s.id, x, y),
                  onDelete: () => deleteStudy(s),
                })} />
            )
          )}

          {tab === "links" && (
            <LinksSection links={links} isEdit={isEdit}
              onAdd={createLink} onUpdate={updateLink} onRemove={deleteLink}
              fetchLinkMeta={fetchLinkMeta} />
          )}
        </div>

        {optimizeOpen && (
          <div className="fixed inset-0 z-[220] bg-black/70 flex items-center justify-center p-6"
            onClick={() => { if (optimizePhase === "deleting") return; setOptimizeOpen(false); }}>
            <div className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[560px] max-w-[92vw] max-h-[80vh] overflow-hidden flex flex-col"
              onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
                <Sparkles size={14} className="text-blue-400" />
                <span className="text-sm font-medium text-gray-100">Clean up leftover files</span>
                <button type="button"
                  onClick={() => { if (optimizePhase === "deleting") return; setOptimizeOpen(false); }}
                  disabled={optimizePhase === "deleting"}
                  className="ml-auto text-gray-500 hover:text-gray-300 p-0.5 disabled:opacity-40"
                  title="Close"><X size={14} /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                {optimizePhase === "scanning" && (
                  <div className="flex items-center gap-3 py-8 justify-center text-sm text-gray-400">
                    <Loader2 size={16} className="animate-spin" />
                    <span>Scanning assets/ for leftover files…</span>
                  </div>
                )}
                {optimizePhase === "error" && (
                  <div className="flex items-start gap-3">
                    <AlertTriangle size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm text-red-300 font-medium">Could not scan.</p>
                      <p className="text-xs text-red-400/70 mt-1 break-words">{optimizeError}</p>
                    </div>
                  </div>
                )}
                {optimizePhase === "results" && optimizeUnused.length === 0 && (
                  <div className="text-center py-10">
                    <p className="text-sm text-gray-300">No leftover files.</p>
                    <p className="text-xs text-gray-500 mt-1">
                      All assets live inside per-note folders now, so <span className="font-mono">assets/</span> only contains the organized subfolders.
                    </p>
                  </div>
                )}
                {optimizePhase === "results" && optimizeUnused.length > 0 && (
                  <>
                    <div className="text-sm text-gray-200 mb-1">
                      Found <span className="font-semibold text-gray-100">{optimizeUnused.length}</span>{" "}
                      leftover {optimizeUnused.length === 1 ? "file" : "files"}
                      {totalUnusedBytes > 0 && (<> taking up <span className="font-semibold text-amber-300">{formatBytes(totalUnusedBytes)}</span></>)}.
                    </div>
                    <div className="rounded-md border border-[#2a3136] bg-[#0f1315] max-h-[340px] overflow-y-auto divide-y divide-[#2a3136]">
                      {optimizeUnused.slice(0, 300).map((u) => (
                        <div key={u.file} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                          <span className="text-gray-300 truncate flex-1 font-mono">{u.file}</span>
                          <span className="text-gray-500 tabular-nums flex-shrink-0">{formatBytes(u.size)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {optimizePhase === "deleting" && (
                  <div className="flex items-center gap-3 py-8 justify-center text-sm text-gray-400">
                    <Loader2 size={16} className="animate-spin" /><span>Moving files to trash…</span>
                  </div>
                )}
                {optimizePhase === "done" && (
                  <div className="text-center py-10">
                    <p className="text-sm text-gray-200">
                      Moved <span className="font-semibold text-gray-100">{optimizeDeletedCount}</span>{" "}
                      {optimizeDeletedCount === 1 ? "file" : "files"} to the trash.
                    </p>
                  </div>
                )}
              </div>
              {optimizePhase === "results" && optimizeUnused.length > 0 && (
                <div className="flex justify-end gap-2 px-4 py-3 border-t border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
                  <button type="button" onClick={() => setOptimizeOpen(false)}
                    className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-[#2a3136] rounded transition-colors">Cancel</button>
                  <button type="button" onClick={deleteAllUnused}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors font-medium">
                    <Trash2 size={12} /><span>Move {optimizeUnused.length} to trash</span>
                  </button>
                </div>
              )}
              {(optimizePhase === "done" || (optimizePhase === "results" && optimizeUnused.length === 0)) && (
                <div className="flex justify-end gap-2 px-4 py-3 border-t border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
                  <button type="button" onClick={() => setOptimizeOpen(false)}
                    className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium">Done</button>
                </div>
              )}
            </div>
          </div>
        )}

        {newSermonDate !== null && (
          <div className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-6"
            onClick={() => setNewSermonDate(null)}>
            <div className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[380px] max-w-[92vw] overflow-hidden"
              onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a3136] bg-[#1a1e21]">
                <Church size={14} className="text-blue-400" />
                <span className="text-sm font-medium text-gray-100">New Sermon</span>
                <button type="button" onClick={() => setNewSermonDate(null)}
                  className="ml-auto text-gray-500 hover:text-gray-300 p-0.5" title="Close"><X size={14} /></button>
              </div>
              <div className="p-4 space-y-3">
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5 flex items-center gap-1.5">
                    <Calendar size={10} /> Service date
                  </label>
                  <input type="date" value={newSermonDate}
                    onChange={(e) => setNewSermonDate(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") confirmNewSermon();
                      if (e.key === "Escape") setNewSermonDate(null);
                    }}
                    className="w-full bg-[#0f1315] border border-[#30363d] rounded px-3 py-2 text-sm text-gray-100 outline-none focus:ring-1 focus:ring-blue-500" />
                  <p className="text-[10px] text-gray-600 mt-1.5">
                    {newSermonDate
                      ? `Will be saved as ${fmtDate(new Date(`${newSermonDate}T12:00:00`).toISOString())}`
                      : "Pick a date for this sermon."}
                  </p>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button type="button" onClick={() => setNewSermonDate(null)}
                    className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-[#2a3136] rounded transition-colors">Cancel</button>
                  <button type="button" onClick={confirmNewSermon} disabled={!newSermonDate}
                    className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors font-medium">Create Sermon</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </AbbaErrorBoundary>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  RichDetail — Prayers, Testimonies, Events, Studies
// ═══════════════════════════════════════════════════════════════════════════
type RichKind = "prayers" | "testimonies" | "events" | "studies";

function RichDetail({
  kind, entry, abbaDir, isEdit, onBack, onUpdate, onDelete,
  fetchLinkMeta, onImageClick,
}: {
  kind: RichKind;
  entry: any;
  abbaDir: string;
  isEdit: boolean;
  onBack: () => void;
  onUpdate: (patch: any) => void;
  onDelete: () => void;
  fetchLinkMeta?: (url: string) => Promise<Partial<AbbaLink>>;
  onImageClick?: (srcs: string[], index: number) => void;
}) {
  const { mode, toggle, setMode } = useNoteMode();
  const noteBodyRef = useRef<NoteBodyHandle>(null);
  const [ready, setReady] = useState(false);
  const [path, setPath] = useState<string | null>(null);

  const [title, setTitle] = useState<string>(entry.title ?? "");
  const [date, setDate] = useState<string>(entry.date ?? "");
  const [location, setLocation] = useState<string>(entry.location ?? "");
  const [topic, setTopic] = useState<string>(entry.topic ?? "");
  const [created, setCreated] = useState<string>(entry.created ?? "");
  const [modified, setModified] = useState<string>(entry.modified ?? "");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p = await ensureAbbaNoteFile(abbaDir, kind, entry.id, {
        id: entry.id,
        date: entry.date,
        title: entry.title ?? "",
        topic: kind === "studies" ? entry.topic ?? "" : undefined,
        location: kind === "events" ? entry.location ?? "" : undefined,
        links: (kind === "events" || kind === "studies") ? (entry.links ?? []) : undefined,
        created: entry.created ?? nowIso(),
        modified: entry.modified ?? nowIso(),
      });
      if (cancelled) return;
      setPath(p);
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, [abbaDir, kind, entry.id]);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    if (mode === "read" && !entry.title?.trim() && !entry.created) setMode("edit");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const writeFm = (patch: Record<string, any>) => {
    noteBodyRef.current?.updateFrontmatter(patch).catch((e) =>
      console.error("[abba] updateFrontmatter failed:", e));
  };

  const handleTitleChange = (v: string) => {
    setTitle(v); onUpdate({ title: v }); writeFm({ title: v });
  };
  const handleDateChange = (iso: string) => {
    setDate(iso); onUpdate({ date: iso }); writeFm({ date: iso });
  };
  const handleLocationChange = (v: string) => {
    setLocation(v); onUpdate({ location: v }); writeFm({ location: v });
  };
  const handleTopicChange = (v: string) => {
    setTopic(v); onUpdate({ topic: v }); writeFm({ topic: v });
  };

  const dateValue = date ? date.slice(0, 10) : "";
  const showTopic = kind === "studies";
  const showLocation = kind === "events";
  const showLinks = kind === "events" || kind === "studies";

  if (!ready || !path) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-6 flex items-center gap-2 text-gray-500 text-sm">
        <Loader2 size={14} className="animate-spin" />
        <span>Opening…</span>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-[#2a3136] gap-2">
        <button type="button" onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-100 transition-colors">
          <ChevronLeft size={14} />
          <span>
            All {kind === "prayers" ? "Prayers" :
                 kind === "testimonies" ? "Testimonies" :
                 kind === "events" ? "Events" : "Studies"}
          </span>
        </button>
        <div className="flex items-center gap-2">
          {isEdit && (
            <button type="button" onClick={onDelete}
              className="text-gray-500 hover:text-red-400 p-1.5 rounded transition-colors"
              title="Delete"><Trash2 size={14} /></button>
          )}
          <span className="text-[10px] uppercase tracking-wider text-gray-500">
            {mode === "edit" ? "Editing" : "Reading"}
          </span>
          <button type="button" onClick={toggle}
            className="flex items-center justify-center w-7 h-7 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer"
            title={mode === "edit" ? "Switch to read mode (Ctrl+E)" : "Switch to edit mode (Ctrl+E)"}>
            {mode === "edit" ? <BookOpen size={15} /> : <Pencil size={15} />}
          </button>
        </div>
      </div>

      <div className="flex justify-center mb-2">
        {entry.icon ? (
          <span className="text-4xl leading-none select-none">{entry.icon}</span>
        ) : null}
      </div>

      <StableField
        as="input"
        type="text"
        value={title}
        onChange={handleTitleChange}
        readOnly={!isEdit}
        placeholder={
          kind === "prayers" ? "A prayer…" :
          kind === "testimonies" ? "A testimony…" :
          kind === "events" ? "Event title (e.g. Baptism of Sarah)" :
          "Study title…"
        }
        className={`w-full bg-transparent border-none outline-none text-3xl font-bold tracking-tight px-2 py-1 rounded text-center placeholder-gray-700 ${
          isEdit ? "text-gray-100 focus:bg-white/5" : "text-gray-100 cursor-default"
        }`}
      />

      <div className="flex items-center justify-center gap-3 text-xs text-gray-500 mt-3">
        {isEdit ? (
          <input type="date" value={dateValue}
            onChange={(e) => handleDateChange(new Date(e.target.value + "T12:00:00").toISOString())}
            className="bg-transparent border-none outline-none text-xs text-gray-400 focus:text-gray-200" />
        ) : (
          <span>{fmtDate(date)}</span>
        )}
      </div>

      {showLocation && (
        <div className="mt-4">
          {isEdit ? (
            <div className="flex items-center justify-center gap-1.5 text-amber-300/90">
              <MapPin size={12} className="flex-shrink-0" />
              <StableField
                as="input"
                type="text"
                value={location}
                onChange={handleLocationChange}
                placeholder="Location (e.g. Main Sanctuary)"
                className="bg-transparent border-none outline-none text-sm text-amber-300/90 text-center placeholder-gray-600 focus:bg-white/5 px-2 py-1 rounded"
                style={{ minWidth: "12rem", maxWidth: "24rem" }}
              />
            </div>
          ) : location.trim() ? (
            <div className="text-sm text-amber-300/90 font-medium text-center flex items-center justify-center gap-1.5">
              <MapPin size={12} className="flex-shrink-0" /><span>{location}</span>
            </div>
          ) : null}
        </div>
      )}

      {showTopic && (
        <div className="mt-4">
          {isEdit ? (
            <StableField
              as="input"
              type="text"
              value={topic}
              onChange={handleTopicChange}
              placeholder="Topic / passage (e.g. Romans 8:28)"
              className="w-full bg-transparent border-none outline-none text-sm text-amber-300/90 text-center placeholder-gray-600 focus:bg-white/5 px-2 py-1 rounded"
            />
          ) : topic.trim() ? (
            <div className="text-sm text-amber-300/90 font-medium text-center">{topic}</div>
          ) : null}
        </div>
      )}

      <div className="mt-6">
        <NoteBody
          ref={noteBodyRef}
          key={path}
          path={path}
          onFrontmatterLoaded={(fm) => {
            if (typeof fm.title === "string") setTitle(fm.title);
            if (typeof fm.date === "string") setDate(fm.date);
            if (typeof fm.location === "string") setLocation(fm.location);
            if (typeof fm.topic === "string") setTopic(fm.topic);
            if (typeof fm.created === "string") setCreated(fm.created);
            if (typeof fm.modified === "string") setModified(fm.modified);
          }}
          onSaved={() => setModified(new Date().toISOString())}
          onImageClick={onImageClick}
        />
      </div>

      {showLinks && fetchLinkMeta && (
        <RichLinksSection
          links={(entry.links ?? []) as AbbaLink[]}
          isEdit={isEdit}
          fetchLinkMeta={fetchLinkMeta}
          onChange={(nextLinks) => {
            onUpdate({ links: nextLinks });
            writeFm({ links: nextLinks });
          }}
        />
      )}

      {(created || modified) && (
        <div className="mt-12 pt-4 border-t border-[#2a3136]">
          <TimeMeta created={created} modified={modified} align="center" />
        </div>
      )}

      <div className="h-16" />
    </div>
  );
}

function RichLinksSection({
  links, isEdit, fetchLinkMeta, onChange,
}: {
  links: AbbaLink[];
  isEdit: boolean;
  fetchLinkMeta: (url: string) => Promise<Partial<AbbaLink>>;
  onChange: (links: AbbaLink[]) => void;
}) {
  const [linkDraft, setLinkDraft] = useState("");
  const [savingLink, setSavingLink] = useState(false);

  const addLink = async () => {
    const url = normalizeUrl(linkDraft);
    if (!url) return;
    setSavingLink(true);
    const meta = await fetchLinkMeta(url);
    const l: AbbaLink = {
      id: newId("link"), url,
      title: meta.title || url, description: meta.description || "",
      icon: meta.icon || "", image: meta.image || "",
      created: nowIso(), modified: nowIso(),
    };
    onChange([...links, l]);
    setLinkDraft("");
    setSavingLink(false);
  };

  const removeLink = (id: string) => onChange(links.filter((l) => l.id !== id));

  return (
    <section className="mt-8 rounded-lg border border-[#2a3136] bg-[#161a1d] p-4">
      <SectionLabel icon={LinkIcon} label="Links" />
      {links.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {links.map((l) => (
            <AbbaLinkDisplay key={l.id} link={l} isEdit={isEdit}
              onRemove={() => removeLink(l.id)} />
          ))}
        </div>
      )}
      {isEdit && (
        <div className="flex gap-1.5">
          <input type="text" value={linkDraft}
            onChange={(e) => setLinkDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addLink(); }}
            placeholder="Paste a link and press Enter"
            className="flex-1 min-w-0 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500" />
          <button type="button" onClick={addLink}
            disabled={!linkDraft.trim() || savingLink}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-[#2a3136] hover:bg-[#30363d] disabled:opacity-40 border border-[#30363d] rounded text-gray-200 flex-shrink-0">
            {savingLink ? "…" : <Plus size={11} />}
          </button>
        </div>
      )}
    </section>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function sermonTitle(s: Sermon): string {
  if (s.title.trim()) return s.title.trim();
  if (s.speaker.trim()) return `${s.speaker.trim()} — ${fmtShort(s.date)}`;
  return `Sermon — ${fmtShort(s.date)}`;
}
function prayerTitle(p: Prayer): string { return p.title.trim() || `Prayer — ${fmtShort(p.date)}`; }
function testimonyTitle(t: Testimony): string { return t.title.trim() || `Testimony — ${fmtShort(t.date)}`; }
function studyTitle(s: Study): string { return s.title.trim() || `Study — ${fmtShort(s.date)}`; }
function eventTitle(e: AbbaEvent): string { return e.title.trim() || `Event — ${fmtShort(e.date)}`; }

function TimeMeta({ created, modified, align = "left" }: {
  created?: string; modified?: string; align?: "left" | "center";
}) {
  if (!created && !modified) return null;
  const showModified = modified && created && modified !== created;
  return (
    <div className={`flex flex-wrap items-center gap-3 text-[10px] text-gray-500 ${
      align === "center" ? "justify-center" : ""}`}>
      {created && (
        <span className="flex items-center gap-1">
          <Clock size={9} /><span>Created {fmtDateTime(created)}</span>
        </span>
      )}
      {showModified && (
        <>
          <span className="text-gray-700">•</span>
          <span className="flex items-center gap-1">
            <Clock size={9} /><span>Modified {fmtDateTime(modified)}</span>
          </span>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  List views
// ═══════════════════════════════════════════════════════════════════════════

function SermonsList({ sermons, viewMode, abbaDir, onOpen, onCreate, onContextMenu }: {
  sermons: Sermon[]; viewMode: ViewMode; abbaDir: string;
  onOpen: (id: string) => void; onCreate: () => void;
  onContextMenu: ListContextHandler<Sermon>;
}) {
  const sorted = [...sermons].sort(byDateDesc);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter((s) =>
      [s.title || "", s.speaker || "", s.notes || "", ...songsOf(s), dateSearchString(s.date)]
        .join(" ").toLowerCase().includes(query));
  }, [sorted, q]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-100">Sermons</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {sermons.length} {sermons.length === 1 ? "sermon" : "sermons"} archived
          </p>
        </div>
        <button type="button" onClick={onCreate}
          className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium">
          <Plus size={13} /> <span>New Sermon</span>
        </button>
      </div>
      {sermons.length > 0 && (
        <div className="relative mb-4">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search by title, speaker, date, or song…"
            className="w-full bg-[#161a1d] border border-[#2a3136] rounded pl-9 pr-3 py-2 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500" />
        </div>
      )}
      {sorted.length === 0 ? (
        <EmptyCTA icon={Church} title="No sermons yet"
          subtitle="Pick a date to start your first sermon entry."
          buttonLabel="Create your first sermon" onCreate={onCreate} />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-gray-500 italic text-center py-6">No matches for "{q}".</p>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((s) => {
            const songs = songsOf(s);
            const scope: AbbaScope = { abbaDir, section: "sermons", noteId: s.id };
            return (
              <GridCard key={s.id} scope={scope} image={s.images[0]} icon={s.icon}
                fallbackIcon={Church} fallbackTint="#60a5fa"
                title={sermonTitle(s)} dateText={fmtShort(s.date)}
                subtitle={s.speaker || undefined}
                subtitleIcon={s.speaker ? User : undefined}
                previewText={s.notes.trim() ? preview(s.notes) : undefined}
                onContextMenu={(e) => onContextMenu(e, s)}
                meta={
                  <div className="flex items-center gap-2 text-[10px] text-gray-500 flex-wrap">
                    {s.audioFile && (<span className="flex items-center gap-1 text-blue-400/80"><FileAudio size={10} /> Audio</span>)}
                    {s.images.length > 0 && (<span className="flex items-center gap-1"><ImageIcon size={10} /> {s.images.length}</span>)}
                    {songs.length > 0 && (<span className="flex items-center gap-1 text-purple-400/80"><ListMusic size={10} /> {songs.length}</span>)}
                    {s.links.length > 0 && (<span className="flex items-center gap-1"><LinkIcon size={10} /> {s.links.length}</span>)}
                  </div>
                }
                onClick={() => onOpen(s.id)} />
            );
          })}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((s) => {
            const songs = songsOf(s);
            return (
              <button key={s.id} type="button" onClick={() => onOpen(s.id)}
                onContextMenu={(e) => onContextMenu(e, s)}
                className="w-full text-left rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] hover:bg-[#1a1e21] transition-colors p-3 group">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-md bg-[#1e2327] flex items-center justify-center flex-shrink-0">
                    {s.icon ? <span className="text-lg leading-none">{s.icon}</span> : <Church size={15} className="text-blue-400" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <h4 className="text-sm font-medium text-gray-100 truncate">{sermonTitle(s)}</h4>
                      <span className="text-[10px] text-gray-500 flex-shrink-0">{fmtShort(s.date)}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[11px] text-gray-500 flex-wrap">
                      {s.speaker && (<span className="flex items-center gap-1 truncate"><User size={10} className="flex-shrink-0" />{s.speaker}</span>)}
                      {s.audioFile && (<span className="flex items-center gap-1 text-blue-400/80"><FileAudio size={10} /> Audio</span>)}
                      {s.images.length > 0 && (<span className="flex items-center gap-1"><ImageIcon size={10} /> {s.images.length}</span>)}
                      {songs.length > 0 && (<span className="flex items-center gap-1 text-purple-400/80"><ListMusic size={10} /> {songs.length}</span>)}
                      {s.links.length > 0 && (<span className="flex items-center gap-1"><LinkIcon size={10} /> {s.links.length}</span>)}
                    </div>
                    {s.notes.trim() && (
                      <p className="text-xs text-gray-400 mt-2 leading-relaxed line-clamp-2">{preview(s.notes)}</p>
                    )}
                  </div>
                  <ChevronLeft size={14} className="text-gray-600 group-hover:text-gray-400 rotate-180 flex-shrink-0 mt-1" />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PrayersList({ prayers, viewMode, onOpen, onCreate, onContextMenu }: {
  prayers: Prayer[]; viewMode: ViewMode;
  onOpen: (id: string) => void; onCreate: () => void;
  onContextMenu: ListContextHandler<Prayer>;
}) {
  const sorted = [...prayers].sort(byDateDesc);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter((p) => (p.title || "").toLowerCase().includes(query));
  }, [sorted, q]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-100">Prayer Journal</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {prayers.length} {prayers.length === 1 ? "prayer" : "prayers"} kept
          </p>
        </div>
        <button type="button" onClick={onCreate}
          className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium">
          <Plus size={13} /> <span>New Prayer</span>
        </button>
      </div>
      {prayers.length > 0 && (
        <div className="relative mb-4">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search prayers…"
            className="w-full bg-[#161a1d] border border-[#2a3136] rounded pl-9 pr-3 py-2 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500" />
        </div>
      )}
      {sorted.length === 0 ? (
        <EmptyCTA icon={HandHeart} title="No prayers yet"
          subtitle="Write freely — with / menu, images, video, and embeds."
          buttonLabel="Write your first prayer" onCreate={onCreate} />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-gray-500 italic text-center py-6">No matches for "{q}".</p>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((p) => (
            <GridCard key={p.id}
              scope={{ abbaDir: "", section: "prayers", noteId: p.id }}
              icon={p.icon}
              fallbackIcon={HandHeart} fallbackTint="#fb7185"
              title={prayerTitle(p)} dateText={fmtShort(p.date)}
              onContextMenu={(e) => onContextMenu(e, p)}
              meta={<TimeMeta created={p.created} modified={p.modified} />}
              onClick={() => onOpen(p.id)} />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((p) => (
            <button key={p.id} type="button" onClick={() => onOpen(p.id)}
              onContextMenu={(e) => onContextMenu(e, p)}
              className="w-full text-left rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] hover:bg-[#1a1e21] transition-colors p-3 group">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-md bg-[#1e2327] flex items-center justify-center flex-shrink-0">
                  {p.icon ? <span className="text-lg leading-none">{p.icon}</span> : <HandHeart size={15} className="text-rose-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <h4 className="text-sm font-medium text-gray-100 truncate">{prayerTitle(p)}</h4>
                    <span className="text-[10px] text-gray-500 flex-shrink-0">{fmtShort(p.date)}</span>
                  </div>
                  <div className="mt-2"><TimeMeta created={p.created} modified={p.modified} /></div>
                </div>
                <ChevronLeft size={14} className="text-gray-600 group-hover:text-gray-400 rotate-180 flex-shrink-0 mt-1" />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TestimoniesList({ testimonies, viewMode, onOpen, onCreate, onContextMenu }: {
  testimonies: Testimony[]; viewMode: ViewMode;
  onOpen: (id: string) => void; onCreate: () => void;
  onContextMenu: ListContextHandler<Testimony>;
}) {
  const sorted = [...testimonies].sort(byDateDesc);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter((t) => (t.title || "").toLowerCase().includes(query));
  }, [sorted, q]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-100">Testimonies</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {testimonies.length} {testimonies.length === 1 ? "testimony" : "testimonies"} kept
          </p>
        </div>
        <button type="button" onClick={onCreate}
          className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium">
          <Plus size={13} /> <span>New Testimony</span>
        </button>
      </div>
      {testimonies.length > 0 && (
        <div className="relative mb-4">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search testimonies…"
            className="w-full bg-[#161a1d] border border-[#2a3136] rounded pl-9 pr-3 py-2 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500" />
        </div>
      )}
      {sorted.length === 0 ? (
        <EmptyCTA icon={Heart} title="No testimonies yet"
          subtitle="Capture what God has done — with / menu, images, video, and embeds."
          buttonLabel="Add your first testimony" onCreate={onCreate} />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-gray-500 italic text-center py-6">No matches for "{q}".</p>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((t) => (
            <GridCard key={t.id}
              scope={{ abbaDir: "", section: "testimonies", noteId: t.id }}
              icon={t.icon}
              fallbackIcon={Heart} fallbackTint="#f472b6"
              title={testimonyTitle(t)} dateText={fmtShort(t.date)}
              onContextMenu={(e) => onContextMenu(e, t)}
              meta={<TimeMeta created={t.created} modified={t.modified} />}
              onClick={() => onOpen(t.id)} />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((t) => (
            <button key={t.id} type="button" onClick={() => onOpen(t.id)}
              onContextMenu={(e) => onContextMenu(e, t)}
              className="w-full text-left rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] hover:bg-[#1a1e21] transition-colors p-3 group">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-md bg-[#1e2327] flex items-center justify-center flex-shrink-0">
                  {t.icon ? <span className="text-lg leading-none">{t.icon}</span> : <Heart size={15} className="text-pink-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <h4 className="text-sm font-medium text-gray-100 truncate">{testimonyTitle(t)}</h4>
                    <span className="text-[10px] text-gray-500 flex-shrink-0">{fmtShort(t.date)}</span>
                  </div>
                  <div className="mt-2"><TimeMeta created={t.created} modified={t.modified} /></div>
                </div>
                <ChevronLeft size={14} className="text-gray-600 group-hover:text-gray-400 rotate-180 flex-shrink-0 mt-1" />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EventsList({ events, viewMode, onOpen, onCreate, onContextMenu }: {
  events: AbbaEvent[]; viewMode: ViewMode;
  onOpen: (id: string) => void; onCreate: () => void;
  onContextMenu: ListContextHandler<AbbaEvent>;
}) {
  const sorted = [...events].sort(byDateDesc);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter((e) =>
      [e.title, e.location, dateSearchString(e.date)].join(" ").toLowerCase().includes(query));
  }, [sorted, q]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-100">Events</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {events.length} {events.length === 1 ? "event" : "events"} recorded
          </p>
        </div>
        <button type="button" onClick={onCreate}
          className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium">
          <Plus size={13} /> <span>New Event</span>
        </button>
      </div>
      {events.length > 0 && (
        <div className="relative mb-4">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search by title, location, or date…"
            className="w-full bg-[#161a1d] border border-[#2a3136] rounded pl-9 pr-3 py-2 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500" />
        </div>
      )}
      {sorted.length === 0 ? (
        <EmptyCTA icon={Star} title="No events yet"
          subtitle="Record a baptism, communion service, retreat, or any gathering."
          buttonLabel="Add your first event" onCreate={onCreate} />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-gray-500 italic text-center py-6">No matches for "{q}".</p>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((e) => (
            <GridCard key={e.id}
              scope={{ abbaDir: "", section: "events", noteId: e.id }}
              icon={e.icon}
              fallbackIcon={Star} fallbackTint="#facc15"
              title={eventTitle(e)} dateText={fmtShort(e.date)}
              subtitle={e.location || undefined}
              subtitleIcon={e.location ? MapPin : undefined}
              subtitleTint="#fcd34d"
              onContextMenu={(ev) => onContextMenu(ev, e)}
              meta={
                <div className="flex items-center gap-3">
                  <TimeMeta created={e.created} modified={e.modified} />
                  {e.links.length > 0 && (
                    <span className="flex items-center gap-1 text-[10px] text-gray-500">
                      <LinkIcon size={10} /> {e.links.length}
                    </span>
                  )}
                </div>
              }
              onClick={() => onOpen(e.id)} />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((e) => (
            <button key={e.id} type="button" onClick={() => onOpen(e.id)}
              onContextMenu={(ev) => onContextMenu(ev, e)}
              className="w-full text-left rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] hover:bg-[#1a1e21] transition-colors p-3 group">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-md bg-[#1e2327] flex items-center justify-center flex-shrink-0">
                  {e.icon ? <span className="text-lg leading-none">{e.icon}</span> : <Star size={15} className="text-yellow-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <h4 className="text-sm font-medium text-gray-100 truncate">{eventTitle(e)}</h4>
                    <span className="text-[10px] text-gray-500 flex-shrink-0">{fmtShort(e.date)}</span>
                  </div>
                  {e.location.trim() && (
                    <div className="flex items-center gap-1 text-[11px] text-amber-300/90 mt-0.5 truncate">
                      <MapPin size={10} className="flex-shrink-0" /><span className="truncate">{e.location}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-3 mt-2">
                    <TimeMeta created={e.created} modified={e.modified} />
                    {e.links.length > 0 && (
                      <span className="flex items-center gap-1 text-[10px] text-gray-500">
                        <LinkIcon size={10} /> {e.links.length}
                      </span>
                    )}
                  </div>
                </div>
                <ChevronLeft size={14} className="text-gray-600 group-hover:text-gray-400 rotate-180 flex-shrink-0 mt-1" />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StudiesList({ studies, viewMode, onOpen, onCreate, onContextMenu }: {
  studies: Study[]; viewMode: ViewMode;
  onOpen: (id: string) => void; onCreate: () => void;
  onContextMenu: ListContextHandler<Study>;
}) {
  const sorted = [...studies].sort(byDateDesc);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter((s) =>
      [s.title, s.topic, dateSearchString(s.date)]
        .join(" ").toLowerCase().includes(query));
  }, [sorted, q]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-100">Bible Studies</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {studies.length} {studies.length === 1 ? "study" : "studies"}
          </p>
        </div>
        <button type="button" onClick={onCreate}
          className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium">
          <Plus size={13} /> <span>New Study</span>
        </button>
      </div>
      {studies.length > 0 && (
        <div className="relative mb-4">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search by title, topic, passage, or date…"
            className="w-full bg-[#161a1d] border border-[#2a3136] rounded pl-9 pr-3 py-2 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500" />
        </div>
      )}
      {sorted.length === 0 ? (
        <EmptyCTA icon={BookOpen} title="No studies yet"
          subtitle="Notes, topics, links, and photos all in one place."
          buttonLabel="Start your first study" onCreate={onCreate} />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-gray-500 italic text-center py-6">No matches for "{q}".</p>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((s) => (
            <GridCard key={s.id}
              scope={{ abbaDir: "", section: "studies", noteId: s.id }}
              icon={s.icon}
              fallbackIcon={BookOpen} fallbackTint="#fbbf24"
              title={studyTitle(s)} dateText={fmtShort(s.date)}
              subtitle={s.topic || undefined} subtitleTint="#fcd34d"
              onContextMenu={(e) => onContextMenu(e, s)}
              meta={
                <div className="flex items-center gap-3">
                  <TimeMeta created={s.created} modified={s.modified} />
                  {s.links.length > 0 && (
                    <span className="flex items-center gap-1 text-[10px] text-gray-500">
                      <LinkIcon size={10} /> {s.links.length}
                    </span>
                  )}
                </div>
              }
              onClick={() => onOpen(s.id)} />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((s) => (
            <button key={s.id} type="button" onClick={() => onOpen(s.id)}
              onContextMenu={(e) => onContextMenu(e, s)}
              className="w-full text-left rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] hover:bg-[#1a1e21] transition-colors p-3 group">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-md bg-[#1e2327] flex items-center justify-center flex-shrink-0">
                  {s.icon ? <span className="text-lg leading-none">{s.icon}</span> : <BookOpen size={15} className="text-amber-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <h4 className="text-sm font-medium text-gray-100 truncate">{studyTitle(s)}</h4>
                    <span className="text-[10px] text-gray-500 flex-shrink-0">{fmtShort(s.date)}</span>
                  </div>
                  {s.topic.trim() && (<div className="text-[11px] text-amber-300/90 mt-0.5 truncate">{s.topic}</div>)}
                  <div className="flex items-center gap-3 mt-2">
                    <TimeMeta created={s.created} modified={s.modified} />
                    {s.links.length > 0 && (
                      <span className="flex items-center gap-1 text-[10px] text-gray-500">
                        <LinkIcon size={10} /> {s.links.length}
                      </span>
                    )}
                  </div>
                </div>
                <ChevronLeft size={14} className="text-gray-600 group-hover:text-gray-400 rotate-180 flex-shrink-0 mt-1" />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  SermonDetail
// ═══════════════════════════════════════════════════════════════════════════
function SermonDetail({
  sermon, abbaDir, isEdit, onBack, onUpdate, onDelete,
  pickAudio, fetchLinkMeta,
}: {
  sermon: Sermon; abbaDir: string; isEdit: boolean;
  onBack: () => void; onUpdate: (patch: Partial<Sermon>) => void; onDelete: () => void;
  pickAudio: () => Promise<{ sourcePath: string; name: string } | null>;
  fetchLinkMeta: (url: string) => Promise<Partial<AbbaLink>>;
}) {
  const { mode, toggle, setMode } = useNoteMode();
  const [linkDraft, setLinkDraft] = useState("");
  const [savingLink, setSavingLink] = useState(false);
  const [songDraft, setSongDraft] = useState("");
  const songs = songsOf(sermon);

  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    if (mode === "read" && !sermon.title.trim() && !sermon.notes.trim() && !sermon.speaker.trim()) setMode("edit");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUploadAudio = async () => {
    const picked = await pickAudio();
    if (!picked) return;
    try {
      const { fileName, displayName } = await saveFileToAbbaNote(abbaDir, "sermons", sermon.id, picked.sourcePath, picked.name);
      if (sermon.audioFile) await deleteAbbaNoteAsset(abbaDir, "sermons", sermon.id, sermon.audioFile);
      onUpdate({ audioFile: fileName, audioName: displayName });
    } catch (e) { console.error("[abba] audio upload failed:", e); }
  };
  const removeAudio = async () => {
    if (sermon.audioFile) await deleteAbbaNoteAsset(abbaDir, "sermons", sermon.id, sermon.audioFile);
    onUpdate({ audioFile: null, audioName: null });
  };
  const addSong = () => {
    const trimmed = songDraft.trim(); if (!trimmed) return;
    onUpdate({ songs: [...songs, trimmed] }); setSongDraft("");
  };
  const removeSong = (idx: number) => onUpdate({ songs: songs.filter((_, i) => i !== idx) });
  const addLink = async () => {
    const url = normalizeUrl(linkDraft); if (!url) return;
    setSavingLink(true);
    const meta = await fetchLinkMeta(url);
    const l: AbbaLink = {
      id: newId("link"), url,
      title: meta.title || url, description: meta.description || "",
      icon: meta.icon || "", image: meta.image || "",
      created: nowIso(), modified: nowIso(),
    };
    onUpdate({ links: [...sermon.links, l] });
    setLinkDraft(""); setSavingLink(false);
  };
  const removeLink = (id: string) => onUpdate({ links: sermon.links.filter((l) => l.id !== id) });

  const dateValue = sermon.date ? sermon.date.slice(0, 10) : "";

  return (
    <div className="max-w-4xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-[#2a3136] gap-2">
        <button type="button" onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-100 transition-colors">
          <ChevronLeft size={14} /><span>All Sermons</span>
        </button>
        <div className="flex items-center gap-2">
          {isEdit && (
            <button type="button" onClick={onDelete}
              className="text-gray-500 hover:text-red-400 p-1.5 rounded transition-colors"
              title="Delete this sermon"><Trash2 size={14} /></button>
          )}
          <span className="text-[10px] uppercase tracking-wider text-gray-500">
            {mode === "edit" ? "Editing" : "Reading"}
          </span>
          <button type="button" onClick={toggle}
            className="flex items-center justify-center w-7 h-7 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer"
            title={mode === "edit" ? "Switch to read mode (Ctrl+E)" : "Switch to edit mode (Ctrl+E)"}>
            {mode === "edit" ? <BookOpen size={15} /> : <Pencil size={15} />}
          </button>
        </div>
      </div>

      <div className="flex justify-center mb-2">
        {sermon.icon ? (
          <span className="text-4xl leading-none select-none">{sermon.icon}</span>
        ) : null}
      </div>

      <StableField as="input" type="text" value={sermon.title}
        onChange={(v) => onUpdate({ title: v })} readOnly={!isEdit}
        placeholder="Untitled Sermon"
        className={`w-full bg-transparent border-none outline-none text-3xl font-bold tracking-tight px-2 py-1 rounded text-center placeholder-gray-700 ${
          isEdit ? "text-gray-100 focus:bg-white/5" : "text-gray-100 cursor-default"}`} />

      <div className="flex items-center justify-center gap-3 text-xs text-gray-500 mt-3 mb-8">
        {isEdit ? (
          <StableField as="input" type="text" value={sermon.speaker}
            onChange={(v) => onUpdate({ speaker: v })} placeholder="Speaker"
            className="bg-transparent border-none outline-none text-center text-xs text-gray-400 placeholder-gray-600 focus:text-gray-200"
            style={{ minWidth: "6rem", maxWidth: "12rem" }} />
        ) : sermon.speaker ? (<span className="text-gray-400">{sermon.speaker}</span>) : null}
        {(isEdit || sermon.speaker) && <span>•</span>}
        {isEdit ? (
          <input type="date" value={dateValue}
            onChange={(e) => onUpdate({ date: new Date(e.target.value + "T12:00:00").toISOString() })}
            className="bg-transparent border-none outline-none text-xs text-gray-400 focus:text-gray-200" />
        ) : (<span>{fmtDate(sermon.date)}</span>)}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {(sermon.notes.trim() || isEdit) && (
            <section className="rounded-lg border border-[#2a3136] bg-[#161a1d] p-4">
              <SectionLabel icon={BookMarked} label="Notes" />
              {isEdit ? (
                <StableField as="textarea" value={sermon.notes}
                  onChange={(v) => onUpdate({ notes: v })}
                  placeholder="Sermon notes, key verses, takeaways…" rows={12}
                  className="w-full bg-transparent border-none outline-none text-sm text-gray-200 leading-relaxed resize-y placeholder-gray-600 focus:outline-none"
                  style={{ minHeight: "12rem" }} />
              ) : (
                <div className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">{sermon.notes}</div>
              )}
            </section>
          )}
        </div>

        <div className="lg:col-span-1 space-y-4">
          {(songs.length > 0 || isEdit) && (
            <section className="rounded-lg border border-[#2a3136] bg-[#161a1d] p-4">
              <SectionLabel icon={ListMusic} label="Songs We Sang" />
              {songs.length > 0 && (
                <div className="space-y-1 mb-2">
                  {songs.map((song, idx) => (
                    <div key={`${song}-${idx}`}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-[#0f1315] border border-[#2a3136] group">
                      <ListMusic size={11} className="text-purple-400 flex-shrink-0" />
                      <span className="text-xs text-gray-200 truncate flex-1">{song}</span>
                      {isEdit && (
                        <button type="button" onClick={() => removeSong(idx)}
                          className="text-gray-500 hover:text-red-400 p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Remove song"><X size={11} /></button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {isEdit && (
                <div className="flex gap-1.5">
                  <input type="text" value={songDraft} onChange={(e) => setSongDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addSong(); }}
                    placeholder="Add a song…"
                    className="flex-1 min-w-0 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500" />
                  <button type="button" onClick={addSong} disabled={!songDraft.trim()}
                    className="flex items-center gap-1 px-2 py-1 text-xs bg-[#2a3136] hover:bg-[#30363d] disabled:opacity-40 border border-[#30363d] rounded text-gray-200 flex-shrink-0">
                    <Plus size={11} />
                  </button>
                </div>
              )}
            </section>
          )}
          {(sermon.audioFile || isEdit) && (
            <section className="rounded-lg border border-[#2a3136] bg-[#161a1d] p-4">
              <SectionLabel icon={FileAudio} label="Recording" />
              {sermon.audioFile ? (
                <>
                  <div className="flex items-center gap-2 bg-[#0f1315] border border-[#2a3136] rounded p-2 mb-2">
                    <Music size={13} className="text-blue-400 flex-shrink-0" />
                    <span className="text-xs text-gray-300 truncate flex-1">
                      {sermon.audioName || sermon.audioFile}
                    </span>
                    {isEdit && (
                      <>
                        <button type="button" onClick={handleUploadAudio}
                          className="text-gray-500 hover:text-gray-200 p-1" title="Replace audio">
                          <Upload size={12} /></button>
                        <button type="button" onClick={removeAudio}
                          className="text-gray-500 hover:text-red-400 p-1" title="Remove audio">
                          <X size={12} /></button>
                      </>
                    )}
                  </div>
                  <AudioPlayer abbaDir={abbaDir} section="sermons" noteId={sermon.id}
                    fileName={sermon.audioFile}
                    displayName={sermon.audioName || sermon.audioFile} />
                </>
              ) : (
                <button type="button" onClick={handleUploadAudio}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200">
                  <Upload size={12} /> Attach audio
                </button>
              )}
            </section>
          )}
          {(sermon.links.length > 0 || isEdit) && (
            <section className="rounded-lg border border-[#2a3136] bg-[#161a1d] p-4">
              <SectionLabel icon={LinkIcon} label="Links" />
              {sermon.links.length > 0 && (
                <div className="space-y-1.5 mb-2">
                  {sermon.links.map((l) => (
                    <AbbaLinkDisplay key={l.id} link={l} isEdit={isEdit}
                      onRemove={() => removeLink(l.id)} />
                  ))}
                </div>
              )}
              {isEdit && (
                <div className="flex gap-1.5">
                  <input type="text" value={linkDraft} onChange={(e) => setLinkDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addLink(); }}
                    placeholder="Paste a link and press Enter"
                    className="flex-1 min-w-0 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500" />
                  <button type="button" onClick={addLink} disabled={!linkDraft.trim() || savingLink}
                    className="flex items-center gap-1 px-2 py-1 text-xs bg-[#2a3136] hover:bg-[#30363d] disabled:opacity-40 border border-[#30363d] rounded text-gray-200 flex-shrink-0">
                    {savingLink ? "…" : <Plus size={11} />}
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
      <div className="h-16" />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Shared helpers
// ═══════════════════════════════════════════════════════════════════════════
function SectionLabel({ icon: Icon, label }: { icon: any; label: string }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5">
      <Icon size={10} /> {label}
    </div>
  );
}

function EmptyCTA({
  icon: Icon, title, subtitle, buttonLabel, onCreate,
}: {
  icon: any; title: string; subtitle: string; buttonLabel: string; onCreate: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-gray-500 mt-16 gap-4">
      <Icon size={40} className="opacity-30" />
      <div className="text-center">
        <p className="text-sm text-gray-400">{title}</p>
        <p className="text-xs text-gray-600 mt-1">{subtitle}</p>
      </div>
      <button type="button" onClick={onCreate}
        className="flex items-center gap-2 px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors cursor-pointer">
        <Plus size={14} /><span>{buttonLabel}</span>
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Links section (bookmark-only)
// ═══════════════════════════════════════════════════════════════════════════
function LinksSection({
  links, isEdit, onAdd, onUpdate, onRemove, fetchLinkMeta,
}: {
  links: AbbaLink[]; isEdit: boolean;
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<AbbaLink>) => void;
  onRemove: (l: AbbaLink) => void;
  fetchLinkMeta: (url: string) => Promise<Partial<AbbaLink>>;
}) {
  const { mode, toggle } = useNoteMode();

  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-4 gap-3">
        <div>
          <h3 className="text-base font-semibold text-gray-100">Saved Links</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {links.length} {links.length === 1 ? "link" : "links"}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {isEdit && (
            <button
              type="button"
              onClick={onAdd}
              className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium"
            >
              <Plus size={13} /><span>Add Link</span>
            </button>
          )}

          <span className="text-[10px] uppercase tracking-wider text-gray-500">
            {mode === "edit" ? "Editing" : "Reading"}
          </span>
          <button
            type="button"
            onClick={toggle}
            className="flex items-center justify-center w-7 h-7 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer"
            title={
              mode === "edit"
                ? "Switch to read mode (Ctrl+E)"
                : "Switch to edit mode (Ctrl+E)"
            }
          >
            {mode === "edit" ? <BookOpen size={15} /> : <Pencil size={15} />}
          </button>
        </div>
      </div>

      {links.length === 0 ? (
        isEdit ? (
          <EmptyCTA
            icon={LinkIcon}
            title="No links saved"
            subtitle="Add a sermon video, worship song, commentary, or resource."
            buttonLabel="Add your first link"
            onCreate={onAdd}
          />
        ) : (
          <div className="flex flex-col items-center justify-center text-gray-500 mt-16 gap-4">
            <LinkIcon size={40} className="opacity-30" />
            <div className="text-center">
              <p className="text-sm text-gray-400">No links saved</p>
              <p className="text-xs text-gray-600 mt-1">
                Switch to edit mode to add a link.
              </p>
            </div>
          </div>
        )
      ) : (
        <div className="space-y-3">
          {links.map((l) => (
            <LinkCard
              key={l.id}
              link={l}
              isEdit={isEdit}
              onUpdate={(patch) => onUpdate(l.id, patch)}
              onRemove={() => onRemove(l)}
              fetchLinkMeta={fetchLinkMeta}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LinkCard({
  link, isEdit, onUpdate, onRemove, fetchLinkMeta,
}: {
  link: AbbaLink; isEdit: boolean;
  onUpdate: (patch: Partial<AbbaLink>) => void;
  onRemove: () => void;
  fetchLinkMeta: (url: string) => Promise<Partial<AbbaLink>>;
}) {
  const [fetching, setFetching] = useState(false);
  const [iconError, setIconError] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [urlEditing, setUrlEditing] = useState(false);

  const refetch = async () => {
    if (!link.url) return;
    setFetching(true);
    const meta = await fetchLinkMeta(normalizeUrl(link.url));
    onUpdate({
      title: meta.title || link.title,
      description: meta.description || link.description,
      icon: meta.icon || link.icon,
      image: meta.image || link.image,
    });
    setFetching(false);
  };

  const open = () => {
    if (link.url) openUrl(normalizeUrl(link.url)).catch(console.error);
  };

  const handleUrlChange = (raw: string) => onUpdate({ url: raw });

  const handleUrlBlur = () => {
    const trimmed = normalizeUrl(link.url);
    if (trimmed !== link.url) onUpdate({ url: trimmed });
    if (link.url && (!link.title || link.title === link.url)) refetch();
  };

  const hostname = hostnameOf(link.url);

  return (
    <div className="rounded-lg border border-[#2a3136] bg-[#161a1d] overflow-hidden group hover:border-[#3a4147] transition-colors">
      <div className="flex">
        {/* Left: title, description, hostname */}
        <div className="flex-1 min-w-0 p-3">
          {/* Title + actions */}
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              {isEdit ? (
                <StableField
                  as="input"
                  type="text"
                  value={link.title}
                  onChange={(v) => onUpdate({ title: v })}
                  placeholder={hostname || "Untitled link"}
                  className="w-full bg-transparent border-none outline-none text-sm font-medium text-gray-100 placeholder-gray-500 focus:bg-white/5 px-1 py-0.5 rounded -mx-1"
                />
              ) : (
                <button
                  type="button"
                  onClick={open}
                  className="text-sm font-medium text-gray-100 hover:text-blue-300 truncate text-left block w-full"
                  title={link.url}
                >
                  {link.title || hostname || link.url || "Untitled link"}
                </button>
              )}
            </div>

            {isEdit && (
              <div className="flex items-center gap-0.5 flex-shrink-0 -mt-0.5 -mr-1">
                <button
                  type="button"
                  onClick={refetch}
                  disabled={fetching || !link.url}
                  className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-[#2a3136] transition-colors disabled:opacity-40"
                  title="Refresh metadata from URL"
                >
                  {fetching ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Save size={11} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={onRemove}
                  className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-[#2a3136] transition-colors"
                  title="Remove"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            )}
          </div>

          {/* Description */}
          {(isEdit || link.description) && (
            <div className="mt-1">
              {isEdit ? (
                <StableField
                  as="textarea"
                  value={link.description}
                  onChange={(v) => onUpdate({ description: v })}
                  placeholder="Add a description…"
                  rows={2}
                  className="w-full bg-transparent border-none outline-none text-xs text-gray-400 leading-relaxed resize-none placeholder-gray-600 focus:bg-white/5 px-1 py-0.5 rounded -mx-1"
                  style={{ minHeight: "2rem" }}
                />
              ) : (
                <div className="text-xs text-gray-400 leading-relaxed line-clamp-3">
                  {link.description}
                </div>
              )}
            </div>
          )}

          {/* Favicon + hostname line */}
          <div className="flex items-center gap-1.5 mt-2 min-w-0">
            {link.icon && !iconError ? (
              <img
                src={link.icon}
                alt=""
                className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
                onError={() => setIconError(true)}
              />
            ) : (
              <LinkIcon size={11} className="text-gray-500 flex-shrink-0" />
            )}

            {isEdit && urlEditing ? (
              <input
                autoFocus
                type="text"
                value={link.url}
                onChange={(e) => handleUrlChange(e.target.value)}
                onBlur={() => {
                  handleUrlBlur();
                  setUrlEditing(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (e.currentTarget as HTMLInputElement).blur();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setUrlEditing(false);
                  }
                }}
                placeholder="https://…"
                className="flex-1 min-w-0 bg-[#0f1315] border border-[#30363d] rounded px-2 py-0.5 text-[11px] text-gray-200 outline-none focus:ring-1 focus:ring-blue-500 font-mono"
              />
            ) : isEdit ? (
              <button
                type="button"
                onClick={() => setUrlEditing(true)}
                className="text-[11px] text-gray-500 hover:text-blue-400 truncate min-w-0 text-left"
                title="Click to edit URL"
              >
                {hostname || link.url || "Add URL…"}
              </button>
            ) : (
              <button
                type="button"
                onClick={open}
                className="text-[11px] text-gray-500 hover:text-blue-400 truncate min-w-0 text-left"
                title={link.url}
              >
                {hostname || link.url}
              </button>
            )}

            {isEdit && !urlEditing && link.url && (
              <button
                type="button"
                onClick={open}
                className="text-gray-500 hover:text-gray-200 p-0.5 flex-shrink-0"
                title="Open in browser"
              >
                <ExternalLink size={10} />
              </button>
            )}
          </div>
        </div>

        {/* Right: preview image from URL metadata */}
        {link.image && !imageError && (
          <div className="w-32 sm:w-40 flex-shrink-0 bg-[#0f1315] flex items-center justify-center overflow-hidden">
            <img
              src={link.image}
              alt=""
              className="w-full h-full object-cover"
              onError={() => setImageError(true)}
            />
          </div>
        )}
      </div>

      {/* Footer: timestamps */}
      {(link.created || link.modified) && (
        <div className="px-3 py-1.5 border-t border-[#2a3136] bg-[#1a1e21]">
          <TimeMeta created={link.created} modified={link.modified} />
        </div>
      )}
    </div>
  );
}
