// src/AbbaView.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  readTextFile, writeTextFile, mkdir, readDir,
  exists as fsExists, rename as fsRename,
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
  Search, Clock, Calendar, Maximize2, ZoomIn, ZoomOut,
  Sparkles, Loader2, AlertTriangle, Star, MapPin,
  List as ListIcon, LayoutGrid,
} from "lucide-react";
import { useModal } from "./Modal";
import { useNoteMode } from "./useNoteMode";
import AudioPlayer from "./AudioPlayer";
import {
  saveFileToAbbaNote, deleteAbbaNoteAsset, deleteAbbaNoteAssetsFolder,
  loadAbbaNoteAssetBlob, abbaNoteAssetSize, migrateLegacyAssetToNote,
} from "./abbaAssets";
import { parseNoteFile } from "./noteFormat";
import { moveToTrash } from "./trash";

// ─── Sections ───────────────────────────────────────────────────────────────
type AbbaSection =
  | "sermons"
  | "prayers"
  | "testimonies"
  | "studies"
  | "events"
  | "links";

const SECTION_DIR: Record<AbbaSection, string> = {
  sermons: "sermons",
  prayers: "prayers",
  testimonies: "testimonies",
  studies: "studies",
  events: "events",
  links: "links",
};

function baseNameForSection(section: AbbaSection): string {
  switch (section) {
    case "sermons":     return "sermon";
    case "prayers":     return "prayer";
    case "testimonies": return "testimony";
    case "studies":     return "study";
    case "events":      return "event";
    case "links":       return "link";
  }
}

const BODY_FIELD: Record<AbbaSection, string | null> = {
  sermons: "notes",
  prayers: "body",
  testimonies: "body",
  studies: "notes",
  events: "description",
  links: null,
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

// ─── Filename derivation ────────────────────────────────────────────────────
function slugifyForFilename(title: string): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function desiredFileName(section: AbbaSection, entry: any): string {
  const prefix = baseNameForSection(section);
  const slug = slugifyForFilename(entry.title || "");
  if (slug) return `${prefix}-${slug}`;
  return entry.id || `${prefix}-untitled`;
}

// ─── Serialize / parse ──────────────────────────────────────────────────────
function encodeFmValue(v: any): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") {
    const risky =
      v === "true" || v === "false" ||
      /^-?\d+(\.\d+)?$/.test(v) ||
      (v.startsWith("[") && v.endsWith("]")) ||
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"));
    if (risky) return `json:${JSON.stringify(v)}`;
    return v.replace(/\r?\n/g, " ");
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `json:${JSON.stringify(v)}`;
}

function decodeFmValue(v: any): any {
  if (typeof v === "string" && v.startsWith("json:")) {
    try {
      return JSON.parse(v.slice(5));
    } catch {
      return v.slice(5);
    }
  }
  return v;
}

function serializeAbbaNote(section: AbbaSection, entry: any): string {
  const bodyField = BODY_FIELD[section];
  const body = bodyField ? String(entry[bodyField] || "") : "";

  const lines: string[] = [];
  for (const [k, v] of Object.entries(entry)) {
    if (k.startsWith("_")) continue;
    if (bodyField && k === bodyField) continue;
    if (v === undefined || v === null) continue;
    const encoded = encodeFmValue(v);
    if (encoded === "") continue;
    lines.push(`${k}: ${encoded}`);
  }
  const fmBlock = lines.length ? `---\n${lines.join("\n")}\n---\n\n` : "";
  return `${fmBlock}${body.trimEnd()}\n`;
}

function parseAbbaNote(section: AbbaSection, raw: string): any {
  const { frontmatter, body } = parseNoteFile(raw);
  const out: any = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    out[k] = decodeFmValue(v);
  }
  const bodyField = BODY_FIELD[section];
  if (bodyField) out[bodyField] = body.replace(/\s+$/, "");
  return out;
}

// ─── Storage ops ────────────────────────────────────────────────────────────
type WithFile<T> = T & { _fileName?: string };

async function readSection<T extends { id: string }>(
  abbaDir: string,
  section: AbbaSection
): Promise<WithFile<T>[]> {
  const dir = sectionDir(abbaDir, section);
  let entries: any[] = [];
  try {
    entries = await readDir(dir);
  } catch {
    return [];
  }
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
      window.dispatchEvent(
        new CustomEvent("abba-read-error", {
          detail: { section, count: failures, total: entries.length },
        })
      );
    } catch {}
  }
  return out;
}

async function writeSectionNote(
  abbaDir: string,
  section: AbbaSection,
  entry: any
): Promise<void> {
  const dir = sectionDir(abbaDir, section);
  await mkdir(dir, { recursive: true });

  const desired = desiredFileName(section, entry);
  const current: string = entry._fileName || "";

  let final = desired;
  if (current !== final) {
    let n = 1;
    while (await fsExists(subPath(dir, `${final}.selah`))) {
      final = `${desired}-${n++}`;
      if (n > 500) {
        final = `${desired}-${Date.now()}`;
        break;
      }
    }
  }

  if (current && current !== final) {
    const oldPath = subPath(dir, `${current}.selah`);
    try {
      if (await fsExists(oldPath)) await moveToTrash(oldPath);
    } catch (e) {
      console.warn("[abba] could not trash old note file:", current, e);
    }
  }

  const finalPath = subPath(dir, `${final}.selah`);
  await writeTextFile(finalPath, serializeAbbaNote(section, entry));
  entry._fileName = final;
}

async function deleteSectionNote(
  abbaDir: string,
  section: AbbaSection,
  entry: { id: string; _fileName?: string }
): Promise<void> {
  const dir = sectionDir(abbaDir, section);
  const name = entry._fileName || entry.id;
  const file = subPath(dir, `${name}.selah`);
  try {
    if (await fsExists(file)) await moveToTrash(file);
  } catch {}
}

async function migrateEntryFileName(
  abbaDir: string,
  section: AbbaSection,
  entry: any
): Promise<void> {
  const desired = desiredFileName(section, entry);
  const current: string = entry._fileName || "";
  if (!current || current === desired) return;

  const dir = sectionDir(abbaDir, section);
  const currentPath = subPath(dir, `${current}.selah`);
  if (!(await fsExists(currentPath))) {
    entry._fileName = desired;
    return;
  }

  let final = desired;
  let n = 1;
  while (await fsExists(subPath(dir, `${final}.selah`))) {
    final = `${desired}-${n++}`;
    if (n > 500) {
      final = `${desired}-${Date.now()}`;
      break;
    }
  }

  try {
    await fsRename(currentPath, subPath(dir, `${final}.selah`));
    entry._fileName = final;
  } catch (e) {
    console.warn("[abba] migration rename failed:", current, "→", final, e);
  }
}

/**
 * Migrate old `<section>.json` arrays into `<section>/<id>.selah` files.
 */
async function migrateJsonIfNeeded(abbaDir: string): Promise<void> {
  const specs: [string, AbbaSection][] = [
    ["sermons.json", "sermons"],
    ["prayers.json", "prayers"],
    ["testimonies.json", "testimonies"],
    ["studies.json", "studies"],
    ["events.json", "events"],
    ["links.json", "links"],
  ];

  for (const [jsonName, section] of specs) {
    const jsonPath = subPath(abbaDir, jsonName);
    let raw: string;
    try {
      raw = await readTextFile(jsonPath);
    } catch {
      continue;
    }

    let entries: any[];
    try {
      entries = JSON.parse(raw);
      if (!Array.isArray(entries)) continue;
    } catch {
      continue;
    }
    if (entries.length === 0) {
      try { await moveToTrash(jsonPath); } catch {}
      continue;
    }

    const dir = sectionDir(abbaDir, section);
    await mkdir(dir, { recursive: true });

    const existingIds = new Set<string>();
    try {
      const existing = await readDir(dir);
      for (const e of existing) {
        if (!e.name || !e.name.endsWith(".selah")) continue;
        try {
          const parsed = parseAbbaNote(
            section,
            await readTextFile(await join(dir, e.name))
          );
          if (parsed.id) existingIds.add(String(parsed.id));
        } catch {}
      }
    } catch {}

    console.log(`[abba] migrating ${entries.length} ${section} from JSON → .selah`);
    let allMigrated = true;

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (!entry.id) {
        entry.id = `${section.slice(0, -1)}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      }
      if (existingIds.has(String(entry.id))) continue;

      const files: string[] = [];
      if (Array.isArray(entry.images)) files.push(...entry.images);
      if (typeof entry.audioFile === "string" && entry.audioFile) {
        files.push(entry.audioFile);
      }
      for (const fileName of files) {
        if (!fileName) continue;
        await migrateLegacyAssetToNote(abbaDir, section, entry.id, fileName);
      }

      try {
        await writeSectionNote(abbaDir, section, entry);
        existingIds.add(String(entry.id));
      } catch (e) {
        console.error("[abba] could not write migrated note:", entry.id, e);
        allMigrated = false;
      }
    }

    if (allMigrated) {
      try {
        await moveToTrash(jsonPath);
        console.log(`[abba] retired legacy ${jsonName}`);
      } catch (e) {
        console.warn("[abba] could not retire legacy JSON:", e);
      }
    } else {
      console.warn(`[abba] leaving ${jsonName} in place — some entries failed to migrate`);
    }
  }
}

// ─── Error boundary ─────────────────────────────────────────────────────────
class AbbaErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[abba] render error:", error);
    console.error("[abba] component stack:", info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="w-full h-full flex items-center justify-center p-6 bg-[#0f1315]">
          <div className="max-w-lg text-center">
            <p className="text-sm text-gray-300 mb-3">
              Something went wrong rendering this section.
            </p>
            <pre className="text-[11px] text-red-400 bg-[#161a1d] border border-[#2a3136] rounded p-3 text-left overflow-auto max-h-48 whitespace-pre-wrap break-words">
              {this.state.error.message}
            </pre>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="mt-4 px-3 py-1.5 text-xs bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200"
            >
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
  scope,
  fileName,
  className,
  alt,
}: {
  scope: AbbaScope;
  fileName: string;
  className?: string;
  alt?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    loadAbbaNoteAssetBlob(
      scope.abbaDir,
      scope.section,
      scope.noteId,
      fileName
    ).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [scope.abbaDir, scope.section, scope.noteId, fileName]);

  if (!url) {
    return (
      <div
        className={
          className
            ? `${className} bg-[#0f1315] animate-pulse`
            : "bg-[#0f1315]"
        }
      />
    );
  }
  return <img src={url} alt={alt || ""} className={className} />;
}

