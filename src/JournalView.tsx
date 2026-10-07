// src/JournalView.tsx
import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, CalendarDays, Pencil, BookOpen,
  Image as ImageIcon, Smile, X, Palette, Trash2, Type as TypeIcon,
  Sparkles, Sliders, Move, Columns2, Columns3, Columns4, Square,
  GripHorizontal, ArrowUp, ArrowDown, Minus, Upload, Link as LinkIcon,
  List, Code2, Copy, Plus, Check, Download, FileImage, FileText as FileTextIcon,
  Maximize2, Minimize2, LayoutGrid, Loader2, AlertTriangle,
  ZoomIn, ZoomOut,
} from "lucide-react";
import {
  mkdir, exists, rename as renameFs, readDir, readTextFile, writeFile, readFile,
} from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { toCanvas } from "html-to-image";
import jsPDF from "jspdf";
import EmojiPicker, { Theme, EmojiStyle } from "emoji-picker-react";
import NoteBody, { type NoteBodyHandle } from "./NoteBody";
import JournalTimeline from "./JournalTimeline";
import PhotoLightbox from "./PhotoLightbox";
import { useNoteMode } from "./useNoteMode";
import { useModal } from "./Modal";
import { parseNoteFile, type Frontmatter } from "./noteFormat";
import { saveImageToNoteAssets, assetUrlToAbsolutePath } from "./imageAssets";

interface JournalViewProps {
  vaultPath: string;
  journalDir: string;
  initialDate?: { year: number; month: number; day: number };
  initialMode?: "day" | "month";
  focusMode?: boolean;
  onToggleFocus?: () => void;
  onOpenNoteByPath?: (path: string) => void;
}

const TRANSPARENT_PX =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

const EXPORT_WIDTH_PRESETS = [900, 1200, 1600, 2200, 3000];

const CANVAS_MAX_DIM = 16000;
const CANVAS_MAX_AREA = 16_000_000;

function computeEffectiveRatio(
  cssWidth: number,
  cssHeight: number,
  requestedRatio: number
): number {
  let r = requestedRatio;
  if (r <= 0 || cssWidth <= 0 || cssHeight <= 0) return r;
  const maxDim = Math.max(cssWidth * r, cssHeight * r);
  if (maxDim > CANVAS_MAX_DIM) r *= CANVAS_MAX_DIM / maxDim;
  const area = cssWidth * r * cssHeight * r;
  if (area > CANVAS_MAX_AREA) r *= Math.sqrt(CANVAS_MAX_AREA / area);
  return Math.max(0.05, r);
}

function pad(n: number) { return n.toString().padStart(2, "0"); }

function formatDayName(year: number, month: number, day: number): string {
  const d = new Date(year, month - 1, day);
  return `${d.toLocaleString("en-US", { month: "long" })} ${day}, ${year}`;
}

function formatDate(iso?: unknown): string {
  if (typeof iso !== "string" || !iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString("en-US", {
      year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch { return iso; }
}

type Anchor = "above" | "in" | "below";

function resolveCoverUrl(value: string): string {
  if (!value) return "";
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  try { return convertFileSrc(value); } catch { return value; }
}

function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif":  return "image/gif";
    case "svg":  return "image/svg+xml";
    case "avif": return "image/avif";
    case "bmp":  return "image/bmp";
    default:     return "image/png";
  }
}

const COVER_GRADIENTS: { id: string; label: string; value: string }[] = [
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

const TITLE_FONTS: { id: string; label: string; stack: string }[] = [
  { id: "default",     label: "Default",      stack: "inherit" },
  { id: "serif",       label: "Serif",        stack: "Georgia, 'Times New Roman', 'Liberation Serif', 'DejaVu Serif', serif" },
  { id: "mono",        label: "Mono",         stack: "'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace" },
  { id: "rounded",     label: "Rounded",      stack: "'SF Pro Rounded', 'Nunito', 'Quicksand', system-ui, sans-serif" },
  { id: "cursive",     label: "Cursive",      stack: "'Brush Script MT', 'URW Chancery L', 'Z003', 'Apple Chancery', 'Lucida Handwriting', cursive" },
  { id: "elegant",     label: "Elegant",      stack: "'URW Bookman L', 'Bookman Old Style', Georgia, 'DejaVu Serif', serif" },
  { id: "display",     label: "Display",      stack: "Impact, 'Haettenschweiler', 'Arial Narrow Bold', 'Liberation Sans Narrow', sans-serif" },
  { id: "handwritten", label: "Handwritten",  stack: "'Comic Sans MS', 'Chalkboard SE', 'Comic Neue', 'Segoe Print', cursive" },
  { id: "italic",      label: "Italic Serif", stack: "Georgia, 'Liberation Serif', serif" },
];

const DOC_WIDTHS = [
  { id: "narrow",  label: "Narrow",  icon: Square,   wrap: "max-w-xl w-full mx-auto px-10" },
  { id: "default", label: "Default", icon: Columns2, wrap: "max-w-3xl w-full mx-auto px-10" },
  { id: "wide",    label: "Wide",    icon: Columns3, wrap: "max-w-5xl w-full mx-auto px-10" },
  { id: "full",    label: "Full",    icon: Columns4, wrap: "w-full px-16" },
] as const;

type DocWidthId = (typeof DOC_WIDTHS)[number]["id"];

function fmValueToString(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return `[${v.join(", ")}]`;
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function stringToFmValue(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith("[") && s.endsWith("]")) {
    return s.slice(1, -1).split(",").map(x => x.trim()).filter(Boolean);
  }
  return s;
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK))
    );
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function waitForImageReady(img: HTMLImageElement): Promise<void> {
  return new Promise((resolve) => {
    if (img.complete && img.naturalWidth > 0) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      img.removeEventListener("load", finish);
      img.removeEventListener("error", finish);
      resolve();
    };
    img.addEventListener("load", finish);
    img.addEventListener("error", finish);
    setTimeout(finish, 6000);
  });
}

// ─── Data-URL cache + inliners ──────────────────────────────────────────────
// Cache keyed by the *original* src so a preview pass and the real export
// pass don't re-read the same files off disk.
const dataUrlCache = new Map<string, string>();

/**
 * Turn any image src (asset://, blob:, file path, http(s), data:) into a
 * data: URL that html-to-image can embed without re-fetching. Returns null
 * if the source could not be resolved.
 */
async function toDataUrl(src: string): Promise<string | null> {
  if (!src) return null;
  if (src.startsWith("data:")) return src;

  const cached = dataUrlCache.get(src);
  if (cached) return cached;

  // blob:
  if (src.startsWith("blob:")) {
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      const d = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
      dataUrlCache.set(src, d);
      return d;
    } catch (e) {
      console.warn("[export] blob fetch failed:", src, e);
      return null;
    }
  }

  // asset:// / http://asset.localhost/...
  const assetAbs = assetUrlToAbsolutePath(src);
  if (assetAbs) {
    try {
      const bytes = await readFile(assetAbs);
      const ext = assetAbs.split(".").pop() || "png";
      const d = bytesToDataUrl(bytes, mimeForExt(ext));
      dataUrlCache.set(src, d);
      return d;
    } catch (e) {
      console.warn("[export] readFile (asset) failed:", assetAbs, e);
    }
  }

  // Absolute filesystem path
  if (/^([a-zA-Z]:[\\/]|\/)/.test(src)) {
    try {
      const bytes = await readFile(src);
      const ext = src.split(".").pop() || "png";
      const d = bytesToDataUrl(bytes, mimeForExt(ext));
      dataUrlCache.set(src, d);
      return d;
    } catch (e) {
      console.warn("[export] readFile failed:", src, e);
    }
  }

  // http(s) — route through the Rust command so CORS doesn't bite.
  if (/^https?:\/\//i.test(src)) {
    try {
      const d = await invoke<string>("fetch_image_data_url", { url: src });
      if (d && d.startsWith("data:")) {
        dataUrlCache.set(src, d);
        return d;
      }
    } catch (e) {
      console.warn("[export] remote fetch failed:", src, e);
    }
  }

  return null;
}

/**
 * Fallback for when the file-based inliner fails: draw the already-loaded
 * <img> to a canvas and export it as a PNG data URL. This works because
 * the browser has the decoded pixels in memory; we don't need to re-read
 * the file from disk.
 *
 * Fails (with a SecurityError) only if the image is cross-origin AND the
 * server doesn't send CORS headers.
 */
