// src/Editor.tsx
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { rename, readTextFile, writeFile, readDir } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Pencil, BookOpen, Image as ImageIcon, Smile, X, Palette,
  Type as TypeIcon, Sparkles, Sliders, Move, Trash2,
  Columns2, Columns3, Columns4, Square, GripHorizontal,
  ArrowUp, ArrowDown, Minus, Upload, Link as LinkIcon,
  Maximize2, Minimize2, List, Code2, Copy, Check, Plus,
} from "lucide-react";
import EmojiPicker, { Theme, EmojiStyle } from "emoji-picker-react";
import NoteBody, { type NoteBodyHandle } from "./NoteBody";
import PhotoLightbox from "./PhotoLightbox";
import { useNoteMode } from "./useNoteMode";
import { useModal } from "./Modal";
import { parseNoteFile, type Frontmatter } from "./noteFormat";
import { saveImageToNoteAssets, assetsDirForNote } from "./imageAssets";

interface EditorProps {
  activeNote: { path: string; name: string };
  vaultPath: string;
  focusMode?: boolean;
  onToggleFocus?: () => void;
  onOpenNoteByPath?: (path: string) => void;
  setActiveNote: (note: { path: string; name: string }) => void;
}

function displayTitle(name: string): string {
  const ym = name.match(/^_(\d{4})-Year\.(selah|md)$/);
  if (ym) return ym[1];
  return name.replace(/\.(selah|md)$/, "");
}

function isYearNote(name: string): boolean {
  return /^_\d{4}-Year\.(selah|md)$/.test(name);
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

const TITLE_FONTS = [
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
    return s.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean);
  }
  return s;
}