// ─── Lightbox ───────────────────────────────────────────────────────────────
function Lightbox({
  scope,
  images,
  index,
  onClose,
  onIndexChange,
}: {
  scope: AbbaScope;
  images: string[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    startX: number;
    startY: number;
    panX: number;
    panY: number;
    moved: boolean;
  } | null>(null);

  const current = images[index];

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    if (!current) return;
    loadAbbaNoteAssetBlob(scope.abbaDir, scope.section, scope.noteId, current).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [scope.abbaDir, scope.section, scope.noteId, current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      else if (e.key === "ArrowRight" && index < images.length - 1)
        onIndexChange(index + 1);
      else if (e.key === "+" || e.key === "=") {
        setZoom((z) => Math.min(z * 1.25, 8));
      } else if (e.key === "-") {
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
  }, [index, images.length, onClose, onIndexChange]);

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
      startX: e.clientX,
      startY: e.clientY,
      panX: pan.x,
      panY: pan.y,
      moved: false,
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
    const up = () => {
      dragRef.current = null;
    };
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

      {images.length > 1 && (
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
            onClick={(e) => { e.stopPropagation(); if (index < images.length - 1) onIndexChange(index + 1); }}
            disabled={index === images.length - 1}
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
        style={{
          cursor: zoom > 1 ? (dragRef.current ? "grabbing" : "grab") : "zoom-in",
        }}
      >
        {url ? (
          <img
            src={url}
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
        ) : (
          <div className="w-96 h-96 bg-[#161a1d] rounded animate-pulse" />
        )}
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
  id: string;
  url: string;
  title: string;
  description: string;
  icon: string;
  image: string;
  created?: string;
  modified?: string;
  _fileName?: string;
}

interface Sermon {
  id: string;
  date: string;
  title: string;
  speaker: string;
  notes: string;
  songs?: string[];
  audioFile: string | null;
  audioName: string | null;
  images: string[];
  links: AbbaLink[];
  _fileName?: string;
}

interface Prayer {
  id: string;
  date: string;
  title: string;
  body: string;
  created?: string;
  modified?: string;
  _fileName?: string;
}

interface Testimony {
  id: string;
  date: string;
  title: string;
  body: string;
  images: string[];
  created?: string;
  modified?: string;
  _fileName?: string;
}

interface Study {
  id: string;
  date: string;
  title: string;
  topic: string;
  notes: string;
  links: AbbaLink[];
  images: string[];
  created?: string;
  modified?: string;
  _fileName?: string;
}

interface AbbaEvent {
  id: string;
  date: string;
  title: string;
  location: string;
  description: string;
  images: string[];
  links: AbbaLink[];
  created?: string;
  modified?: string;
  _fileName?: string;
}

type Tab = "sermons" | "prayer" | "testimonies" | "events" | "studies" | "links";
type ViewMode = "list" | "grid";

interface AbbaViewProps {
  abbaDir: string;
  name: string;
  icon?: string;
}

// ─── Utilities ──────────────────────────────────────────────────────────────
const AUDIO_EXT = ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus", "webm"];
const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg"];
const VIEW_MODE_KEY = "abba-view-mode";

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
function nowIso(): string { return new Date().toISOString(); }

function todayLocalInput(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

function songsOf(s: Sermon): string[] {
  return Array.isArray(s.songs) ? s.songs : [];
}

// ─── Grid card ──────────────────────────────────────────────────────────────
function GridCard({
  scope,
  image,
  fallbackIcon: FallbackIcon,
  fallbackTint,
  title,
  dateText,
  subtitle,
  subtitleIcon: SubtitleIcon,
  subtitleTint,
  previewText,
  meta,
  onClick,
}: {
  scope: AbbaScope;
  image?: string;
  fallbackIcon: any;
  fallbackTint: string;
  title: string;
  dateText: string;
  subtitle?: string;
  subtitleIcon?: any;
  subtitleTint?: string;
  previewText?: string;
  meta?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group text-left rounded-lg overflow-hidden bg-[#161a1d] border border-[#2a3136] hover:border-[#3a4147] transition-colors flex flex-col"
    >
      <div className="w-full h-40 bg-[#0f1315] overflow-hidden relative flex items-center justify-center">
        {image ? (
          <AbImage
            scope={scope}
            fileName={image}
            className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{ background: `radial-gradient(circle at center, ${fallbackTint}22 0%, transparent 70%)` }}
          >
            <FallbackIcon size={32} style={{ color: fallbackTint, opacity: 0.6 }} />
          </div>
        )}
      </div>
      <div className="p-3 flex-1 flex flex-col min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="text-sm font-medium text-gray-100 truncate">{title}</h4>
          <span className="text-[10px] text-gray-500 flex-shrink-0">{dateText}</span>
        </div>
        {subtitle && (
          <div
            className="flex items-center gap-1 text-[11px] mt-0.5 truncate"
            style={{ color: subtitleTint || "#9ca3af" }}
          >
            {SubtitleIcon && <SubtitleIcon size={10} className="flex-shrink-0" />}
            <span className="truncate">{subtitle}</span>
          </div>
        )}
        {previewText ? (
          <p className="text-xs text-gray-400 mt-2 leading-relaxed line-clamp-3 flex-1">
            {previewText}
          </p>
        ) : (
          <div className="flex-1" />
        )}
        {meta && <div className="mt-2">{meta}</div>}
      </div>
    </button>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────
export default function AbbaView({ abbaDir, name, icon }: AbbaViewProps) {
  const [tab, setTab] = useState<Tab>("sermons");
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

  const [readErrors, setReadErrors] = useState<
    { section: string; count: number; total: number }[]
  >([]);

  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [optimizePhase, setOptimizePhase] = useState<
    "scanning" | "results" | "deleting" | "done" | "error"
  >("scanning");
  const [optimizeUnused, setOptimizeUnused] = useState<
    { file: string; size: number }[]
  >([]);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const [optimizeDeletedCount, setOptimizeDeletedCount] = useState(0);

  const writeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const sermonsRef = useRef<Sermon[]>([]);
  const prayersRef = useRef<Prayer[]>([]);
  const testimoniesRef = useRef<Testimony[]>([]);
  const studiesRef = useRef<Study[]>([]);
  const eventsRef = useRef<AbbaEvent[]>([]);
  const linksRef = useRef<AbbaLink[]>([]);
  useEffect(() => { sermonsRef.current = sermons; }, [sermons]);
  useEffect(() => { prayersRef.current = prayers; }, [prayers]);
  useEffect(() => { testimoniesRef.current = testimonies; }, [testimonies]);
  useEffect(() => { studiesRef.current = studies; }, [studies]);
  useEffect(() => { eventsRef.current = events; }, [events]);
  useEffect(() => { linksRef.current = links; }, [links]);

  const listForSection = (section: AbbaSection): any[] => {
    switch (section) {
      case "sermons":     return sermonsRef.current;
      case "prayers":     return prayersRef.current;
      case "testimonies": return testimoniesRef.current;
      case "studies":     return studiesRef.current;
      case "events":      return eventsRef.current;
      case "links":       return linksRef.current;
    }
  };

  const queueWrite = (section: AbbaSection, entry: any) => {
    const key = `${section}:${entry.id}`;
    const existing = writeTimers.current.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(async () => {
      try {
        await writeSectionNote(abbaDir, section, entry);
      } catch (e) {
        console.error("[abba] write failed:", key, e);
      }
      writeTimers.current.delete(key);
    }, 350);
    writeTimers.current.set(key, t);
  };

  const cancelWrite = (section: AbbaSection, id: string) => {
    const key = `${section}:${id}`;
    const t = writeTimers.current.get(key);
    if (t) {
      clearTimeout(t);
      writeTimers.current.delete(key);
    }
  };

  useEffect(() => {
    return () => {
      for (const [key, t] of Array.from(writeTimers.current.entries())) {
        clearTimeout(t);
        const [section, id] = key.split(":");
        const list = listForSection(section as AbbaSection);
        const entry = list.find((x: any) => x.id === id);
        if (entry) {
          writeSectionNote(abbaDir, section as AbbaSection, entry).catch((e) =>
            console.error("[abba] flush on unmount failed:", key, e)
          );
        }
      }
      writeTimers.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abbaDir]);

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

      try {
        await migrateJsonIfNeeded(abbaDir);
      } catch (e) {
        console.error("[abba] json migration failed:", e);
      }

      const [se, pr, te, st, ev, li] = await Promise.all([
        readSection<Sermon>(abbaDir, "sermons"),
        readSection<Prayer>(abbaDir, "prayers"),
        readSection<Testimony>(abbaDir, "testimonies"),
        readSection<Study>(abbaDir, "studies"),
        readSection<AbbaEvent>(abbaDir, "events"),
        readSection<AbbaLink>(abbaDir, "links"),
      ]);

      const migrationSpecs: [AbbaSection, WithFile<any>[]][] = [
        ["sermons", se], ["prayers", pr], ["testimonies", te],
        ["studies", st], ["events", ev], ["links", li],
      ];
      for (const [section, list] of migrationSpecs) {
        for (const entry of list) {
          try {
            await migrateEntryFileName(abbaDir, section, entry);
          } catch (e) {
            console.warn("[abba] filename migration failed:", section, entry.id, e);
          }
        }
      }

      if (!mounted) return;
      setSermons(se.map((x) => ({
        ...x,
        title: x.title ?? "",
        speaker: x.speaker ?? "",
        notes: x.notes ?? "",
        songs: Array.isArray(x.songs) ? x.songs : [],
        images: Array.isArray(x.images) ? x.images : [],
        links: Array.isArray(x.links) ? x.links : [],
        audioFile: x.audioFile ?? null,
        audioName: x.audioName ?? null,
      })));
      setPrayers(pr.map((x) => ({
        ...x,
        title: x.title ?? "",
        body: x.body ?? "",
      })));
      setTestimonies(te.map((x) => ({
        ...x,
        title: x.title ?? "",
        body: x.body ?? "",
        images: Array.isArray(x.images) ? x.images : [],
      })));
      setStudies(st.map((x) => ({
        ...x,
        title: x.title ?? "",
        topic: x.topic ?? "",
        notes: x.notes ?? "",
        images: Array.isArray(x.images) ? x.images : [],
        links: Array.isArray(x.links) ? x.links : [],
      })));
      setEvents(ev.map((x) => ({
        ...x,
        title: x.title ?? "",
        location: x.location ?? "",
        description: x.description ?? "",
        images: Array.isArray(x.images) ? x.images : [],
        links: Array.isArray(x.links) ? x.links : [],
      })));
      setLinks(li.map((x) => ({
        ...x,
        url: x.url ?? "",
        title: x.title ?? "",
        description: x.description ?? "",
        icon: x.icon ?? "",
        image: x.image ?? "",
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
    section: AbbaSection,
    prev: T[],
    next: T[],
    setter: (v: T[]) => void
  ) {
    setter(next);
    const prevById = new Map(prev.map((x) => [x.id, x]));
    const nextById = new Map(next.map((x) => [x.id, x]));
    for (const [id, prevEntry] of prevById) {
      if (!nextById.has(id)) {
        cancelWrite(section, id);
        deleteSectionNote(abbaDir, section, prevEntry as any);
        deleteAbbaNoteAssetsFolder(abbaDir, section, id);
      }
    }
    for (const [id, entry] of nextById) {
      const before = prevById.get(id);
      if (!before || JSON.stringify(before) !== JSON.stringify(entry)) {
        queueWrite(section, entry);
      }
    }
  }

  const commitSermons = (next: Sermon[]) =>
    diffAndWrite<Sermon>("sermons", sermons, next, setSermons);
  const commitPrayers = (next: Prayer[]) =>
    diffAndWrite<Prayer>("prayers", prayers, next, setPrayers);
  const commitTestimonies = (next: Testimony[]) =>
    diffAndWrite<Testimony>("testimonies", testimonies, next, setTestimonies);
  const commitStudies = (next: Study[]) =>
    diffAndWrite<Study>("studies", studies, next, setStudies);
  const commitEvents = (next: AbbaEvent[]) =>
    diffAndWrite<AbbaEvent>("events", events, next, setEvents);
  const commitLinks = (next: AbbaLink[]) =>
    diffAndWrite<AbbaLink>("links", links, next, setLinks);

  const pickAudio = async (): Promise<{ sourcePath: string; name: string } | null> => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Audio", extensions: AUDIO_EXT }],
    });
    if (!picked || typeof picked !== "string") return null;
    const name = picked.split(/[/\\]/).pop() || "audio";
    return { sourcePath: picked, name };
  };

  const pickImages = async (): Promise<string[]> => {
    const picked = await open({
      multiple: true,
      filters: [{ name: "Image", extensions: IMAGE_EXT }],
    });
    if (!picked) return [];
    const arr = Array.isArray(picked) ? picked : [picked];
    return arr.filter((p): p is string => typeof p === "string");
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

  const promptNewSermon = () => setNewSermonDate(todayLocalInput());

  const confirmNewSermon = () => {
    if (!newSermonDate) return;
    const iso = new Date(`${newSermonDate}T12:00:00`).toISOString();
    const s: Sermon = {
      id: newId("sermon"),
      date: iso,
      title: "",
      speaker: "",
      notes: "",
      songs: [],
      audioFile: null,
      audioName: null,
      images: [],
      links: [],
    };
    commitSermons([s, ...sermons]);
    setNewSermonDate(null);
    setOpenSermonId(s.id);
  };

  const updateSermon = (id: string, patch: Partial<Sermon>) =>
    commitSermons(sermons.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const deleteSermon = async (s: Sermon) => {
    const ok = await confirmAsync(
      `Delete "${sermonTitle(s)}"? This moves audio and photos to the trash.`
    );
    if (!ok) return;
    commitSermons(sermons.filter((x) => x.id !== s.id));
    if (openSermonId === s.id) setOpenSermonId(null);
  };

  const createPrayer = () => {
    const now = nowIso();
    const p: Prayer = { id: newId("prayer"), date: now, title: "", body: "", created: now, modified: now };
    commitPrayers([p, ...prayers]);
    setOpenPrayerId(p.id);
  };
  const updatePrayer = (id: string, patch: Partial<Prayer>) =>
    commitPrayers(prayers.map((p) =>
      p.id === id ? { ...p, ...patch, modified: nowIso() } : p
    ));
  const deletePrayer = async (p: Prayer) => {
    const ok = await confirmAsync(`Delete "${p.title || "this prayer"}"?`);
    if (!ok) return;
    commitPrayers(prayers.filter((x) => x.id !== p.id));
    if (openPrayerId === p.id) setOpenPrayerId(null);
  };

  const createTestimony = () => {
    const now = nowIso();
    const t: Testimony = {
      id: newId("testimony"), date: now, title: "", body: "",
      images: [], created: now, modified: now,
    };
    commitTestimonies([t, ...testimonies]);
    setOpenTestimonyId(t.id);
  };
  const updateTestimony = (id: string, patch: Partial<Testimony>) =>
    commitTestimonies(testimonies.map((t) =>
      t.id === id ? { ...t, ...patch, modified: nowIso() } : t
    ));
  const deleteTestimony = async (t: Testimony) => {
    const ok = await confirmAsync(`Delete "${t.title || "this testimony"}"?`);
    if (!ok) return;
    commitTestimonies(testimonies.filter((x) => x.id !== t.id));
    if (openTestimonyId === t.id) setOpenTestimonyId(null);
  };

  const createStudy = () => {
    const now = nowIso();
    const s: Study = {
      id: newId("study"), date: now, title: "", topic: "", notes: "",
      links: [], images: [], created: now, modified: now,
    };
    commitStudies([s, ...studies]);
    setOpenStudyId(s.id);
  };
  const updateStudy = (id: string, patch: Partial<Study>) =>
    commitStudies(studies.map((s) =>
      s.id === id ? { ...s, ...patch, modified: nowIso() } : s
    ));
  const deleteStudy = async (s: Study) => {
    const ok = await confirmAsync(`Delete "${s.title || "this study"}"?`);
    if (!ok) return;
    commitStudies(studies.filter((x) => x.id !== s.id));
    if (openStudyId === s.id) setOpenStudyId(null);
  };

  const createEvent = () => {
    const now = nowIso();
    const e: AbbaEvent = {
      id: newId("event"), date: now, title: "", location: "",
      description: "", images: [], links: [], created: now, modified: now,
    };
    commitEvents([e, ...events]);
    setOpenEventId(e.id);
  };
  const updateEvent = (id: string, patch: Partial<AbbaEvent>) =>
    commitEvents(events.map((e) =>
      e.id === id ? { ...e, ...patch, modified: nowIso() } : e
    ));
  const deleteEvent = async (e: AbbaEvent) => {
    const ok = await confirmAsync(
      `Delete "${e.title || "this event"}"? This moves its photos to the trash.`
    );
    if (!ok) return;
    commitEvents(events.filter((x) => x.id !== e.id));
    if (openEventId === e.id) setOpenEventId(null);
  };

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
      l.id === id ? { ...l, ...patch, modified: nowIso() } : l
    ));
  const deleteLink = async (l: AbbaLink) => {
    const ok = await confirmAsync(`Remove this link?`);
    if (!ok) return;
    commitLinks(links.filter((x) => x.id !== l.id));
  };

  const handleTabChange = (next: Tab) => {
    if (next !== tab) {
      setOpenSermonId(null);
      setOpenPrayerId(null);
      setOpenTestimonyId(null);
      setOpenStudyId(null);
      setOpenEventId(null);
      setLightbox(null);
    }
    setTab(next);
  };

  const openOptimizer = async () => {
    setOptimizeOpen(true);
    setOptimizePhase("scanning");
    setOptimizeError(null);
    setOptimizeUnused([]);
    setOptimizeDeletedCount(0);

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

      setOptimizeUnused(unused);
      setOptimizePhase("results");
    } catch (e: any) {
      console.error("[abba] scan failed:", e);
      setOptimizeError(e?.message ?? String(e));
      setOptimizePhase("error");
    }
  };

  const deleteAllUnused = async () => {
    setOptimizePhase("deleting");
    let count = 0;
    for (const { file } of optimizeUnused) {
      try {
        const full = subPath(abbaDir, "assets", file);
        if (full) { await moveToTrash(full); count++; }
      } catch (e) {
        console.error("[abba] could not delete:", file, e);
      }
    }
    setOptimizeDeletedCount(count);
    setOptimizeUnused([]);
    setOptimizePhase("done");
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

  const openLightbox = (scope: AbbaScope, images: string[], index = 0) => {
    setLightbox({ scope, images, index });
  };

  const totalUnusedBytes = optimizeUnused.reduce((sum, u) => sum + u.size, 0);

  return (
    <AbbaErrorBoundary>
      <div className="w-full h-full flex flex-col bg-[#0f1315] overflow-hidden">
        {modal}

        {lightbox && (
          <Lightbox
            scope={lightbox.scope}
            images={lightbox.images}
            index={lightbox.index}
            onClose={() => setLightbox(null)}
            onIndexChange={(i) =>
              setLightbox((prev) => (prev ? { ...prev, index: i } : null))
            }
          />
        )}

        {readErrors.length > 0 && (
          <div className="flex-shrink-0 mx-4 mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-300 flex items-start gap-2">
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-medium">
                Some entries couldn't be read
              </div>
              <div className="text-amber-400/70 mt-0.5">
                {readErrors.map((r) => `${r.section}: ${r.count}/${r.total}`).join(" · ")}
                {" — the files may be corrupt."}
              </div>
            </div>
            <button
              onClick={() => setReadErrors([])}
              className="text-amber-400/70 hover:text-amber-300 p-0.5"
              title="Dismiss"
            >
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
            <button
              type="button"
              onClick={openOptimizer}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-[#2a3136] text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors text-xs font-medium"
              title="Find and delete leftover files in assets/"
            >
              <Sparkles size={12} />
              <span>Clean up</span>
            </button>
          </div>
        </div>

        <div className="flex items-center px-4 pt-2 pb-0 border-b border-[#2a3136] flex-shrink-0 gap-2">
          <div className="flex items-center gap-1 overflow-x-auto flex-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => handleTabChange(t.id)}
                  className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t transition-colors whitespace-nowrap ${
                    active
                      ? "text-gray-100 bg-[#161a1d] border-b-2 border-blue-500"
                      : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  <Icon size={13} />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>

          {showViewToggle && (
            <div className="flex items-center bg-[#0f1315] border border-[#30363d] rounded p-0.5 flex-shrink-0 mb-1">
              <button
                type="button"
                onClick={() => updateViewMode("list")}
                className={`flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer ${
                  viewMode === "list" ? "bg-[#2a3136] text-gray-100" : "text-gray-500 hover:text-gray-300"
                }`}
                title="List view"
              >
                <ListIcon size={13} />
              </button>
              <button
                type="button"
                onClick={() => updateViewMode("grid")}
                className={`flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer ${
                  viewMode === "grid" ? "bg-[#2a3136] text-gray-100" : "text-gray-500 hover:text-gray-300"
                }`}
                title="Grid view"
              >
                <LayoutGrid size={13} />
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {tab === "sermons" && (
            openSermon ? (
              <SermonDetail
                key={openSermon.id}
                sermon={openSermon}
                abbaDir={abbaDir}
                isEdit={isEdit}
                onBack={() => setOpenSermonId(null)}
                onUpdate={(patch) => updateSermon(openSermon.id, patch)}
                onDelete={() => deleteSermon(openSermon)}
                pickAudio={pickAudio}
                pickImages={pickImages}
                fetchLinkMeta={fetchLinkMeta}
                onOpenLightbox={openLightbox}
              />
            ) : (
              <SermonsList
                sermons={sermons}
                viewMode={viewMode}
                abbaDir={abbaDir}
                onOpen={(id) => setOpenSermonId(id)}
                onCreate={promptNewSermon}
              />
            )
          )}

          {tab === "prayer" && (
            openPrayer ? (
              <PrayerDetail
                key={openPrayer.id}
                prayer={openPrayer}
                isEdit={isEdit}
                onBack={() => setOpenPrayerId(null)}
                onUpdate={(patch) => updatePrayer(openPrayer.id, patch)}
                onDelete={() => deletePrayer(openPrayer)}
              />
            ) : (
              <PrayersList
                prayers={prayers}
                viewMode={viewMode}
                onOpen={(id) => setOpenPrayerId(id)}
                onCreate={createPrayer}
              />
            )
          )}

          {tab === "testimonies" && (
            openTestimony ? (
              <TestimonyDetail
                key={openTestimony.id}
                testimony={openTestimony}
                abbaDir={abbaDir}
                isEdit={isEdit}
                onBack={() => setOpenTestimonyId(null)}
                onUpdate={(patch) => updateTestimony(openTestimony.id, patch)}
                onDelete={() => deleteTestimony(openTestimony)}
                pickImages={pickImages}
                onOpenLightbox={openLightbox}
              />
            ) : (
              <TestimoniesList
                testimonies={testimonies}
                viewMode={viewMode}
                abbaDir={abbaDir}
                onOpen={(id) => setOpenTestimonyId(id)}
                onCreate={createTestimony}
              />
            )
          )}

          {tab === "events" && (
            openEvent ? (
              <EventDetail
                key={openEvent.id}
                event={openEvent}
                abbaDir={abbaDir}
                isEdit={isEdit}
                onBack={() => setOpenEventId(null)}
                onUpdate={(patch) => updateEvent(openEvent.id, patch)}
                onDelete={() => deleteEvent(openEvent)}
                pickImages={pickImages}
                fetchLinkMeta={fetchLinkMeta}
                onOpenLightbox={openLightbox}
              />
            ) : (
              <EventsList
                events={events}
                viewMode={viewMode}
                abbaDir={abbaDir}
                onOpen={(id) => setOpenEventId(id)}
                onCreate={createEvent}
              />
            )
          )}

          {tab === "studies" && (
            openStudy ? (
              <StudyDetail
                key={openStudy.id}
                study={openStudy}
                abbaDir={abbaDir}
                isEdit={isEdit}
                onBack={() => setOpenStudyId(null)}
                onUpdate={(patch) => updateStudy(openStudy.id, patch)}
                onDelete={() => deleteStudy(openStudy)}
                pickImages={pickImages}
                fetchLinkMeta={fetchLinkMeta}
                onOpenLightbox={openLightbox}
              />
            ) : (
              <StudiesList
                studies={studies}
                viewMode={viewMode}
                abbaDir={abbaDir}
                onOpen={(id) => setOpenStudyId(id)}
                onCreate={createStudy}
              />
            )
          )}

          {tab === "links" && (
            <LinksSection
              links={links}
              isEdit={isEdit}
              onAdd={createLink}
              onUpdate={updateLink}
              onRemove={deleteLink}
              fetchLinkMeta={fetchLinkMeta}
            />
          )}
        </div>

        {optimizeOpen && (
          <div
            className="fixed inset-0 z-[220] bg-black/70 flex items-center justify-center p-6"
            onClick={() => {
              if (optimizePhase === "deleting") return;
              setOptimizeOpen(false);
            }}
          >
            <div
              className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[560px] max-w-[92vw] max-h-[80vh] overflow-hidden flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
                <Sparkles size={14} className="text-blue-400" />
                <span className="text-sm font-medium text-gray-100">
                  Clean up leftover files
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (optimizePhase === "deleting") return;
                    setOptimizeOpen(false);
                  }}
                  disabled={optimizePhase === "deleting"}
                  className="ml-auto text-gray-500 hover:text-gray-300 p-0.5 disabled:opacity-40"
                  title="Close"
                >
                  <X size={14} />
                </button>
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
                      <p className="text-xs text-red-400/70 mt-1 break-words">
                        {optimizeError}
                      </p>
                    </div>
                  </div>
                )}

                {optimizePhase === "results" && optimizeUnused.length === 0 && (
                  <div className="text-center py-10">
                    <p className="text-sm text-gray-300">No leftover files.</p>
                    <p className="text-xs text-gray-500 mt-1">
                      All assets live inside per-note folders now, so
                      <span className="font-mono"> assets/ </span>
                      only contains the organized subfolders.
                    </p>
                  </div>
                )}

                {optimizePhase === "results" && optimizeUnused.length > 0 && (
                  <>
                    <div className="text-sm text-gray-200 mb-1">
                      Found{" "}
                      <span className="font-semibold text-gray-100">
                        {optimizeUnused.length}
                      </span>{" "}
                      leftover {optimizeUnused.length === 1 ? "file" : "files"}
                      {totalUnusedBytes > 0 && (
                        <>
                          {" "}taking up{" "}
                          <span className="font-semibold text-amber-300">
                            {formatBytes(totalUnusedBytes)}
                          </span>
                        </>
                      )}
                      .
                    </div>
                    <p className="text-[11px] text-gray-500 mb-3">
                      These are flat files sitting directly in{" "}
                      <span className="font-mono">assets/</span> — usually
                      leftovers from before entries had their own subfolders.
                    </p>

                    <div className="rounded-md border border-[#2a3136] bg-[#0f1315] max-h-[340px] overflow-y-auto divide-y divide-[#2a3136]">
                      {optimizeUnused.slice(0, 300).map((u) => (
                        <div key={u.file} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                          <span className="text-gray-300 truncate flex-1 font-mono">{u.file}</span>
                          <span className="text-gray-500 tabular-nums flex-shrink-0">
                            {formatBytes(u.size)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {optimizePhase === "deleting" && (
                  <div className="flex items-center gap-3 py-8 justify-center text-sm text-gray-400">
                    <Loader2 size={16} className="animate-spin" />
                    <span>Moving files to trash…</span>
                  </div>
                )}

                {optimizePhase === "done" && (
                  <div className="text-center py-10">
                    <p className="text-sm text-gray-200">
                      Moved{" "}
                      <span className="font-semibold text-gray-100">
                        {optimizeDeletedCount}
                      </span>{" "}
                      {optimizeDeletedCount === 1 ? "file" : "files"} to the trash.
                    </p>
                  </div>
                )}
              </div>

              {optimizePhase === "results" && optimizeUnused.length > 0 && (
                <div className="flex justify-end gap-2 px-4 py-3 border-t border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => setOptimizeOpen(false)}
                    className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-[#2a3136] rounded transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={deleteAllUnused}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors font-medium"
                  >
                    <Trash2 size={12} />
                    <span>Move {optimizeUnused.length} to trash</span>
                  </button>
                </div>
              )}

              {(optimizePhase === "done" ||
                (optimizePhase === "results" && optimizeUnused.length === 0)) && (
                <div className="flex justify-end gap-2 px-4 py-3 border-t border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => setOptimizeOpen(false)}
                    className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
                  >
                    Done
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {newSermonDate !== null && (
          <div
            className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-6"
            onClick={() => setNewSermonDate(null)}
          >
            <div
              className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[380px] max-w-[92vw] overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a3136] bg-[#1a1e21]">
                <Church size={14} className="text-blue-400" />
                <span className="text-sm font-medium text-gray-100">New Sermon</span>
                <button
                  type="button"
                  onClick={() => setNewSermonDate(null)}
                  className="ml-auto text-gray-500 hover:text-gray-300 p-0.5"
                  title="Close"
                >
                  <X size={14} />
                </button>
              </div>

              <div className="p-4 space-y-3">
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5 flex items-center gap-1.5">
                    <Calendar size={10} /> Service date
                  </label>
                  <input
                    type="date"
                    value={newSermonDate}
                    onChange={(e) => setNewSermonDate(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") confirmNewSermon();
                      if (e.key === "Escape") setNewSermonDate(null);
                    }}
                    className="w-full bg-[#0f1315] border border-[#30363d] rounded px-3 py-2 text-sm text-gray-100 outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <p className="text-[10px] text-gray-600 mt-1.5">
                    {newSermonDate
                      ? `Will be saved as ${fmtDate(
                          new Date(`${newSermonDate}T12:00:00`).toISOString()
                        )}`
                      : "Pick a date for this sermon."}
                  </p>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setNewSermonDate(null)}
                    className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-[#2a3136] rounded transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={confirmNewSermon}
                    disabled={!newSermonDate}
                    className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors font-medium"
                  >
                    Create Sermon
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </AbbaErrorBoundary>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function sermonTitle(s: Sermon): string {
  if (s.title.trim()) return s.title.trim();
  if (s.speaker.trim()) return `${s.speaker.trim()} — ${fmtShort(s.date)}`;
  return `Sermon — ${fmtShort(s.date)}`;
}
function prayerTitle(p: Prayer): string {
  return p.title.trim() || `Prayer — ${fmtShort(p.date)}`;
}
function testimonyTitle(t: Testimony): string {
  return t.title.trim() || `Testimony — ${fmtShort(t.date)}`;
}
function studyTitle(s: Study): string {
  return s.title.trim() || `Study — ${fmtShort(s.date)}`;
}
function eventTitle(e: AbbaEvent): string {
  return e.title.trim() || `Event — ${fmtShort(e.date)}`;
}

function TimeMeta({
  created, modified, align = "left",
}: {
  created?: string; modified?: string; align?: "left" | "center";
}) {
  if (!created && !modified) return null;
  const showModified = modified && created && modified !== created;
  return (
    <div className={`flex flex-wrap items-center gap-3 text-[10px] text-gray-500 ${
      align === "center" ? "justify-center" : ""
    }`}>
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

function PhotoGrid({
  scope,
  images,
  onOpenLightbox,
  onRemove,
  isEdit,
}: {
  scope: AbbaScope;
  images: string[];
  onOpenLightbox: (scope: AbbaScope, images: string[], index: number) => void;
  onRemove: (fileName: string) => void;
  isEdit: boolean;
}) {
  if (images.length === 0) return null;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {images.map((img, idx) => (
        <div
          key={img}
          className="relative group rounded-lg overflow-hidden border border-[#2a3136] bg-[#0f1315] cursor-zoom-in"
          onClick={() => onOpenLightbox(scope, images, idx)}
        >
          <AbImage
            scope={scope}
            fileName={img}
            className="w-full max-h-96 object-contain bg-black/40"
          />
          <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenLightbox(scope, images, idx); }}
              className="p-1.5 rounded bg-black/70 text-white hover:bg-black/90 transition-colors"
              title="View full size"
            >
              <Maximize2 size={12} />
            </button>
            {isEdit && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRemove(img); }}
                className="p-1.5 rounded bg-black/70 text-white hover:bg-red-600 transition-colors"
                title="Remove"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  SERMONS
// ═══════════════════════════════════════════════════════════════════════════

function SermonsList({
  sermons, viewMode, abbaDir, onOpen, onCreate,
}: {
  sermons: Sermon[]; viewMode: ViewMode; abbaDir: string;
  onOpen: (id: string) => void; onCreate: () => void;
}) {
  const sorted = [...sermons].sort(byDateDesc);
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter((s) =>
      [s.title || "", s.speaker || "", s.notes || "", ...songsOf(s), dateSearchString(s.date)]
        .join(" ").toLowerCase().includes(query)
    );
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
        <button
          type="button"
          onClick={onCreate}
          className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium"
        >
          <Plus size={13} /> <span>New Sermon</span>
        </button>
      </div>

      {sermons.length > 0 && (
        <div className="relative mb-4">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by title, speaker, date, or song…"
            className="w-full bg-[#161a1d] border border-[#2a3136] rounded pl-9 pr-3 py-2 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      )}

      {sorted.length === 0 ? (
        <EmptyCTA
          icon={Church}
          title="No sermons yet"
          subtitle="Pick a date to start your first sermon entry."
          buttonLabel="Create your first sermon"
          onCreate={onCreate}
        />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-gray-500 italic text-center py-6">No matches for "{q}".</p>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((s) => {
            const songs = songsOf(s);
            const scope: AbbaScope = { abbaDir, section: "sermons", noteId: s.id };
            return (
              <GridCard
                key={s.id}
                scope={scope}
                image={s.images[0]}
                fallbackIcon={Church}
                fallbackTint="#60a5fa"
                title={sermonTitle(s)}
                dateText={fmtShort(s.date)}
                subtitle={s.speaker || undefined}
                subtitleIcon={s.speaker ? User : undefined}
                previewText={s.notes.trim() ? preview(s.notes) : undefined}
                meta={
                  <div className="flex items-center gap-2 text-[10px] text-gray-500 flex-wrap">
                    {s.audioFile && (
                      <span className="flex items-center gap-1 text-blue-400/80">
                        <FileAudio size={10} /> Audio
                      </span>
                    )}
                    {s.images.length > 0 && (
                      <span className="flex items-center gap-1">
                        <ImageIcon size={10} /> {s.images.length}
                      </span>
                    )}
                    {songs.length > 0 && (
                      <span className="flex items-center gap-1 text-purple-400/80">
                        <ListMusic size={10} /> {songs.length}
                      </span>
                    )}
                    {s.links.length > 0 && (
                      <span className="flex items-center gap-1">
                        <LinkIcon size={10} /> {s.links.length}
                      </span>
                    )}
                  </div>
                }
                onClick={() => onOpen(s.id)}
              />
            );
          })}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((s) => {
            const songs = songsOf(s);
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onOpen(s.id)}
                className="w-full text-left rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] hover:bg-[#1a1e21] transition-colors p-3 group"
              >
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-md bg-[#1e2327] flex items-center justify-center flex-shrink-0">
                    <Church size={15} className="text-blue-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <h4 className="text-sm font-medium text-gray-100 truncate">
                        {sermonTitle(s)}
                      </h4>
                      <span className="text-[10px] text-gray-500 flex-shrink-0">
                        {fmtShort(s.date)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[11px] text-gray-500 flex-wrap">
                      {s.speaker && (
                        <span className="flex items-center gap-1 truncate">
                          <User size={10} className="flex-shrink-0" />{s.speaker}
                        </span>
                      )}
                      {s.audioFile && (
                        <span className="flex items-center gap-1 text-blue-400/80">
                          <FileAudio size={10} /> Audio
                        </span>
                      )}
                      {s.images.length > 0 && (
                        <span className="flex items-center gap-1">
                          <ImageIcon size={10} /> {s.images.length}
                        </span>
                      )}
                      {songs.length > 0 && (
                        <span className="flex items-center gap-1 text-purple-400/80">
                          <ListMusic size={10} /> {songs.length}
                        </span>
                      )}
                      {s.links.length > 0 && (
                        <span className="flex items-center gap-1">
                          <LinkIcon size={10} /> {s.links.length}
                        </span>
                      )}
                    </div>
                    {s.notes.trim() && (
                      <p className="text-xs text-gray-400 mt-2 leading-relaxed line-clamp-2">
                        {preview(s.notes)}
                      </p>
                    )}
                    {songs.length > 0 && !s.notes.trim() && (
                      <p className="text-xs text-gray-500 mt-2 truncate italic">
                        {songs.join(" · ")}
                      </p>
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

function SermonDetail({
  sermon, abbaDir, isEdit, onBack, onUpdate, onDelete,
  pickAudio, pickImages, fetchLinkMeta, onOpenLightbox,
}: {
  sermon: Sermon; abbaDir: string; isEdit: boolean;
  onBack: () => void; onUpdate: (patch: Partial<Sermon>) => void; onDelete: () => void;
  pickAudio: () => Promise<{ sourcePath: string; name: string } | null>;
  pickImages: () => Promise<string[]>;
  fetchLinkMeta: (url: string) => Promise<Partial<AbbaLink>>;
  onOpenLightbox: (scope: AbbaScope, images: string[], index: number) => void;
}) {
  const scope: AbbaScope = { abbaDir, section: "sermons", noteId: sermon.id };
  const { mode, toggle, setMode } = useNoteMode();
  const [linkDraft, setLinkDraft] = useState("");
  const [savingLink, setSavingLink] = useState(false);
  const [songDraft, setSongDraft] = useState("");
  const songs = songsOf(sermon);

  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    if (mode === "read" && !sermon.title.trim() && !sermon.notes.trim() && !sermon.speaker.trim()) {
      setMode("edit");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUploadAudio = async () => {
    const picked = await pickAudio();
    if (!picked) return;
    try {
      const { fileName, displayName } = await saveFileToAbbaNote(
        abbaDir, "sermons", sermon.id, picked.sourcePath, picked.name
      );
      if (sermon.audioFile) {
        await deleteAbbaNoteAsset(abbaDir, "sermons", sermon.id, sermon.audioFile);
      }
      onUpdate({ audioFile: fileName, audioName: displayName });
    } catch (e) { console.error("[abba] audio upload failed:", e); }
  };

  const handleUploadImages = async () => {
    const paths = await pickImages();
    if (paths.length === 0) return;
    const newFiles: string[] = [];
    for (const p of paths) {
      try {
        const { fileName } = await saveFileToAbbaNote(abbaDir, "sermons", sermon.id, p);
        newFiles.push(fileName);
      } catch (e) { console.error("[abba] image upload failed:", e); }
    }
    onUpdate({ images: [...sermon.images, ...newFiles] });
  };

  const removeImage = async (fileName: string) => {
    await deleteAbbaNoteAsset(abbaDir, "sermons", sermon.id, fileName);
    onUpdate({ images: sermon.images.filter((f) => f !== fileName) });
  };

  const removeAudio = async () => {
    if (sermon.audioFile) {
      await deleteAbbaNoteAsset(abbaDir, "sermons", sermon.id, sermon.audioFile);
    }
    onUpdate({ audioFile: null, audioName: null });
  };

  const addSong = () => {
    const trimmed = songDraft.trim();
    if (!trimmed) return;
    onUpdate({ songs: [...songs, trimmed] });
    setSongDraft("");
  };
  const removeSong = (idx: number) => onUpdate({ songs: songs.filter((_, i) => i !== idx) });

  const addLink = async () => {
    const url = linkDraft.trim();
    if (!url) return;
    setSavingLink(true);
    const meta = await fetchLinkMeta(url);
    const l: AbbaLink = {
      id: newId("link"), url,
      title: meta.title || url, description: meta.description || "",
      icon: meta.icon || "", image: meta.image || "",
      created: nowIso(), modified: nowIso(),
    };
    onUpdate({ links: [...sermon.links, l] });
    setLinkDraft("");
    setSavingLink(false);
  };
  const removeLink = (id: string) => onUpdate({ links: sermon.links.filter((l) => l.id !== id) });

  const dateValue = sermon.date ? sermon.date.slice(0, 10) : "";
  const heroImage = sermon.images[0];
  const restImages = sermon.images.slice(1);

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-[#2a3136] gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-100 transition-colors"
        >
          <ChevronLeft size={14} /><span>All Sermons</span>
        </button>

        <div className="flex items-center gap-2">
          {isEdit && (
            <button
              type="button"
              onClick={onDelete}
              className="text-gray-500 hover:text-red-400 p-1.5 rounded transition-colors"
              title="Delete this sermon"
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

      <input
        type="text"
        value={sermon.title}
        onChange={(e) => onUpdate({ title: e.target.value })}
        readOnly={!isEdit}
        placeholder="Untitled Sermon"
        className={`w-full bg-transparent border-none outline-none text-3xl font-bold tracking-tight px-2 py-1 rounded text-center placeholder-gray-700 ${
          isEdit ? "text-gray-100 focus:bg-white/5" : "text-gray-100 cursor-default"
        }`}
      />

      <div className="flex items-center justify-center gap-3 text-xs text-gray-500 mt-3 mb-8">
        {isEdit ? (
          <input
            type="text"
            value={sermon.speaker}
            onChange={(e) => onUpdate({ speaker: e.target.value })}
            placeholder="Speaker"
            className="bg-transparent border-none outline-none text-center text-xs text-gray-400 placeholder-gray-600 focus:text-gray-200"
            style={{ minWidth: "6rem", maxWidth: "12rem" }}
          />
        ) : sermon.speaker ? (
          <span className="text-gray-400">{sermon.speaker}</span>
        ) : null}
        {(isEdit || sermon.speaker) && <span>•</span>}
        {isEdit ? (
          <input
            type="date"
            value={dateValue}
            onChange={(e) =>
              onUpdate({ date: new Date(e.target.value + "T12:00:00").toISOString() })
            }
            className="bg-transparent border-none outline-none text-xs text-gray-400 focus:text-gray-200"
          />
        ) : (
          <span>{fmtDate(sermon.date)}</span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {(sermon.images.length > 0 || isEdit) && (
            <section>
              {heroImage && (
                <div
                  className="relative group rounded-lg overflow-hidden border border-[#2a3136] bg-[#0f1315] cursor-zoom-in"
                  onClick={() => onOpenLightbox(scope, sermon.images, 0)}
                >
                  <AbImage scope={scope} fileName={heroImage} className="w-full max-h-[600px] object-contain bg-black/40" />
                  <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onOpenLightbox(scope, sermon.images, 0); }}
                      className="p-1.5 rounded bg-black/70 text-white hover:bg-black/90 transition-colors"
                      title="View full size"
                    >
                      <Maximize2 size={13} />
                    </button>
                    {isEdit && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeImage(heroImage); }}
                        className="p-1.5 rounded bg-black/70 text-white hover:bg-red-600 transition-colors"
                        title="Remove"
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                </div>
              )}

              {restImages.length > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
                  {restImages.map((img, idx) => (
                    <div
                      key={img}
                      className="relative group rounded-lg overflow-hidden border border-[#2a3136] bg-[#0f1315] cursor-zoom-in"
                      onClick={() => onOpenLightbox(scope, sermon.images, idx + 1)}
                    >
                      <AbImage scope={scope} fileName={img} className="w-full h-32 object-cover" />
                      {isEdit && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); removeImage(img); }}
                          className="absolute top-1 right-1 p-1 rounded bg-black/70 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                          title="Remove"
                        >
                          <X size={11} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {isEdit && (
                <button
                  type="button"
                  onClick={handleUploadImages}
                  className="mt-3 flex items-center gap-1.5 text-xs px-3 py-1.5 bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200"
                >
                  <Upload size={12} /> Add photos
                </button>
              )}
            </section>
          )}

          {(sermon.notes.trim() || isEdit) && (
            <section className="rounded-lg border border-[#2a3136] bg-[#161a1d] p-4">
              <SectionLabel icon={BookMarked} label="Notes" />
              {isEdit ? (
                <textarea
                  value={sermon.notes}
                  onChange={(e) => onUpdate({ notes: e.target.value })}
                  placeholder="Sermon notes, key verses, takeaways…"
                  rows={10}
                  className="w-full bg-transparent border-none outline-none text-sm text-gray-200 leading-relaxed resize-y placeholder-gray-600 focus:outline-none"
                  style={{ minHeight: "10rem" }}
                />
              ) : (
                <div className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
                  {sermon.notes}
                </div>
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
                    <div
                      key={`${song}-${idx}`}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-[#0f1315] border border-[#2a3136] group"
                    >
                      <ListMusic size={11} className="text-purple-400 flex-shrink-0" />
                      <span className="text-xs text-gray-200 truncate flex-1">{song}</span>
                      {isEdit && (
                        <button
                          type="button"
                          onClick={() => removeSong(idx)}
                          className="text-gray-500 hover:text-red-400 p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Remove song"
                        >
                          <X size={11} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {isEdit && (
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={songDraft}
                    onChange={(e) => setSongDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addSong(); }}
                    placeholder="Add a song…"
                    className="flex-1 min-w-0 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={addSong}
                    disabled={!songDraft.trim()}
                    className="flex items-center gap-1 px-2 py-1 text-xs bg-[#2a3136] hover:bg-[#30363d] disabled:opacity-40 border border-[#30363d] rounded text-gray-200 flex-shrink-0"
                  >
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
                        <button
                          type="button"
                          onClick={handleUploadAudio}
                          className="text-gray-500 hover:text-gray-200 p-1"
                          title="Replace audio"
                        >
                          <Upload size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={removeAudio}
                          className="text-gray-500 hover:text-red-400 p-1"
                          title="Remove audio"
                        >
                          <X size={12} />
                        </button>
                      </>
                    )}
                  </div>
                  <AudioPlayer
                    abbaDir={abbaDir}
                    section="sermons"
                    noteId={sermon.id}
                    fileName={sermon.audioFile}
                    displayName={sermon.audioName || sermon.audioFile}
                  />
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleUploadAudio}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200"
                >
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
                    <div
                      key={l.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded bg-[#0f1315] border border-[#2a3136] group"
                    >
                      {l.icon ? (
                        <img
                          src={l.icon} alt=""
                          className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
                          onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                        />
                      ) : (
                        <LinkIcon size={11} className="text-gray-500 flex-shrink-0" />
                      )}
                      <button
                        type="button"
                        onClick={() => openUrl(l.url).catch((err) => console.error("[abba] open link failed:", err))}
                        className="text-xs text-gray-300 hover:text-blue-300 truncate flex-1 text-left"
                        title={l.url}
                      >
                        {l.title || l.url}
                      </button>
                      {isEdit && (
                        <button
                          type="button"
                          onClick={() => removeLink(l.id)}
                          className="text-gray-500 hover:text-red-400 p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X size={11} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {isEdit && (
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={linkDraft}
                    onChange={(e) => setLinkDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addLink(); }}
                    placeholder="Add a link…"
                    className="flex-1 min-w-0 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={addLink}
                    disabled={!linkDraft.trim() || savingLink}
                    className="flex items-center gap-1 px-2 py-1 text-xs bg-[#2a3136] hover:bg-[#30363d] disabled:opacity-40 border border-[#30363d] rounded text-gray-200 flex-shrink-0"
                  >
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
//  PRAYERS
// ═══════════════════════════════════════════════════════════════════════════

function PrayersList({
  prayers, viewMode, onOpen, onCreate,
}: {
  prayers: Prayer[]; viewMode: ViewMode;
  onOpen: (id: string) => void; onCreate: () => void;
}) {
  const sorted = [...prayers].sort(byDateDesc);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter((p) =>
      [p.title, p.body].some((f) => (f || "").toLowerCase().includes(query))
    );
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
        <button
          type="button"
          onClick={onCreate}
          className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium"
        >
          <Plus size={13} /> <span>New Prayer</span>
        </button>
      </div>

      {prayers.length > 0 && (
        <div className="relative mb-4">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search prayers…"
            className="w-full bg-[#161a1d] border border-[#2a3136] rounded pl-9 pr-3 py-2 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      )}

      {sorted.length === 0 ? (
        <EmptyCTA
          icon={HandHeart}
          title="No prayers yet"
          subtitle="Start writing to God — everything you write is kept as a journal."
          buttonLabel="Write your first prayer"
          onCreate={onCreate}
        />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-gray-500 italic text-center py-6">No matches for "{q}".</p>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((p) => (
            <GridCard
              key={p.id}
              scope={{ abbaDir: "", section: "prayers", noteId: p.id }}
              fallbackIcon={HandHeart}
              fallbackTint="#fb7185"
              title={prayerTitle(p)}
              dateText={fmtShort(p.date)}
              previewText={p.body.trim() ? preview(p.body) : undefined}
              meta={<TimeMeta created={p.created} modified={p.modified} />}
              onClick={() => onOpen(p.id)}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onOpen(p.id)}
              className="w-full text-left rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] hover:bg-[#1a1e21] transition-colors p-3 group"
            >
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-md bg-[#1e2327] flex items-center justify-center flex-shrink-0">
                  <HandHeart size={15} className="text-rose-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <h4 className="text-sm font-medium text-gray-100 truncate">
                      {prayerTitle(p)}
                    </h4>
                    <span className="text-[10px] text-gray-500 flex-shrink-0">
                      {fmtShort(p.date)}
                    </span>
                  </div>
                  {p.body.trim() && (
                    <p className="text-xs text-gray-400 mt-2 leading-relaxed line-clamp-2 italic">
                      {preview(p.body)}
                    </p>
                  )}
                  <div className="mt-2">
                    <TimeMeta created={p.created} modified={p.modified} />
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

function PrayerDetail({
  prayer, isEdit, onBack, onUpdate, onDelete,
}: {
  prayer: Prayer; isEdit: boolean;
  onBack: () => void; onUpdate: (patch: Partial<Prayer>) => void; onDelete: () => void;
}) {
  const { mode, toggle, setMode } = useNoteMode();
  const dateValue = prayer.date ? prayer.date.slice(0, 10) : "";

  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    if (mode === "read" && !prayer.title.trim() && !prayer.body.trim()) setMode("edit");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="max-w-2xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-8 pb-4 border-b border-[#2a3136] gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-100 transition-colors"
        >
          <ChevronLeft size={14} /><span>All Prayers</span>
        </button>
        <div className="flex items-center gap-2">
          {isEdit && (
            <button
              type="button"
              onClick={onDelete}
              className="text-gray-500 hover:text-red-400 p-1.5 rounded transition-colors"
              title="Delete this prayer"
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

      <input
        type="text"
        value={prayer.title}
        onChange={(e) => onUpdate({ title: e.target.value })}
        readOnly={!isEdit}
        placeholder="A prayer…"
        className={`w-full bg-transparent border-none outline-none text-3xl font-bold tracking-tight px-2 py-1 rounded text-center placeholder-gray-700 ${
          isEdit ? "text-gray-100 focus:bg-white/5" : "text-gray-100 cursor-default"
        }`}
      />

      <div className="flex items-center justify-center gap-2 text-xs text-gray-500 mt-3">
        {isEdit ? (
          <input
            type="date"
            value={dateValue}
            onChange={(e) =>
              onUpdate({ date: new Date(e.target.value + "T12:00:00").toISOString() })
            }
            className="bg-transparent border-none outline-none text-xs text-gray-400 focus:text-gray-200"
          />
        ) : (
          <span>{fmtDate(prayer.date)}</span>
        )}
      </div>

      <div className="mt-10">
        {isEdit ? (
          <textarea
            value={prayer.body}
            onChange={(e) => onUpdate({ body: e.target.value })}
            placeholder="Dear God…"
            rows={16}
            className="w-full bg-transparent border-none outline-none text-base text-gray-200 leading-relaxed resize-y placeholder-gray-600"
            style={{
              minHeight: "16rem",
              fontFamily: "Georgia, 'Times New Roman', 'Liberation Serif', 'DejaVu Serif', serif",
            }}
          />
        ) : prayer.body.trim() ? (
          <div
            className="text-base text-gray-300 leading-loose whitespace-pre-wrap"
            style={{ fontFamily: "Georgia, 'Times New Roman', 'Liberation Serif', 'DejaVu Serif', serif" }}
          >
            {prayer.body}
          </div>
        ) : null}
      </div>

      {(prayer.created || prayer.modified) && (
        <div className="mt-12 pt-4 border-t border-[#2a3136]">
          <TimeMeta created={prayer.created} modified={prayer.modified} align="center" />
        </div>
      )}

      <div className="h-16" />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  TESTIMONIES
// ═══════════════════════════════════════════════════════════════════════════

function TestimoniesList({
  testimonies, viewMode, abbaDir, onOpen, onCreate,
}: {
  testimonies: Testimony[]; viewMode: ViewMode; abbaDir: string;
  onOpen: (id: string) => void; onCreate: () => void;
}) {
  const sorted = [...testimonies].sort(byDateDesc);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter((t) =>
      [t.title, t.body].some((f) => (f || "").toLowerCase().includes(query))
    );
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
        <button
          type="button"
          onClick={onCreate}
          className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium"
        >
          <Plus size={13} /> <span>New Testimony</span>
        </button>
      </div>

      {testimonies.length > 0 && (
        <div className="relative mb-4">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search testimonies…"
            className="w-full bg-[#161a1d] border border-[#2a3136] rounded pl-9 pr-3 py-2 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      )}

      {sorted.length === 0 ? (
        <EmptyCTA
          icon={Heart}
          title="No testimonies yet"
          subtitle="Capture what God has done — everything you write is kept."
          buttonLabel="Add your first testimony"
          onCreate={onCreate}
        />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-gray-500 italic text-center py-6">No matches for "{q}".</p>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((t) => (
            <GridCard
              key={t.id}
              scope={{ abbaDir, section: "testimonies", noteId: t.id }}
              image={t.images[0]}
              fallbackIcon={Heart}
              fallbackTint="#f472b6"
              title={testimonyTitle(t)}
              dateText={fmtShort(t.date)}
              previewText={t.body.trim() ? preview(t.body) : undefined}
              meta={
                <div className="flex items-center gap-3">
                  <TimeMeta created={t.created} modified={t.modified} />
                  {t.images.length > 0 && (
                    <span className="flex items-center gap-1 text-[10px] text-gray-500">
                      <ImageIcon size={10} /> {t.images.length}
                    </span>
                  )}
                </div>
              }
              onClick={() => onOpen(t.id)}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onOpen(t.id)}
              className="w-full text-left rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] hover:bg-[#1a1e21] transition-colors p-3 group"
            >
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-md bg-[#1e2327] flex items-center justify-center flex-shrink-0">
                  <Heart size={15} className="text-pink-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <h4 className="text-sm font-medium text-gray-100 truncate">
                      {testimonyTitle(t)}
                    </h4>
                    <span className="text-[10px] text-gray-500 flex-shrink-0">
                      {fmtShort(t.date)}
                    </span>
                  </div>
                  {t.body.trim() && (
                    <p className="text-xs text-gray-400 mt-2 leading-relaxed line-clamp-2">
                      {preview(t.body)}
                    </p>
                  )}
                  <div className="flex items-center gap-3 mt-2">
                    <TimeMeta created={t.created} modified={t.modified} />
                    {t.images.length > 0 && (
                      <span className="flex items-center gap-1 text-[10px] text-gray-500">
                        <ImageIcon size={10} /> {t.images.length}
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

function TestimonyDetail({
  testimony, abbaDir, isEdit, onBack, onUpdate, onDelete,
  pickImages, onOpenLightbox,
}: {
  testimony: Testimony; abbaDir: string; isEdit: boolean;
  onBack: () => void; onUpdate: (patch: Partial<Testimony>) => void; onDelete: () => void;
  pickImages: () => Promise<string[]>;
  onOpenLightbox: (scope: AbbaScope, images: string[], index: number) => void;
}) {
  const scope: AbbaScope = { abbaDir, section: "testimonies", noteId: testimony.id };
  const { mode, toggle, setMode } = useNoteMode();
  const dateValue = testimony.date ? testimony.date.slice(0, 10) : "";

  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    if (mode === "read" && !testimony.title.trim() && !testimony.body.trim()) setMode("edit");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUploadImages = async () => {
    const paths = await pickImages();
    if (paths.length === 0) return;
    const newFiles: string[] = [];
    for (const p of paths) {
      try {
        const { fileName } = await saveFileToAbbaNote(abbaDir, "testimonies", testimony.id, p);
        newFiles.push(fileName);
      } catch (e) { console.error("[abba] image upload failed:", e); }
    }
    onUpdate({ images: [...testimony.images, ...newFiles] });
  };

  const removeImage = async (fileName: string) => {
    await deleteAbbaNoteAsset(abbaDir, "testimonies", testimony.id, fileName);
    onUpdate({ images: testimony.images.filter((f) => f !== fileName) });
  };

  return (
    <div className="max-w-2xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-8 pb-4 border-b border-[#2a3136] gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-100 transition-colors"
        >
          <ChevronLeft size={14} /><span>All Testimonies</span>
        </button>
        <div className="flex items-center gap-2">
          {isEdit && (
            <button
              type="button"
              onClick={onDelete}
              className="text-gray-500 hover:text-red-400 p-1.5 rounded transition-colors"
              title="Delete this testimony"
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

      <input
        type="text"
        value={testimony.title}
        onChange={(e) => onUpdate({ title: e.target.value })}
        readOnly={!isEdit}
        placeholder="A testimony…"
        className={`w-full bg-transparent border-none outline-none text-3xl font-bold tracking-tight px-2 py-1 rounded text-center placeholder-gray-700 ${
          isEdit ? "text-gray-100 focus:bg-white/5" : "text-gray-100 cursor-default"
        }`}
      />

      <div className="flex items-center justify-center gap-2 text-xs text-gray-500 mt-3">
        {isEdit ? (
          <input
            type="date"
            value={dateValue}
            onChange={(e) =>
              onUpdate({ date: new Date(e.target.value + "T12:00:00").toISOString() })
            }
            className="bg-transparent border-none outline-none text-xs text-gray-400 focus:text-gray-200"
          />
        ) : (
          <span>{fmtDate(testimony.date)}</span>
        )}
      </div>

      <div className="mt-10 space-y-8">
        <section>
          {isEdit ? (
            <textarea
              value={testimony.body}
              onChange={(e) => onUpdate({ body: e.target.value })}
              placeholder="What has God done?"
              rows={12}
              className="w-full bg-transparent border-none outline-none text-base text-gray-200 leading-relaxed resize-y placeholder-gray-600 focus:outline-none"
              style={{ minHeight: "12rem" }}
            />
          ) : testimony.body.trim() ? (
            <div className="text-base text-gray-300 leading-relaxed whitespace-pre-wrap">
              {testimony.body}
            </div>
          ) : null}
        </section>

        {(testimony.images.length > 0 || isEdit) && (
          <section>
            <SectionLabel icon={ImageIcon} label="Photos" />
            <PhotoGrid
              scope={scope}
              images={testimony.images}
              onOpenLightbox={onOpenLightbox}
              onRemove={removeImage}
              isEdit={isEdit}
            />
            {isEdit && (
              <button
                type="button"
                onClick={handleUploadImages}
                className="mt-3 flex items-center gap-1.5 text-xs px-3 py-1.5 bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200"
              >
                <Upload size={12} /> Add photos
              </button>
            )}
          </section>
        )}
      </div>

      {(testimony.created || testimony.modified) && (
        <div className="mt-12 pt-4 border-t border-[#2a3136]">
          <TimeMeta created={testimony.created} modified={testimony.modified} align="center" />
        </div>
      )}

      <div className="h-16" />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  EVENTS
// ═══════════════════════════════════════════════════════════════════════════

function EventsList({
  events, viewMode, abbaDir, onOpen, onCreate,
}: {
  events: AbbaEvent[]; viewMode: ViewMode; abbaDir: string;
  onOpen: (id: string) => void; onCreate: () => void;
}) {
  const sorted = [...events].sort(byDateDesc);
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter((e) =>
      [e.title, e.location, e.description, dateSearchString(e.date)]
        .join(" ").toLowerCase().includes(query)
    );
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
        <button
          type="button"
          onClick={onCreate}
          className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium"
        >
          <Plus size={13} /> <span>New Event</span>
        </button>
      </div>

      {events.length > 0 && (
        <div className="relative mb-4">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by title, location, or date…"
            className="w-full bg-[#161a1d] border border-[#2a3136] rounded pl-9 pr-3 py-2 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      )}

      {sorted.length === 0 ? (
        <EmptyCTA
          icon={Star}
          title="No events yet"
          subtitle="Record a baptism, communion service, retreat, or any gathering worth remembering."
          buttonLabel="Add your first event"
          onCreate={onCreate}
        />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-gray-500 italic text-center py-6">No matches for "{q}".</p>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((e) => (
            <GridCard
              key={e.id}
              scope={{ abbaDir, section: "events", noteId: e.id }}
              image={e.images[0]}
              fallbackIcon={Star}
              fallbackTint="#facc15"
              title={eventTitle(e)}
              dateText={fmtShort(e.date)}
              subtitle={e.location || undefined}
              subtitleIcon={e.location ? MapPin : undefined}
              subtitleTint="#fcd34d"
              previewText={e.description.trim() ? preview(e.description) : undefined}
              meta={
                <div className="flex items-center gap-3">
                  <TimeMeta created={e.created} modified={e.modified} />
                  {e.images.length > 0 && (
                    <span className="flex items-center gap-1 text-[10px] text-gray-500">
                      <ImageIcon size={10} /> {e.images.length}
                    </span>
                  )}
                  {e.links.length > 0 && (
                    <span className="flex items-center gap-1 text-[10px] text-gray-500">
                      <LinkIcon size={10} /> {e.links.length}
                    </span>
                  )}
                </div>
              }
              onClick={() => onOpen(e.id)}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => onOpen(e.id)}
              className="w-full text-left rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] hover:bg-[#1a1e21] transition-colors p-3 group"
            >
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-md bg-[#1e2327] flex items-center justify-center flex-shrink-0">
                  <Star size={15} className="text-yellow-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <h4 className="text-sm font-medium text-gray-100 truncate">
                      {eventTitle(e)}
                    </h4>
                    <span className="text-[10px] text-gray-500 flex-shrink-0">
                      {fmtShort(e.date)}
                    </span>
                  </div>
                  {e.location.trim() && (
                    <div className="flex items-center gap-1 text-[11px] text-amber-300/90 mt-0.5 truncate">
                      <MapPin size={10} className="flex-shrink-0" />
                      <span className="truncate">{e.location}</span>
                    </div>
                  )}
                  {e.description.trim() && (
                    <p className="text-xs text-gray-400 mt-2 leading-relaxed line-clamp-2">
                      {preview(e.description)}
                    </p>
                  )}
                  <div className="flex items-center gap-3 mt-2">
                    <TimeMeta created={e.created} modified={e.modified} />
                    {e.images.length > 0 && (
                      <span className="flex items-center gap-1 text-[10px] text-gray-500">
                        <ImageIcon size={10} /> {e.images.length}
                      </span>
                    )}
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

function EventDetail({
  event, abbaDir, isEdit, onBack, onUpdate, onDelete,
  pickImages, fetchLinkMeta, onOpenLightbox,
}: {
  event: AbbaEvent; abbaDir: string; isEdit: boolean;
  onBack: () => void; onUpdate: (patch: Partial<AbbaEvent>) => void; onDelete: () => void;
  pickImages: () => Promise<string[]>;
  fetchLinkMeta: (url: string) => Promise<Partial<AbbaLink>>;
  onOpenLightbox: (scope: AbbaScope, images: string[], index: number) => void;
}) {
  const scope: AbbaScope = { abbaDir, section: "events", noteId: event.id };
  const { mode, toggle, setMode } = useNoteMode();
  const [linkDraft, setLinkDraft] = useState("");
  const [savingLink, setSavingLink] = useState(false);
  const dateValue = event.date ? event.date.slice(0, 10) : "";

  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    if (mode === "read" && !event.title.trim() && !event.description.trim() && !event.location.trim()) {
      setMode("edit");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUploadImages = async () => {
    const paths = await pickImages();
    if (paths.length === 0) return;
    const newFiles: string[] = [];
    for (const p of paths) {
      try {
        const { fileName } = await saveFileToAbbaNote(abbaDir, "events", event.id, p);
        newFiles.push(fileName);
      } catch (e) { console.error("[abba] image upload failed:", e); }
    }
    onUpdate({ images: [...event.images, ...newFiles] });
  };

  const removeImage = async (fileName: string) => {
    await deleteAbbaNoteAsset(abbaDir, "events", event.id, fileName);
    onUpdate({ images: event.images.filter((f) => f !== fileName) });
  };

  const addLink = async () => {
    const url = linkDraft.trim();
    if (!url) return;
    setSavingLink(true);
    const meta = await fetchLinkMeta(url);
    const l: AbbaLink = {
      id: newId("link"), url,
      title: meta.title || url, description: meta.description || "",
      icon: meta.icon || "", image: meta.image || "",
      created: nowIso(), modified: nowIso(),
    };
    onUpdate({ links: [...event.links, l] });
    setLinkDraft("");
    setSavingLink(false);
  };
  const removeLink = (id: string) => onUpdate({ links: event.links.filter((l) => l.id !== id) });

  return (
    <div className="max-w-2xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-8 pb-4 border-b border-[#2a3136] gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-100 transition-colors"
        >
          <ChevronLeft size={14} /><span>All Events</span>
        </button>
        <div className="flex items-center gap-2">
          {isEdit && (
            <button
              type="button"
              onClick={onDelete}
              className="text-gray-500 hover:text-red-400 p-1.5 rounded transition-colors"
              title="Delete this event"
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

      <input
        type="text"
        value={event.title}
        onChange={(e) => onUpdate({ title: e.target.value })}
        readOnly={!isEdit}
        placeholder="Event title (e.g. Baptism of Sarah)"
        className={`w-full bg-transparent border-none outline-none text-3xl font-bold tracking-tight px-2 py-1 rounded text-center placeholder-gray-700 ${
          isEdit ? "text-gray-100 focus:bg-white/5" : "text-gray-100 cursor-default"
        }`}
      />

      <div className="flex items-center justify-center gap-3 text-xs text-gray-500 mt-3">
        {isEdit ? (
          <input
            type="date"
            value={dateValue}
            onChange={(e) =>
              onUpdate({ date: new Date(e.target.value + "T12:00:00").toISOString() })
            }
            className="bg-transparent border-none outline-none text-xs text-gray-400 focus:text-gray-200"
          />
        ) : (
          <span>{fmtDate(event.date)}</span>
        )}
      </div>

      <div className="mt-6">
        {isEdit ? (
          <div className="flex items-center justify-center gap-1.5 text-amber-300/90">
            <MapPin size={12} className="flex-shrink-0" />
            <input
              type="text"
              value={event.location}
              onChange={(e) => onUpdate({ location: e.target.value })}
              placeholder="Location (e.g. Main Sanctuary)"
              className="bg-transparent border-none outline-none text-sm text-amber-300/90 text-center placeholder-gray-600 focus:bg-white/5 px-2 py-1 rounded"
              style={{ minWidth: "12rem", maxWidth: "24rem" }}
            />
          </div>
        ) : event.location.trim() ? (
          <div className="text-sm text-amber-300/90 font-medium text-center flex items-center justify-center gap-1.5">
            <MapPin size={12} className="flex-shrink-0" /><span>{event.location}</span>
          </div>
        ) : null}
      </div>

      <div className="mt-8 space-y-8">
        <section>
          {isEdit ? (
            <textarea
              value={event.description}
              onChange={(e) => onUpdate({ description: e.target.value })}
              placeholder="What happened? Who was involved? What stood out?"
              rows={12}
              className="w-full bg-transparent border-none outline-none text-base text-gray-200 leading-relaxed resize-y placeholder-gray-600 focus:outline-none"
              style={{ minHeight: "12rem" }}
            />
          ) : event.description.trim() ? (
            <div className="text-base text-gray-300 leading-relaxed whitespace-pre-wrap">
              {event.description}
            </div>
          ) : null}
        </section>

        {(event.images.length > 0 || isEdit) && (
          <section>
            <SectionLabel icon={ImageIcon} label="Photos" />
            <PhotoGrid
              scope={scope}
              images={event.images}
              onOpenLightbox={onOpenLightbox}
              onRemove={removeImage}
              isEdit={isEdit}
            />
            {isEdit && (
              <button
                type="button"
                onClick={handleUploadImages}
                className="mt-3 flex items-center gap-1.5 text-xs px-3 py-1.5 bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200"
              >
                <Upload size={12} /> Add photos
              </button>
            )}
          </section>
        )}

        {(event.links.length > 0 || isEdit) && (
          <section className="rounded-lg border border-[#2a3136] bg-[#161a1d] p-4">
            <SectionLabel icon={LinkIcon} label="Links" />
            {event.links.length > 0 && (
              <div className="space-y-1.5 mb-2">
                {event.links.map((l) => (
                  <div
                    key={l.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded bg-[#0f1315] border border-[#2a3136] group"
                  >
                    {l.icon ? (
                      <img
                        src={l.icon} alt=""
                        className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
                        onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                      />
                    ) : (
                      <LinkIcon size={11} className="text-gray-500 flex-shrink-0" />
                    )}
                    <button
                      type="button"
                      onClick={() => openUrl(l.url).catch((err) => console.error("[abba] open link failed:", err))}
                      className="text-xs text-gray-300 hover:text-blue-300 truncate flex-1 text-left"
                      title={l.url}
                    >
                      {l.title || l.url}
                    </button>
                    {isEdit && (
                      <button
                        type="button"
                        onClick={() => removeLink(l.id)}
                        className="text-gray-500 hover:text-red-400 p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X size={11} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {isEdit && (
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={linkDraft}
                  onChange={(e) => setLinkDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addLink(); }}
                  placeholder="Add a link (video, album, article…)"
                  className="flex-1 min-w-0 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={addLink}
                  disabled={!linkDraft.trim() || savingLink}
                  className="flex items-center gap-1 px-2 py-1 text-xs bg-[#2a3136] hover:bg-[#30363d] disabled:opacity-40 border border-[#30363d] rounded text-gray-200 flex-shrink-0"
                >
                  {savingLink ? "…" : <Plus size={11} />}
                </button>
              </div>
            )}
          </section>
        )}
      </div>

      {(event.created || event.modified) && (
        <div className="mt-12 pt-4 border-t border-[#2a3136]">
          <TimeMeta created={event.created} modified={event.modified} align="center" />
        </div>
      )}

      <div className="h-16" />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  SHARED
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
      <button
        type="button"
        onClick={onCreate}
        className="flex items-center gap-2 px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors cursor-pointer"
      >
        <Plus size={14} /> <span>{buttonLabel}</span>
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  BIBLE STUDIES
// ═══════════════════════════════════════════════════════════════════════════

function StudiesList({
  studies, viewMode, abbaDir, onOpen, onCreate,
}: {
  studies: Study[]; viewMode: ViewMode; abbaDir: string;
  onOpen: (id: string) => void; onCreate: () => void;
}) {
  const sorted = [...studies].sort(byDateDesc);
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter((s) =>
      [s.title, s.topic, s.notes, dateSearchString(s.date)]
        .join(" ").toLowerCase().includes(query)
    );
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
        <button
          type="button"
          onClick={onCreate}
          className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium"
        >
          <Plus size={13} /> <span>New Study</span>
        </button>
      </div>

      {studies.length > 0 && (
        <div className="relative mb-4">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by title, topic, passage, or date…"
            className="w-full bg-[#161a1d] border border-[#2a3136] rounded pl-9 pr-3 py-2 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      )}

      {sorted.length === 0 ? (
        <EmptyCTA
          icon={BookOpen}
          title="No studies yet"
          subtitle="Start your first Bible study — notes, topics, links, and photos all in one place."
          buttonLabel="Start your first study"
          onCreate={onCreate}
        />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-gray-500 italic text-center py-6">No matches for "{q}".</p>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((s) => (
            <GridCard
              key={s.id}
              scope={{ abbaDir, section: "studies", noteId: s.id }}
              image={s.images[0]}
              fallbackIcon={BookOpen}
              fallbackTint="#fbbf24"
              title={studyTitle(s)}
              dateText={fmtShort(s.date)}
              subtitle={s.topic || undefined}
              subtitleTint="#fcd34d"
              previewText={s.notes.trim() ? preview(s.notes) : undefined}
              meta={
                <div className="flex items-center gap-3">
                  <TimeMeta created={s.created} modified={s.modified} />
                  {s.images.length > 0 && (
                    <span className="flex items-center gap-1 text-[10px] text-gray-500">
                      <ImageIcon size={10} /> {s.images.length}
                    </span>
                  )}
                  {s.links.length > 0 && (
                    <span className="flex items-center gap-1 text-[10px] text-gray-500">
                      <LinkIcon size={10} /> {s.links.length}
                    </span>
                  )}
                </div>
              }
              onClick={() => onOpen(s.id)}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onOpen(s.id)}
              className="w-full text-left rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] hover:bg-[#1a1e21] transition-colors p-3 group"
            >
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-md bg-[#1e2327] flex items-center justify-center flex-shrink-0">
                  <BookOpen size={15} className="text-amber-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <h4 className="text-sm font-medium text-gray-100 truncate">
                      {studyTitle(s)}
                    </h4>
                    <span className="text-[10px] text-gray-500 flex-shrink-0">
                      {fmtShort(s.date)}
                    </span>
                  </div>
                  {s.topic.trim() && (
                    <div className="text-[11px] text-amber-300/90 mt-0.5 truncate">
                      {s.topic}
                    </div>
                  )}
                  {s.notes.trim() && (
                    <p className="text-xs text-gray-400 mt-2 leading-relaxed line-clamp-2">
                      {preview(s.notes)}
                    </p>
                  )}
                  <div className="flex items-center gap-3 mt-2">
                    <TimeMeta created={s.created} modified={s.modified} />
                    {s.images.length > 0 && (
                      <span className="flex items-center gap-1 text-[10px] text-gray-500">
                        <ImageIcon size={10} /> {s.images.length}
                      </span>
                    )}
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

function StudyDetail({
  study, abbaDir, isEdit, onBack, onUpdate, onDelete,
  pickImages, fetchLinkMeta, onOpenLightbox,
}: {
  study: Study; abbaDir: string; isEdit: boolean;
  onBack: () => void; onUpdate: (patch: Partial<Study>) => void; onDelete: () => void;
  pickImages: () => Promise<string[]>;
  fetchLinkMeta: (url: string) => Promise<Partial<AbbaLink>>;
  onOpenLightbox: (scope: AbbaScope, images: string[], index: number) => void;
}) {
  const scope: AbbaScope = { abbaDir, section: "studies", noteId: study.id };
  const { mode, toggle, setMode } = useNoteMode();
  const [linkDraft, setLinkDraft] = useState("");
  const [savingLink, setSavingLink] = useState(false);
  const dateValue = study.date ? study.date.slice(0, 10) : "";

  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    if (mode === "read" && !study.title.trim() && !study.notes.trim() && !study.topic.trim()) {
      setMode("edit");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUploadImages = async () => {
    const paths = await pickImages();
    if (paths.length === 0) return;
    const newFiles: string[] = [];
    for (const p of paths) {
      try {
        const { fileName } = await saveFileToAbbaNote(abbaDir, "studies", study.id, p);
        newFiles.push(fileName);
      } catch (e) { console.error("[abba] image upload failed:", e); }
    }
    onUpdate({ images: [...study.images, ...newFiles] });
  };

  const removeImage = async (fileName: string) => {
    await deleteAbbaNoteAsset(abbaDir, "studies", study.id, fileName);
    onUpdate({ images: study.images.filter((f) => f !== fileName) });
  };

  const addLink = async () => {
    const url = linkDraft.trim();
    if (!url) return;
    setSavingLink(true);
    const meta = await fetchLinkMeta(url);
    const l: AbbaLink = {
      id: newId("link"), url,
      title: meta.title || url, description: meta.description || "",
      icon: meta.icon || "", image: meta.image || "",
      created: nowIso(), modified: nowIso(),
    };
    onUpdate({ links: [...study.links, l] });
    setLinkDraft("");
    setSavingLink(false);
  };
  const removeLink = (id: string) => onUpdate({ links: study.links.filter((l) => l.id !== id) });

  return (
    <div className="max-w-2xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-8 pb-4 border-b border-[#2a3136] gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-100 transition-colors"
        >
          <ChevronLeft size={14} /><span>All Studies</span>
        </button>
        <div className="flex items-center gap-2">
          {isEdit && (
            <button
              type="button"
              onClick={onDelete}
              className="text-gray-500 hover:text-red-400 p-1.5 rounded transition-colors"
              title="Delete this study"
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

      <input
        type="text"
        value={study.title}
        onChange={(e) => onUpdate({ title: e.target.value })}
        readOnly={!isEdit}
        placeholder="Study title…"
        className={`w-full bg-transparent border-none outline-none text-3xl font-bold tracking-tight px-2 py-1 rounded text-center placeholder-gray-700 ${
          isEdit ? "text-gray-100 focus:bg-white/5" : "text-gray-100 cursor-default"
        }`}
      />

      <div className="flex items-center justify-center gap-2 text-xs text-gray-500 mt-3">
        {isEdit ? (
          <input
            type="date"
            value={dateValue}
            onChange={(e) =>
              onUpdate({ date: new Date(e.target.value + "T12:00:00").toISOString() })
            }
            className="bg-transparent border-none outline-none text-xs text-gray-400 focus:text-gray-200"
          />
        ) : (
          <span>{fmtDate(study.date)}</span>
        )}
      </div>

      <div className="mt-6">
        {isEdit ? (
          <input
            type="text"
            value={study.topic}
            onChange={(e) => onUpdate({ topic: e.target.value })}
            placeholder="Topic / passage (e.g. Romans 8:28)"
            className="w-full bg-transparent border-none outline-none text-sm text-amber-300/90 text-center placeholder-gray-600 focus:bg-white/5 px-2 py-1 rounded"
          />
        ) : study.topic.trim() ? (
          <div className="text-sm text-amber-300/90 font-medium text-center">
            {study.topic}
          </div>
        ) : null}
      </div>

      <div className="mt-8 space-y-8">
        <section>
          {isEdit ? (
            <textarea
              value={study.notes}
              onChange={(e) => onUpdate({ notes: e.target.value })}
              placeholder="Study notes…"
              rows={16}
              className="w-full bg-transparent border-none outline-none text-base text-gray-200 leading-relaxed resize-y placeholder-gray-600 focus:outline-none"
              style={{
                minHeight: "16rem",
                fontFamily: "Georgia, 'Times New Roman', 'Liberation Serif', 'DejaVu Serif', serif",
              }}
            />
          ) : study.notes.trim() ? (
            <div
              className="text-base text-gray-300 leading-loose whitespace-pre-wrap"
              style={{ fontFamily: "Georgia, 'Times New Roman', 'Liberation Serif', 'DejaVu Serif', serif" }}
            >
              {study.notes}
            </div>
          ) : null}
        </section>

        {(study.images.length > 0 || isEdit) && (
          <section>
            <SectionLabel icon={ImageIcon} label="Photos" />
            <PhotoGrid
              scope={scope}
              images={study.images}
              onOpenLightbox={onOpenLightbox}
              onRemove={removeImage}
              isEdit={isEdit}
            />
            {isEdit && (
              <button
                type="button"
                onClick={handleUploadImages}
                className="mt-3 flex items-center gap-1.5 text-xs px-3 py-1.5 bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200"
              >
                <Upload size={12} /> Add photos
              </button>
            )}
          </section>
        )}

        {(study.links.length > 0 || isEdit) && (
          <section className="rounded-lg border border-[#2a3136] bg-[#161a1d] p-4">
            <SectionLabel icon={LinkIcon} label="Links" />
            {study.links.length > 0 && (
              <div className="space-y-1.5 mb-2">
                {study.links.map((l) => (
                  <div
                    key={l.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded bg-[#0f1315] border border-[#2a3136] group"
                  >
                    {l.icon ? (
                      <img
                        src={l.icon} alt=""
                        className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
                        onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                      />
                    ) : (
                      <LinkIcon size={11} className="text-gray-500 flex-shrink-0" />
                    )}
                    <button
                      type="button"
                      onClick={() => openUrl(l.url).catch((err) => console.error("[abba] open link failed:", err))}
                      className="text-xs text-gray-300 hover:text-blue-300 truncate flex-1 text-left"
                      title={l.url}
                    >
                      {l.title || l.url}
                    </button>
                    {isEdit && (
                      <button
                        type="button"
                        onClick={() => removeLink(l.id)}
                        className="text-gray-500 hover:text-red-400 p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X size={11} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {isEdit && (
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={linkDraft}
                  onChange={(e) => setLinkDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addLink(); }}
                  placeholder="Add a link (resource, commentary, video…)"
                  className="flex-1 min-w-0 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={addLink}
                  disabled={!linkDraft.trim() || savingLink}
                  className="flex items-center gap-1 px-2 py-1 text-xs bg-[#2a3136] hover:bg-[#30363d] disabled:opacity-40 border border-[#30363d] rounded text-gray-200 flex-shrink-0"
                >
                  {savingLink ? "…" : <Plus size={11} />}
                </button>
              </div>
            )}
          </section>
        )}
      </div>

      {(study.created || study.modified) && (
        <div className="mt-12 pt-4 border-t border-[#2a3136]">
          <TimeMeta created={study.created} modified={study.modified} align="center" />
        </div>
      )}

      <div className="h-16" />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  LINKS
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
  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-100">Saved Links</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {links.length} {links.length === 1 ? "link" : "links"}
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium"
        >
          <Plus size={13} /> <span>Add Link</span>
        </button>
      </div>

      {links.length === 0 ? (
        <EmptyCTA
          icon={LinkIcon}
          title="No links saved"
          subtitle="Add a sermon video, worship song, commentary, or resource."
          buttonLabel="Add your first link"
          onCreate={onAdd}
        />
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

  const refetch = async () => {
    if (!link.url) return;
    setFetching(true);
    const meta = await fetchLinkMeta(link.url);
    onUpdate({
      title: meta.title || link.title,
      description: meta.description || link.description,
      icon: meta.icon || link.icon,
      image: meta.image || link.image,
    });
    setFetching(false);
  };

  const open = () => {
    if (link.url) openUrl(link.url).catch(console.error);
  };

  if (!isEdit) {
    return (
      <div className="rounded-lg border border-[#2a3136] bg-[#161a1d] overflow-hidden">
        <button
          type="button"
          onClick={open}
          className="w-full text-left flex hover:bg-[#1a1e21] transition-colors"
          title={link.url}
        >
          <div className="flex-1 p-3 min-w-0 flex flex-col justify-center">
            <div className="flex items-center gap-1.5 text-sm text-gray-100 font-medium truncate">
              {link.icon && (
                <img
                  src={link.icon} alt=""
                  className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
                  onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                />
              )}
              <span className="truncate">{link.title || link.url}</span>
            </div>
            {link.description && (
              <div className="text-xs text-gray-400 mt-1 leading-relaxed line-clamp-2">
                {link.description}
              </div>
            )}
          </div>
          {link.image && (
            <div className="w-32 flex-shrink-0 bg-[#0f1315]">
              <img
                src={link.image} alt=""
                className="w-full h-full object-cover"
                onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
              />
            </div>
          )}
        </button>
        {(link.created || link.modified) && (
          <div className="px-3 py-2 border-t border-[#2a3136] bg-[#1a1e21]">
            <TimeMeta created={link.created} modified={link.modified} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[#2a3136] bg-[#161a1d] overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#2a3136] bg-[#1a1e21]">
        {link.icon && (
          <img
            src={link.icon} alt=""
            className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
            onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
          />
        )}
        <input
          type="text"
          value={link.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          placeholder="Title…"
          className="flex-1 bg-transparent border-none outline-none text-sm font-medium text-gray-100 placeholder-gray-600"
        />
        <button
          type="button"
          onClick={refetch}
          disabled={fetching || !link.url}
          className="text-gray-500 hover:text-gray-200 p-1 rounded transition-colors disabled:opacity-40"
          title="Refresh metadata from URL"
        >
          <Save size={12} />
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="text-gray-500 hover:text-red-400 p-1 rounded transition-colors"
          title="Remove"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="p-3 space-y-2">
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={link.url}
            onChange={(e) => onUpdate({ url: e.target.value })}
            onBlur={() => {
              if (link.url && (!link.title || link.title === link.url)) refetch();
            }}
            placeholder="https://…"
            className="flex-1 bg-[#0f1315] border border-[#30363d] rounded px-3 py-1.5 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
          />
          {link.url && (
            <button
              type="button"
              onClick={open}
              className="text-gray-400 hover:text-gray-100 p-1.5 rounded bg-[#2a3136] hover:bg-[#30363d] transition-colors"
              title="Open in browser"
            >
              <ExternalLink size={13} />
            </button>
          )}
        </div>
        <textarea
          value={link.description}
          onChange={(e) => onUpdate({ description: e.target.value })}
          placeholder="Description…"
          rows={2}
          className="w-full bg-[#0f1315] border border-[#30363d] rounded px-3 py-2 text-xs text-gray-300 outline-none focus:ring-1 focus:ring-blue-500 resize-y"
        />
        <div className="pt-2 border-t border-[#2a3136]">
          <TimeMeta created={link.created} modified={link.modified} />
        </div>
      </div>
    </div>
  );
}