async function imgToDataUrlViaCanvas(
  img: HTMLImageElement
): Promise<string | null> {
  try {
    if (!img.complete || img.naturalWidth === 0) {
      await waitForImageReady(img);
    }
    if (img.naturalWidth === 0 || img.naturalHeight === 0) {
      console.warn("[export] canvas fallback: zero natural dimensions", img.src);
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const url = canvas.toDataURL("image/png");
    dataUrlCache.set(img.src, url);
    return url;
  } catch (e) {
    console.warn("[export] canvas fallback failed (likely CORS):", img.src, e);
    return null;
  }
}

interface RenderResult {
  canvas: HTMLCanvasElement;
  cssWidth: number;
  cssHeight: number;
  outputWidth: number;
  outputHeight: number;
  requestedRatio: number;
  effectiveRatio: number;
  capped: boolean;
}

export default function JournalView({
  vaultPath,
  journalDir,
  initialDate,
  initialMode,
  focusMode = false,
  onToggleFocus,
  onOpenNoteByPath,
}: JournalViewProps) {
  const [date, setDate] = useState(() =>
    initialDate
      ? new Date(initialDate.year, initialDate.month - 1, initialDate.day)
      : new Date()
  );
  const [mode, setMode] = useState<"day" | "month">(initialMode || "day");
  const [viewMode, setViewMode] = useState<"day" | "timeline">("day");
  const [dayPath, setDayPath] = useState<string | null>(null);
  const [monthPath, setMonthPath] = useState<string | null>(null);

  const { mode: noteMode, toggle: toggleNoteMode } = useNoteMode();
  const { modal, confirmAsync } = useModal();
  const noteBodyRef = useRef<NoteBodyHandle>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const [icon, setIcon] = useState("");
  const [showHeaderIcon, setShowHeaderIcon] = useState(true);
  const [title, setTitle] = useState("");
  const [coverType, setCoverType] = useState("");
  const [coverValue, setCoverValue] = useState("");
  const [coverPosX, setCoverPosX] = useState(50);
  const [coverPosY, setCoverPosY] = useState(50);
  const [coverOpacity, setCoverOpacity] = useState(100);
  const [coverBlur, setCoverBlur] = useState(0);
  const [coverRadius, setCoverRadius] = useState(0);
  const [coverFeather, setCoverFeather] = useState(0);
  const [coverTextShadow, setCoverTextShadow] = useState(true);
  const [iconAnchor, setIconAnchor] = useState<Anchor>("in");
  const [iconX, setIconX] = useState(8);
  const [iconY, setIconY] = useState(50);
  const [titleAnchor, setTitleAnchor] = useState<Anchor>("in");
  const [titleX, setTitleX] = useState(50);
  const [titleY, setTitleY] = useState(50);
  const [titleFont, setTitleFont] = useState("default");
  const [docWidth, setDocWidth] = useState<DocWidthId>("default");
  const [createdAt, setCreatedAt] = useState<string>("");
  const [modifiedAt, setModifiedAt] = useState<string>("");
  const [wordCount, setWordCount] = useState(0);

  const [lightbox, setLightbox] = useState<
    { srcs: string[]; index: number } | null
  >(null);

  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [properties, setProperties] = useState<Record<string, unknown>>({});
  const [rawSource, setRawSource] = useState("");
  const [sourceDraft, setSourceDraft] = useState("");
  const [sourceSaving, setSourceSaving] = useState(false);
  const [sourceNonce, setSourceNonce] = useState(0);
  const [newPropKey, setNewPropKey] = useState("");
  const [newPropValue, setNewPropValue] = useState("");
  const [copied, setCopied] = useState(false);

  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  const [widthMenuOpen, setWidthMenuOpen] = useState(false);
  const [coverUrlDraft, setCoverUrlDraft] = useState("");
  const [iconMenu, setIconMenu] = useState<{ x: number; y: number } | null>(null);
  const [titleMenu, setTitleMenu] = useState<{ x: number; y: number } | null>(null);

  const [pickerPos, setPickerPos] = useState({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState<
    { mx: number; my: number; px: number; py: number } | null
  >(null);

  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportTargetWidth, setExportTargetWidth] = useState(1200);
  const [exportCustomWidth, setExportCustomWidth] = useState("");
  const [exportFormat, setExportFormat] = useState<"png" | "pdf">("png");
  const [exportFilename, setExportFilename] = useState("");
  const [exportPreviewUrl, setExportPreviewUrl] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<RenderResult | null>(null);
  const [exportPhase, setExportPhase] = useState<"idle" | "preview" | "exporting">("idle");
  const [exportError, setExportError] = useState<string | null>(null);
  const [previewZoom, setPreviewZoom] = useState(0);

  const iconMenuRef = useRef<HTMLDivElement>(null);
  const titleMenuRef = useRef<HTMLDivElement>(null);
  const widthMenuRef = useRef<HTMLButtonElement>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const monthName = date.toLocaleString("en-US", { month: "long" });
  const dayName = formatDayName(year, month + 1, day);

  const currentPath = mode === "day" ? dayPath : monthPath;
  const hasCover = coverType === "color" || coverType === "image";
  const fontStack = TITLE_FONTS.find((f) => f.id === titleFont)?.stack || "inherit";
  const widthOption = DOC_WIDTHS.find((w) => w.id === docWidth) || DOC_WIDTHS[1];
  const contentWrap = widthOption.wrap;
  const WidthIcon = widthOption.icon;

  const hasAboveContent =
    (iconAnchor === "above" && showHeaderIcon && (icon || noteMode === "edit")) ||
    (titleAnchor === "above" && (title || noteMode === "edit"));
  const hasBelowContent =
    (iconAnchor === "below" && showHeaderIcon && (icon || noteMode === "edit")) ||
    (titleAnchor === "below" && (title || noteMode === "edit"));
  const hasInZoneContent =
    (iconAnchor === "in" && showHeaderIcon && (icon || noteMode === "edit")) ||
    (titleAnchor === "in" && (title || noteMode === "edit"));

  const exporting = exportPhase !== "idle";

  const showCoverStrip =
    hasCover || hasInZoneContent || (noteMode === "edit" && !exporting);

  const coverStripHeight = hasCover ? "h-56" : hasInZoneContent ? "h-32" : "h-10";

  useEffect(() => {
    setIcon(""); setShowHeaderIcon(true); setTitle("");
    setCoverType(""); setCoverValue("");
    setCoverPosX(50); setCoverPosY(50);
    setCoverOpacity(100); setCoverBlur(0);
    setCoverRadius(0); setCoverFeather(0);
    setCoverTextShadow(true);
    setIconAnchor("in"); setIconX(8); setIconY(50);
    setTitleAnchor("in"); setTitleX(50); setTitleY(50);
    setTitleFont("default"); setDocWidth("default");
    setCreatedAt(""); setModifiedAt(""); setWordCount(0);
    setIconPickerOpen(false); setCoverPickerOpen(false);
    setWidthMenuOpen(false); setCoverUrlDraft("");
    setIconMenu(null); setTitleMenu(null); setDragStart(null);
    setPropertiesOpen(false); setSourceOpen(false); setSourceDraft("");
    setExportDialogOpen(false); setExportPreviewUrl(null);
    setExportResult(null); setExportError(null); setExportPhase("idle");
  }, [currentPath]);

  useEffect(() => {
    if (!currentPath) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.path !== currentPath) return;
      (async () => {
        try {
          const raw = await readTextFile(currentPath);
          const { frontmatter } = parseNoteFile(raw);
          setIcon((frontmatter.icon as string) || "");
          setShowHeaderIcon(frontmatter.showHeaderIcon !== false);
          setCreatedAt((frontmatter.created as string) || "");
          setModifiedAt((frontmatter.modified as string) || "");
        } catch (err) { console.error("[journal] sync failed:", err); }
      })();
    };
    window.addEventListener("note-frontmatter-changed", handler);
    return () => window.removeEventListener("note-frontmatter-changed", handler);
  }, [currentPath]);

  useEffect(() => {
    if (!currentPath) return;
    const onFocus = async () => {
      try {
        const raw = await readTextFile(currentPath);
        const { frontmatter } = parseNoteFile(raw);
        setIcon((frontmatter.icon as string) || "");
        setShowHeaderIcon(frontmatter.showHeaderIcon !== false);
        setCreatedAt((frontmatter.created as string) || "");
        setModifiedAt((frontmatter.modified as string) || "");
      } catch {}
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [currentPath]);

  useEffect(() => {
    if (!dragStart) return;
    const onMove = (e: MouseEvent) => {
      setPickerPos({
        x: dragStart.px + (e.clientX - dragStart.mx),
        y: dragStart.py + (e.clientY - dragStart.my),
      });
    };
    const onUp = () => setDragStart(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragStart]);

  useEffect(() => {
    if (!coverPickerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCoverPickerOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [coverPickerOpen]);

  useEffect(() => {
    if (!propertiesOpen && !sourceOpen && !exportDialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (exportPhase === "exporting") return;
      if (propertiesOpen) setPropertiesOpen(false);
      if (sourceOpen) setSourceOpen(false);
      if (exportDialogOpen) setExportDialogOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [propertiesOpen, sourceOpen, exportDialogOpen, exportPhase]);

  useEffect(() => {
    if (!iconMenu) return;
    const onDown = (e: MouseEvent) => {
      if (iconMenuRef.current?.contains(e.target as Node)) return;
      setIconMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setIconMenu(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [iconMenu]);

  useEffect(() => {
    if (!titleMenu) return;
    const onDown = (e: MouseEvent) => {
      if (titleMenuRef.current?.contains(e.target as Node)) return;
      setTitleMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTitleMenu(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [titleMenu]);

  useEffect(() => {
    if (!widthMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (widthMenuRef.current?.contains(t)) return;
      const menu = document.getElementById("journal-width-menu");
      if (menu?.contains(t)) return;
      setWidthMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [widthMenuOpen]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const monthDir = await join(journalDir, String(year), pad(month + 1));
      const dPath = await join(monthDir, `${dayName}.note`);
      const mPath = await join(monthDir, `_${year}-${pad(month + 1)}-Month.note`);
      try { await mkdir(monthDir, { recursive: true }); } catch (e) {
        console.error("[journal] could not create month dir:", monthDir, e);
      }
      try {
        if (await exists(monthDir)) {
          const entries = await readDir(monthDir);
          for (const entry of entries) {
            const n = entry.name;
            if (!n || !/\.md$/.test(n) || !/^_.+-Month\.md$/.test(n)) continue;
            const np = await join(monthDir, n.replace(/\.md$/, ".note"));
            try {
              if (!(await exists(np))) await renameFs(await join(monthDir, n), np);
            } catch {}
          }
        }
      } catch {}
      if (mounted) {
        setDayPath(dPath); setMonthPath(mPath);
        window.dispatchEvent(new CustomEvent("folder-changed", { detail: { path: monthDir } }));
        window.dispatchEvent(new CustomEvent("journal-date-changed", {
          detail: { year, month: month + 1, day, dir: journalDir },
        }));
      }
    })();
    return () => { mounted = false; };
  }, [journalDir, year, month, day, dayName]);

  const shiftDay = (delta: number) => {
    const d = new Date(date); d.setDate(d.getDate() + delta);
    setDate(d); setMode("day");
  };
  const shiftMonth = (delta: number) => {
    const d = new Date(date);
    const keepDay = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + delta);
    const maxDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(keepDay, maxDay));
    setDate(d);
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (viewMode !== "day") return;
      if (lightbox) return;
      const active = document.activeElement as HTMLElement | null;
      if (
        active?.closest(".ProseMirror") ||
        active?.tagName === "INPUT" || active?.tagName === "TEXTAREA"
      ) return;
      if (propertiesOpen || sourceOpen || coverPickerOpen || exportDialogOpen || exporting) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); shiftDay(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); shiftDay(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); shiftMonth(-1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); shiftMonth(1); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, viewMode, propertiesOpen, sourceOpen, coverPickerOpen, exportDialogOpen, exporting, lightbox]);

  const openProperties = async () => {
    if (!currentPath) return;
    try {
      const raw = await readTextFile(currentPath);
      const { frontmatter } = parseNoteFile(raw);
      setProperties(frontmatter as Record<string, unknown>);
      setNewPropKey(""); setNewPropValue("");
      setPropertiesOpen(true);
    } catch (e) { console.error("[journal] read properties failed:", e); }
  };

  const openSource = async () => {
    if (!currentPath) return;
    try {
      const raw = await readTextFile(currentPath);
      setRawSource(raw); setSourceDraft(raw); setCopied(false);
      setSourceOpen(true);
    } catch (e) { console.error("[journal] read source failed:", e); }
  };

  const refreshFrontmatterFromDisk = async () => {
    if (!currentPath) return;
    try {
      const raw = await readTextFile(currentPath);
      const { frontmatter } = parseNoteFile(raw);
      setProperties(frontmatter as Record<string, unknown>);
      setIcon((frontmatter.icon as string) || "");
      setShowHeaderIcon(frontmatter.showHeaderIcon !== false);
      setTitle((frontmatter.title as string) || "");
      setCoverType((frontmatter.coverType as string) || "");
      setCoverValue((frontmatter.coverValue as string) || "");
      setCreatedAt((frontmatter.created as string) || "");
      setModifiedAt((frontmatter.modified as string) || "");
    } catch (e) { console.error("[journal] refresh failed:", e); }
  };

  const updateProperty = async (key: string, value: string) => {
    const parsed = stringToFmValue(value);
    setProperties((prev) => ({ ...prev, [key]: parsed }));
    await noteBodyRef.current?.updateFrontmatter({ [key]: parsed });
    await refreshFrontmatterFromDisk();
  };

  const deleteProperty = async (key: string) => {
    const ok = await confirmAsync(`Remove property "${key}"?`);
    if (!ok) return;
    setProperties((prev) => { const n = { ...prev }; delete n[key]; return n; });
    await noteBodyRef.current?.updateFrontmatter({ [key]: "" });
    await refreshFrontmatterFromDisk();
  };

  const addProperty = async () => {
    const key = newPropKey.trim(); if (!key) return;
    const parsed = stringToFmValue(newPropValue);
    setProperties((prev) => ({ ...prev, [key]: parsed }));
    setNewPropKey(""); setNewPropValue("");
    await noteBodyRef.current?.updateFrontmatter({ [key]: parsed });
    await refreshFrontmatterFromDisk();
  };

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(sourceDraft);
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch (e) { console.error("[journal] copy failed:", e); }
  };

  const saveSource = async () => {
    if (!currentPath) return;
    setSourceSaving(true);
    try {
      try { await noteBodyRef.current?.flush(); } catch (e) {
        console.warn("[journal] flush before save failed:", e);
      }
      await writeFile(currentPath, new TextEncoder().encode(sourceDraft));
      setRawSource(sourceDraft); setSourceNonce((n) => n + 1);
      await refreshFrontmatterFromDisk();
      window.dispatchEvent(new CustomEvent("file-changed", { detail: { path: currentPath } }));
      window.dispatchEvent(new CustomEvent("note-frontmatter-changed", { detail: { path: currentPath } }));
    } catch (e) { console.error("[journal] save source failed:", e); }
    setSourceSaving(false);
  };

  const revertSource = () => setSourceDraft(rawSource);

  // ======================================================================
  //  EXPORT
  //
  //  Strategy:
  //   1. Clone the content into an off-screen wrapper FIRST. Never mutate
  //      the live DOM — otherwise a failed inline leaves the on-screen
  //      note with a transparent pixel and the user has to refresh.
  //   2. Inline every <img> src *inside the clone* as data URLs. Try the
  //      file-based inliner first; if it fails, fall back to grabbing the
  //      pixels from the already-loaded live <img> via a <canvas>. This
  //      covers asset:// paths, restricted readFile permissions, and any
  //      other case where reading the source is impossible but the browser
  //      has the image in memory.
  //   3. Inline the cover background the same way.
  //   4. Do NOT pass imagePlaceholder — it silently swaps any image
  //      html-to-image can't re-fetch for a transparent 1×1 GIF.
  //   5. Do NOT pass width/height + pixelRatio together — html-to-image
  //      multiplies them, producing a bitmap scaled twice.
  // ======================================================================

  const relaxWidthConstraints = (root: HTMLElement, targetWidth: number) => {
    const all = Array.from(root.querySelectorAll<HTMLElement>("*"));
    all.push(root);
    let cleared = 0;
    for (const el of all) {
      const cs = getComputedStyle(el);
      const mw = cs.maxWidth;
      if (!mw || mw === "none" || !mw.endsWith("px")) continue;
      const px = parseFloat(mw);
      if (!Number.isFinite(px) || px <= 0) continue;
      if (px < targetWidth * 0.92) {
        el.style.maxWidth = "none";
        cleared++;
      }
    }
    console.log("[export] cleared", cleared, "max-width constraint(s)");
  };

  const renderNoteToCanvas = async (
    cssWidth: number,
    requestedPixelRatio: number
  ): Promise<RenderResult | null> => {
    const el = contentRef.current;
    if (!el) {
      console.warn("[export] contentRef is null");
      return null;
    }

    // ---- 1. Clone into an off-screen wrapper. Live DOM is untouched. ----
    const wrapper = document.createElement("div");
    wrapper.style.cssText = `
      position: fixed; top: 0; left: 0;
      z-index: -2147483648;
      width: ${cssWidth}px;
      background: #0f1315;
      pointer-events: none;
      overflow: hidden;
    `;

    const clone = el.cloneNode(true) as HTMLElement;
    clone.style.cssText = `
      position: relative !important;
      top: 0 !important; left: 0 !important;
      right: auto !important; bottom: auto !important;
      width: ${cssWidth}px !important;
      min-width: ${cssWidth}px !important;
      max-width: ${cssWidth}px !important;
      height: auto !important;
      min-height: 0 !important;
      max-height: none !important;
      overflow: visible !important;
      flex: none !important;
      align-self: auto !important;
      margin: 0 !important;
      padding: 0 !important;
      background: #0f1315 !important;
      transform: none !important;
    `;

    wrapper.appendChild(clone);
    document.body.appendChild(wrapper);

    try {
      // Two frames so the clone's initial layout settles.
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r()))
      );

      // ---- 2. Relax inner width constraints so content actually reflows. ----
      relaxWidthConstraints(clone, cssWidth);

      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r()))
      );

      // ---- 3. Inline <img> srcs INSIDE THE CLONE. ----
      //
      // We have two ways to get a data URL for each image:
      //   a. toDataUrl(src) — reads the file from disk. Fast, but requires
      //      the path to resolve and readFile to be permitted.
      //   b. imgToDataUrlViaCanvas(origImg) — grabs pixels from the img
      //      that is already rendered in the live DOM. Slower, but immune
      //      to path/permission issues.
      //
      // Try (a) first, fall back to (b), then finally TRANSPARENT_PX so the
      // layout is preserved even if both fail.
      const originalImgs = Array.from(
        el.querySelectorAll("img")
      ) as HTMLImageElement[];
      const cloneImgs = Array.from(
        clone.querySelectorAll("img")
      ) as HTMLImageElement[];

      const inlineResults = await Promise.all(
        cloneImgs.map(async (cloneImg, i) => {
          const src = cloneImg.getAttribute("src") || "";

          let dataUrl = await toDataUrl(src);
          let via: "read" | "canvas" | "none" = dataUrl ? "read" : "none";

          if (!dataUrl) {
            const origImg = originalImgs[i];
            if (origImg && (origImg.getAttribute("src") || "") === src) {
              dataUrl = await imgToDataUrlViaCanvas(origImg);
              if (dataUrl) via = "canvas";
            } else {
              console.warn(
                "[export] no matching original <img> for clone index", i, src
              );
            }
          }

          // Strip attributes that stop html-to-image from waiting on
          // decode (lazy) or that point at stale srcset entries.
          cloneImg.removeAttribute("srcset");
          cloneImg.removeAttribute("sizes");
          cloneImg.removeAttribute("loading");
          cloneImg.setAttribute("src", dataUrl || TRANSPARENT_PX);
          return { src, ok: !!dataUrl, via };
        })
      );

      const inlined = inlineResults.filter((r) => r.ok).length;
      console.log(
        "[export] inlined", inlined, "/", cloneImgs.length, "image(s)"
      );
      for (const r of inlineResults) {
        if (r.ok) {
          console.log("[export]   ok  [", r.via, "]", r.src);
        } else {
          console.warn("[export]   FAIL", r.src);
        }
      }

      await Promise.all(cloneImgs.map(waitForImageReady));

      // ---- 4. Inline the cover background INSIDE THE CLONE. ----
      if (coverType === "image" && coverValue) {
        const coverEl = clone.querySelector(
          "[data-cover-layer]"
        ) as HTMLElement | null;
        if (!coverEl) {
          console.warn("[export] [data-cover-layer] not found in clone");
        } else {
          let dataUrl = await toDataUrl(coverValue);

          // Fallback: let the browser fetch it (works for http(s) even
          // without the Rust command, and for asset:// in some configs).
          if (!dataUrl) {
            try {
              console.log("[export] cover: trying browser fetch fallback");
              const res = await fetch(resolveCoverUrl(coverValue));
              const blob = await res.blob();
              dataUrl = await new Promise<string>((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(r.result as string);
                r.onerror = reject;
                r.readAsDataURL(blob);
              });
            } catch (e) {
              console.warn("[export] cover browser fetch also failed:", e);
            }
          }

          if (dataUrl) {
            await new Promise<void>((resolve) => {
              const probe = new Image();
              probe.onload = () => resolve();
              probe.onerror = () => resolve();
              probe.src = dataUrl!;
            });
            coverEl.style.backgroundImage = `url("${dataUrl}")`;
            console.log("[export] cover inlined ok");
          } else {
            console.warn("[export] cover could not be inlined:", coverValue);
          }
        }
      }

      // One more frame for the reflow/inline to settle.
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r()))
      );

      const cssHeight = clone.scrollHeight;
      const effectiveRatio = computeEffectiveRatio(
        cssWidth, cssHeight, requestedPixelRatio
      );
      const outputWidth = Math.round(cssWidth * effectiveRatio);
      const outputHeight = Math.round(cssHeight * effectiveRatio);
      const capped = effectiveRatio < requestedPixelRatio * 0.995;

      console.log(
        "[export] css", cssWidth, "×", cssHeight,
        "· ratio", requestedPixelRatio, "→", effectiveRatio.toFixed(3),
        "· output", outputWidth, "×", outputHeight,
        capped ? "(capped)" : ""
      );

      // ---- 5. Render. Only pixelRatio scales. No width/height, no
      //         imagePlaceholder — we want failures to be loud, not
      //         silently transparent. ----
      const canvas = await toCanvas(clone, {
        backgroundColor: "#0f1315",
        pixelRatio: effectiveRatio,
        cacheBust: false,
      });

      return {
        canvas,
        cssWidth,
        cssHeight,
        outputWidth,
        outputHeight,
        requestedRatio: requestedPixelRatio,
        effectiveRatio,
        capped,
      };
    } finally {
      try { document.body.removeChild(wrapper); } catch {}
    }
  };

  const openExportDialog = () => {
    setExportFormat("png");
    setExportFilename(dayName);
    setExportTargetWidth(1200);
    setExportCustomWidth("");
    setExportPreviewUrl(null);
    setExportResult(null);
    setExportError(null);
    setPreviewZoom(0);
    setExportDialogOpen(true);
  };

  // ---------- Live preview ----------
  useEffect(() => {
    if (!exportDialogOpen) return;
    let cancelled = false;

    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(async () => {
      if (cancelled) return;
      setExportPhase("preview");
      setExportError(null);

      try {
        const result = await renderNoteToCanvas(exportTargetWidth, 1);
        if (cancelled) return;
        if (!result) { setExportError("Could not render the preview."); return; }
        const url = result.canvas.toDataURL("image/png");
        if (cancelled) return;
        setExportPreviewUrl(url);
        setExportResult(result);
        setPreviewZoom(0);
      } catch (e: any) {
        if (cancelled) return;
        console.error("[export] preview failed:", e);
        setExportError(e?.message ?? String(e));
      } finally {
        if (!cancelled) setExportPhase("idle");
      }
    }, 220);

    return () => {
      cancelled = true;
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
        previewTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportDialogOpen, exportTargetWidth, currentPath, coverType, coverValue]);

  const runExport = async () => {
    if (!exportFilename.trim() || !currentPath) return;
    setExportError(null);
    setExportPhase("exporting");

    try {
      const result = await renderNoteToCanvas(exportTargetWidth, 1);
      if (!result) { setExportError("Render failed."); return; }

      const { canvas } = result;
      const safeName =
        exportFilename.trim().replace(/[\\/:*?"<>|]/g, "-") || dayName;

      if (exportFormat === "png") {
        const dataUrl = canvas.toDataURL("image/png");
        const base64 = dataUrl.split(",")[1];
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const target = await save({
          defaultPath: `${safeName}.png`,
          filters: [{ name: "PNG Image", extensions: ["png"] }],
        });
        if (!target) return;
        await writeFile(target, bytes);
      } else {
        const imgData = canvas.toDataURL("image/png");
        const A4_W = 595.28;
        const imgW = A4_W;
        const imgH = (canvas.height * imgW) / canvas.width;
        const pdf = new jsPDF({
          unit: "pt",
          format: [imgW, imgH],
          orientation: imgH > imgW ? "portrait" : "landscape",
          compress: true,
        });
        pdf.addImage(imgData, "PNG", 0, 0, imgW, imgH, undefined, "FAST");
        const pdfBytes = pdf.output("arraybuffer");
        const target = await save({
          defaultPath: `${safeName}.pdf`,
          filters: [{ name: "PDF Document", extensions: ["pdf"] }],
        });
        if (!target) return;
        await writeFile(target, new Uint8Array(pdfBytes));
      }

      setExportDialogOpen(false);
    } catch (e: any) {
      console.error("[export] failed:", e);
      setExportError(e?.message ?? String(e));
    } finally {
      setExportPhase("idle");
    }
  };

  // ------------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------------

  const applyIcon = async (newIcon: string) => {
    setIcon(newIcon); setIconPickerOpen(false); setIconMenu(null);
    await noteBodyRef.current?.updateFrontmatter({ icon: newIcon });
  };

  const toggleShowHeaderIcon = () => {
    const next = !showHeaderIcon;
    setShowHeaderIcon(next);
    noteBodyRef.current?.updateFrontmatter({ showHeaderIcon: next });
  };

  const openIconPicker = () => {
    if (noteMode !== "edit") return;
    setIconPickerOpen(true); setIconMenu(null);
  };

  const handleIconContextMenu = (e: React.MouseEvent) => {
    if (noteMode !== "edit") return;
    e.preventDefault(); e.stopPropagation();
    setIconMenu({ x: e.clientX, y: e.clientY });
    setIconPickerOpen(false);
  };

  const confirmRemoveIcon = async () => {
    setIconMenu(null);
    const ok = await confirmAsync("Remove this icon? This will also remove it from the sidebar.");
    if (ok) await applyIcon("");
  };

  const resetIconPosition = async () => {
    setIconX(8); setIconY(50); setIconAnchor("in"); setIconMenu(null);
    await noteBodyRef.current?.updateFrontmatter({ iconX: 8, iconY: 50, iconAnchor: "in" });
  };

  const saveTitle = async () => {
    const trimmed = title.trim();
    await noteBodyRef.current?.updateFrontmatter({ title: trimmed });
  };

  const handleTitleContextMenu = (e: React.MouseEvent) => {
    if (noteMode !== "edit") return;
    e.preventDefault(); e.stopPropagation();
    setTitleMenu({ x: e.clientX, y: e.clientY });
  };

  const applyCover = async (type: string, value: string) => {
    setCoverType(type); setCoverValue(value); setCoverUrlDraft("");
    setCoverPosX(50); setCoverPosY(50);
    await noteBodyRef.current?.updateFrontmatter({
      coverType: type, coverValue: value, coverPosX: 50, coverPosY: 50,
    });
  };

  const uploadCover = async () => {
    if (!currentPath) return;
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg"] }],
      });
      if (!picked || typeof picked !== "string") return;
      const ext = (picked.split(".").pop() || "png").toLowerCase();
      const destPath = await saveImageToNoteAssets(
        currentPath, picked, `cover-${Date.now()}.${ext}`
      );
      await applyCover("image", destPath);
    } catch (e) { console.error("[journal] upload cover failed:", e); }
  };

  const updateCoverStyle = (patch: {
    opacity?: number; blur?: number; radius?: number; feather?: number;
    posX?: number; posY?: number;
  }) => {
    if (patch.opacity !== undefined) setCoverOpacity(patch.opacity);
    if (patch.blur !== undefined) setCoverBlur(patch.blur);
    if (patch.radius !== undefined) setCoverRadius(patch.radius);
    if (patch.feather !== undefined) setCoverFeather(patch.feather);
    if (patch.posX !== undefined) setCoverPosX(patch.posX);
    if (patch.posY !== undefined) setCoverPosY(patch.posY);

    const fm: Record<string, any> = {};
    if (patch.opacity !== undefined) fm.coverOpacity = patch.opacity;
    if (patch.blur !== undefined) fm.coverBlur = patch.blur;
    if (patch.radius !== undefined) fm.coverRadius = patch.radius;
    if (patch.feather !== undefined) fm.coverFeather = patch.feather;
    if (patch.posX !== undefined) fm.coverPosX = patch.posX;
    if (patch.posY !== undefined) fm.coverPosY = patch.posY;
    noteBodyRef.current?.updateFrontmatter(fm);
  };

  const removeCover = async () => {
    setCoverType(""); setCoverValue("");
    setCoverPosX(50); setCoverPosY(50);
    setCoverOpacity(100); setCoverBlur(0);
    setCoverRadius(0); setCoverFeather(0);
    setCoverPickerOpen(false);
    await noteBodyRef.current?.updateFrontmatter({
      coverType: "", coverValue: "", coverPosX: 50, coverPosY: 50,
      coverOpacity: 100, coverBlur: 0, coverRadius: 0, coverFeather: 0,
    });
  };

  const applyTitleFont = async (font: string) => {
    setTitleFont(font); setTitleMenu(null);
    await noteBodyRef.current?.updateFrontmatter({ titleFont: font });
  };

  const toggleTextShadow = async () => {
    const next = !coverTextShadow;
    setCoverTextShadow(next);
    await noteBodyRef.current?.updateFrontmatter({ coverTextShadow: next });
  };

  const applyDocWidth = async (w: DocWidthId) => {
    setDocWidth(w); setWidthMenuOpen(false);
    try { await noteBodyRef.current?.updateFrontmatter({ docWidth: w }); }
    catch (e) { console.error("[journal] applyDocWidth failed:", e); }
  };

  const updateIconPos = (patch: {
    iconX?: number; iconY?: number; iconAnchor?: Anchor;
  }) => {
    if (patch.iconX !== undefined) setIconX(patch.iconX);
    if (patch.iconY !== undefined) setIconY(patch.iconY);
    if (patch.iconAnchor !== undefined) setIconAnchor(patch.iconAnchor);
    noteBodyRef.current?.updateFrontmatter(patch);
  };

  const updateTitlePos = (patch: {
    titleX?: number; titleY?: number; titleAnchor?: Anchor;
  }) => {
    if (patch.titleX !== undefined) setTitleX(patch.titleX);
    if (patch.titleY !== undefined) setTitleY(patch.titleY);
    if (patch.titleAnchor !== undefined) setTitleAnchor(patch.titleAnchor);
    noteBodyRef.current?.updateFrontmatter(patch);
  };

  const openCoverPanel = () => {
    const W = 560;
    setPickerPos({
      x: Math.max(20, Math.floor(window.innerWidth / 2 - W / 2)),
      y: 90,
    });
    setCoverPickerOpen(true);
  };

  const coverBackground: React.CSSProperties = (() => {
    if (coverType === "color") {
      const preset = COVER_GRADIENTS.find((g) => g.id === coverValue);
      return { backgroundImage: preset?.value || COVER_GRADIENTS[0].value };
    }
    if (coverType === "image") {
      return {
        backgroundImage: `url("${resolveCoverUrl(coverValue)}")`,
        backgroundSize: "cover",
        backgroundPosition: `${coverPosX}% ${coverPosY}%`,
        backgroundRepeat: "no-repeat",
      };
    }
    return {};
  })();

  const featherMask =
    coverFeather > 0
      ? {
          WebkitMaskImage: `linear-gradient(to right, transparent 0%, black ${coverFeather}%, black ${100 - coverFeather}%, transparent 100%), linear-gradient(to bottom, transparent 0%, black ${coverFeather}%, black ${100 - coverFeather}%, transparent 100%)`,
          maskImage: `linear-gradient(to right, transparent 0%, black ${coverFeather}%, black ${100 - coverFeather}%, transparent 100%), linear-gradient(to bottom, transparent 0%, black ${coverFeather}%, black ${100 - coverFeather}%, transparent 100%)`,
          WebkitMaskComposite: "source-in",
          maskComposite: "intersect",
        }
      : {};

  const iconPickerPopup = iconPickerOpen ? (
    <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-[150]">
      <EmojiPicker
        theme={Theme.DARK} emojiStyle={EmojiStyle.NATIVE}
        onEmojiClick={(d) => applyIcon(d.emoji)}
        width={320} height={400}
        previewConfig={{ showPreview: false }}
      />
    </div>
  ) : null;

  const iconEl = icon ? (
    <div className="relative">
      <button
        onContextMenu={handleIconContextMenu}
        className={`text-5xl leading-none p-1 rounded transition-colors flex-shrink-0 ${
          noteMode === "edit"
            ? hasCover ? "hover:bg-white/10 cursor-pointer" : "hover:bg-[#1e2327] cursor-pointer"
            : "cursor-default"
        }`}
        style={
          hasCover && coverTextShadow && titleAnchor === "in"
            ? { filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.5))" }
            : undefined
        }
        title={noteMode === "edit" ? "Right-click for options" : undefined}
      >
        {icon}
      </button>
      {iconPickerPopup}
    </div>
  ) : null;

  const addIconEl = noteMode === "edit" && !icon ? (
    <div className="relative flex-shrink-0">
      <button
        onClick={() => setIconPickerOpen((o) => !o)}
        className={`text-xs flex items-center gap-1.5 px-2 py-1 rounded transition-colors whitespace-nowrap ${
          hasCover
            ? "text-white/90 hover:text-white hover:bg-white/10 bg-black/30 backdrop-blur-sm"
            : "text-gray-500 hover:text-gray-300 hover:bg-[#1e2327]"
        }`}
      >
        <Smile size={12} /> Add icon
      </button>
      {iconPickerPopup}
    </div>
  ) : null;

  const titleInputEl = (title || noteMode === "edit") ? (
    <input
      type="text"
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={saveTitle}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      onContextMenu={handleTitleContextMenu}
      readOnly={noteMode !== "edit"}
      placeholder="Add a title…"
      className={`w-full bg-transparent border-none outline-none text-4xl font-bold tracking-tight px-2 py-1 rounded text-center ${
        hasCover && titleAnchor === "in"
          ? "text-white placeholder-white/60"
          : "text-gray-100 placeholder-gray-600"
      } ${noteMode === "edit" ? "focus:bg-white/5" : "cursor-default"}`}
      style={{
        fontFamily: fontStack,
        fontStyle: titleFont === "italic" ? "italic" : undefined,
        textShadow: hasCover && coverTextShadow && titleAnchor === "in"
          ? "0 2px 10px rgba(0,0,0,0.6)" : undefined,
      }}
      title={noteMode === "edit" ? "Right-click for font options" : undefined}
    />
  ) : null;

  const renderIconInZone = (zone: Anchor) => {
    if (!showHeaderIcon) return null;
    if (iconAnchor !== zone) return null;
    if (!icon && noteMode !== "edit") return null;
    return (
      <div className="absolute z-10" style={{
        left: `${iconX}%`, top: `${iconY}%`,
        transform: "translate(-50%, -50%)",
      }}>
        {icon ? iconEl : addIconEl}
      </div>
    );
  };

  const renderTitleInZone = (zone: Anchor) => {
    if (titleAnchor !== zone) return null;
    return (
      <div className="absolute z-[5]" style={{
        left: `${titleX}%`, top: `${titleY}%`,
        transform: "translate(-50%, -50%)",
        width: "80%", maxWidth: "48rem",
      }}>
        {titleInputEl}
      </div>
    );
  };

  const openFromTimeline = (y: number, m: number, d: number) => {
    setDate(new Date(y, m - 1, d));
    setMode("day"); setViewMode("day");
  };

  const sourceDirty = sourceDraft !== rawSource;

  const estimate = exportResult
    ? {
        w: exportResult.outputWidth,
        h: exportResult.outputHeight,
        capped: exportResult.capped,
        cssW: exportResult.cssWidth,
        cssH: exportResult.cssHeight,
      }
    : null;

  const zoomIn = () => setPreviewZoom((z) => Math.min(4, (z === 0 ? 1 : z) * 1.25));
  const zoomOut = () => setPreviewZoom((z) => {
    const next = (z === 0 ? 1 : z) / 1.25;
    return next <= 0.1 ? 0 : next;
  });
  const resetZoom = () => setPreviewZoom(0);

  return (
    <div className="w-full h-full flex flex-col overflow-hidden bg-[#0f1315]">
      {modal}

      {lightbox && (
        <PhotoLightbox
          srcs={lightbox.srcs} index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndexChange={(i) =>
            setLightbox((prev) => (prev ? { ...prev, index: i } : null))
          }
        />
      )}

      {focusMode && (
        <button onClick={onToggleFocus}
          className="fixed top-3 right-3 z-[80] p-2 rounded bg-[#1e2327] border border-[#2a3136] text-gray-400 hover:text-gray-100 cursor-pointer"
          title="Exit focus mode (Ctrl+Shift+F)">
          <Minimize2 size={14} />
        </button>
      )}

      {iconMenu && (
        <div ref={iconMenuRef}
          className="fixed z-[200] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-xl py-1 w-56"
          style={{ top: iconMenu.y, left: iconMenu.x }}>
          <button onClick={() => { setIconMenu(null); openIconPicker(); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]">
            <Smile size={13} /> <span>Change icon</span>
          </button>
          <button onClick={resetIconPosition}
            className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]">
            <Move size={13} /> <span>Reset position</span>
          </button>
          <button onClick={confirmRemoveIcon}
            className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-[#2a3136] flex items-center space-x-2">
            <Trash2 size={13} /> <span>Remove icon (both)</span>
          </button>
        </div>
      )}

      {titleMenu && (
        <div ref={titleMenuRef}
          className="fixed z-[200] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-xl py-1 w-48 max-h-96 overflow-y-auto"
          style={{ top: titleMenu.y, left: titleMenu.x }}>
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
            <TypeIcon size={10} /> Title font
          </div>
          {TITLE_FONTS.map((f) => (
            <button key={f.id} onClick={() => applyTitleFont(f.id)}
              style={{ fontFamily: f.stack, fontStyle: f.id === "italic" ? "italic" : undefined }}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-[#2a3136] flex items-center justify-between ${
                f.id === titleFont ? "text-gray-100" : "text-gray-300"
              }`}>
              <span>{f.label}</span>
              {f.id === titleFont && <span className="text-blue-400 text-xs">●</span>}
            </button>
          ))}
        </div>
      )}

      {!focusMode && (
        <div className="flex items-center justify-between px-6 pt-4 pb-3 border-b border-[#2a3136] flex-shrink-0 gap-3">
          <div className="flex items-center space-x-2 text-sm font-medium text-gray-300 whitespace-nowrap flex-shrink-0">
            <CalendarDays size={16} className="text-gray-400 flex-shrink-0" />
            <span>Daily Journal</span>
          </div>

          <div className="flex items-center space-x-2 flex-nowrap overflow-x-auto">
            <div className="flex items-center bg-[#0f1315] border border-[#30363d] rounded p-0.5 flex-shrink-0">
              <button onClick={() => setViewMode("day")}
                className={`flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer ${
                  viewMode === "day" ? "bg-[#2a3136] text-gray-100" : "text-gray-500 hover:text-gray-300"
                }`} title="Day view">
                <CalendarDays size={13} />
              </button>
              <button onClick={() => setViewMode("timeline")}
                className={`flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer ${
                  viewMode === "timeline" ? "bg-[#2a3136] text-gray-100" : "text-gray-500 hover:text-gray-300"
                }`} title="Timeline view">
                <LayoutGrid size={13} />
              </button>
            </div>

            {viewMode === "day" && (
              <>
                <span className="text-[11px] text-gray-600 hidden lg:inline whitespace-nowrap flex-shrink-0">
                  ← → days · ↑ ↓ months
                </span>

                <button ref={widthMenuRef} type="button"
                  onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); setWidthMenuOpen((o) => !o); }}
                  className="flex items-center gap-1.5 px-2 h-7 rounded text-xs text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer flex-shrink-0"
                  title="Document width">
                  <WidthIcon size={15} />
                  <span className="hidden xl:inline">{widthOption.label}</span>
                </button>

                <button onClick={openProperties}
                  className="flex items-center justify-center w-7 h-7 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer flex-shrink-0"
                  title="Properties">
                  <List size={15} />
                </button>

                <button onClick={openSource}
                  className="flex items-center justify-center w-7 h-7 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer flex-shrink-0"
                  title="Source">
                  <Code2 size={15} />
                </button>

                <button onClick={openExportDialog}
                  className="flex items-center justify-center w-7 h-7 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer flex-shrink-0"
                  title="Export">
                  <Download size={15} />
                </button>

                <button onClick={() => openCoverPanel()}
                  className="flex items-center justify-center w-7 h-7 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer flex-shrink-0"
                  title="Header settings">
                  <Sliders size={15} />
                </button>

                <button onClick={toggleNoteMode}
                  className="flex items-center justify-center w-7 h-7 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer flex-shrink-0"
                  title={noteMode === "edit" ? "Read mode" : "Edit mode"}>
                  {noteMode === "edit" ? <BookOpen size={15} /> : <Pencil size={15} />}
                </button>
              </>
            )}

            {onToggleFocus && (
              <button onClick={onToggleFocus}
                className="flex items-center justify-center w-7 h-7 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer flex-shrink-0"
                title="Focus mode">
                <Maximize2 size={15} />
              </button>
            )}
          </div>
        </div>
      )}

      {viewMode === "day" && !focusMode && (
        <div className="flex items-center justify-center space-x-6 py-3 border-b border-[#2a3136] flex-shrink-0">
          <button onClick={() => shiftMonth(-1)} className="text-gray-500 hover:text-gray-200 cursor-pointer">
            <ChevronLeft size={16} />
          </button>
          <button onClick={() => setMode("month")}
            className={`text-sm transition-colors cursor-pointer ${
              mode === "month" ? "text-gray-100 font-semibold" : "text-gray-500 hover:text-gray-300"
            }`}>
            {monthName} {year}
          </button>
          <button onClick={() => shiftMonth(1)} className="text-gray-500 hover:text-gray-200 cursor-pointer">
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      {viewMode === "day" && !focusMode && (
        <div className="flex items-center justify-center space-x-6 py-3 flex-shrink-0">
          <button onClick={() => shiftDay(-1)} className="text-gray-500 hover:text-gray-200 cursor-pointer">
            <ChevronLeft size={18} />
          </button>
          <button onClick={() => setMode("day")}
            className={`text-lg transition-colors cursor-pointer ${
              mode === "day" ? "text-gray-100 font-semibold" : "text-gray-500 hover:text-gray-300"
            }`}>
            {dayName}
          </button>
          <button onClick={() => shiftDay(1)} className="text-gray-500 hover:text-gray-200 cursor-pointer">
            <ChevronRight size={18} />
          </button>
        </div>
      )}

      {viewMode === "timeline" ? (
        <div className="flex-1 overflow-hidden">
          <JournalTimeline journalDir={journalDir} onOpenDay={openFromTimeline} />
        </div>
      ) : (
        <div ref={contentRef} className="flex-1 overflow-y-auto">
          {currentPath && (
            <>
              {hasAboveContent && (
                <div className="relative w-full h-20">
                  {renderIconInZone("above")}
                  {renderTitleInZone("above")}
                </div>
              )}

              {showCoverStrip && (
                <div className={`relative w-full ${coverStripHeight} mb-2`}>
                  {hasCover && (
                    <>
                      <div className="absolute inset-0 overflow-hidden" style={{
                        borderRadius: coverRadius > 0 ? `${coverRadius}px` : undefined,
                        ...featherMask,
                      }}>
                        <div data-cover-layer className="absolute" style={{
                          top: coverBlur > 0 ? -Math.max(16, coverBlur * 2) : 0,
                          left: coverBlur > 0 ? -Math.max(16, coverBlur * 2) : 0,
                          right: coverBlur > 0 ? -Math.max(16, coverBlur * 2) : 0,
                          bottom: coverBlur > 0 ? -Math.max(16, coverBlur * 2) : 0,
                          ...coverBackground,
                          opacity: coverOpacity / 100,
                          filter: coverBlur > 0 ? `blur(${coverBlur}px)` : undefined,
                        }} />
                      </div>
                      {coverTextShadow && (
                        <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/10 to-transparent pointer-events-none"
                          style={{ borderRadius: coverRadius > 0 ? `${coverRadius}px` : undefined }} />
                      )}
                    </>
                  )}

                  {renderIconInZone("in")}
                  {renderTitleInZone("in")}

                  {hasCover && noteMode === "edit" && !exporting && (
                    <div className="absolute top-3 right-3 flex items-center gap-1">
                      <button onClick={toggleTextShadow}
                        className={`p-1.5 rounded text-white transition-colors ${
                          coverTextShadow ? "bg-black/60 hover:bg-black/80" : "bg-black/30 hover:bg-black/60 text-white/50"
                        }`}
                        title={coverTextShadow ? "Hide text shadow" : "Show text shadow"}>
                        <Sparkles size={12} />
                      </button>
                      <button onClick={openCoverPanel}
                        className="p-1.5 rounded bg-black/60 hover:bg-black/80 text-white"
                        title="Header settings">
                        <Sliders size={12} />
                      </button>
                      <button onClick={removeCover}
                        className="p-1.5 rounded bg-black/60 hover:bg-black/80 text-white"
                        title="Remove cover">
                        <X size={12} />
                      </button>
                    </div>
                  )}

                  {!hasCover && noteMode === "edit" && !exporting && (
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2">
                      <button onClick={openCoverPanel}
                        className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#1e2327] transition-colors whitespace-nowrap">
                        <ImageIcon size={12} /> Add cover
                      </button>
                    </div>
                  )}
                </div>
              )}

              {hasBelowContent && (
                <div className="relative w-full h-20">
                  {renderIconInZone("below")}
                  {renderTitleInZone("below")}
                </div>
              )}

              <div className={`${contentWrap} pt-2 pb-3`}>
                <div className="flex items-center justify-center space-x-4 text-[11px] text-gray-500">
                  <span>Created: {formatDate(createdAt)}</span>
                  <span>•</span>
                  <span>Modified: {formatDate(modifiedAt)}</span>
                  {wordCount > 0 && (<><span>•</span><span>{wordCount} words</span></>)}
                </div>
              </div>

              <div className={`${contentWrap} pb-6`}>
                <NoteBody
                  ref={noteBodyRef}
                  key={`${currentPath}::${sourceNonce}`}
                  path={currentPath}
                  vaultPath={vaultPath}
                  onWordCountChange={setWordCount}
                  onOpenNoteByPath={onOpenNoteByPath}
                  onImageClick={(srcs, index) => setLightbox({ srcs, index })}
                  onFrontmatterLoaded={(fm: Frontmatter) => {
                    setIcon((fm.icon as string) || "");
                    setShowHeaderIcon(fm.showHeaderIcon !== false);
                    setTitle((fm.title as string) || "");
                    setCoverType((fm.coverType as string) || "");
                    setCoverValue((fm.coverValue as string) || "");
                    setCoverPosX(typeof fm.coverPosX === "number" ? fm.coverPosX : 50);
                    setCoverPosY(typeof fm.coverPosY === "number" ? fm.coverPosY : 50);
                    setCoverOpacity(typeof fm.coverOpacity === "number" ? fm.coverOpacity : 100);
                    setCoverBlur(typeof fm.coverBlur === "number" ? fm.coverBlur : 0);
                    setCoverRadius(typeof fm.coverRadius === "number" ? fm.coverRadius : 0);
                    setCoverFeather(typeof fm.coverFeather === "number" ? fm.coverFeather : 0);
                    setCoverTextShadow(fm.coverTextShadow !== false);
                    setIconAnchor(((fm.iconAnchor as Anchor) || "in"));
                    setIconX(typeof fm.iconX === "number" ? fm.iconX : 8);
                    setIconY(typeof fm.iconY === "number" ? fm.iconY : 50);
                    setTitleAnchor(((fm.titleAnchor as Anchor) || "in"));
                    setTitleX(typeof fm.titleX === "number" ? fm.titleX : 50);
                    setTitleY(typeof fm.titleY === "number" ? fm.titleY : 50);
                    setTitleFont((fm.titleFont as string) || "default");
                    setDocWidth(((fm.docWidth as string) as DocWidthId) || "default");
                    setCreatedAt((fm.created as string) || "");
                    setModifiedAt((fm.modified as string) || "");
                  }}
                  onSaved={() => { setModifiedAt(new Date().toISOString()); }}
                />
              </div>
            </>
          )}
        </div>
      )}

      {widthMenuOpen && (
        <div id="journal-width-menu"
          className="fixed z-[300] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-xl py-1 w-44"
          style={{
            top: (widthMenuRef.current?.getBoundingClientRect().bottom ?? 60) + 4,
            right: Math.max(8, window.innerWidth - (widthMenuRef.current?.getBoundingClientRect().right ?? window.innerWidth)),
          }}>
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-500">
            Document width
          </div>
          {DOC_WIDTHS.map((w) => {
            const WIcon = w.icon;
            return (
              <button key={w.id} onClick={() => applyDocWidth(w.id)}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-[#2a3136] flex items-center gap-2 ${
                  w.id === docWidth ? "text-gray-100" : "text-gray-300"
                }`}>
                <WIcon size={13} />
                <span>{w.label}</span>
                {w.id === docWidth && <span className="ml-auto text-blue-400 text-xs">●</span>}
              </button>
            );
          })}
        </div>
      )}

      {propertiesOpen && (
        <div className="fixed inset-0 z-[150] bg-black/60 flex items-start justify-center pt-20"
          onClick={() => setPropertiesOpen(false)}>
          <div className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[560px] max-h-[75vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a3136] bg-[#1a1e21]">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-100">
                <List size={14} /><span>Properties</span>
              </div>
              <button onClick={() => setPropertiesOpen(false)}
                className="text-gray-500 hover:text-gray-300 cursor-pointer" title="Close">
                <X size={14} />
              </button>
            </div>
            <div className="p-4 overflow-y-auto space-y-2">
              {Object.keys(properties).length === 0 && (
                <p className="text-xs text-gray-500 italic text-center py-4">No properties yet.</p>
              )}
              {Object.entries(properties).map(([key, value]) => (
                <div key={key} className="flex items-center gap-2 group">
                  <span className="text-xs text-gray-400 font-mono w-32 flex-shrink-0 truncate" title={key}>{key}</span>
                  <input type="text" defaultValue={fmValueToString(value)}
                    onBlur={(e) => {
                      const next = e.target.value;
                      if (next !== fmValueToString(value)) updateProperty(key, next);
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    className="flex-1 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-100 outline-none focus:ring-1 focus:ring-blue-500 font-mono" />
                  <button onClick={() => deleteProperty(key)}
                    className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 p-1 transition-opacity"
                    title="Delete property">
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <div className="border-t border-[#2a3136] mt-3 pt-3">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Add property</div>
                <div className="flex items-center gap-2">
                  <input type="text" value={newPropKey} onChange={(e) => setNewPropKey(e.target.value)}
                    placeholder="key"
                    className="bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-100 outline-none focus:ring-1 focus:ring-blue-500 font-mono w-32" />
                  <input type="text" value={newPropValue} onChange={(e) => setNewPropValue(e.target.value)}
                    placeholder="value"
                    onKeyDown={(e) => { if (e.key === "Enter") addProperty(); }}
                    className="flex-1 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-100 outline-none focus:ring-1 focus:ring-blue-500 font-mono" />
                  <button onClick={addProperty} disabled={!newPropKey.trim()}
                    className="flex items-center gap-1 px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded whitespace-nowrap">
                    <Plus size={12} /> Add
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {sourceOpen && (
        <div className="fixed inset-0 z-[150] bg-black/70 flex items-start justify-center pt-16"
          onClick={() => setSourceOpen(false)}>
          <div className="bg-[#0f1315] border border-[#2a3136] rounded-lg shadow-2xl w-[820px] max-w-[92vw] max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-100 min-w-0">
                <Code2 size={14} className="flex-shrink-0" /><span className="flex-shrink-0">Source</span>
                <span className="text-[10px] text-gray-500 font-mono ml-2 truncate">{currentPath?.split(/[/\\]/).pop()}</span>
                {sourceDirty && <span className="text-[10px] text-amber-400 flex-shrink-0">• unsaved</span>}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {sourceDirty && (
                  <button onClick={revertSource} disabled={sourceSaving}
                    className="flex items-center gap-1.5 px-2 py-1 text-xs text-gray-400 hover:text-gray-100 hover:bg-[#2a3136] rounded transition-colors disabled:opacity-40">
                    <X size={12} /><span>Revert</span>
                  </button>
                )}
                <button onClick={saveSource} disabled={!sourceDirty || sourceSaving}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors font-medium">
                  {sourceSaving ? <span>Saving…</span> : <><Check size={12} /><span>Save</span></>}
                </button>
                <button onClick={copySource}
                  className="flex items-center gap-1.5 px-2 py-1 text-xs text-gray-400 hover:text-gray-100 hover:bg-[#2a3136] rounded transition-colors">
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  <span>{copied ? "Copied" : "Copy"}</span>
                </button>
                <button onClick={() => setSourceOpen(false)}
                  className="text-gray-500 hover:text-gray-300 cursor-pointer p-1" title="Close">
                  <X size={14} />
                </button>
              </div>
            </div>
            <textarea value={sourceDraft} onChange={(e) => setSourceDraft(e.target.value)}
              spellCheck={false} autoCorrect="off" autoCapitalize="off"
              className="flex-1 w-full bg-transparent p-4 text-xs text-gray-300 font-mono leading-relaxed outline-none resize-none border-0"
              style={{ tabSize: 2, minHeight: "60vh" }} />
          </div>
        </div>
      )}

      {coverPickerOpen && (
        <div className="fixed z-[100] bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[560px] max-h-[80vh] overflow-hidden flex flex-col"
          style={{ top: pickerPos.y, left: pickerPos.x }}>
          <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a3136] cursor-move select-none bg-[#1a1e21]"
            onMouseDown={(e) => {
              if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
              e.preventDefault();
              setDragStart({ mx: e.clientX, my: e.clientY, px: pickerPos.x, py: pickerPos.y });
            }}>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-100">
              <GripHorizontal size={14} className="text-gray-500" />
              <Palette size={14} /><span>Header</span>
            </div>
            <button data-no-drag onClick={() => setCoverPickerOpen(false)}
              className="text-gray-500 hover:text-gray-300 cursor-pointer" title="Close">
              <X size={14} />
            </button>
          </div>
          <div className="p-4 pr-5 overflow-y-auto space-y-4">
            <div>
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className="text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
                  <Smile size={10} /> Icon
                </span>
                <button type="button" onClick={toggleShowHeaderIcon}
                  className="flex items-center gap-2 flex-shrink-0 cursor-pointer">
                  <span className="text-[10px] text-gray-500">{showHeaderIcon ? "Visible" : "Hidden"}</span>
                  <span className="relative rounded-full transition-colors flex-shrink-0"
                    style={{ width: 28, height: 16, backgroundColor: showHeaderIcon ? "#3b82f6" : "#3a4147" }}>
                    <span className="absolute rounded-full bg-white"
                      style={{ width: 12, height: 12, top: 2, left: showHeaderIcon ? 14 : 2, transition: "left 150ms ease", boxShadow: "0 1px 2px rgba(0,0,0,0.3)" }} />
                  </span>
                </button>
              </div>
              <p className="text-[10px] text-gray-600 mb-3 leading-snug">
                Shared with the sidebar — toggling only hides it here.
              </p>
              <AnchorPicker value={iconAnchor} onChange={(a) => updateIconPos({ iconAnchor: a })} />
              <div className="mt-3 space-y-2">
                <SliderRow label="Horizontal" value={iconX} min={0} max={100} unit="%" onChange={(v) => updateIconPos({ iconX: v })} />
                <SliderRow label="Vertical" value={iconY} min={0} max={100} unit="%" onChange={(v) => updateIconPos({ iconY: v })} />
              </div>
            </div>

            <div className="border-t border-[#2a3136] pt-3">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5">
                <TypeIcon size={10} /> Title
              </div>
              <AnchorPicker value={titleAnchor} onChange={(a) => updateTitlePos({ titleAnchor: a })} />
              <div className="mt-3 space-y-2">
                <SliderRow label="Horizontal" value={titleX} min={0} max={100} unit="%" onChange={(v) => updateTitlePos({ titleX: v })} />
                <SliderRow label="Vertical" value={titleY} min={0} max={100} unit="%" onChange={(v) => updateTitlePos({ titleY: v })} />
              </div>
            </div>

            <div className="border-t border-[#2a3136] pt-3">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5">
                <ImageIcon size={10} /> Banner
              </div>
              <div className="flex gap-2 mb-3">
                <button onClick={uploadCover}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200 whitespace-nowrap">
                  <Upload size={12} /> Upload
                </button>
                <div className="flex-1 flex gap-2">
                  <input type="text" value={coverUrlDraft} onChange={(e) => setCoverUrlDraft(e.target.value)}
                    placeholder="or paste image URL…"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const val = coverUrlDraft.trim();
                        if (val) applyCover("image", val);
                      }
                    }}
                    className="flex-1 bg-[#0f1315] border border-[#30363d] rounded px-3 py-1.5 text-xs text-gray-100 outline-none focus:ring-1 focus:ring-blue-500" />
                  <button onClick={() => { const val = coverUrlDraft.trim(); if (val) applyCover("image", val); }}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded whitespace-nowrap">
                    <LinkIcon size={12} /> Apply
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-5 gap-2 mb-3">
                {COVER_GRADIENTS.map((g) => (
                  <button key={g.id} onClick={() => applyCover("color", g.id)}
                    className={`aspect-[3/2] rounded cursor-pointer hover:ring-2 hover:ring-blue-500 transition-all ${
                      coverType === "color" && coverValue === g.id ? "ring-2 ring-blue-400" : ""
                    }`}
                    style={{ background: g.value }} title={g.label} />
                ))}
              </div>
              {hasCover && (
                <div className="space-y-3">
                  {coverType === "image" && (
                    <div className="space-y-3 pb-1">
                      <div className="text-[10px] uppercase tracking-wider text-gray-500">Image position</div>
                      <SliderRow label="Horizontal" value={coverPosX} min={0} max={100} unit="%" onChange={(v) => updateCoverStyle({ posX: v })} />
                      <SliderRow label="Vertical" value={coverPosY} min={0} max={100} unit="%" onChange={(v) => updateCoverStyle({ posY: v })} />
                    </div>
                  )}
                  <div className="text-[10px] uppercase tracking-wider text-gray-500 pt-1">Style</div>
                  <SliderRow label="Opacity" value={coverOpacity} min={0} max={100} unit="%" onChange={(v) => updateCoverStyle({ opacity: v })} />
                  <SliderRow label="Blur" value={coverBlur} min={0} max={20} unit="px" onChange={(v) => updateCoverStyle({ blur: v })} />
                  <SliderRow label="Corner radius" value={coverRadius} min={0} max={60} unit="px" onChange={(v) => updateCoverStyle({ radius: v })} />
                  <SliderRow label="Edge feather" value={coverFeather} min={0} max={40} unit="%" onChange={(v) => updateCoverStyle({ feather: v })} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---------- EXPORT DIALOG ---------- */}
      {exportDialogOpen && (
        <div className="fixed inset-0 z-[250] bg-black/70 flex items-center justify-center p-6"
          onClick={() => {
            if (exportPhase === "exporting") return;
            setExportDialogOpen(false);
          }}>
          <div className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[860px] max-w-[96vw] max-h-[92vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
              <Download size={14} className="text-blue-400" />
              <span className="text-sm font-medium text-gray-100">Export</span>
              <button type="button"
                onClick={() => {
                  if (exportPhase === "exporting") return;
                  setExportDialogOpen(false);
                }}
                disabled={exportPhase === "exporting"}
                className="ml-auto text-gray-500 hover:text-gray-300 p-0.5 disabled:opacity-40"
                title="Close">
                <X size={14} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {/* Preview */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-2">
                  <span>Preview</span>
                  {exportPhase === "preview" && (
                    <span className="text-[10px] text-blue-400 normal-case tracking-normal flex items-center gap-1">
                      <Loader2 size={10} className="animate-spin" />
                      updating…
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1">
                    <button type="button" onClick={zoomOut}
                      className="p-1 rounded text-gray-400 hover:text-gray-100 hover:bg-[#2a3136] transition-colors"
                      title="Zoom out">
                      <ZoomOut size={13} />
                    </button>
                    <button type="button" onClick={resetZoom}
                      className="text-[11px] tabular-nums text-gray-400 hover:text-gray-100 px-1.5 py-0.5 rounded hover:bg-[#2a3136] transition-colors normal-case tracking-normal"
                      title="Fit to pane">
                      {previewZoom === 0 ? "Fit" : `${Math.round(previewZoom * 100)}%`}
                    </button>
                    <button type="button" onClick={zoomIn}
                      className="p-1 rounded text-gray-400 hover:text-gray-100 hover:bg-[#2a3136] transition-colors"
                      title="Zoom in">
                      <ZoomIn size={13} />
                    </button>
                  </span>
                </div>
                <div className="rounded-md border border-[#2a3136] bg-[#0f1315] overflow-hidden">
                  <div className="max-h-[460px] overflow-auto p-3 flex justify-center items-start">
                    {exportPreviewUrl ? (
                      <img
                        src={exportPreviewUrl}
                        alt=""
                        style={{
                          width: previewZoom === 0 ? "100%" : `${previewZoom * 100}%`,
                          maxWidth: previewZoom === 0 ? "100%" : "none",
                          height: "auto",
                          maxHeight: "none",
                          display: "block",
                          boxShadow: "0 0 0 1px #2a3136",
                          opacity: exportPhase === "preview" ? 0.6 : 1,
                          transition: "opacity 150ms",
                        }}
                      />
                    ) : exportPhase === "preview" ? (
                      <div className="flex items-center gap-3 py-16 text-sm text-gray-400">
                        <Loader2 size={16} className="animate-spin" />
                        <span>Rendering preview…</span>
                      </div>
                    ) : (
                      <div className="py-16 text-xs text-gray-500 italic">Preview unavailable</div>
                    )}
                  </div>
                </div>
                {estimate && (
                  <div className="text-[10px] text-gray-600 mt-1.5 tabular-nums">
                    Layout: {estimate.cssW} × {Math.round(estimate.cssH)} px CSS
                  </div>
                )}
              </div>

              {/* Width presets */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
                  Note width — the actual layout width of the exported image
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {EXPORT_WIDTH_PRESETS.map((w) => (
                    <button key={w} type="button"
                      onClick={() => { setExportTargetWidth(w); setExportCustomWidth(""); }}
                      className={`px-3 py-1.5 text-xs rounded border transition-colors cursor-pointer tabular-nums ${
                        exportTargetWidth === w && !exportCustomWidth
                          ? "bg-blue-600 text-white border-blue-500"
                          : "bg-[#0f1315] text-gray-300 border-[#2a3136] hover:border-[#3a4147]"
                      }`}>
                      {w}px
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-gray-500">Custom:</span>
                  <input type="text" inputMode="numeric" value={exportCustomWidth}
                    onChange={(e) => {
                      const raw = e.target.value.replace(/\D/g, "");
                      setExportCustomWidth(raw);
                      const n = Number(raw);
                      if (Number.isFinite(n) && n >= 300 && n <= 6000) {
                        setExportTargetWidth(n);
                      }
                    }}
                    placeholder="e.g. 1400"
                    className="w-28 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-100 outline-none focus:ring-1 focus:ring-blue-500 tabular-nums" />
                  <span className="text-[11px] text-gray-500">px</span>
                </div>
              </div>

              {/* Format */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Format</div>
                <div className="flex gap-1.5">
                  <button type="button" onClick={() => setExportFormat("png")}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-colors cursor-pointer ${
                      exportFormat === "png"
                        ? "bg-blue-600 text-white border-blue-500"
                        : "bg-[#0f1315] text-gray-300 border-[#2a3136] hover:border-[#3a4147]"
                    }`}>
                    <FileImage size={12} /> PNG
                  </button>
                  <button type="button" onClick={() => setExportFormat("pdf")}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-colors cursor-pointer ${
                      exportFormat === "pdf"
                        ? "bg-blue-600 text-white border-blue-500"
                        : "bg-[#0f1315] text-gray-300 border-[#2a3136] hover:border-[#3a4147]"
                    }`}>
                    <FileTextIcon size={12} /> PDF
                  </button>
                </div>
              </div>

              {/* Filename */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Filename</div>
                <div className="flex items-center gap-1.5">
                  <input type="text" value={exportFilename}
                    onChange={(e) => setExportFilename(e.target.value)}
                    className="flex-1 bg-[#0f1315] border border-[#30363d] rounded px-3 py-1.5 text-xs text-gray-100 outline-none focus:ring-1 focus:ring-blue-500" />
                  <span className="text-[11px] text-gray-500 font-mono">.{exportFormat}</span>
                </div>
              </div>

              {estimate && (
                <div className="text-[11px] text-gray-500">
                  Output image:{" "}
                  <span className="text-gray-300 tabular-nums">
                    {estimate.w} × {estimate.h} px
                  </span>
                  {estimate.capped && (
                    <span className="text-amber-400 ml-2">(clamped by canvas limits)</span>
                  )}
                </div>
              )}

              {estimate && estimate.capped && (
                <div className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-3 py-2 leading-relaxed flex items-start gap-2">
                  <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium">Output clamped by canvas size limits.</div>
                    <div className="text-amber-400/70 mt-0.5">
                      The browser can't produce a bitmap larger than ~16M pixels
                      ({CANVAS_MAX_DIM.toLocaleString()}px per side). Try a narrower preset.
                    </div>
                  </div>
                </div>
              )}

              {exportError && (
                <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2 leading-relaxed">
                  {exportError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
              <button type="button" onClick={() => setExportDialogOpen(false)}
                disabled={exportPhase === "exporting"}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-[#2a3136] rounded transition-colors disabled:opacity-40">
                Cancel
              </button>
              <button type="button" onClick={runExport}
                disabled={
                  exportPhase === "exporting" ||
                  exportPhase === "preview" ||
                  !exportFilename.trim()
                }
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors font-medium">
                {exportPhase === "exporting" ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    <span>Exporting…</span>
                  </>
                ) : (
                  <>
                    <Download size={12} />
                    <span>Export {exportFormat.toUpperCase()}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function AnchorPicker({ value, onChange }: { value: Anchor; onChange: (a: Anchor) => void }) {
  const opts: { id: Anchor; label: string; icon: any }[] = [
    { id: "above", label: "Above", icon: ArrowUp },
    { id: "in",    label: "In",    icon: Minus },
    { id: "below", label: "Below", icon: ArrowDown },
  ];
  return (
    <div className="flex gap-1 bg-[#0f1315] border border-[#30363d] rounded p-0.5">
      {opts.map((o) => {
        const Icon = o.icon;
        const active = value === o.id;
        return (
          <button key={o.id} onClick={() => onChange(o.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1 text-xs rounded transition-colors ${
              active ? "bg-[#2a3136] text-gray-100" : "text-gray-400 hover:text-gray-200 hover:bg-[#1e2327]"
            }`}>
            <Icon size={11} />
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SliderRow({ label, value, min, max, unit, onChange }: {
  label: string; value: number; min: number; max: number; unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="flex justify-between text-[10px] uppercase tracking-wider text-gray-500 mb-1">
        <span>{label}</span>
        <span className="text-gray-400 normal-case">{value}{unit}</span>
      </label>
      <input type="range" min={min} max={max} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-blue-500" />
    </div>
  );
}