export default function Editor({
  activeNote,
  vaultPath,
  focusMode = false,
  onToggleFocus,
  onOpenNoteByPath,
  setActiveNote,
}: EditorProps) {
  const [title, setTitle] = useState(displayTitle(activeNote.name));
  const [modifiedAt, setModifiedAt] = useState<string>(new Date().toLocaleString());
  const [createdAt] = useState<string>(new Date().toLocaleString());
  const [wordCount, setWordCount] = useState(0);
  const { mode, toggle } = useNoteMode();
  const { modal, confirmAsync } = useModal();
  const noteBodyRef = useRef<NoteBodyHandle>(null);

  const [icon, setIcon] = useState("");
  const [showHeaderIcon, setShowHeaderIcon] = useState(true);
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

  const [lightbox, setLightbox] = useState<{ srcs: string[]; index: number } | null>(null);

  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  const [widthMenuOpen, setWidthMenuOpen] = useState(false);
  const [coverUrlDraft, setCoverUrlDraft] = useState("");
  const [iconMenu, setIconMenu] = useState<{ x: number; y: number } | null>(null);
  const [titleMenu, setTitleMenu] = useState<{ x: number; y: number } | null>(null);

  const [pickerPos, setPickerPos] = useState({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState<{ mx: number; my: number; px: number; py: number } | null>(null);

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

  // ── "In this note" image picker state ─────────────────────────────────
  const [noteImages, setNoteImages] = useState<{ name: string; abs: string }[]>([]);
  const [noteImagesLoading, setNoteImagesLoading] = useState(false);

  const iconMenuRef = useRef<HTMLDivElement>(null);
  const titleMenuRef = useRef<HTMLDivElement>(null);
  const widthMenuRef = useRef<HTMLDivElement>(null);
  // Anchor for the emoji picker popup — see JournalView for the rationale.
  const iconAnchorRef = useRef<HTMLButtonElement | null>(null);
  // Ref on the picker's wrapper so an outside-click handler can tell
  // whether a mousedown landed inside the picker (do nothing) or outside
  // it (close it).
  const iconPickerRef = useRef<HTMLDivElement | null>(null);

  const isYear = isYearNote(activeNote.name);
  const hasCover = coverType === "color" || coverType === "image";
  const fontStack = TITLE_FONTS.find((f) => f.id === titleFont)?.stack || "inherit";
  const widthOption = DOC_WIDTHS.find((w) => w.id === docWidth) || DOC_WIDTHS[1];
  const contentWrap = widthOption.wrap;
  const WidthIcon = widthOption.icon;

  const hasAboveContent =
    (iconAnchor === "above" && showHeaderIcon && (icon || mode === "edit")) ||
    (titleAnchor === "above" && (title || mode === "edit"));
  const hasBelowContent =
    (iconAnchor === "below" && showHeaderIcon && (icon || mode === "edit")) ||
    (titleAnchor === "below" && (title || mode === "edit"));

  const getParentDir = (p: string) => {
    const n = p.replace(/\\/g, "/");
    const i = n.lastIndexOf("/");
    return i === -1 ? p : p.substring(0, i);
  };

  useEffect(() => { setTitle(displayTitle(activeNote.name)); }, [activeNote.name]);

  useEffect(() => {
    setIcon(""); setShowHeaderIcon(true);
    setCoverType(""); setCoverValue("");
    setCoverPosX(50); setCoverPosY(50); setCoverOpacity(100); setCoverBlur(0);
    setCoverRadius(0); setCoverFeather(0); setCoverTextShadow(true);
    setIconAnchor("in"); setIconX(8); setIconY(50);
    setTitleAnchor("in"); setTitleX(50); setTitleY(50);
    setTitleFont("default"); setDocWidth("default");
    setWordCount(0);
    setIconPickerOpen(false); setCoverPickerOpen(false); setWidthMenuOpen(false);
    setCoverUrlDraft(""); setIconMenu(null); setTitleMenu(null); setDragStart(null);
    setPropertiesOpen(false); setSourceOpen(false); setSourceDraft("");
    setNoteImages([]); setNoteImagesLoading(false);

    (async () => {
      try {
        const raw = await readTextFile(activeNote.path);
        const { frontmatter } = parseNoteFile(raw);
        setIcon((frontmatter.icon as string) || "");
        setShowHeaderIcon(frontmatter.showHeaderIcon !== false);
        setCoverType((frontmatter.coverType as string) || "");
        setCoverValue((frontmatter.coverValue as string) || "");
        setCoverPosX(typeof frontmatter.coverPosX === "number" ? frontmatter.coverPosX : 50);
        setCoverPosY(typeof frontmatter.coverPosY === "number" ? frontmatter.coverPosY : 50);
        setCoverOpacity(typeof frontmatter.coverOpacity === "number" ? frontmatter.coverOpacity : 100);
        setCoverBlur(typeof frontmatter.coverBlur === "number" ? frontmatter.coverBlur : 0);
        setCoverRadius(typeof frontmatter.coverRadius === "number" ? frontmatter.coverRadius : 0);
        setCoverFeather(typeof frontmatter.coverFeather === "number" ? frontmatter.coverFeather : 0);
        setCoverTextShadow(frontmatter.coverTextShadow !== false);
        setIconAnchor((frontmatter.iconAnchor as Anchor) || "in");
        setIconX(typeof frontmatter.iconX === "number" ? frontmatter.iconX : 8);
        setIconY(typeof frontmatter.iconY === "number" ? frontmatter.iconY : 50);
        setTitleAnchor((frontmatter.titleAnchor as Anchor) || "in");
        setTitleX(typeof frontmatter.titleX === "number" ? frontmatter.titleX : 50);
        setTitleY(typeof frontmatter.titleY === "number" ? frontmatter.titleY : 50);
        setTitleFont((frontmatter.titleFont as string) || "default");
        setDocWidth(((frontmatter.docWidth as string) as DocWidthId) || "default");
      } catch {}
    })();
  }, [activeNote.path]);

  // When the header panel opens, scan the note's own assets folder for
  // images so the "In this note" picker can show them as thumbnails.
  useEffect(() => {
    if (!coverPickerOpen || !activeNote.path) return;
    let cancelled = false;
    setNoteImagesLoading(true);
    (async () => {
      const imgs = await listNoteImages(activeNote.path);
      if (cancelled) return;
      setNoteImages(imgs);
      setNoteImagesLoading(false);
    })();
    return () => { cancelled = true; };
  }, [coverPickerOpen, activeNote.path]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.path !== activeNote.path) return;
      (async () => {
        try {
          const raw = await readTextFile(activeNote.path);
          const { frontmatter } = parseNoteFile(raw);
          setIcon((frontmatter.icon as string) || "");
          setShowHeaderIcon(frontmatter.showHeaderIcon !== false);
          setCoverType((frontmatter.coverType as string) || "");
          setCoverValue((frontmatter.coverValue as string) || "");
        } catch {}
      })();
    };
    window.addEventListener("note-frontmatter-changed", handler);
    return () => window.removeEventListener("note-frontmatter-changed", handler);
  }, [activeNote.path]);

  useEffect(() => {
    const onFocus = async () => {
      try {
        const raw = await readTextFile(activeNote.path);
        const { frontmatter } = parseNoteFile(raw);
        setIcon((frontmatter.icon as string) || "");
        setShowHeaderIcon(frontmatter.showHeaderIcon !== false);
        setCoverType((frontmatter.coverType as string) || "");
        setCoverValue((frontmatter.coverValue as string) || "");
      } catch {}
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [activeNote.path]);

  useEffect(() => {
    if (!dragStart) return;
    const onMove = (e: MouseEvent) => {
      setPickerPos({ x: dragStart.px + (e.clientX - dragStart.mx), y: dragStart.py + (e.clientY - dragStart.my) });
    };
    const onUp = () => setDragStart(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
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
      if (e.key === "Escape") { setPropertiesOpen(false); setSourceOpen(false); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [propertiesOpen, sourceOpen]);

  useEffect(() => {
    if (!iconMenu) return;
    const onDown = (e: MouseEvent) => { if (iconMenuRef.current?.contains(e.target as Node)) return; setIconMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setIconMenu(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [iconMenu]);

  useEffect(() => {
    if (!titleMenu) return;
    const onDown = (e: MouseEvent) => { if (titleMenuRef.current?.contains(e.target as Node)) return; setTitleMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTitleMenu(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [titleMenu]);

  useEffect(() => {
    if (!widthMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (widthMenuRef.current?.contains(e.target as Node)) return;
      setWidthMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [widthMenuOpen]);

  const handleTitleSubmit = async () => {
    if (isYear) { setTitle(displayTitle(activeNote.name)); return; }
    const trimmed = title.trim();
    const oldName = displayTitle(activeNote.name);
    if (!trimmed || trimmed === oldName) { setTitle(oldName); return; }

    try { await noteBodyRef.current?.flush(); } catch {}
    noteBodyRef.current?.dispose();

    try {
      const lastSlash = Math.max(activeNote.path.lastIndexOf("/"), activeNote.path.lastIndexOf("\\"));
      const dirPath = activeNote.path.substring(0, lastSlash + 1);
      const parentFolderName = getParentDir(dirPath).split(/[/\\]/).filter(Boolean).pop();
      const isFolderNote = oldName === parentFolderName;
      const extMatch = activeNote.name.match(/\.(selah|md)$/);
      const ext = extMatch ? extMatch[0] : ".selah";
      const oldParentDir = getParentDir(activeNote.path);

      if (isFolderNote) {
        const folderDirPath = getParentDir(dirPath);
        const grandParentDir = getParentDir(folderDirPath);
        const newFolderPath = await join(grandParentDir, trimmed);
        const newFilePath = await join(newFolderPath, `${trimmed}${ext}`);
        await rename(folderDirPath, newFolderPath);
        setActiveNote({ path: newFilePath, name: `${trimmed}${ext}` });
        window.dispatchEvent(new CustomEvent("folder-changed", { detail: { path: grandParentDir } }));
      } else {
        const newPath = await join(dirPath, `${trimmed}${ext}`);
        await rename(activeNote.path, newPath);
        setActiveNote({ path: newPath, name: `${trimmed}${ext}` });
        window.dispatchEvent(new CustomEvent("folder-changed", { detail: { path: oldParentDir } }));
      }
    } catch (e) {
      console.error("Failed to rename note:", e);
      setTitle(oldName);
      noteBodyRef.current?.rearm();
    }
  };

  const applyIcon = async (newIcon: string) => {
    setIcon(newIcon); setIconPickerOpen(false); setIconMenu(null);
    await noteBodyRef.current?.updateFrontmatter({ icon: newIcon });
  };

  const toggleShowHeaderIcon = () => {
    const next = !showHeaderIcon;
    setShowHeaderIcon(next);
    noteBodyRef.current?.updateFrontmatter({ showHeaderIcon: next });
  };

  const openIconPicker = () => { if (mode !== "edit") return; setIconPickerOpen(true); setIconMenu(null); };

  const handleIconContextMenu = (e: React.MouseEvent) => {
    if (mode !== "edit") return;
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

  const handleTitleContextMenu = (e: React.MouseEvent) => {
    if (mode !== "edit") return;
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
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg"] }],
      });
      if (!picked || typeof picked !== "string") return;
      const ext = (picked.split(".").pop() || "png").toLowerCase();
      const destPath = await saveImageToNoteAssets(activeNote.path, picked, `cover-${Date.now()}.${ext}`);
      await applyCover("image", destPath);
      // Refresh the "In this note" grid so the newly-added file shows up.
      const imgs = await listNoteImages(activeNote.path);
      setNoteImages(imgs);
    } catch (e) { console.error("[editor] upload cover failed:", e); }
  };

  const updateCoverStyle = (patch: { opacity?: number; blur?: number; radius?: number; feather?: number; posX?: number; posY?: number }) => {
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
    setCoverOpacity(100); setCoverBlur(0); setCoverRadius(0); setCoverFeather(0);
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
    setDocWidth(w);
    setWidthMenuOpen(false);
    try {
      await noteBodyRef.current?.updateFrontmatter({ docWidth: w });
    } catch (e) {
      console.error("[editor] applyDocWidth: write failed", e);
    }
  };

  const updateIconPos = (patch: { iconX?: number; iconY?: number; iconAnchor?: Anchor }) => {
    if (patch.iconX !== undefined) setIconX(patch.iconX);
    if (patch.iconY !== undefined) setIconY(patch.iconY);
    if (patch.iconAnchor !== undefined) setIconAnchor(patch.iconAnchor);
    noteBodyRef.current?.updateFrontmatter(patch);
  };

  const updateTitlePos = (patch: { titleX?: number; titleY?: number; titleAnchor?: Anchor }) => {
    if (patch.titleX !== undefined) setTitleX(patch.titleX);
    if (patch.titleY !== undefined) setTitleY(patch.titleY);
    if (patch.titleAnchor !== undefined) setTitleAnchor(patch.titleAnchor);
    noteBodyRef.current?.updateFrontmatter(patch);
  };

  const openCoverPanel = () => {
    const W = 560;
    setPickerPos({ x: Math.max(20, Math.floor(window.innerWidth / 2 - W / 2)), y: 90 });
    setCoverPickerOpen(true);
  };

  const openProperties = async () => {
    try {
      const raw = await readTextFile(activeNote.path);
      const { frontmatter } = parseNoteFile(raw);
      setProperties(frontmatter as Record<string, unknown>);
      setNewPropKey(""); setNewPropValue("");
      setPropertiesOpen(true);
    } catch (e) { console.error("[editor] read properties failed:", e); }
  };

  const refreshFrontmatterFromDisk = async () => {
    try {
      const raw = await readTextFile(activeNote.path);
      const { frontmatter } = parseNoteFile(raw);
      setProperties(frontmatter as Record<string, unknown>);
      setIcon((frontmatter.icon as string) || "");
      setShowHeaderIcon(frontmatter.showHeaderIcon !== false);
      setCoverType((frontmatter.coverType as string) || "");
      setCoverValue((frontmatter.coverValue as string) || "");
    } catch (e) { console.error("[editor] refresh failed:", e); }
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
    const key = newPropKey.trim();
    if (!key) return;
    const parsed = stringToFmValue(newPropValue);
    setProperties((prev) => ({ ...prev, [key]: parsed }));
    setNewPropKey(""); setNewPropValue("");
    await noteBodyRef.current?.updateFrontmatter({ [key]: parsed });
    await refreshFrontmatterFromDisk();
  };

  const openSource = async () => {
    try {
      const raw = await readTextFile(activeNote.path);
      setRawSource(raw);
      setSourceDraft(raw);
      setCopied(false);
      setSourceOpen(true);
    } catch (e) { console.error("[editor] read source failed:", e); }
  };

  const saveSource = async () => {
    setSourceSaving(true);
    try {
      try { await noteBodyRef.current?.flush(); } catch {}
      await writeFile(activeNote.path, new TextEncoder().encode(sourceDraft));
      setRawSource(sourceDraft);
      setSourceNonce((n) => n + 1);
      await refreshFrontmatterFromDisk();
      window.dispatchEvent(new CustomEvent("file-changed", { detail: { path: activeNote.path } }));
    } catch (e) { console.error("[editor] save source failed:", e); }
    setSourceSaving(false);
  };

  const revertSource = () => setSourceDraft(rawSource);

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(sourceDraft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) { console.error("[editor] copy failed:", e); }
  };

  const sourceDirty = sourceDraft !== rawSource;

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

  const featherMask = coverFeather > 0 ? {
    WebkitMaskImage: `linear-gradient(to right, transparent 0%, black ${coverFeather}%, black ${100 - coverFeather}%, transparent 100%), linear-gradient(to bottom, transparent 0%, black ${coverFeather}%, black ${100 - coverFeather}%, transparent 100%)`,
    maskImage: `linear-gradient(to right, transparent 0%, black ${coverFeather}%, black ${100 - coverFeather}%, transparent 100%), linear-gradient(to bottom, transparent 0%, black ${coverFeather}%, black ${100 - coverFeather}%, transparent 100%)`,
    WebkitMaskComposite: "source-in",
    maskComposite: "intersect",
  } : {};

  // Portal the emoji picker to <body> and position it with `fixed` coords
  // derived from the icon button. Rendering it inline would clip against
  // the note editor's `overflow-y-auto` container (which also clips
  // horizontally), and clamping keeps it on-screen when the button is near
  // the right or bottom edge of the viewport.
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
          mode === "edit" ? (hasCover ? "hover:bg-white/10 cursor-pointer" : "hover:bg-[#1e2327] cursor-pointer") : "cursor-default"
        }`}
        style={hasCover && coverTextShadow && titleAnchor === "in" ? { filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.5))" } : undefined}
        title={mode === "edit" ? "Right-click for options" : undefined}
      >
        {icon}
      </button>
      {iconPickerPopup}
    </div>
  ) : null;

  const addIconEl = mode === "edit" && !icon ? (
    <div className="relative flex-shrink-0">
      <button
        ref={iconAnchorRef}
        onClick={() => setIconPickerOpen((o) => !o)}
        className={`text-xs flex items-center gap-1.5 px-2 py-1 rounded transition-colors whitespace-nowrap ${
          hasCover ? "text-white/90 hover:text-white hover:bg-white/10 bg-black/30 backdrop-blur-sm" : "text-gray-500 hover:text-gray-300 hover:bg-[#1e2327]"
        }`}
      >
        <Smile size={12} /> Add icon
      </button>
      {iconPickerPopup}
    </div>
  ) : null;

  const titleInputEl = (
    <input
      type="text"
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={handleTitleSubmit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { setTitle(displayTitle(activeNote.name)); e.currentTarget.blur(); }
      }}
      onContextMenu={handleTitleContextMenu}
      readOnly={isYear || mode !== "edit"}
      placeholder="Untitled Note"
      className={`w-full bg-transparent border-none outline-none text-4xl font-bold tracking-tight px-2 py-1 rounded text-center ${
        hasCover && titleAnchor === "in" ? "text-white placeholder-white/60" : "text-gray-100 placeholder-gray-600"
      } ${isYear || mode !== "edit" ? "cursor-default" : "focus:bg-white/5"}`}
      style={{
        fontFamily: fontStack,
        fontStyle: titleFont === "italic" ? "italic" : undefined,
        textShadow: hasCover && coverTextShadow && titleAnchor === "in" ? "0 2px 10px rgba(0,0,0,0.6)" : undefined,
      }}
      title={mode === "edit" && !isYear ? "Right-click for font options" : undefined}
    />
  );

  const renderIconInZone = (zone: Anchor) => {
    if (!showHeaderIcon) return null;
    if (iconAnchor !== zone) return null;
    if (!icon && mode !== "edit") return null;
    return (
      <div className="absolute z-10" style={{ left: `${iconX}%`, top: `${iconY}%`, transform: "translate(-50%, -50%)" }}>
        {icon ? iconEl : addIconEl}
      </div>
    );
  };

  const renderTitleInZone = (zone: Anchor) => {
    if (titleAnchor !== zone) return null;
    return (
      <div className="absolute z-[5]" style={{ left: `${titleX}%`, top: `${titleY}%`, transform: "translate(-50%, -50%)", width: "80%", maxWidth: "48rem" }}>
        {titleInputEl}
      </div>
    );
  };

  return (
    <div className="w-full h-full bg-[#0f1315] text-gray-200 overflow-y-auto flex flex-col">
      {modal}

      {lightbox && (
        <PhotoLightbox
          srcs={lightbox.srcs}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndexChange={(i) => setLightbox((prev) => (prev ? { ...prev, index: i } : null))}
        />
      )}

      {focusMode && (
        <button onClick={onToggleFocus} className="fixed top-3 right-3 z-[80] p-2 rounded bg-[#1e2327] border border-[#2a3136] text-gray-400 hover:text-gray-100 cursor-pointer" title="Exit focus mode (Ctrl+Shift+F)">
          <Minimize2 size={14} />
        </button>
      )}

      {iconMenu && (
        <div ref={iconMenuRef} className="fixed z-[200] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-xl py-1 w-56" style={{ top: iconMenu.y, left: iconMenu.x }}>
          <button onClick={() => { setIconMenu(null); openIconPicker(); }} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]">
            <Smile size={13} /> <span>Change icon</span>
          </button>
          <button onClick={resetIconPosition} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]">
            <Move size={13} /> <span>Reset position</span>
          </button>
          <button onClick={confirmRemoveIcon} className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-[#2a3136] flex items-center space-x-2">
            <Trash2 size={13} /> <span>Remove icon (both)</span>
          </button>
        </div>
      )}

      {titleMenu && (
        <div ref={titleMenuRef} className="fixed z-[200] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-xl py-1 w-48 max-h-96 overflow-y-auto" style={{ top: titleMenu.y, left: titleMenu.x }}>
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
            <TypeIcon size={10} /> Title font
          </div>
          {TITLE_FONTS.map((f) => (
            <button
              key={f.id}
              onClick={() => applyTitleFont(f.id)}
              style={{ fontFamily: f.stack, fontStyle: f.id === "italic" ? "italic" : undefined }}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-[#2a3136] flex items-center justify-between ${f.id === titleFont ? "text-gray-100" : "text-gray-300"}`}
            >
              <span>{f.label}</span>
              {f.id === titleFont && <span className="text-blue-400 text-xs">●</span>}
            </button>
          ))}
        </div>
      )}

      {!focusMode && (
        <div className="flex items-center justify-end gap-2 px-6 pt-4 pb-2 flex-shrink-0">
          <div className="relative" ref={widthMenuRef}>
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setWidthMenuOpen((o) => !o)}
              className="flex items-center gap-1.5 px-2 h-8 rounded text-xs text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer"
              title="Document width"
            >
              <WidthIcon size={16} />
              <span className="hidden md:inline">{widthOption.label}</span>
            </button>
            {widthMenuOpen && (
              <div className="absolute right-0 top-full mt-1 z-[300] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-xl py-1 w-44">
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-500">Document width</div>
                {DOC_WIDTHS.map((w) => {
                  const WIcon = w.icon;
                  return (
                    <button key={w.id} onClick={() => applyDocWidth(w.id)} className={`w-full text-left px-3 py-1.5 text-sm hover:bg-[#2a3136] flex items-center gap-2 ${w.id === docWidth ? "text-gray-100" : "text-gray-300"}`}>
                      <WIcon size={13} />
                      <span>{w.label}</span>
                      {w.id === docWidth && <span className="ml-auto text-blue-400 text-xs">●</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <button onClick={openProperties} className="flex items-center justify-center w-8 h-8 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer" title="Properties">
            <List size={16} />
          </button>
          <button onClick={openSource} className="flex items-center justify-center w-8 h-8 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer" title="Source">
            <Code2 size={16} />
          </button>
          <button onClick={openCoverPanel} className="flex items-center justify-center w-8 h-8 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer" title="Header settings">
            <Sliders size={16} />
          </button>
          <button onClick={toggle} className="flex items-center justify-center w-8 h-8 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer" title={mode === "edit" ? "Switch to read mode (Ctrl+E)" : "Switch to edit mode (Ctrl+E)"}>
            {mode === "edit" ? <BookOpen size={16} /> : <Pencil size={16} />}
          </button>
          {onToggleFocus && (
            <button onClick={onToggleFocus} className="flex items-center justify-center w-8 h-8 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors cursor-pointer" title="Focus mode (Ctrl+Shift+F)">
              <Maximize2 size={16} />
            </button>
          )}
        </div>
      )}

      {hasAboveContent && (
        <div className="relative w-full h-20">
          {renderIconInZone("above")}
          {renderTitleInZone("above")}
        </div>
      )}

      <div className="flex-1">
        <div className={`relative w-full ${hasCover ? "h-56" : "h-44"} mb-2`}>
          {hasCover && (
            <>
              <div className="absolute inset-0 overflow-hidden" style={{ borderRadius: coverRadius > 0 ? `${coverRadius}px` : undefined, ...featherMask }}>
                <div data-cover-layer className="absolute" style={{ inset: coverBlur > 0 ? `-${Math.max(16, coverBlur * 2)}px` : 0, ...coverBackground, opacity: coverOpacity / 100, filter: coverBlur > 0 ? `blur(${coverBlur}px)` : undefined }} />
              </div>
              {coverTextShadow && <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/10 to-transparent pointer-events-none" style={{ borderRadius: coverRadius > 0 ? `${coverRadius}px` : undefined }} />}
            </>
          )}

          {renderIconInZone("in")}
          {renderTitleInZone("in")}

          {hasCover && mode === "edit" && (
            <div className="absolute top-3 right-3 flex items-center gap-1">
              <button onClick={toggleTextShadow} className={`p-1.5 rounded text-white transition-colors ${coverTextShadow ? "bg-black/60 hover:bg-black/80" : "bg-black/30 hover:bg-black/60 text-white/50"}`} title={coverTextShadow ? "Hide text shadow" : "Show text shadow"}>
                <Sparkles size={12} />
              </button>
              <button onClick={openCoverPanel} className="p-1.5 rounded bg-black/60 hover:bg-black/80 text-white" title="Header settings">
                <Sliders size={12} />
              </button>
              <button onClick={removeCover} className="p-1.5 rounded bg-black/60 hover:bg-black/80 text-white" title="Remove cover">
                <X size={12} />
              </button>
            </div>
          )}

          {!hasCover && mode === "edit" && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
              <button onClick={openCoverPanel} className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#1e2327] transition-colors whitespace-nowrap">
                <ImageIcon size={12} /> Add cover
              </button>
            </div>
          )}
        </div>

        {hasBelowContent && (
          <div className="relative w-full h-20">
            {renderIconInZone("below")}
            {renderTitleInZone("below")}
          </div>
        )}

        <div className={`${contentWrap} pt-2 pb-4`}>
          <div className="flex items-center justify-center space-x-4 text-xs text-gray-400">
            <span>Created: {createdAt}</span>
            <span>•</span>
            <span>Last Modified: {modifiedAt}</span>
            {wordCount > 0 && (<><span>•</span><span>{wordCount} words</span></>)}
          </div>
        </div>

        <div className={`${contentWrap} pb-8`}>
          <NoteBody
            ref={noteBodyRef}
            key={`${activeNote.path}::${sourceNonce}`}
            path={activeNote.path}
            vaultPath={vaultPath}
            onWordCountChange={setWordCount}
            onOpenNoteByPath={onOpenNoteByPath}
            onImageClick={(srcs, index) => setLightbox({ srcs, index })}
            onLoaded={() => setModifiedAt(new Date().toLocaleString())}
            onSaved={() => setModifiedAt(new Date().toLocaleString())}
            onFrontmatterLoaded={(fm: Frontmatter) => {
              setIcon((fm.icon as string) || "");
              setShowHeaderIcon(fm.showHeaderIcon !== false);
              setCoverType((fm.coverType as string) || "");
              setCoverValue((fm.coverValue as string) || "");
              setCoverPosX(typeof fm.coverPosX === "number" ? fm.coverPosX : 50);
              setCoverPosY(typeof fm.coverPosY === "number" ? fm.coverPosY : 50);
              setCoverOpacity(typeof fm.coverOpacity === "number" ? fm.coverOpacity : 100);
              setCoverBlur(typeof fm.coverBlur === "number" ? fm.coverBlur : 0);
              setCoverRadius(typeof fm.coverRadius === "number" ? fm.coverRadius : 0);
              setCoverFeather(typeof fm.coverFeather === "number" ? fm.coverFeather : 0);
              setCoverTextShadow(fm.coverTextShadow !== false);
              setIconAnchor((fm.iconAnchor as Anchor) || "in");
              setIconX(typeof fm.iconX === "number" ? fm.iconX : 8);
              setIconY(typeof fm.iconY === "number" ? fm.iconY : 50);
              setTitleAnchor((fm.titleAnchor as Anchor) || "in");
              setTitleX(typeof fm.titleX === "number" ? fm.titleX : 50);
              setTitleY(typeof fm.titleY === "number" ? fm.titleY : 50);
              setTitleFont((fm.titleFont as string) || "default");
              setDocWidth(((fm.docWidth as string) as DocWidthId) || "default");
            }}
          />
        </div>
      </div>

      {coverPickerOpen && (
        <div className="fixed z-[100] bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[560px] max-h-[80vh] overflow-hidden flex flex-col" style={{ top: pickerPos.y, left: pickerPos.x }}>
          <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a3136] cursor-move select-none bg-[#1a1e21]" onMouseDown={(e) => { if ((e.target as HTMLElement).closest("[data-no-drag]")) return; e.preventDefault(); setDragStart({ mx: e.clientX, my: e.clientY, px: pickerPos.x, py: pickerPos.y }); }}>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-100">
              <GripHorizontal size={14} className="text-gray-500" />
              <Palette size={14} />
              <span>Header</span>
            </div>
            <button data-no-drag onClick={() => setCoverPickerOpen(false)} className="text-gray-500 hover:text-gray-300 cursor-pointer" title="Close">
              <X size={14} />
            </button>
          </div>
          <div className="p-4 pr-5 overflow-y-auto space-y-4">
            <div>
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className="text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-1.5"><Smile size={10} /> Icon</span>
                <button type="button" onClick={toggleShowHeaderIcon} className="flex items-center gap-2 flex-shrink-0 cursor-pointer" title={showHeaderIcon ? "Hide icon from note header" : "Show icon in note header"}>
                  <span className="text-[10px] text-gray-500">{showHeaderIcon ? "Visible" : "Hidden"}</span>
                  <span className="relative rounded-full transition-colors flex-shrink-0" style={{ width: 28, height: 16, backgroundColor: showHeaderIcon ? "#3b82f6" : "#3a4147" }}>
                    <span className="absolute rounded-full bg-white" style={{ width: 12, height: 12, top: 2, left: showHeaderIcon ? 14 : 2, transition: "left 150ms ease", boxShadow: "0 1px 2px rgba(0,0,0,0.3)" }} />
                  </span>
                </button>
              </div>
              <AnchorPicker value={iconAnchor} onChange={(a) => updateIconPos({ iconAnchor: a })} />
              <div className="mt-3 space-y-2">
                <SliderRow label="Horizontal" value={iconX} min={0} max={100} unit="%" onChange={(v) => updateIconPos({ iconX: v })} />
                <SliderRow label="Vertical" value={iconY} min={0} max={100} unit="%" onChange={(v) => updateIconPos({ iconY: v })} />
              </div>
            </div>
            <div className="border-t border-[#2a3136] pt-3">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5"><TypeIcon size={10} /> Title</div>
              <AnchorPicker value={titleAnchor} onChange={(a) => updateTitlePos({ titleAnchor: a })} />
              <div className="mt-3 space-y-2">
                <SliderRow label="Horizontal" value={titleX} min={0} max={100} unit="%" onChange={(v) => updateTitlePos({ titleX: v })} />
                <SliderRow label="Vertical" value={titleY} min={0} max={100} unit="%" onChange={(v) => updateTitlePos({ titleY: v })} />
              </div>
            </div>
            <div className="border-t border-[#2a3136] pt-3">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5"><ImageIcon size={10} /> Banner</div>
              <div className="flex gap-2 mb-3">
                <button onClick={uploadCover} className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200 whitespace-nowrap">
                  <Upload size={12} /> Upload
                </button>
                <div className="flex-1 flex gap-2">
                  <input type="text" value={coverUrlDraft} onChange={(e) => setCoverUrlDraft(e.target.value)} placeholder="or paste image URL…" onKeyDown={(e) => { if (e.key === "Enter") { const val = coverUrlDraft.trim(); if (val) applyCover("image", val); } }} className="flex-1 bg-[#0f1315] border border-[#30363d] rounded px-3 py-1.5 text-xs text-gray-100 outline-none focus:ring-1 focus:ring-blue-500" />
                  <button onClick={() => { const val = coverUrlDraft.trim(); if (val) applyCover("image", val); }} className="flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded whitespace-nowrap">
                    <LinkIcon size={12} /> Apply
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-5 gap-2 mb-3">
                {COVER_GRADIENTS.map((g) => (
                  <button key={g.id} onClick={() => applyCover("color", g.id)} className={`aspect-[3/2] rounded cursor-pointer hover:ring-2 hover:ring-blue-500 transition-all ${coverType === "color" && coverValue === g.id ? "ring-2 ring-blue-400" : ""}`} style={{ background: g.value }} title={g.label} />
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

      {propertiesOpen && (
        <div className="fixed inset-0 z-[150] bg-black/60 flex items-start justify-center pt-20" onClick={() => setPropertiesOpen(false)}>
          <div className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[560px] max-h-[75vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a3136] bg-[#1a1e21]">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-100">
                <List size={14} />
                <span>Properties</span>
              </div>
              <button onClick={() => setPropertiesOpen(false)} className="text-gray-500 hover:text-gray-300 cursor-pointer"><X size={14} /></button>
            </div>
            <div className="p-4 overflow-y-auto space-y-2">
              {Object.keys(properties).length === 0 && (
                <p className="text-xs text-gray-500 italic text-center py-4">No properties yet.</p>
              )}
              {Object.entries(properties).map(([key, value]) => (
                <div key={key} className="flex items-center gap-2 group">
                  <span className="text-xs text-gray-400 font-mono w-32 flex-shrink-0 truncate" title={key}>{key}</span>
                  <input
                    type="text"
                    defaultValue={fmValueToString(value)}
                    onBlur={(e) => {
                      const next = e.target.value;
                      if (next !== fmValueToString(value)) updateProperty(key, next);
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    className="flex-1 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-100 outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                  />
                  <button onClick={() => deleteProperty(key)} className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 p-1 transition-opacity" title="Delete property">
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <div className="border-t border-[#2a3136] mt-3 pt-3">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Add property</div>
                <div className="flex items-center gap-2">
                  <input type="text" value={newPropKey} onChange={(e) => setNewPropKey(e.target.value)} placeholder="key" className="bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-100 outline-none focus:ring-1 focus:ring-blue-500 font-mono w-32" />
                  <input type="text" value={newPropValue} onChange={(e) => setNewPropValue(e.target.value)} placeholder="value" onKeyDown={(e) => { if (e.key === "Enter") addProperty(); }} className="flex-1 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-100 outline-none focus:ring-1 focus:ring-blue-500 font-mono" />
                  <button onClick={addProperty} disabled={!newPropKey.trim()} className="flex items-center gap-1 px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded whitespace-nowrap">
                    <Plus size={12} /> Add
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {sourceOpen && (
        <div className="fixed inset-0 z-[150] bg-black/70 flex items-start justify-center pt-16" onClick={() => setSourceOpen(false)}>
          <div className="bg-[#0f1315] border border-[#2a3136] rounded-lg shadow-2xl w-[820px] max-w-[92vw] max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-100 min-w-0">
                <Code2 size={14} className="flex-shrink-0" />
                <span className="flex-shrink-0">Source</span>
                <span className="text-[10px] text-gray-500 font-mono ml-2 truncate">{activeNote.path.split(/[/\\]/).pop()}</span>
                {sourceDirty && <span className="text-[10px] text-amber-400 flex-shrink-0">• unsaved</span>}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {sourceDirty && (
                  <button onClick={revertSource} disabled={sourceSaving} className="flex items-center gap-1.5 px-2 py-1 text-xs text-gray-400 hover:text-gray-100 hover:bg-[#2a3136] rounded transition-colors disabled:opacity-40">
                    <X size={12} /> <span>Revert</span>
                  </button>
                )}
                <button onClick={saveSource} disabled={!sourceDirty || sourceSaving} className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors font-medium">
                  {sourceSaving ? <span>Saving…</span> : <><Check size={12} /><span>Save</span></>}
                </button>
                <button onClick={copySource} className="flex items-center gap-1.5 px-2 py-1 text-xs text-gray-400 hover:text-gray-100 hover:bg-[#2a3136] rounded transition-colors">
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  <span>{copied ? "Copied" : "Copy"}</span>
                </button>
                <button onClick={() => setSourceOpen(false)} className="text-gray-500 hover:text-gray-300 cursor-pointer p-1"><X size={14} /></button>
              </div>
            </div>
            <textarea
              value={sourceDraft}
              onChange={(e) => setSourceDraft(e.target.value)}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              className="flex-1 w-full bg-transparent p-4 text-xs text-gray-300 font-mono leading-relaxed outline-none resize-none border-0"
              style={{ tabSize: 2, minHeight: "60vh" }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function AnchorPicker({ value, onChange }: { value: Anchor; onChange: (a: Anchor) => void }) {
  const opts: { id: Anchor; label: string; icon: any }[] = [
    { id: "above", label: "Above", icon: ArrowUp },
    { id: "in", label: "In", icon: Minus },
    { id: "below", label: "Below", icon: ArrowDown },
  ];
  return (
    <div className="flex gap-1 bg-[#0f1315] border border-[#30363d] rounded p-0.5">
      {opts.map((o) => {
        const Icon = o.icon;
        const active = value === o.id;
        return (
          <button key={o.id} onClick={() => onChange(o.id)} className={`flex-1 flex items-center justify-center gap-1.5 py-1 text-xs rounded transition-colors ${active ? "bg-[#2a3136] text-gray-100" : "text-gray-400 hover:text-gray-200 hover:bg-[#1e2327]"}`}>
            <Icon size={11} />
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SliderRow({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="flex justify-between text-[10px] uppercase tracking-wider text-gray-500 mb-1">
        <span>{label}</span>
        <span className="text-gray-400 normal-case">{value}{unit}</span>
      </label>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-blue-500" />
    </div>
  );
}
