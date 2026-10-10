// src/JournalView.tsx
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft, ChevronRight, CalendarDays, Pencil, BookOpen,
  Image as ImageIcon, Smile, X, Palette, Trash2, Type as TypeIcon,
  Sparkles, Sliders, Move, Columns2, Columns3, Columns4, Square,
  GripHorizontal, ArrowUp, ArrowDown, Minus, Upload, Link as LinkIcon,
  List, Code2, Copy, Plus, Check, Maximize2, Minimize2, LayoutGrid,
} from "lucide-react";
import {
  mkdir, exists, rename as renameFs, readDir, readTextFile, writeFile,
} from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import EmojiPicker, { Theme, EmojiStyle } from "emoji-picker-react";
import NoteBody, { type NoteBodyHandle } from "./NoteBody";
import JournalTimeline from "./JournalTimeline";
import PhotoLightbox from "./PhotoLightbox";
import { useNoteMode } from "./useNoteMode";
import { useModal } from "./Modal";
import { parseNoteFile, type Frontmatter } from "./noteFormat";
import { saveImageToNoteAssets, assetsDirForNote } from "./imageAssets";

interface JournalViewProps {
  vaultPath: string;
  journalDir: string;
  initialDate?: { year: number; month: number; day: number };
  initialMode?: "day" | "month";
  focusMode?: boolean;
  onToggleFocus?: () => void;
  onOpenNoteByPath?: (path: string) => void;
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

const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i;

/** List images sitting in <noteDir>/assets/<noteBase>/ — i.e. files that
 *  were uploaded or pasted into this note. Used by the "In this note"
 *  picker in the header settings panel. */
async function listNoteImages(notePath: string): Promise<{ name: string; abs: string }[]> {
  try {
    const dir = await assetsDirForNote(notePath);
    const entries = await readDir(dir);
    const names = entries
      .filter((e) => !e.isDirectory && !!e.name && IMAGE_FILE_RE.test(e.name))
      .map((e) => e.name!)
      .sort((a, b) => a.localeCompare(b));
    const out: { name: string; abs: string }[] = [];
    for (const name of names) {
      out.push({ name, abs: await join(dir, name) });
    }
    return out;
  } catch {
    return [];
  }
}

function resolveCoverUrl(value: string): string {
  if (!value) return "";
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  try { return convertFileSrc(value); } catch { return value; }
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

  // ── "In this note" image picker state ─────────────────────────────────
  const [noteImages, setNoteImages] = useState<{ name: string; abs: string }[]>([]);
  const [noteImagesLoading, setNoteImagesLoading] = useState(false);

  const iconMenuRef = useRef<HTMLDivElement>(null);
  const titleMenuRef = useRef<HTMLDivElement>(null);
  const widthMenuRef = useRef<HTMLButtonElement>(null);
  // Anchor for the emoji picker popup. We read its bounding rect at open
  // time so we can position the (portaled) picker next to it without the
  // note editor's `overflow-y-auto` container clipping it.
  const iconAnchorRef = useRef<HTMLButtonElement | null>(null);
  // Ref on the picker's wrapper so an outside-click handler can tell
  // whether a mousedown landed inside the picker (do nothing) or outside
  // it (close it).
  const iconPickerRef = useRef<HTMLDivElement | null>(null);

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

  const showCoverStrip =
    hasCover || hasInZoneContent || noteMode === "edit";

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
    setNoteImages([]); setNoteImagesLoading(false);
  }, [currentPath]);

  // When the header panel opens, scan the note's own assets folder for
  // images so the "In this note" picker can show them as thumbnails.
  useEffect(() => {
    if (!coverPickerOpen || !currentPath) return;
    let cancelled = false;
    setNoteImagesLoading(true);
    (async () => {
      const imgs = await listNoteImages(currentPath);
      if (cancelled) return;
      setNoteImages(imgs);
      setNoteImagesLoading(false);
    })();
    return () => { cancelled = true; };
  }, [coverPickerOpen, currentPath]);

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

  // Close the emoji picker on Escape. Capture phase + stopPropagation so
  // the picker's autofocused search input and any app-level global keydown
  // handlers can't swallow or pre-empt the event.
  useEffect(() => {
    if (!iconPickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setIconPickerOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [iconPickerOpen]);

  // Close the emoji picker when the user clicks anywhere outside it.
  // We skip clicks inside the picker itself (so picking an emoji works) and
  // clicks on the anchor button (so the button's own onClick toggle handles
  // open/close without fighting this handler).
  useEffect(() => {
    if (!iconPickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (iconPickerRef.current?.contains(t)) return;
      if (iconAnchorRef.current?.contains(t)) return;
      setIconPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [iconPickerOpen]);

  useEffect(() => {
    if (!propertiesOpen && !sourceOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (propertiesOpen) setPropertiesOpen(false);
      if (sourceOpen) setSourceOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [propertiesOpen, sourceOpen]);

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
      const dPath = await join(monthDir, `${dayName}.selah`);
      const mPath = await join(monthDir, `_${year}-${pad(month + 1)}-Month.selah`);

      try { await mkdir(monthDir, { recursive: true }); } catch (e) {
        console.error("[journal] could not create month dir:", monthDir, e);
      }
      try {
        if (await exists(monthDir)) {
          const entries = await readDir(monthDir);
          for (const entry of entries) {
            const n = entry.name;
            if (!n || !/\.md$/.test(n) || !/^_.+-Month\.md$/.test(n)) continue;
            const np = await join(monthDir, n.replace(/\.md$/, ".selah"));
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
      if (propertiesOpen || sourceOpen || coverPickerOpen) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); shiftDay(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); shiftDay(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); shiftMonth(-1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); shiftMonth(1); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, viewMode, propertiesOpen, sourceOpen, coverPickerOpen, lightbox]);

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
      // Refresh the "In this note" grid so the newly-added file shows up.
      const imgs = await listNoteImages(currentPath);
      setNoteImages(imgs);
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

  // Portal the emoji picker to <body> so the note editor's scroll container
  // (which has `overflow-y-auto`, and therefore clips horizontally too) can't
  // cut it off. Position it with a `fixed` rect derived from the icon button
  // and clamp it into the viewport so it never hangs off the edge on a
  // narrow window.
  const iconPickerPopup = iconPickerOpen ? (() => {
    const W = 320;
    const H = 420;
    let top = 100;
    let left = 100;
    const btn = iconAnchorRef.current;
    if (btn) {
      const rect = btn.getBoundingClientRect();
      top = rect.bottom + 8;
      left = rect.left + rect.width / 2 - W / 2;
      if (top + H > window.innerHeight - 12) {
        top = Math.max(12, window.innerHeight - H - 12);
      }
      if (left + W > window.innerWidth - 12) {
        left = window.innerWidth - W - 12;
      }
      if (left < 12) left = 12;
    }
    return createPortal(
      <div
        ref={iconPickerRef}
        className="fixed z-[500] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-2xl overflow-hidden"
        style={{ top, left, width: W }}
        onKeyDownCapture={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setIconPickerOpen(false);
          }
        }}
      >
        <EmojiPicker
          theme={Theme.DARK} emojiStyle={EmojiStyle.NATIVE}
          onEmojiClick={(d) => applyIcon(d.emoji)}
          width={W} height={400}
          previewConfig={{ showPreview: false }}
        />
      </div>,
      document.body
    );
  })() : null;

  const iconEl = icon ? (
    <div className="relative">
      <button
        ref={iconAnchorRef}
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
        ref={iconAnchorRef}
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
        <div className="flex-1 overflow-y-auto">
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

                  {hasCover && noteMode === "edit" && (
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

                  {!hasCover && noteMode === "edit" && (
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

            {/* ── In this note ─────────────────────────────────────────── */}
            <div className="border-t border-[#2a3136] pt-3">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5">
                <ImageIcon size={10} /> In this note
              </div>
              {noteImagesLoading ? (
                <div className="text-[11px] text-gray-600 italic py-2">Loading…</div>
              ) : noteImages.length === 0 ? (
                <p className="text-[11px] text-gray-600 italic leading-snug">
                  No images in this note yet. Upload or paste an image into the note body and it will show up here.
                </p>
              ) : (
                <div className="grid grid-cols-4 gap-x-2 gap-y-0.5 max-h-56 overflow-y-auto pr-1">
                  {noteImages.map((img) => {
                    const isActive = coverType === "image" && coverValue === img.abs;
                    return (
                      <button
                        key={img.abs}
                        type="button"
                        onClick={() => applyCover("image", img.abs)}
                        title={img.name}
                        className={`aspect-square rounded overflow-hidden border bg-[#0f1315] cursor-pointer transition-all hover:ring-2 hover:ring-blue-500 ${
                          isActive ? "ring-2 ring-blue-400 border-blue-400" : "border-[#30363d]"
                        }`}
                      >
                        <img
                          src={convertFileSrc(img.abs)}
                          alt={img.name}
                          loading="lazy"
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.opacity = "0.3";
                          }}
                        />
                      </button>
                    );
                  })}
                </div>
              )}
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
