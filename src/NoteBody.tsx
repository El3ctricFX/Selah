// // src/NoteBody.tsx
import { BlockNoteSchema, combineByGroup, filterSuggestionItems } from "@blocknote/core";
import {
  createImageGallery,
  GALLERY_MOVE_EVENT,
  GALLERY_EDGE_DROP_EVENT,
  GALLERY_EDGE_HOVER_EVENT,
} from "./ImageGallery";
import { insertOrUpdateBlockForSlashMenu } from "@blocknote/core/extensions";
import {
  useCreateBlockNote,
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import * as locales from "@blocknote/core/locales";
import {
  withMultiColumn,
  multiColumnDropCursor,
  locales as multiColumnLocales,
  getMultiColumnSlashMenuItems,
} from "@blocknote/xl-multi-column";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  readTextFile,
  readDir,
  writeFile,
  copyFile,
  rename as fsRename,
  exists as fsExists,
} from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl, openPath } from "@tauri-apps/plugin-opener";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Trash2,
  AlertTriangle,
  X,
  Link as LinkIcon,
  Type as TypeIcon,
  Play as PlayIcon,
  Copy,
  ExternalLink,
  Square,
  RectangleHorizontal,
  RectangleVertical,
  RotateCcw,
  Download,
  Replace,
  Pencil,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Eye,
  EyeOff,
  FileText,
} from "lucide-react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { createCallout } from "./Callout";
import { createBookmark } from "./Bookmark";
import { createVideo } from "./VideoBlock";
import { createScripture } from "./ScriptureBlock";
import { createDmArchive } from "./DmArchive";
import { isReliablyEmbeddable } from "./embeds";
import { useNoteMode } from "./useNoteMode";
import { NoteContext } from "./NoteContext";
import {
  noteBodyToBlocks,
  blocksToNoteBody,
  parseNoteFile,
  serializeNoteFile,
} from "./noteFormat";
import type { Frontmatter } from "./noteFormat";
import {
  saveImageToNoteAssets,
  saveFileToNoteAssets,
  writeImageBytesToNoteAssets,
  markdownImagesToAssetUrls,
  markdownImagesToRelativePaths,
  videoSrcsToAssetUrls,
  videoSrcsToRelativePaths,
  dmarchiveSrcsToAssetUrls,
  dmarchiveSrcsToRelativePaths,
  assetUrlToAbsolutePath,
  isInsideNoteAssets,
  deleteImageFromNoteAssets,
  imageGalleryToAssetUrls,
  imageGalleryToRelativePaths,
} from "./imageAssets";
import {
  canonicalizeUrl,
  detectPlatform,
  fetchEnrichedMetadata,
  humanizeUrlTitle,
  normalizeUrlInput,
} from "./linkMeta";
import { writeFileAtomic } from "./safeWrite";
import { registerFlusher } from "./flushRegistry";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

interface NoteBodyProps {
  path: string;
  vaultPath?: string;
  onLoaded?: () => void;
  onSaved?: () => void;
  onWordCountChange?: (count: number) => void;
  onFrontmatterLoaded?: (fm: Frontmatter) => void;
  onOpenNoteByPath?: (path: string) => void;
  onImageClick?: (srcs: string[], index: number) => void;
}

export interface NoteBodyHandle {
  updateFrontmatter: (patch: Partial<Frontmatter>) => Promise<void>;
  flush: () => Promise<void>;
  dispose: () => void;
  rearm: () => void;
}

type NoteEntry = { path: string; name: string; icon: string };

function noteDirOf(notePath: string): string {
  const lastSlash = Math.max(notePath.lastIndexOf("/"), notePath.lastIndexOf("\\"));
  return notePath.substring(0, lastSlash);
}

function mimeToExt(mime: string): string {
  if (!mime.startsWith("image/")) return "png";
  const sub = mime.slice(6).toLowerCase();
  if (sub === "jpeg") return "jpg";
  if (sub === "svg+xml") return "svg";
  return sub;
}

function collectImageUrls(blocks: any[]): string[] {
  const out: string[] = [];
  const walk = (bs: any[]) => {
    for (const b of bs) {
      if (b?.type === "image" && b.props?.url) {
        out.push(b.props.url as string);
      }
      if (Array.isArray(b?.children)) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

async function collectNoteFiles(
  dir: string,
  out: NoteEntry[],
  depth = 0
): Promise<void> {
  if (depth > 8) return;
  try {
    const entries = await readDir(dir);
    for (const e of entries) {
      if (!e.name) continue;
      if (e.name.startsWith(".") || e.name === "assets" || e.name === "_attachments") continue;
      const full = await join(dir, e.name);
      if (e.isDirectory) {
        await collectNoteFiles(full, out, depth + 1);
      } else if (e.name.endsWith(".selah")) {
        let icon = "";
        try {
          const raw = await readTextFile(full);
          const { frontmatter } = parseNoteFile(raw);
          icon = (frontmatter.icon as string) || "";
        } catch {}
        out.push({
          path: full,
          name: e.name.replace(/\.selah$/, ""),
          icon,
        });
      }
    }
  } catch {}
}

function countWords(markdown: string): number {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[.*?\]\(.*?\)/g, " ")
    .replace(/\[([^\]]*)\]\(.*?\)/g, "$1")
    .replace(/[#*_>`~\-|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return 0;
  return plain.split(" ").filter(Boolean).length;
}

function isEmptyParagraph(block: any): boolean {
  if (!block || block.type !== "paragraph") return false;
  const content = block.content;
  if (!Array.isArray(content)) return true;
  if (content.length === 0) return true;
  return content.every(
    (c: any) =>
      !c || (c.type === "text" && !String(c.text ?? "").trim())
  );
}

function guessImageFileName(url: string): string {
  try {
    const cleaned = url.split("?")[0].split("#")[0];
    const parts = cleaned.split(/[/\\]/);
    const last = parts[parts.length - 1] || "";
    let decoded = last;
    try { decoded = decodeURIComponent(last); } catch {}
    if (!decoded) return "image.png";
    if (!/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(decoded)) {
      return `${decoded}.png`;
    }
    return decoded;
  } catch {
    return "image.png";
  }
}

/**
 * Parse a `text/uri-list` payload (what Linux file managers put on the
 * clipboard when you copy a file) into a list of absolute filesystem paths.
 *
 * Format is one URI per line, CRLF-separated, with `#` for comments.
 * We handle both file:///home/user/x.png and file:///C:/Users/x.png.
 */
function parseUriList(text: string): string[] {
  if (!text) return [];
  const paths: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    if (/^file:\/\//i.test(line)) {
      try {
        const url = new URL(line);
        let p = decodeURIComponent(url.pathname);
        // Windows: /C:/Users/... → C:/Users/...
        if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
        paths.push(p);
      } catch {
        let p = line.slice(7);
        try { p = decodeURIComponent(p); } catch {}
        paths.push(p);
      }
      continue;
    }

    // Some file managers (notably Nemo on this system) put a plain
    // absolute path on the clipboard instead of a file:// URI. Accept
    // both Unix (/home/…) and Windows (C:\… or C:/…) shapes.
    if (/^\//.test(line) || /^[a-zA-Z]:[\\/]/.test(line)) {
      let p = line;
      try { p = decodeURIComponent(line); } catch {}
      paths.push(p);
    }
  }
  return paths;
}

type DropTarget =
| {
  kind: "insert";
  refId: string;
  placement: "before" | "after" | "nested";
}
| { kind: "gallery"; blockId: string; row: number; col: number }
| null;

/**
 * Turn a viewport coordinate into a description of where a dropped file
 * should land:
 *
 *   - Over a gallery cell → target that cell (one image per cell).
 *   - Over an empty column → nest inside that column.
 *   - Over any other block → insert before/after it based on which half
 *     of the block the cursor is in.
 *
 * Returns null if nothing sensible is under the cursor — the caller then
 * falls back to the default (insert after the cursor / at end of doc).
 */
function resolveDropTarget(
  clientX: number,
  clientY: number,
  editorRoot: HTMLElement
): DropTarget {
  const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  if (!el) return null;
  if (!editorRoot.contains(el)) return null;

  // ── Gallery cell ───────────────────────────────────────────────
  const cellEl = el.closest("[data-gallery-block-id]") as HTMLElement | null;
  if (cellEl) {
    const blockId = cellEl.getAttribute("data-gallery-block-id");
    const row = Number(cellEl.getAttribute("data-gallery-row"));
    const col = Number(cellEl.getAttribute("data-gallery-col"));
    if (blockId && Number.isFinite(row) && Number.isFinite(col)) {
      return { kind: "gallery", blockId, row, col };
    }
  }

  // ── Nearest [data-id] block ancestor ───────────────────────────
  const blockEl = el.closest("[data-id]") as HTMLElement | null;
  if (!blockEl || !editorRoot.contains(blockEl)) return null;
  const refId = blockEl.getAttribute("data-id");
  if (!refId) return null;

  // Empty column: nest inside rather than dropping at root level.
  if (blockEl.matches(".bn-block-column, [data-node-type='column']")) {
    return { kind: "insert", refId, placement: "nested" };
  }

  const rect = blockEl.getBoundingClientRect();
  const placement: "before" | "after" =
  clientY < rect.top + rect.height / 2 ? "before" : "after";
  return { kind: "insert", refId, placement };
}


const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|mkv|m4v|avi|ogv)$/i;

const URL_RE = /^https?:\/\/\S+$/i;
const DEBOUNCE_MS = 150;
const MAX_DEBOUNCE_MS = 2000;

const NOTE_LINK_KEY = new PluginKey("note-links");

function buildNoteLinkDecorations(doc: any): DecorationSet {
  try {
    return buildNoteLinkDecorationsUnsafe(doc);
  } catch (e) {
    console.error("[note-links] decoration build failed:", e);
    return DecorationSet.empty;
  }
}

function buildNoteLinkDecorationsUnsafe(doc: any): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node: any, pos: number) => {
    if (!node.isText) return;
    const text: string = node.text || "";
    const re = /\[\[([^\]\n]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const openFrom = pos + m.index;
      const openTo = openFrom + 2;
      const nameFrom = openTo;
      const nameTo = nameFrom + m[1].length;
      const closeFrom = nameTo;
      const closeTo = closeFrom + 2;

      decos.push(
        Decoration.inline(openFrom, openTo, { class: "note-link-bracket" } as any)
      );
      decos.push(
        Decoration.inline(nameFrom, nameTo, {
          class: "note-link",
          "data-note-name": m[1],
        } as any)
      );
      decos.push(
        Decoration.inline(closeFrom, closeTo, { class: "note-link-bracket" } as any)
      );
    }
  });
  return DecorationSet.create(doc, decos);
}

const noteLinkPlugin = new Plugin({
  key: NOTE_LINK_KEY,
  // Rebuild decorations fresh from whichever state is being rendered.
  // Storing them in plugin state is what caused the
  // "Position 35 outside of fragment" crash: after a rapid run of
  // transactions (undo spam, column resize, etc.) the stale set from a
  // longer document could still be attached to a shorter one, and
  // ProseMirror threw when it tried to paint an inline decoration past
  // the end of the doc. Rebuilding on every render makes that impossible
  // — the positions always match the doc being rendered.
  props: {
    decorations(state: any) {
      return buildNoteLinkDecorations(state.doc);
    },
  },
});

const insertCallout = (editor: any) => ({
  title: "Callout",
  subtext: "Callout for emphasizing text",
  onItemClick: () => {
    insertOrUpdateBlockForSlashMenu(editor, {
      type: "callout",
      props: { icon: "💡", color: "gray" },
    } as any);
  },
  aliases: ["callout", "alert", "notification", "info", "warning", "tip", "note"],
  group: "Basic blocks",
  icon: <span className="text-base">💡</span>,
});

const IMAGE_WIDTH_PRESETS: { label: string; px: number | null; icon: any }[] = [
  { label: "Small (240px)",      px: 240,  icon: Square },
  { label: "Medium (400px)",     px: 400,  icon: RectangleHorizontal },
  { label: "Large (600px)",      px: 600,  icon: RectangleVertical },
  { label: "Reset (responsive)", px: null, icon: RotateCcw },
];

const PREVIEW_WIDTH_PX = 512;

type ImageMenuMode = "main" | "caption" | "rename";

interface ImageMenuState {
  x: number;
  y: number;
  blockId: string;
  url: string;
  caption: string;
  textAlignment: string;
  previewWidth: number | undefined;
  mode: ImageMenuMode;
}

const NoteBody = forwardRef<NoteBodyHandle, NoteBodyProps>(
  (
    {
      path,
      vaultPath,
      onLoaded,
      onSaved,
      onWordCountChange,
      onFrontmatterLoaded,
      onOpenNoteByPath,
      onImageClick,
    },
    ref
  ) => {
    const [isLoading, setIsLoading] = useState(true);
    const [linkPickerOpen, setLinkPickerOpen] = useState(false);
    const [linkQuery, setLinkQuery] = useState("");
    const [allNotes, setAllNotes] = useState<NoteEntry[]>([]);
    const [loadingNotes, setLoadingNotes] = useState(false);
    const [pendingImageDelete, setPendingImageDelete] = useState<string[]>([]);
    const [pasteMenu, setPasteMenu] = useState<{
      url: string;
      x: number;
      y: number;
    } | null>(null);
    const pasteMenuRef = useRef<HTMLDivElement>(null);

    const [imageMenu, setImageMenu] = useState<ImageMenuState | null>(null);
    const imageMenuRef = useRef<HTMLDivElement>(null);
    const captionInputRef = useRef<HTMLInputElement>(null);
    const renameInputRef = useRef<HTMLInputElement>(null);

    const [captionDraft, setCaptionDraft] = useState("");
        const [dragOverlay, setDragOverlay] = useState<{
      x: number;
      y: number;
      target: DropTarget;
      indicator?: { left: number; top: number; width: number; height?: number };
    } | null>(null);
    const [renameDraft, setRenameDraft] = useState("");
    const [renameError, setRenameError] = useState<string | null>(null);

    const frontmatterRef = useRef<Frontmatter>({});
    const isNewFileRef = useRef(false);
    const dirtyRef = useRef(false);
    const bracketTriggerRef = useRef(false);
    const disposedRef = useRef(false);

    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
    const saveBodyRef = useRef<() => Promise<void>>(async () => {});
    const lastSaveAtRef = useRef<number>(Date.now());

    const prevImageUrlsRef = useRef<Set<string>>(new Set());
    const handlingDeleteRef = useRef(false);

    // Set to true for a short window when the user presses Ctrl+Z /
    // Ctrl+Shift+Z / Ctrl+Y. BlockNote's `onChange` fires after the undo
    // transaction lands, so without this flag we'd compare the pre-undo
    // image set against the post-undo image set and wrongly conclude the
    // user deleted a photo. Undo is not a deletion.
    // The JSON fingerprint of the document as it looked right after the
    // initial load finished. BlockNote's `replaceBlocks` on load
    // pushes an "[empty] → [content]" entry onto the undo stack, so
    // pressing Ctrl+Z at the loaded state would empty the editor.
    // We detect that exact situation in the keydown handler below and
    // stop the keystroke before ProseMirror sees it. Any edit the user
    // makes changes the fingerprint, so undo works normally after that.
    const undoRedoRef = useRef(false);
    const undoRedoClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const loadedDocFingerprintRef = useRef<string | null>(null);

    const { mode } = useNoteMode();



    const editor = useCreateBlockNote({
      schema: withMultiColumn(
        BlockNoteSchema.create().extend({
          blockSpecs: {
            callout: createCallout(),
            bookmark: createBookmark(),
            video: createVideo(),
            scripture: createScripture(),
            dmarchive: createDmArchive(),
            imagegallery: createImageGallery(),
          },
        })
      ),
      dropCursor: multiColumnDropCursor,
      dictionary: { ...locales.en, multi_column: multiColumnLocales.en },
      pasteHandler: ({ event, editor: ed, defaultPasteHandler }) => {
        const clipboardText = event.clipboardData?.getData("text/plain")?.trim();
        if (!clipboardText) return defaultPasteHandler();
        if (!URL_RE.test(clipboardText)) return defaultPasteHandler();
        const selected = ed.getSelectedText();
        if (!selected || selected.length === 0) return defaultPasteHandler();
        ed.createLink(clipboardText);
        ed.addStyles({ textColor: "blue", underline: true });
        return true;
      },
    });

    // Watch for undo/redo keypresses at the document level, in the
    // capture phase so we see them before ProseMirror's own keymap runs.
    // The flag stays true long enough for any debounced onChange to fire
    // and be processed; if the user keeps spamming Ctrl+Z, the timer is
    // refreshed on each press.
    useEffect(() => {
      // Find the nearest scrollable ancestor of the editor DOM and
      // pin its scrollTop to where it is right now. ProseMirror's undo
      // command ends with `scrollIntoView()`, which yanks the viewport
      // to wherever the restored cursor sits — annoying when you're
      // spamming Ctrl+Z to walk back through a dozen edits. We capture
      // the position before the undo runs and restore it two animation
      // frames later, after ProseMirror's scroll and any layout
      // corrections have landed.
      // Pin every scrollable ancestor of the editor for two frames so
      // ProseMirror's `scrollRectIntoView` (which writes scrollTop
      // directly on each scrolling ancestor during an undo) cannot
      // move the viewport. We override the instance-level scrollTop
      // accessor with a getter that returns the current value and a
      // setter that swallows writes. Two rAFs later we delete the
      // overrides, restoring the native accessor.
      const preserveScroll = () => {
        const tiptap: any = (editor as any)?._tiptapEditor;
        const dom: HTMLElement | null = tiptap?.view?.dom ?? null;
        if (!dom) return;

        // Collect every scrollable ancestor (usually just one).
        const targets: { el: HTMLElement; saved: number }[] = [];
        let node: HTMLElement | null = dom.parentElement;
        while (node) {
          const style = window.getComputedStyle(node);
          const scrollable =
            (style.overflowY === "auto" || style.overflowY === "scroll") &&
            node.scrollHeight > node.clientHeight;
          if (scrollable) {
            targets.push({ el: node, saved: node.scrollTop });
          }
          node = node.parentElement;
        }

        const winX = window.scrollX;
        const winY = window.scrollY;

        if (targets.length === 0 && winX === 0 && winY === 0) return;

        // Enforcement loop.
        //
        // Patching `el.scrollTop` only blocks direct `scrollTop = …`
        // writes. It does not block `scrollTo()`, `scrollBy()`,
        // `scrollIntoView()`, or the browser's native reflow scroll
        // adjustments — so those kept moving the viewport after we'd
        // "protected" it, producing the one-frame up-and-back.
        //
        // Reading back the *actual* scroll position on every rAF and
        // rewriting it when it drifts is the only technique that
        // catches every mover uniformly. rAF callbacks run before the
        // paint phase, so a correction applied in the same frame is
        // never visible to the user.
        const deadline = performance.now() + 220;

        const enforce = () => {
          for (const { el, saved } of targets) {
            if (el.scrollTop !== saved) {
              el.scrollTop = saved;
            }
          }
          if (window.scrollX !== winX || window.scrollY !== winY) {
            window.scrollTo(winX, winY);
          }
          if (performance.now() < deadline) {
            requestAnimationFrame(enforce);
          }
        };

        requestAnimationFrame(enforce);

        // Failsafe for backgrounded tabs where rAF may be throttled.
        setTimeout(() => {
          for (const { el, saved } of targets) {
            try {
              if (el.scrollTop !== saved) el.scrollTop = saved;
            } catch {}
          }
          try {
            if (window.scrollX !== winX || window.scrollY !== winY) {
              window.scrollTo(winX, winY);
            }
          } catch {}
        }, 240);
      };

      const onKeyDown = (e: KeyboardEvent) => {
        const ctrl = e.ctrlKey || e.metaKey;

        // Markdown input-rule scroll guard.
        //
        // Typing `---`, `*** `, or `___ ` turns the paragraph into a
        // horizontal rule. BlockNote/TipTap's rule is:
        //     /^(?:---|—-|___\s|\*\*\*\s)$/
        // Notice `---` has NO trailing `\s` — it fires the instant you
        // type the third hyphen, not on a following space. `***` and
        // `___` do require the trailing space.
        //
        // Either way a taller paragraph is swapped for a shorter HR and
        // ProseMirror's `scrollIntoView` yanks the viewport. Pin the
        // scroll *before* ProseMirror's input-rule handler sees this
        // keystroke so the override is in place when the transaction
        // dispatches.
        if (!ctrl) {
          try {
            const tiptap: any = (editor as any)._tiptapEditor;
            const state = tiptap?.state;
            const sel = state?.selection;
            const from = sel?.empty ? sel.from : -1;

            if (from >= 0) {
              if (e.key === "-" || e.key === "*" || e.key === "_") {
                // Third repetition: typing `-` after `--`, etc.
                const two = state.doc.textBetween(
                  Math.max(0, from - 2),
                  from,
                  "",
                  ""
                );
                if (two === e.key + e.key) preserveScroll();
              } else if (e.key === " " || e.key === "Enter") {
                // Trailing-space variant: `*** ` / `___ ` (and `--- `
                // defensively, in case BlockNote ever changes the rule
                // to require a space).
                const three = state.doc.textBetween(
                  Math.max(0, from - 3),
                  from,
                  "",
                  ""
                );
                if (
                  three === "---" ||
                  three === "***" ||
                  three === "___"
                ) {
                  preserveScroll();
                }
              }
            }
          } catch {}
          return;
        }

        const k = e.key.toLowerCase();
        if (k !== "z" && k !== "y") return;

        // Redo and Ctrl+Y always pass through — they can't empty the doc.
        const isRedo = e.shiftKey || k === "y";
        if (isRedo) {
          preserveScroll();
          undoRedoRef.current = true;
          if (undoRedoClearRef.current) clearTimeout(undoRedoClearRef.current);
          undoRedoClearRef.current = setTimeout(() => {
            undoRedoRef.current = false;
            undoRedoClearRef.current = null;
          }, 400);
          return;
        }

        // Plain Ctrl+Z. If the document currently matches the loaded
        // fingerprint, the next undo would unwind the initial load
        // transaction and leave an empty editor. Swallow the keystroke.
        if (loadedDocFingerprintRef.current !== null) {
          try {
            const current = JSON.stringify(
              editor.document.map((b: any) => ({
                type: b.type,
                props: b.props || {},
                content: b.content || [],
                children: b.children || [],
              }))
            );
            if (current === loadedDocFingerprintRef.current) {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              return;
            }
          } catch {
            /* fingerprint failed — let the undo through */
          }
        }

        // Normal undo — keep the viewport pinned, then mark the flag
        // so the image-delete detector doesn't misread the resulting
        // change as a user deletion.
        preserveScroll();
        undoRedoRef.current = true;
        if (undoRedoClearRef.current) clearTimeout(undoRedoClearRef.current);
        undoRedoClearRef.current = setTimeout(() => {
          undoRedoRef.current = false;
          undoRedoClearRef.current = null;
        }, 400);
      };
      document.addEventListener("keydown", onKeyDown, true);
      return () => {
        document.removeEventListener("keydown", onKeyDown, true);
        if (undoRedoClearRef.current) {
          clearTimeout(undoRedoClearRef.current);
          undoRedoClearRef.current = null;
        }
      };
    }, [editor]);

    // Hide BlockNote's floating toolbar while a file block (image/video/...) is
    // selected. We toggle a body class and let CSS do the hiding, because the
    // toolbar is portaled and can't be reliably suppressed from the component.
    useEffect(() => {
      if (!editor) return;
      const FILE_TYPES = ["image", "video", "audio", "file"];
      const update = () => {
        let hide = false;
        try {
          const sel: any = (editor as any)._tiptapEditor?.state?.selection;
          if (sel?.node) hide = true;
          else hide = FILE_TYPES.includes(editor.getTextCursorPosition().block.type);
        } catch {
          /* ignore */
        }
        document.body.classList.toggle("bn-hide-file-toolbar", hide);
      };
      update();
      const unsub = editor.onSelectionChange(update);
      return () => {
        document.body.classList.remove("bn-hide-file-toolbar");
        if (typeof unsub === "function") unsub();
      };
    }, [editor]);

    const insertBlocksSmart = useCallback(
      (
        blocksToInsert: any[],
        explicitRefId?: string | null,
        explicitPlacement?: "before" | "after" | "nested"
      ): any[] => {
        if (!editor || blocksToInsert.length === 0) return [];
        try {
          // Prefer the caller-supplied reference block. It's captured
          // synchronously before any `await` (file pickers, etc.), so it
          // can't go stale the way `getTextCursorPosition()` can.
          let refBlock: any = null;
          if (explicitRefId) {
            try { refBlock = editor.getBlock(explicitRefId); } catch {}
          }
          if (!refBlock) {
            try {
              const cursor = editor.getTextCursorPosition?.();
              refBlock =
              cursor?.block || editor.document[editor.document.length - 1];
            } catch {
              refBlock = editor.document[editor.document.length - 1];
            }
          }
          if (!refBlock) return [];

          // Caller supplied an explicit placement — honor it verbatim. This
          // is what drag-and-drop uses to land the file exactly where the
          // cursor was released, whether that's at root level or inside a
          // column.
          if (explicitRefId && explicitPlacement) {
            try {
              const inserted = editor.insertBlocks(
                blocksToInsert,
                refBlock.id,
                explicitPlacement as any
              );
              return inserted || [];
            } catch (e) {
              console.warn(
                "[insert] explicit placement failed, falling back:",
                e
              );
            }
          }

          // ── Detect the enclosing column ──────────────────────────────
          // BlockNote doesn't expose parent pointers, so we look up the
          // block's DOM node and walk up to find the nearest column
          // ancestor. This is what lets us nest into the column the user
          // is actually looking at, even when a sibling column is empty.
          let enclosingColumnId: string | null = null;
          if (refBlock.type !== "column" && refBlock.type !== "columnList") {
            try {
              const blockEl = document.querySelector(
                `[data-id="${refBlock.id}"]`
              ) as HTMLElement | null;
              const colEl = blockEl?.closest(
                ".bn-block-column, [data-node-type='column']"
              ) as HTMLElement | null;
              if (colEl) {
                const cid = colEl.getAttribute("data-id");
                if (cid && cid !== refBlock.id) enclosingColumnId = cid;
              }
            } catch {}
          }

          // ── Inside a column ──────────────────────────────────────────
          // Do NOT use replaceBlocks on a block inside a column. Even a
          // successful replace makes BlockNote's multi-column extension
          // re-evaluate the whole column list; any sibling column whose
          // only content is an empty paragraph gets stripped, the now
          // single-column list is un-wrapped, and the image ends up at
          // the root — which is what the user saw as "the columns
          // disappeared and it became one big photo".
          //
          // Inserting the new blocks *alongside* the reference block
          // leaves every existing column (and its placeholder paragraph)
          // completely untouched, so the collapse pass never runs.
          if (enclosingColumnId) {
            const inserted = editor.insertBlocks(
              blocksToInsert,
              refBlock.id,
              "before"
            );
            return inserted || [];
          }

          // ── Structural refs (columnList / column as the cursor) ──────
          // Same reasoning as above: never replace a column or a
          // columnList. Nest into a column instead.
          if (refBlock.type === "columnList") {
            const firstColumn = refBlock.children?.[0];
            if (firstColumn) {
              const inserted = editor.insertBlocks(
                blocksToInsert,
                firstColumn.id,
                "nested" as any
              );
              return inserted || [];
            }
          }
          if (refBlock.type === "column") {
            const inserted = editor.insertBlocks(
              blocksToInsert,
              refBlock.id,
              "nested" as any
            );
            return inserted || [];
          }

          // ── Non-structural refs: existing behavior ───────────────────
          if (isEmptyParagraph(refBlock)) {
            try {
              const replaced = editor.replaceBlocks(
                [refBlock.id],
                blocksToInsert
              );
              return replaced?.insertedBlocks || [];
            } catch (e) {
              console.warn("[insert] replaceBlocks failed, falling back:", e);
            }
          }
          const inserted = editor.insertBlocks(
            blocksToInsert,
            refBlock,
            "after"
          );
          return inserted || [];
        } catch (e) {
          console.error("[insert] failed:", e);
          return [];
        }
      },
      [editor]
    );

    useEffect(() => {
      if (!editor) return;
      editor.isEditable = mode === "edit";
    }, [mode, editor]);

    useEffect(() => {
      if (!editor) return;
      const tiptap: any = (editor as any)._tiptapEditor;
      if (!tiptap) return;
      try {
        tiptap.registerPlugin(noteLinkPlugin);
      } catch (e) {
        console.warn("[note-links] registerPlugin failed:", e);
      }
      // Deliberately no unregister on cleanup. Tiptap's unregister /
      // re-register cycle rebuilds the whole EditorState, which
      // re-initializes the undo history with whatever doc happens to be
      // current at that moment — that's what let Ctrl+Z walk past the
      // initial load and unload the note. The editor instance is thrown
      // away when this component unmounts anyway, so there's nothing to
      // clean up.
    }, [editor]);

    // ── Force deselect of an image when clicking anywhere else ──────────
    useEffect(() => {
      if (!editor) return;

      const onDown = (e: MouseEvent) => {
        const t = e.target as HTMLElement | null;
        if (!t) return;
        if (t.closest('[data-content-type="image"]')) return;

        setTimeout(() => {
          try {
            const tiptap: any = (editor as any)._tiptapEditor;
            if (!tiptap) return;
            const state = tiptap.state;
            if (!state?.selection) return;
            if (!state.selection.node) return;

            const from = state.selection.from;
            const to = state.selection.to;
            const docSize = state.doc.content.size;
            const candidates = [
              Math.max(0, from - 1),
              Math.min(docSize, to + 1),
            ];
            for (const pos of candidates) {
              try {
                tiptap.commands.setTextSelection(pos);
                return;
              } catch {}
            }
            try { tiptap.commands.blur(); } catch {}
          } catch (err) {
            console.warn("[deselect] failed:", err);
          }
        }, 0);
      };

      document.addEventListener("mousedown", onDown);
      return () => document.removeEventListener("mousedown", onDown);
    }, [editor]);

    // ── Right-click menu helpers ────────────────────────────────────────
    const closeImageMenu = () => setImageMenu(null);

    const backToMainMenu = () => {
      setImageMenu((prev) => (prev ? { ...prev, mode: "main" } : prev));
      setRenameError(null);
    };

    const applyImageWidth = (blockId: string, px: number | null) => {
      closeImageMenu();
      try {
        editor.updateBlock(blockId, {
          props: { previewWidth: px === null ? undefined : px } as any,
        });
      } catch (e) {
        console.error("[image-menu] updateBlock failed:", e);
      }
    };

    const applyImageAlignment = (
      blockId: string,
      alignment: "left" | "center" | "right"
    ) => {
      closeImageMenu();
      try {
        editor.updateBlock(blockId, {
          props: { textAlignment: alignment } as any,
        });
      } catch (e) {
        console.error("[image-menu] alignment failed:", e);
      }
    };

    const togglePreview = () => {
      if (!imageMenu) return;
      const has =
        typeof imageMenu.previewWidth === "number" &&
        imageMenu.previewWidth > 0;
      const next = has ? undefined : PREVIEW_WIDTH_PX;
      try {
        editor.updateBlock(imageMenu.blockId, {
          props: { previewWidth: next } as any,
        });
      } catch (e) {
        console.error("[image-menu] toggle preview failed:", e);
      }
      setImageMenu({ ...imageMenu, previewWidth: next, mode: "main" });
    };

    const enterCaptionMode = () => {
      if (!imageMenu) return;
      setCaptionDraft(imageMenu.caption);
      setImageMenu({ ...imageMenu, mode: "caption" });
    };

    const saveCaptionInline = () => {
      if (!imageMenu) return;
      try {
        editor.updateBlock(imageMenu.blockId, {
          props: { caption: captionDraft },
        });
      } catch (e) {
        console.error("[image-menu] caption save failed:", e);
      }
      setImageMenu({
        ...imageMenu,
        caption: captionDraft,
        mode: "main",
      });
    };

    const enterRenameMode = () => {
      if (!imageMenu) return;
      const abs = assetUrlToAbsolutePath(imageMenu.url);
      if (!abs) {
        return;
      }
      const fileName = abs.split(/[/\\]/).pop() || "";
      const base = fileName.replace(/\.[^.]+$/, "");
      setRenameDraft(base);
      setRenameError(null);
      setImageMenu({ ...imageMenu, mode: "rename" });
    };

    const saveRename = async () => {
      if (!imageMenu) return;
      const abs = assetUrlToAbsolutePath(imageMenu.url);
      if (!abs) {
        backToMainMenu();
        return;
      }

      const oldName = abs.split(/[/\\]/).pop() || "";
      const ext = oldName.match(/\.[^.]+$/)?.[0] || "";
      const dir = abs.substring(0, abs.length - oldName.length);

      const cleanBase = renameDraft
        .trim()
        .replace(/[\\/:*?"<>|]/g, "-")
        .replace(/\.[^.]+$/, "");
      if (!cleanBase) {
        setRenameError("Name can't be empty.");
        return;
      }

      const newName = `${cleanBase}${ext}`;
      if (newName === oldName) {
        backToMainMenu();
        return;
      }

      const sep = abs.includes("\\") ? "\\" : "/";
      const newAbs = `${dir}${sep}${newName}`;

      try {
        if (await fsExists(newAbs)) {
          setRenameError("A file with that name already exists.");
          return;
        }
        await fsRename(abs, newAbs);
      } catch (e: any) {
        console.error("[image-menu] rename failed:", e);
        setRenameError(e?.message ?? String(e));
        return;
      }

      const newUrl = convertFileSrc(newAbs);
      try {
        editor.updateBlock(imageMenu.blockId, {
          props: { url: newUrl } as any,
        });
      } catch (e) {
        console.error("[image-menu] url update failed:", e);
      }
      setImageMenu({ ...imageMenu, url: newUrl, mode: "main" });
      setRenameError(null);
    };

    const openImageExternal = (url: string) => {
      closeImageMenu();
      const abs = assetUrlToAbsolutePath(url);
      if (abs) {
        openPath(abs).catch((e) =>
          console.error("[image-menu] openPath failed:", e)
        );
        return;
      }
      if (/^https?:/i.test(url)) {
        openUrl(url).catch((e) =>
          console.error("[image-menu] openUrl failed:", e)
        );
      }
    };

    const copyImageUrl = async (url: string) => {
      closeImageMenu();
      try {
        await navigator.clipboard.writeText(url);
      } catch (e) {
        console.error("[image-menu] copy failed:", e);
      }
    };

    const downloadImage = async (url: string) => {
      closeImageMenu();
      try {
        const defaultName = guessImageFileName(url);
        const dest = await save({
          defaultPath: defaultName,
          filters: [
            {
              name: "Image",
              extensions: [
                "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg",
              ],
            },
          ],
        });
        if (!dest) return;

        const abs = assetUrlToAbsolutePath(url);
        if (abs) {
          await copyFile(abs, dest);
          return;
        }

        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        await writeFile(dest, buf);
      } catch (e) {
        console.error("[image-menu] download failed:", e);
      }
    };

    const replaceImage = async (blockId: string) => {
      closeImageMenu();
      try {
        const picked = await open({
          multiple: false,
          filters: [
            {
              name: "Image",
              extensions: [
                "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg",
              ],
            },
          ],
        });
        if (!picked || typeof picked !== "string") return;
        const dest = await saveImageToNoteAssets(path, picked);
        const url = convertFileSrc(dest);
        editor.updateBlock(blockId, {
          props: { url } as any,
        });
      } catch (e) {
        console.error("[image-menu] replace failed:", e);
      }
    };

    const removeImageBlock = (blockId: string) => {
      closeImageMenu();
      try {
        editor.removeBlocks([blockId]);
      } catch (e) {
        console.error("[image-menu] removeBlocks failed:", e);
      }
    };

    // Close the image menu on outside click.
    useEffect(() => {
      if (!imageMenu) return;
      const onDown = (e: MouseEvent) => {
        if (imageMenuRef.current?.contains(e.target as Node)) return;
        setImageMenu(null);
      };
      document.addEventListener("mousedown", onDown);
      return () => document.removeEventListener("mousedown", onDown);
    }, [imageMenu]);

    useEffect(() => {
      if (!imageMenu) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        if (imageMenu.mode !== "main") return;
        setImageMenu(null);
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [imageMenu]);

    useEffect(() => {
      if (!imageMenu) return;
      if (imageMenu.mode === "caption") {
        const t = setTimeout(() => {
          captionInputRef.current?.focus();
          captionInputRef.current?.select();
        }, 0);
        return () => clearTimeout(t);
      }
      if (imageMenu.mode === "rename") {
        const t = setTimeout(() => {
          renameInputRef.current?.focus();
          renameInputRef.current?.select();
        }, 0);
        return () => clearTimeout(t);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [imageMenu?.mode, imageMenu?.blockId]);

    // ── Image right-click + left-drag handling ──────────────────────────
    const wrapperRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const el = wrapperRef.current;
      if (!el) return;
      if (mode !== "edit") return;

      let pending: {
        blockId: string;
        startX: number;
        startY: number;
        imgEl: HTMLImageElement;
      } | null = null;
      let ghostEl: HTMLDivElement | null = null;
      let indicatorEl: HTMLDivElement | null = null;
      let customDragActive = false;
      let hoveredEdge: { blockId: string; side: string } | null = null;

      const clearHighlights = () => {
        document
        .querySelectorAll<HTMLElement>("[data-drop-highlight]")
        .forEach((n) => {
          n.removeAttribute("data-drop-highlight");
          n.style.outline = "";
          n.style.outlineOffset = "";
        });
      };

      const hideIndicator = () => {
        if (indicatorEl) {
          indicatorEl.remove();
          indicatorEl = null;
        }
      };

      const showIndicator = (rect: DOMRect, side: "before" | "after") => {
        if (!indicatorEl) {
          indicatorEl = document.createElement("div");
          indicatorEl.style.position = "fixed";
          indicatorEl.style.height = "2px";
          indicatorEl.style.background = "#3b82f6";
          indicatorEl.style.zIndex = "9998";
          indicatorEl.style.pointerEvents = "none";
          indicatorEl.style.borderRadius = "1px";
          indicatorEl.style.boxShadow = "0 0 6px rgba(59,130,246,0.8)";
          document.body.appendChild(indicatorEl);
        }
        indicatorEl.style.left = `${rect.left}px`;
        indicatorEl.style.width = `${rect.width}px`;
        indicatorEl.style.top =
        side === "before" ? `${rect.top - 1}px` : `${rect.bottom - 1}px`;
      };

      const cleanup = () => {
        if (ghostEl) {
          ghostEl.remove();
          ghostEl = null;
        }
        hideIndicator();
        document.body.style.cursor = "";
        clearHighlights();
        customDragActive = false;
        if (hoveredEdge) {
          window.dispatchEvent(
            new CustomEvent(GALLERY_EDGE_HOVER_EVENT, {
              detail: { active: false },
            })
          );
          hoveredEdge = null;
        }
      };

      const blockIdFromImg = (img: HTMLImageElement): string | null => {
        const blockEl = img.closest("[data-id]") as HTMLElement | null;
        return blockEl?.getAttribute("data-id") || null;
      };

      const editorRootOf = (): HTMLElement | null =>
      (el.querySelector(".bn-editor") as HTMLElement | null) ||
      (el.querySelector(".ProseMirror") as HTMLElement | null);

      // Walk up from `start` looking for the nearest [data-id] block-outer,
      // skipping our own block and the column's own block-outer.
      //
      // When `boundary` is set (we're inside a column), the walk stops as
      // soon as it reaches that element — so a stray hover over the
      // column's padding can't accidentally resolve to the column-list
      // wrapper above it.
      const findBlockEl = (
        start: HTMLElement | null,
        editorRoot: HTMLElement,
        skipId: string,
        boundary: HTMLElement | null,
        excludeId: string | null
      ): HTMLElement | null => {
        let probe: HTMLElement | null = start;
        while (probe && editorRoot.contains(probe)) {
          if (boundary && probe === boundary) return null;
          const pid =
          probe.getAttribute && probe.getAttribute("data-id");
          if (pid && pid !== skipId && pid !== excludeId) return probe;
          probe = probe.parentElement;
        }
        return null;
      };

      const readColumnId = (col: HTMLElement): string | null =>
      col.getAttribute("data-id") ||
      (
        col.querySelector(":scope > [data-id]") as HTMLElement | null
      )?.getAttribute("data-id") ||
      (
        col.querySelector(
          '[data-node-type="blockOuter"][data-id]'
        ) as HTMLElement | null
      )?.getAttribute("data-id") ||
      null;

      const onContextMenu = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target.tagName !== "IMG") return;
        const img = target as HTMLImageElement;
        if (!el.contains(img)) return;
        if (!img.closest('[data-content-type="image"]')) return;

        const blockId = blockIdFromImg(img);
        if (!blockId) return;

        e.preventDefault();
        e.stopPropagation();

        let caption = "";
        let textAlignment = "left";
        let previewWidth: number | undefined;
        try {
          const block = editor.getBlock(blockId);
          if (block) {
            const bp = block.props as Record<string, unknown>;
            caption = (bp?.caption as string) || "";
            textAlignment = (bp?.textAlignment as string) || "left";
            const pw = bp?.previewWidth as number | undefined;
            if (typeof pw === "number" && pw > 0) previewWidth = pw;
          }
        } catch {}

        const W = 232;
        const H = 460;
        setImageMenu({
          x: Math.min(e.clientX, window.innerWidth - W - 8),
                     y: Math.min(e.clientY, window.innerHeight - H - 8),
                     blockId,
                     url: img.src,
                     caption,
                     textAlignment,
                     previewWidth,
                     mode: "main",
        });
      };

      const onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        if (target.tagName !== "IMG") return;
        const img = target as HTMLImageElement;
        if (!el.contains(img)) return;
        if (!img.closest('[data-content-type="image"]')) return;

        const blockId = blockIdFromImg(img);
        if (!blockId) return;

        pending = {
          blockId,
          startX: e.clientX,
          startY: e.clientY,
          imgEl: img,
        };
      };

      const onMouseMove = (e: MouseEvent) => {
        if (!pending) return;

        if (!ghostEl) {
          const dx = e.clientX - pending.startX;
          const dy = e.clientY - pending.startY;
          if (Math.abs(dx) + Math.abs(dy) < 8) return;

          customDragActive = true;

          ghostEl = document.createElement("div");
          ghostEl.style.position = "fixed";
          ghostEl.style.width = "96px";
          ghostEl.style.height = "72px";
          ghostEl.style.backgroundImage = `url("${pending.imgEl.src}")`;
          ghostEl.style.backgroundSize = "cover";
          ghostEl.style.backgroundPosition = "center";
          ghostEl.style.borderRadius = "6px";
          ghostEl.style.pointerEvents = "none";
          ghostEl.style.zIndex = "9999";
          ghostEl.style.opacity = "0.85";
          ghostEl.style.boxShadow = "0 8px 24px rgba(0,0,0,0.6)";
          ghostEl.style.border = "2px solid #3b82f6";
          document.body.appendChild(ghostEl);
          document.body.style.cursor = "grabbing";
        }

        ghostEl.style.left = `${e.clientX + 14}px`;
        ghostEl.style.top = `${e.clientY + 14}px`;

        const under = document.elementFromPoint(
          e.clientX,
          e.clientY
        ) as HTMLElement | null;
        clearHighlights();
        hideIndicator();

        const editorRoot = editorRootOf();
        if (!editorRoot || !under || !editorRoot.contains(under)) return;

        // Edge-zone detection: if the cursor is over a gallery edge "+"
        // strip, tell that gallery to highlight it and skip the usual
        // before/after insertion indicator — the drop will grow the grid.
        const edgeEl = under.closest(
          "[data-gallery-edge-side]"
        ) as HTMLElement | null;
        if (edgeEl) {
          const edgeBlockId = edgeEl.getAttribute("data-gallery-block-id");
          const edgeSide = edgeEl.getAttribute("data-gallery-edge-side");
          if (edgeBlockId && edgeSide) {
            if (
              !hoveredEdge ||
              hoveredEdge.blockId !== edgeBlockId ||
              hoveredEdge.side !== edgeSide
            ) {
              if (hoveredEdge) {
                window.dispatchEvent(
                  new CustomEvent(GALLERY_EDGE_HOVER_EVENT, {
                    detail: { active: false },
                  })
                );
              }
              window.dispatchEvent(
                new CustomEvent(GALLERY_EDGE_HOVER_EVENT, {
                  detail: {
                    active: true,
                    blockId: edgeBlockId,
                    side: edgeSide,
                  },
                })
              );
              hoveredEdge = { blockId: edgeBlockId, side: edgeSide };
            }
            edgeEl.setAttribute("data-drop-highlight", "1");
            edgeEl.style.outline = "2px solid #3b82f6";
            edgeEl.style.outlineOffset = "-2px";
            return;
          }
        } else if (hoveredEdge) {
          window.dispatchEvent(
            new CustomEvent(GALLERY_EDGE_HOVER_EVENT, {
              detail: { active: false },
            })
          );
          hoveredEdge = null;
        }

        const colEl = under.closest(
          ".bn-block-column, [data-node-type='column']"
        ) as HTMLElement | null;
        if (colEl) {
          colEl.setAttribute("data-drop-highlight", "1");
          colEl.style.outline = "2px solid #3b82f6";
          colEl.style.outlineOffset = "-2px";
        }

        const colId = colEl ? readColumnId(colEl) : null;
        const targetBlockEl = findBlockEl(
          under,
          editorRoot,
          pending.blockId,
          colEl,
          colId
        );

        if (targetBlockEl) {
          const rect = targetBlockEl.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          showIndicator(rect, e.clientY < midY ? "before" : "after");
        } else if (colEl) {
          // Empty area inside a column — hint that the image will land
          // at the end of that column's content.
          showIndicator(colEl.getBoundingClientRect(), "after");
        } else {
          // Empty area below the last top-level block.
          const last = editor.document[editor.document.length - 1];
          if (last && last.id !== pending.blockId) {
            const lastEl = document.querySelector(
              `[data-id="${last.id}"]`
            ) as HTMLElement | null;
            if (lastEl) showIndicator(lastEl.getBoundingClientRect(), "after");
          }
        }
      };

      const onMouseUp = (e: MouseEvent) => {
        if (!pending) return;
        const wasDragging = !!ghostEl;
        const blockId = pending.blockId;
        pending = null;
        cleanup();

        if (!wasDragging) return;

        // Resolve what we're over and grab the editor root FIRST — every
        // case below needs both of these.
        const under = document.elementFromPoint(
          e.clientX,
          e.clientY
        ) as HTMLElement | null;
        const editorRoot = editorRootOf();

        const clearSelection = () => {
          try {
            const tiptap: any = (editor as any)._tiptapEditor;
            const sel = tiptap?.state?.selection;
            if (sel?.node) {
              const docSize = tiptap.state.doc.content.size;
              const target = Math.min(docSize, Math.max(0, sel.to + 1));
              tiptap.commands.setTextSelection(target);
            }
          } catch {}
        };

        if (!editorRoot || !under || !editorRoot.contains(under)) {
          clearSelection();
          return;
        }

        // ── Case 0a: dropped onto a gallery edge "+" zone ──────────
        // The note-body drag is a synthetic mouse drag, so it can't be
        // received as a real `drop` on the zone. Instead we detect the
        // edge zone under the cursor, hand the src off via a custom
        // event, and let the gallery grow the grid to receive it.
        const galleryEdgeEl = under.closest(
          "[data-gallery-edge-side]"
        ) as HTMLElement | null;
        if (galleryEdgeEl) {
          const edgeBlockId = galleryEdgeEl.getAttribute(
            "data-gallery-block-id"
          );
          const edgeSide = galleryEdgeEl.getAttribute(
            "data-gallery-edge-side"
          ) as "top" | "bottom" | "left" | "right" | null;
          const srcBlock = editor.getBlock(blockId);
          const imgSrc = ((srcBlock?.props as any)?.url as string) || "";
          if (edgeBlockId && edgeSide && imgSrc) {
            // Suppress the delete-prompt BEFORE the removal fires.
            // Otherwise handleContentChange runs while the flag is false
            // and treats the vanishing image block as a real deletion.
            handlingDeleteRef.current = true;

            window.dispatchEvent(
              new CustomEvent(GALLERY_EDGE_DROP_EVENT, {
                detail: {
                  blockId: edgeBlockId,
                  side: edgeSide,
                  src: imgSrc,
                  fromBlockId: "",
                  fromRow: -1,
                  fromCol: -1,
                },
              })
            );

            try {
              editor.removeBlocks([blockId]);
            } catch (err) {
              console.error(
                "[drag] removeBlocks after edge-fill failed:",
                err
              );
            }

            requestAnimationFrame(() => {
              try {
                prevImageUrlsRef.current = new Set(
                  collectImageUrls(editor.document)
                );
              } catch {}
              handlingDeleteRef.current = false;
            });
            clearSelection();
            return;
          }
        }


        // ── Case 0: dropped onto a gallery cell ─────────────────────
        // Hand the image over to the gallery via the shared move event,
        // then delete the original block. The gallery block listens for
        // this event and fills the target cell.
        const galleryCellEl = under.closest(
          "[data-gallery-block-id]"
        ) as HTMLElement | null;
        if (galleryCellEl) {
          const galleryBlockId = galleryCellEl.getAttribute(
            "data-gallery-block-id"
          );
          const gRow = Number(galleryCellEl.getAttribute("data-gallery-row"));
          const gCol = Number(galleryCellEl.getAttribute("data-gallery-col"));
          const srcBlock = editor.getBlock(blockId);
          const imgSrc = ((srcBlock?.props as any)?.url as string) || "";
          if (
            galleryBlockId &&
            Number.isFinite(gRow) &&
            Number.isFinite(gCol) &&
            imgSrc
          ) {
            window.dispatchEvent(
              new CustomEvent(GALLERY_MOVE_EVENT, {
                detail: {
                  fromBlockId: "",
                  fromRow: -1,
                  fromCol: -1,
                  toBlockId: galleryBlockId,
                  toRow: gRow,
                  toCol: gCol,
                  src: imgSrc,
                },
              })
            );
            // Suppress the "delete this photo?" prompt during the handoff.
            // The image block is about to vanish, but the URL now lives
            // inside the gallery's grid — so we shouldn't treat the
            // removal as a deletion. Re-snapshot prevImageUrls on the
            // next frame, after BlockNote has committed the gallery
            // update, then re-enable detection.
            handlingDeleteRef.current = true;
            try {
              editor.removeBlocks([blockId]);
            } catch (err) {
              console.error(
                "[drag] removeBlocks after gallery-fill failed:",
                err
              );
            }
            requestAnimationFrame(() => {
              try {
                prevImageUrlsRef.current = new Set(
                  collectImageUrls(editor.document)
                );
              } catch {}
              handlingDeleteRef.current = false;
            });
            clearSelection();
            return;
          }
        }

        const block = editor.getBlock(blockId);
        if (!block) return;

        const snapshot = {
          type: block.type,
          props: { ...(block.props as any) },
        };

        // Single helper for every placement. Insert first; only touch
        // the original if the insert succeeded; roll the insert back if
        // the removal fails so we never leave a duplicate behind.
        const moveTo = (
          refBlockOrId: any,
          placement: "before" | "after" | "nested"
        ): boolean => {
          let inserted: any[] | null = null;
          try {
            inserted = editor.insertBlocks(
              [snapshot as any],
              refBlockOrId,
              placement as any
            );
          } catch (err) {
            console.error("[drag] insertBlocks failed:", err);
            return false;
          }
          if (!inserted || inserted.length === 0) return false;
          try {
            editor.removeBlocks([blockId]);
          } catch (err) {
            console.error("[drag] removeBlocks failed, undoing insert:", err);
            try {
              editor.removeBlocks(inserted.map((b: any) => b.id));
            } catch {}
            return false;
          }
          return true;
        };

        const colEl = under.closest(
          ".bn-block-column, [data-node-type='column']"
        ) as HTMLElement | null;
        const colId = colEl ? readColumnId(colEl) : null;

        // ── Case 1: a sibling block is under the cursor ─────────────
        // Handles reorder-in-place AND cross-column moves uniformly:
        // BlockNote places the new block as a sibling of `targetBlock`
        // regardless of which column that target lives in.
        const targetBlockEl = findBlockEl(
          under,
          editorRoot,
          blockId,
          colEl,
          colId
        );
        if (targetBlockEl) {
          const targetId = targetBlockEl.getAttribute("data-id");
          const targetBlock = targetId ? editor.getBlock(targetId) : null;
          if (targetBlock) {
            const rect = targetBlockEl.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const side: "before" | "after" =
            e.clientY < midY ? "before" : "after";
            if (moveTo(targetBlock, side)) return;
          }
        }

        // ── Case 2: empty area inside a column ──────────────────────
        // Append to that column — unless we're already in it, in which
        // case there's nothing meaningful to reorder to.
        if (colEl) {
          const srcEl = document.querySelector(
            `[data-id="${blockId}"]`
          ) as HTMLElement | null;
          const srcCol = srcEl?.closest(
            ".bn-block-column, [data-node-type='column']"
          );
          if (colId && srcCol !== colEl) {
            if (moveTo(colId, "nested")) return;
          }
          clearSelection();
          return;
        }

        // ── Case 3: empty area below the last block ─────────────────
        const last = editor.document[editor.document.length - 1];
        if (last && last.id !== blockId) {
          if (moveTo(last, "after")) return;
        }

        clearSelection();
      };

      const onDragStart = (e: DragEvent) => {
        const target = e.target as HTMLElement;
        if (target.tagName !== "IMG") return;
        if (!el.contains(target)) return;
        // Let gallery cells start their own native drags.
        if (target.closest("[data-gallery-block-id]")) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      };

      const onDrop = (e: DragEvent) => {
        if (customDragActive) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
      };

      el.addEventListener("contextmenu", onContextMenu);
      el.addEventListener("mousedown", onMouseDown);
      el.addEventListener("dragstart", onDragStart, true);
      el.addEventListener("drop", onDrop, true);
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);

      return () => {
        el.removeEventListener("contextmenu", onContextMenu);
        el.removeEventListener("mousedown", onMouseDown);
        el.removeEventListener("dragstart", onDragStart, true);
        el.removeEventListener("drop", onDrop, true);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        cleanup();
      };
    }, [editor, mode]);

    // ── Save plumbing ───────────────────────────────────────────────────
    // The debounce is trailing-edge (wait for a pause) but capped by
    // MAX_DEBOUNCE_MS: if the user has been typing continuously without
    // pausing for that long, we force a flush anyway. Without the cap, a
    // writer who doesn't stop for thirty minutes never hits disk.
    const queueWrite = <T,>(fn: () => Promise<T>): Promise<T> => {
      const run = writeQueueRef.current.then(() => fn());
      writeQueueRef.current = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    };

    const saveBody = async () => {
      if (!editor) return;
      if (disposedRef.current) return;
      try {
        const rawBody = await blocksToNoteBody(editor, editor.document);
        const withImgs = markdownImagesToRelativePaths(rawBody, noteDirOf(path));
        const withVideos = videoSrcsToRelativePaths(withImgs, noteDirOf(path));
        const withDm = dmarchiveSrcsToRelativePaths(withVideos, noteDirOf(path));
        const body = imageGalleryToRelativePaths(withDm, noteDirOf(path));
        const wordCount = countWords(body);
        onWordCountChange?.(wordCount);

        if (isNewFileRef.current && !body.trim()) return;

        let fm: Frontmatter = { ...frontmatterRef.current };
        try {
          const raw = await readTextFile(path);
          const { frontmatter: onDisk } = parseNoteFile(raw);
          fm = { ...onDisk, ...frontmatterRef.current };
        } catch {}

        fm.modified = new Date().toISOString();
        frontmatterRef.current = fm;

        // Atomic, crash-safe write. Never touches the original until the
        // new content is fully staged in a sibling .tmp file.
        await writeFileAtomic(path, serializeNoteFile(fm, body));
        lastSaveAtRef.current = Date.now();
        dirtyRef.current = false;
        onSaved?.();

        if (isNewFileRef.current) {
          isNewFileRef.current = false;
          const folder = noteDirOf(path);
          window.dispatchEvent(
            new CustomEvent("folder-changed", { detail: { path: folder } })
          );
        }
      } catch (e) {
        console.error("Failed to save note", e);
      }
    };

    saveBodyRef.current = saveBody;

    const scheduleSave = () => {
      dirtyRef.current = true;
      const overdue = Date.now() - lastSaveAtRef.current >= MAX_DEBOUNCE_MS;

      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      if (overdue) {
        queueWrite(saveBodyRef.current);
        return;
      }

      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        queueWrite(saveBodyRef.current);
      }, DEBOUNCE_MS);
    };

    const flush = async () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (disposedRef.current) return;
      if (!dirtyRef.current) {
        await writeQueueRef.current;
        return;
      }
      await queueWrite(saveBodyRef.current);
    };

    const insertImageBlocks = useCallback(
      (
        urls: string[],
        refId?: string | null,
        placement?: "before" | "after" | "nested"
      ) => {
        if (!editor || urls.length === 0) return;
        insertBlocksSmart(
          urls.map((url) => ({
            type: "image",
            props: { url, caption: "" },
          })),
          refId,
          placement
        );
      },
      [editor, insertBlocksSmart]
    );

    const saveAndInsertImageFiles = useCallback(
      async (files: File[]) => {
        const imageFiles = files.filter((f) => f.type.startsWith("image/"));
        if (imageFiles.length === 0) return;

        const urls: string[] = [];
        for (const file of imageFiles) {
          try {
            const ext = mimeToExt(file.type);
            const name =
              file.name && file.name !== "image.png" && file.name !== "blob"
                ? file.name
                : `pasted-${Date.now()}.${ext}`;
            const bytes = new Uint8Array(await file.arrayBuffer());
            const dest = await writeImageBytesToNoteAssets(path, bytes, name);
            urls.push(convertFileSrc(dest));
          } catch (e) {
            console.error("[image] save pasted image failed:", e);
          }
        }
        if (urls.length > 0) insertImageBlocks(urls);
      },
      [path, insertImageBlocks]
    );

    const saveAndInsertVideoFiles = useCallback(
      async (files: File[]) => {
        const videoFiles = files.filter((f) => f.type.startsWith("video/"));
        if (videoFiles.length === 0) return;

        for (const file of videoFiles) {
          try {
            const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
            const name =
              file.name && file.name !== "blob" && !file.name.startsWith("image")
                ? file.name
                : `video-${Date.now()}.${ext}`;
            const bytes = new Uint8Array(await file.arrayBuffer());
            const dest = await writeImageBytesToNoteAssets(path, bytes, name);
            const url = convertFileSrc(dest);

            insertBlocksSmart([
              {
                type: "video",
                props: { src: url, caption: "", fileName: name },
              },
            ]);
          } catch (e) {
            console.error("[video] save pasted video failed:", e);
          }
        }
      },
      [path, insertBlocksSmart]
    );

    const saveAndInsertFilePaths = useCallback(
      async (paths: string[], target?: DropTarget | null) => {
        // ── Images ────────────────────────────────────────────────
        const imageUrls: string[] = [];
        for (const p of paths) {
          if (!IMAGE_EXT_RE.test(p)) continue;
          try {
            const dest = await saveImageToNoteAssets(path, p);
            imageUrls.push(convertFileSrc(dest));
          } catch (e) {
            console.error("[paste] save image from path failed:", p, e);
          }
        }

        if (imageUrls.length > 0) {
          if (target?.kind === "gallery" && imageUrls[0]) {
            // Gallery cells hold one image each. Fill the cell under the
            // cursor with the first image; any extra images fall through
            // to the default insert path so nothing is silently dropped.
            window.dispatchEvent(
              new CustomEvent(GALLERY_MOVE_EVENT, {
                detail: {
                  fromBlockId: "",
                  fromRow: -1,
                  fromCol: -1,
                  toBlockId: target.blockId,
                  toRow: target.row,
                  toCol: target.col,
                  src: imageUrls[0],
                },
              })
            );
            if (imageUrls.length > 1) {
              insertImageBlocks(imageUrls.slice(1), null);
            }
          } else if (target?.kind === "insert") {
            insertImageBlocks(imageUrls, target.refId, target.placement);
          } else {
            insertImageBlocks(imageUrls, null);
          }
        }

        // ── Videos ────────────────────────────────────────────────
        for (const p of paths) {
          if (!VIDEO_EXT_RE.test(p)) continue;
          try {
            const dest = await saveFileToNoteAssets(path, p);
            const url = convertFileSrc(dest);
            const fileName = dest.split(/[/\\]/).pop() || "video";
            insertBlocksSmart(
              [{ type: "video", props: { src: url, caption: "", fileName } }],
              target?.kind === "insert" ? target.refId : null,
              target?.kind === "insert" ? target.placement : undefined
            );
          } catch (e) {
            console.error("[paste] save video from path failed:", p, e);
          }
        }
      },
      [path, insertImageBlocks, insertBlocksSmart]
    );

    // ── OS file drag-and-drop ────────────────────────────────────────
    // Tauri delivers OS-level drops (Nemo, Nautilus, Dolphin, Thunar,
    // Windows Explorer, Finder) via `onDragDropEvent`, bypassing the
    // webview's blocked native drop. We resolve the drop point to a
    // specific editor position so images land where the cursor was,
    // not always at the end of the document.
    useEffect(() => {
      if (isLoading) return;
      let unlisten: (() => void) | null = null;
      let cancelled = false;

      const editorRoot = () =>
      (wrapperRef.current?.querySelector(".bn-editor") as HTMLElement | null) ||
      (wrapperRef.current?.querySelector(".ProseMirror") as HTMLElement | null);

      const clientCoordsOf = (payload: any) => {
        const pos = payload?.position;
        if (!pos) return null;
        const dpr = window.devicePixelRatio || 1;
        return { x: pos.x / dpr, y: pos.y / dpr };
      };

      (async () => {
        try {
          const win = getCurrentWindow();
          const un = await win.onDragDropEvent((event) => {
            const payload: any = event.payload;
            const t = payload?.type;

            if (t === "leave" || t === "drop") {
              setDragOverlay(null);
            }

            if (t === "enter" || t === "over") {
              const c = clientCoordsOf(payload);
              if (!c) return;
              const root = editorRoot();
              const target = root ? resolveDropTarget(c.x, c.y, root) : null;

              // Compute the on-screen indicator.
              let indicator:
              | { left: number; top: number; width: number; height?: number }
              | undefined;

              if (target?.kind === "insert") {
                const el = root?.querySelector(
                  `[data-id="${target.refId}"]`
                ) as HTMLElement | null;
                if (el) {
                  const r = el.getBoundingClientRect();
                  indicator = {
                    left: r.left,
                    top:
                    target.placement === "nested"
                    ? r.top
                    : target.placement === "before"
                    ? r.top - 1
                    : r.bottom - 1,
                    width: r.width,
                    height: target.placement === "nested" ? r.height : 2,
                  };
                }
              } else if (target?.kind === "gallery") {
                const el = root?.querySelector(
                  `[data-gallery-block-id="${target.blockId}"][data-gallery-row="${target.row}"][data-gallery-col="${target.col}"]`
                ) as HTMLElement | null;
                if (el) {
                  const r = el.getBoundingClientRect();
                  indicator = {
                    left: r.left,
                    top: r.top,
                    width: r.width,
                    height: r.height,
                  };
                }
              }

              setDragOverlay({ x: c.x, y: c.y, target, indicator });
              return;
            }

            if (t === "drop") {
              const c = clientCoordsOf(payload);
              const root = editorRoot();
              const target =
              c && root ? resolveDropTarget(c.x, c.y, root) : null;
              const paths: string[] = Array.isArray(payload?.paths)
              ? payload.paths
              : [];
              if (paths.length === 0) return;

              void saveAndInsertFilePaths(paths, target);
              return;
            }
          });
          if (cancelled) un();
          else unlisten = un;
        } catch (e) {
          console.warn("[dragdrop] could not register listener:", e);
        }
      })();

      return () => {
        cancelled = true;
        if (unlisten) unlisten();
        setDragOverlay(null);
      };
    }, [isLoading, saveAndInsertFilePaths]);


    useEffect(() => {
      if (isLoading) return;

      const handler = (e: ClipboardEvent) => {
        const target = e.target as Node | null;
        const wrapper = wrapperRef.current;
        if (!target || !wrapper || !wrapper.contains(target)) return;

        const el = target as HTMLElement;
        if (el.closest?.("input, textarea")) return;

        const cd = e.clipboardData;
        if (!cd) {
          return;
        }

        const collected: File[] = [];

        if (cd.items && cd.items.length > 0) {
          for (let i = 0; i < cd.items.length; i++) {
            const item = cd.items[i];

            if (item.kind !== "file") continue;
            if (!/^image\/|^video\//i.test(item.type)) continue;
            const f = item.getAsFile();
            if (f) collected.push(f);
          }
        }
        if (collected.length === 0 && cd.files && cd.files.length > 0) {
          for (let i = 0; i < cd.files.length; i++) {
            const f = cd.files[i];

            if (/^image\/|^video\//i.test(f.type)) collected.push(f);
          }
        }



        if (collected.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          const imgs = collected.filter((f) => f.type.startsWith("image/"));
          const vids = collected.filter((f) => f.type.startsWith("video/"));
          if (imgs.length > 0) saveAndInsertImageFiles(imgs);
          if (vids.length > 0) saveAndInsertVideoFiles(vids);
          return;
        }

        // ── File-manager + screenshot-tool + URL paste ────────────────
        // Three cases handled here, in priority order:
        //
        //   1. Linux file managers (Nemo, Nautilus, Dolphin, Thunar)
        //      copy files as a `text/uri-list` payload.
        //   2. Screenshot tools (Flameshot, Spectacle, GNOME Screenshot)
        //      put raw PNG bytes on the clipboard.
        //   3. Plain-text URLs on the clipboard → show the bookmark /
        //      embed popup.
        //
        // WebKitGTK advertises the MIME types but refuses to hand the
        // page the data, so we fall back to Rust for the actual read.

        const uriListSync = cd.getData("text/uri-list");
        const plainSync = cd.getData("text/plain")?.trim() || "";

        const tryFromRaw = (raw: string): boolean => {
          const filePaths = parseUriList(raw);
          if (filePaths.length === 0) return false;
          e.preventDefault();
          e.stopPropagation();
          void saveAndInsertFilePaths(filePaths);
          return true;
        };

        // Sync path — works on WebKit/macOS/Windows. On WebKitGTK both
        // calls return "" so we fall through to the async chain.
        if (uriListSync && tryFromRaw(uriListSync)) return;
        if (/^file:\/\//i.test(plainSync) && tryFromRaw(plainSync)) return;

          // Does the paste event advertise a URI list? WebKitGTK always
          // does for a Nemo-style copy, even though it returns "".
          const hasUriListItem = !!(cd.items && Array.from(cd.items).some(
            (it) => it.kind === "string" && it.type === "text/uri-list"
          ));

        // ── URL → bookmark / embed popup ──────────────────────────────
        // Runs synchronously so the coordinate lookup uses the current
        // selection. Skip it if the paste is a file-manager copy.
        //
        // We normalize first so bare "x.com/user/status/123" pastes also
        // trigger the menu, then canonicalize so tracking params don't break
        // the metadata fetch downstream.
        const normalizedUrl = normalizeUrlInput(plainSync);
        if (!hasUriListItem && URL_RE.test(normalizedUrl)) {
          const tiptap: any = (editor as any)._tiptapEditor;
          if (tiptap) {
            const sel = tiptap.state.selection;
            if (sel && sel.empty) {
              e.preventDefault();
              e.stopPropagation();
              const { from } = sel;
              let coords: { left: number; bottom: number } = { left: 40, bottom: 40 };
              try {
                const c = tiptap.view.coordsAtPos(from);
                coords = { left: c.left, bottom: c.bottom };
              } catch {}
              setPasteMenu({
                url: canonicalizeUrl(normalizedUrl),
                x: Math.min(Math.max(8, coords.left), window.innerWidth - 260),
                           y: Math.min(coords.bottom + 6, window.innerHeight - 160),
              });
              return;
            }
          }
        }

        // ── Async chain ──────────────────────────────────────────────
        // File-manager copy (uri-list present) or a binary paste with
        // no text (screenshot tool). Try each strategy in order; the
        // first that finds something wins.
        const likelyBinaryOrFile = hasUriListItem || plainSync.length === 0;
        if (likelyBinaryOrFile) {
          e.preventDefault();
          e.stopPropagation();
        }

        void (async () => {
          // Strategy 1: item.getAsString() per string item. Works on
          // some WebKitGTK builds; harmless where it doesn't.
          const stringItems: DataTransferItem[] = [];
          if (cd.items && cd.items.length > 0) {
            for (let i = 0; i < cd.items.length; i++) {
              const item = cd.items[i];
              if (item.kind !== "string") continue;
              if (item.type === "text/uri-list" || item.type === "text/plain") {
                stringItems.push(item);
              }
            }
          }
          stringItems.sort((a, b) =>
          a.type === "text/uri-list" ? -1 : b.type === "text/uri-list" ? 1 : 0
          );
          for (const item of stringItems) {
            const raw = await new Promise<string>((resolve) => {
              try {
                item.getAsString((s) => resolve(s || ""));
              } catch {
                resolve("");
              }
            });
            const filePaths = parseUriList(raw);
            if (filePaths.length > 0) {
              await saveAndInsertFilePaths(filePaths);
              return;
            }
          }

          // Strategy 2: Rust URI-list read. The one that works on
          // WebKitGTK for Nemo-style copies.
          try {
            const raw = await invoke<string>("read_clipboard_uri_list");
            const filePaths = parseUriList(raw);
            if (filePaths.length > 0) {
              await saveAndInsertFilePaths(filePaths);
              return;
            }
          } catch (err) {
            console.warn("[paste] rust URI-list fallback failed:", err);
          }

          // Strategy 3: Rust image-bytes read. Screenshot tools put
          // raw pixels on the clipboard, not a file path.
          try {
            const pngBytes = await invoke<number[] | null>(
              "read_clipboard_image_png"
            );
            if (!pngBytes || pngBytes.length === 0) return;
            const uint8 = new Uint8Array(pngBytes);
            const name = `pasted-${Date.now()}.png`;
            const dest = await writeImageBytesToNoteAssets(path, uint8, name);
            const url = convertFileSrc(dest);
            insertImageBlocks([url]);
          } catch (err) {
            console.warn("[paste] rust image fallback failed:", err);
          }
        })();
      };

      document.addEventListener("paste", handler, true);
      return () => document.removeEventListener("paste", handler, true);
    }, [isLoading, saveAndInsertImageFiles, saveAndInsertVideoFiles,
        saveAndInsertFilePaths, editor]);

    useEffect(() => {
      if (!pasteMenu) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setPasteMenu(null);
      };
      const onDown = (e: MouseEvent) => {
        if (pasteMenuRef.current?.contains(e.target as Node)) return;
        setPasteMenu(null);
      };
      document.addEventListener("keydown", onKey);
      document.addEventListener("mousedown", onDown);
      return () => {
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("mousedown", onDown);
      };
    }, [pasteMenu]);

    const pasteAsText = (url: string) => {
      setPasteMenu(null);
      try {
        editor.insertInlineContent([{ type: "text", text: url, styles: {} }]);
      } catch (e) {
        console.error("[paste] insert text failed:", e);
      }
    };

    const pasteAsLink = async (
      url: string,
      linkMode: "bookmark" | "embed"
    ) => {
      setPasteMenu(null);

      const canonical = canonicalizeUrl(url);
      const platform = detectPlatform(canonical);

      const fallbackTitle = humanizeUrlTitle(canonical) || canonical;

      try {
        const inserted = insertBlocksSmart([
          {
            type: "bookmark",
            props: {
              url: canonical,
              title: fallbackTitle,
              description: "",
              icon: "",
              image: "",
              mode: linkMode,
              meta: platform?.label || "",
            },
          },
        ]);
        const newId = inserted?.[0]?.id;
        if (!newId) return;

        try {
          const meta = await fetchEnrichedMetadata(canonical);

          editor.updateBlock(newId, {
            props: {
              url: canonical,
              title: meta.title || fallbackTitle,
              description: meta.description || "",
              icon: meta.icon || "",
              image: meta.image || "",
              mode: linkMode,
              meta: meta.meta || platform?.label || "",
            },
          });
        } catch (err) {
          console.warn("[bookmark] enrichment failed:", err);
        }
      } catch (e) {
        console.error("[paste] insert link block failed:", e);
      }
    };

    useEffect(() => {
      let isMounted = true;
      async function load() {
        try {
          setIsLoading(true);
          let raw: string;
          isNewFileRef.current = false;
          dirtyRef.current = false;
          disposedRef.current = false;

          try {
            raw = await readTextFile(path);
          } catch {
            isNewFileRef.current = true;
            raw = `---\ncreated: ${new Date().toISOString()}\n---\n\n`;
          }

          const { frontmatter, body } = parseNoteFile(raw);
          frontmatterRef.current = frontmatter;
          onFrontmatterLoaded?.(frontmatter);
          onWordCountChange?.(countWords(body));

          const withImgs = markdownImagesToAssetUrls(body, noteDirOf(path));
          const withVideos = videoSrcsToAssetUrls(withImgs, noteDirOf(path));
                    const withDmArchives = dmarchiveSrcsToAssetUrls(
            withVideos,
            noteDirOf(path)
          );
          const withGalleries = imageGalleryToAssetUrls(
            withDmArchives,
            noteDirOf(path)
          );
          const blocks = await noteBodyToBlocks(editor, withGalleries);
          if (isMounted && editor) {
            editor.replaceBlocks(
              editor.document,
              blocks.length ? blocks : [{ type: "paragraph" }]
            );
            // Nuke the undo/redo stack that the initial `replaceBlocks`
            // populated. Without this, Ctrl+Z eventually unwinds past the
            // load transaction and lands on an empty doc, which looks
            // like the note "deleted itself."
            try {
              const tiptap: any = (editor as any)._tiptapEditor;
              tiptap?.commands?.clearHistory?.();
            } catch {}
            // BlockNote auto-selects the first block after replaceBlocks.
            // If that block is a void block like our gallery, it stays
            // NodeSelected — and blur() only removes focus, it doesn't
            // clear the selection. We have to move the *selection* into
            // a real text block.
            try {
              const tiptap: any = (editor as any)._tiptapEditor;
              const state = tiptap?.state;
              if (state?.selection?.node) {
                const findTextblockId = (bs: any[]): string | null => {
                  for (const b of bs) {
                    if (b.type === "paragraph" || b.type === "heading") {
                      return b.id;
                    }
                    if (Array.isArray(b.children)) {
                      const found = findTextblockId(b.children);
                      if (found) return found;
                    }
                  }
                  return null;
                };
                let textblockId = findTextblockId(editor.document);
                if (!textblockId) {
                  // All-void doc (e.g. just a gallery). Insert a trailing
                  // empty paragraph purely in memory — it won't survive
                  // serialization since empty paragraphs are stripped —
                  // but it gives us a valid cursor position and clears
                  // the NodeSelection.
                  const last = editor.document[editor.document.length - 1];
                  if (last) {
                    try {
                      const inserted = editor.insertBlocks(
                        [{ type: "paragraph" }],
                        last.id,
                        "after"
                      );
                      textblockId = inserted?.[0]?.id ?? null;
                    } catch {}
                  }
                }
                if (textblockId) {
                  try {
                    editor.setTextCursorPosition(textblockId, "start");
                  } catch {}
                }
              }
            } catch {}
            prevImageUrlsRef.current = new Set(
              collectImageUrls(editor.document)
            );
            try {
              loadedDocFingerprintRef.current = JSON.stringify(
                editor.document.map((b: any) => ({
                  type: b.type,
                  props: b.props || {},
                  content: b.content || [],
                  children: b.children || [],
                }))
              );
            } catch {
              loadedDocFingerprintRef.current = null;
            }
            onLoaded?.();
          }
        } catch (e) {
          console.error("Failed to load note", e);
        } finally {
          if (isMounted) setIsLoading(false);
        }
      }
      load();
      return () => {
        isMounted = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path, editor]);

    useEffect(() => {
      return () => {
        if (disposedRef.current) return;
        flush();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path]);

    useEffect(() => {
      const handler = (e: Event) => {
        const detail = (e as CustomEvent).detail as { path?: string } | undefined;
        if (!detail?.path) return;
        const child = path.replace(/\\/g, "/");
        const parent = detail.path.replace(/\\/g, "/").replace(/\/+$/, "");
        if (child !== parent && !child.startsWith(parent + "/")) return;

        disposedRef.current = true;
        dirtyRef.current = false;
        isNewFileRef.current = false;

        if (saveTimerRef.current !== null) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
      };
      window.addEventListener("note-deleted", handler);
      return () => window.removeEventListener("note-deleted", handler);
    }, [path]);

    useEffect(() => {
      try {
        const raw = sessionStorage.getItem(`pendingImgDel:${path}`);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr) && arr.length) {
            setPendingImageDelete(arr);
            handlingDeleteRef.current = true;
          }
        }
      } catch {}
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path]);

    useEffect(() => {
      try {
        if (pendingImageDelete.length) {
          sessionStorage.setItem(
            `pendingImgDel:${path}`,
            JSON.stringify(pendingImageDelete)
          );
        } else {
          sessionStorage.removeItem(`pendingImgDel:${path}`);
        }
      } catch {}
    }, [pendingImageDelete, path]);

    useImperativeHandle(ref, () => ({
      flush,
      dispose: () => {
        disposedRef.current = true;
      },
      rearm: () => {
        disposedRef.current = false;
      },
      updateFrontmatter: async (patch) => {
        // If this editor has been disposed (note deleted, moved, or the
        // pane switched to a different note), do NOT recreate the file on
        // disk. Without this guard, a late UI action — a slider drag
        // ending, a cover picker closing — can bring a just-trashed file
        // back as an empty stub.
        if (disposedRef.current) return;

        await queueWrite(async () => {
          let raw: string | null = null;
          try {
            raw = await readTextFile(path);
          } catch {
            raw = null;
          }

          if (raw === null) {
            frontmatterRef.current = { ...frontmatterRef.current, ...patch };
            isNewFileRef.current = false;
            await writeFileAtomic(
              path,
              serializeNoteFile(frontmatterRef.current, "")
            );
            lastSaveAtRef.current = Date.now();
            window.dispatchEvent(
              new CustomEvent("file-changed", { detail: { path } })
            );
            return;
          }

          const { frontmatter: onDisk, body } = parseNoteFile(raw);
          const merged: Frontmatter = {
            ...onDisk,
            ...patch,
            modified: new Date().toISOString(),
          };
          for (const k of Object.keys(merged)) {
            if (
              merged[k] === "" ||
              merged[k] === undefined ||
              merged[k] === null
            ) {
              delete merged[k];
            }
          }
          frontmatterRef.current = merged;
          try {
            await writeFileAtomic(path, serializeNoteFile(merged, body));
            lastSaveAtRef.current = Date.now();
            window.dispatchEvent(
              new CustomEvent("file-changed", { detail: { path } })
            );
          } catch (e) {
            console.error("Failed to update frontmatter", e);
          }
        });
      },
    }));

    // Register with the app-wide flusher so window-close saves us.
    useEffect(() => {
      const unreg = registerFlusher(() => flush());
      return unreg;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleContentChange = () => {
      if (isLoading) return;

      const currentUrls = collectImageUrls(editor.document);
      const currentSet = new Set(currentUrls);

      // Undo/redo rewrites the document. Even if an image block came back
      // or went away in the process, that's history navigation, not a
      // user-initiated delete. Just resync our snapshot and move on —
      // no prompt.
      if (undoRedoRef.current) {
        prevImageUrlsRef.current = currentSet;
        scheduleSave();
        return;
      }

      if (!handlingDeleteRef.current) {
        const missing: string[] = [];
        for (const url of prevImageUrlsRef.current) {
          if (!currentSet.has(url)) missing.push(url);
        }
        if (missing.length > 0) {
          handlingDeleteRef.current = true;
          setPendingImageDelete(missing);
        } else {
          prevImageUrlsRef.current = currentSet;
        }
      }

      scheduleSave();
    };

    const resolveImageDelete = async (
      action: "cancel" | "note-only" | "note-and-disk"
    ) => {
      const url = pendingImageDelete[0];

      if (action === "cancel") {
        try {
          (editor as any).undo?.();
        } catch (e) {
          console.error("[image] undo failed:", e);
        }
        const currentSet = new Set(collectImageUrls(editor.document));
        prevImageUrlsRef.current = currentSet;
        setPendingImageDelete([]);
        handlingDeleteRef.current = false;
        scheduleSave();
        return;
      }

      if (action === "note-and-disk" && url) {
        const abs = assetUrlToAbsolutePath(url);
        if (abs) {
          await deleteImageFromNoteAssets(abs, path);
        }
      }

      const rest = pendingImageDelete.slice(1);
      if (rest.length === 0) {
        const currentSet = new Set(collectImageUrls(editor.document));
        prevImageUrlsRef.current = currentSet;
        setPendingImageDelete([]);
        handlingDeleteRef.current = false;
      } else {
        setPendingImageDelete(rest);
      }
      scheduleSave();
    };

    const loadAllNotes = useCallback(async () => {
      if (!vaultPath) return;
      setLoadingNotes(true);
      const out: NoteEntry[] = [];
      await collectNoteFiles(vaultPath, out);
      out.sort((a, b) => a.name.localeCompare(b.name));
      setAllNotes(out);
      setLoadingNotes(false);
    }, [vaultPath]);

    const openLinkPicker = useCallback(
      (fromBracket: boolean) => {
        bracketTriggerRef.current = fromBracket;
        setLinkQuery("");
        setLinkPickerOpen(true);
        if (allNotes.length === 0 && vaultPath) loadAllNotes();
      },
      [allNotes.length, vaultPath, loadAllNotes]
    );

    const closeLinkPicker = () => {
      bracketTriggerRef.current = false;
      setLinkPickerOpen(false);
    };

    const insertNoteLink = (entry: NoteEntry) => {
      try {
        const fromBracket = bracketTriggerRef.current;
        if (fromBracket) {
          const tiptap: any = (editor as any)._tiptapEditor;
          if (tiptap) {
            const sel = tiptap.state.selection;
            if (sel && sel.empty) {
              const from = sel.from - 2;
              if (from >= 0) {
                tiptap.chain().focus().deleteRange({ from, to: sel.from }).run();
              }
            }
          }
        }
        editor.insertInlineContent([
          { type: "text", text: `[[${entry.name}]]`, styles: {} },
        ]);
      } catch (e) {
        console.error("[link] insert failed:", e);
      }
      bracketTriggerRef.current = false;
      setLinkPickerOpen(false);
    };

    const insertNoteLinkMenuItem = () => ({
      title: "Link to note",
      subtext: "Insert a link to another note",
      onItemClick: () => openLinkPicker(false),
      aliases: ["link", "ref", "note", "wiki"],
      group: "Basic blocks",
      icon: <span className="text-base">🔗</span>,
    });

    const insertImageMenuItem = useCallback(
      () => ({
        title: "Upload image",
        subtext: "Insert an image from your computer",
        onItemClick: async () => {
          // Capture the block the user was on *before* the file picker opens.
          // The picker steals focus, and by the time it returns BlockNote's
          // `getTextCursorPosition()` may be stale — which is why images
          // were landing at the root instead of inside the current column.
          let refId: string | null = null;
          try {
            refId = editor.getTextCursorPosition?.().block?.id ?? null;
          } catch {}

          try {
            const picked = await open({
              multiple: true,
              filters: [
                {
                  name: "Image",
                  extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg"],
                },
              ],
            });
            if (!picked) return;
            const paths = Array.isArray(picked) ? picked : [picked];
            const urls: string[] = [];
            for (const src of paths) {
              if (typeof src !== "string") continue;
              try {
                const dest = await saveImageToNoteAssets(path, src);
                urls.push(convertFileSrc(dest));
              } catch (e) {
                console.error("[image] save failed:", e);
              }
            }
            if (urls.length > 0) insertImageBlocks(urls, refId);
          } catch (e) {
            console.error("[image] picker failed:", e);
          }
        },
        aliases: ["image", "img", "photo", "picture", "upload"],
        group: "Basic blocks",
        icon: <span className="text-base">🖼️</span>,
      }),
      [editor, path, insertImageBlocks]
    );

    const insertVideoMenuItem = useCallback(
      () => ({
        title: "Upload video",
        subtext: "Insert a video from your computer",
        onItemClick: async () => {
          let refId: string | null = null;
          try {
            refId = editor.getTextCursorPosition?.().block?.id ?? null;
          } catch {}

          try {
            const picked = await open({
              multiple: false,
              filters: [
                {
                  name: "Video",
                  extensions: ["mp4", "webm", "mov", "mkv", "m4v", "avi", "ogv"],
                },
              ],
            });
            if (!picked || typeof picked !== "string") return;
            const dest = await saveFileToNoteAssets(path, picked);
            const url = convertFileSrc(dest);
            const fileName = dest.split(/[/\\]/).pop() || "video";
            insertBlocksSmart(
              [
                {
                  type: "video",
                  props: { src: url, caption: "", fileName },
                },
              ],
              refId
            );
          } catch (e) {
            console.error("[video] picker failed:", e);
          }
        },
        aliases: ["video", "movie", "film", "clip", "upload"],
        group: "Basic blocks",
        icon: <span className="text-base">🎬</span>,
      }),
      [editor, path, insertBlocksSmart]
    );

    const insertScriptureMenuItem = useCallback(
      () => ({
        title: "Bible verse",
        subtext: "Look up a KJV verse",
        onItemClick: () => {
          let refId: string | null = null;
          try {
            refId = editor.getTextCursorPosition?.().block?.id ?? null;
          } catch {}
          insertBlocksSmart(
            [{ type: "scripture", props: { reference: "", text: "" } }],
            refId
          );
        },
        aliases: ["scripture", "bible", "verse", "kjv"],
        group: "Basic blocks",
        icon: <span className="text-base">📖</span>,
      }),
      [editor, insertBlocksSmart]
    );

    const insertDmArchiveMenuItem = useCallback(
      () => ({
        title: "DM archive",
        subtext: "Collapsible archive of chat screenshots",
        onItemClick: () => {
          try {
            let refId: string | null = null;
            try {
              refId = editor.getTextCursorPosition?.().block?.id ?? null;
            } catch {}
            const today = new Date().toISOString().slice(0, 10);
            const inserted = insertBlocksSmart(
              [
                {
                  type: "dmarchive",
                  props: {
                    platform: "discord",
                    who: "",
                    date: today,
                    caption: "",
                    collapsed: true,
                    srcs: "",
                  },
                } as any,
              ],
              refId
            );
            if (inserted?.[0]?.id) {
              try {
                editor.setTextCursorPosition(inserted[0].id, "end");
              } catch {}
            }
          } catch (e) {
            console.error("[dmarchive] insert failed:", e);
          }
        },
        aliases: [
          "dmarchive", "dm", "screenshot", "chat", "message",
          "discord", "instagram", "imessage", "text", "conversation",
          "archive", "log", "chatlog",
        ],
        group: "Basic blocks",
        icon: <span className="text-base">💬</span>,
      }),
      [editor, insertBlocksSmart]
    );

    const insertImageGalleryMenuItem = useCallback(
      () => ({
        title: "Photo gallery",
        subtext: "Grid of photos with drop-in slots",
        onItemClick: () => {
          let refId: string | null = null;
          try {
            refId = editor.getTextCursorPosition?.().block?.id ?? null;
          } catch {}
          insertBlocksSmart(
            [
              {
                type: "imagegallery",
                props: {
                  grid: JSON.stringify([[null]]),
                  gap: 8,
                },
              } as any,
            ],
            refId
          );
        },
        aliases: [
          "gallery", "imagegallery", "photo", "grid", "album",
          "photos", "pictures", "collage",
        ],
        group: "Basic blocks",
        icon: <span className="text-base">🖼️</span>,
      }),
      [editor, insertBlocksSmart]
    );

    const getSlashMenuItems = useMemo(() => {
      return async (query: string) => {
        const defaultItems = getDefaultReactSlashMenuItems(editor);
        const lastBasicBlockIndex = defaultItems.findLastIndex(
          (item) => item.group === "Basic blocks"
        );
        const extra = [
          insertCallout(editor),
          insertDmArchiveMenuItem(),
          insertNoteLinkMenuItem(),
          insertImageMenuItem(),
          insertVideoMenuItem(),
          insertScriptureMenuItem(),
          insertImageGalleryMenuItem(),

        ];
        if (lastBasicBlockIndex !== -1) {
          defaultItems.splice(lastBasicBlockIndex + 1, 0, ...extra);
        } else {
          defaultItems.push(...extra);
        }
        return filterSuggestionItems(
          combineByGroup(defaultItems, getMultiColumnSlashMenuItems(editor)),
          query
        );
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor, openLinkPicker, insertImageMenuItem, insertVideoMenuItem, insertScriptureMenuItem, insertDmArchiveMenuItem, insertImageGalleryMenuItem]);

    useEffect(() => {
      if (!editor) return;
      const tiptap: any = (editor as any)._tiptapEditor;
      if (!tiptap) return;
      const dom: HTMLElement | undefined = tiptap.view?.dom;
      if (!dom) return;

      const handler = (e: KeyboardEvent) => {
        if (mode !== "edit") return;
        if (e.key !== "[") return;
        setTimeout(() => {
          const state = tiptap.state;
          if (!state) return;
          const sel = state.selection;
          if (!sel || !sel.empty) return;
          const $from = sel.$from;
          const offset = $from.parentOffset;
          const text = $from.parent.textContent.slice(0, offset);
          if (text.endsWith("[[")) openLinkPicker(true);
        }, 0);
      };

      dom.addEventListener("keydown", handler);
      return () => dom.removeEventListener("keydown", handler);
    }, [editor, mode, openLinkPicker]);

    useEffect(() => {
      const el = wrapperRef.current;
      if (!el) return;

      const handler = (e: MouseEvent) => {
        const target = e.target as HTMLElement;

        const anchor = target.closest("a");
        if (anchor) {
          const href = anchor.getAttribute("href");
          if (href) {
            e.preventDefault();
            e.stopPropagation();
            openUrl(href).catch((err) =>
              console.error("[note] open link failed:", err)
            );
            return;
          }
        }

        const img = target.closest("img") as HTMLImageElement | null;
        if (img && !target.closest("a") && onImageClick) {
          const editorRoot =
            (el.querySelector(".bn-editor") as HTMLElement | null) ||
            (el.querySelector(".ProseMirror") as HTMLElement | null);
          if (editorRoot && editorRoot.contains(img)) {
            const allImgs = Array.from(
              editorRoot.querySelectorAll('[data-content-type="image"] img')
            ).filter(
              (n): n is HTMLImageElement => n instanceof HTMLImageElement
            );
            const idx = allImgs.indexOf(img);
            if (idx >= 0) {
              e.preventDefault();
              e.stopPropagation();
              onImageClick(allImgs.map((n) => n.src), idx);
              return;
            }
          }
        }

        const noteLinkEl = target.closest(".note-link") as HTMLElement | null;
        if (!noteLinkEl) return;
        const name = noteLinkEl.getAttribute("data-note-name");
        if (!name) return;

        if (mode === "edit" && !e.ctrlKey && !e.metaKey) return;

        e.preventDefault();
        e.stopPropagation();

        const matches = allNotes.filter((n) => n.name === name);
        if (matches.length === 1) {
          onOpenNoteByPath?.(matches[0].path);
          return;
        }
        if (matches.length > 1) {
          setLinkQuery(name);
          bracketTriggerRef.current = false;
          setLinkPickerOpen(true);
          return;
        }
        if (vaultPath) {
          const out: NoteEntry[] = [];
          collectNoteFiles(vaultPath, out).then(() => {
            setAllNotes(out);
            const found = out.find((n) => n.name === name);
            if (found) onOpenNoteByPath?.(found.path);
          });
        }
      };

      el.addEventListener("click", handler, true);
      return () => el.removeEventListener("click", handler, true);
    }, [mode, allNotes, vaultPath, onOpenNoteByPath, onImageClick]);

    useEffect(() => {
      if (!vaultPath) return;
      const out: NoteEntry[] = [];
      collectNoteFiles(vaultPath, out).then(() => {
        out.sort((a, b) => a.name.localeCompare(b.name));
        setAllNotes(out);
      });
    }, [vaultPath]);

    const filteredNotes = useMemo(() => {
      const q = linkQuery.trim().toLowerCase();
      if (!q) return allNotes.slice(0, 60);
      return allNotes
        .filter((n) => n.name.toLowerCase().includes(q))
        .slice(0, 60);
    }, [linkQuery, allNotes]);

    const pendingImageUrl = pendingImageDelete[0] || null;
    const pendingImageAbs = pendingImageUrl
      ? assetUrlToAbsolutePath(pendingImageUrl)
      : null;
    const canDeleteFromDisk = pendingImageAbs
      ? isInsideNoteAssets(pendingImageAbs, path)
      : false;

    const pasteMenuCanEmbed = pasteMenu
      ? isReliablyEmbeddable(pasteMenu.url)
      : false;

    const noteContextValue = useMemo(
      () => ({ notePath: path, noteDir: noteDirOf(path) }),
      [path]
    );

    const alignBtnClass = (active: boolean) =>
      `flex-1 flex items-center justify-center py-1.5 rounded transition-colors ${
        active
          ? "bg-blue-600/25 text-blue-200"
          : "text-gray-400 hover:text-gray-100 hover:bg-[#2a3136]"
      }`;

    const imageIsLocal = imageMenu
      ? !!assetUrlToAbsolutePath(imageMenu.url)
      : false;
    const previewOn =
      !!imageMenu &&
      typeof imageMenu.previewWidth === "number" &&
      imageMenu.previewWidth > 0;

    return (
      <NoteContext.Provider value={noteContextValue}>
        <div
          ref={wrapperRef}
          className={mode === "read" ? "note-read-mode" : ""}
        >
          <BlockNoteView
            editor={editor}
            theme="dark"
            slashMenu={false}
            onChange={handleContentChange}
          >
            <SuggestionMenuController
              triggerCharacter="/"
              getItems={getSlashMenuItems}
            />
          </BlockNoteView>

          {dragOverlay && (
            <>
            {/* Position indicator: a blue line for insert targets, a
              highlighted border for gallery cells. */}
              {dragOverlay.indicator && (
                <div
                className={
                  dragOverlay.target?.kind === "gallery"
                  ? "fixed z-[450] pointer-events-none rounded-md ring-2 ring-blue-400 bg-blue-500/15 transition-[top,left,width,height] duration-75"
                  : dragOverlay.target?.kind === "insert" &&
                  dragOverlay.target.placement === "nested"
                  ? "fixed z-[450] pointer-events-none rounded-md ring-2 ring-blue-400/70 transition-[top,left,width,height] duration-75"
                  : "fixed z-[450] pointer-events-none bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.9)] rounded-sm transition-[top,left,width] duration-75"
                }
                style={{
                  left: dragOverlay.indicator.left,
                  top: dragOverlay.indicator.top,
                  width: dragOverlay.indicator.width,
                  height: dragOverlay.indicator.height,
                }}
                />
              )}

              {/* Floating badge that follows the cursor. */}
              <div
              className="fixed z-[451] pointer-events-none px-2.5 py-1 rounded-md bg-[#1e2327] border border-blue-500/60 text-[11px] text-blue-100 shadow-2xl whitespace-nowrap"
              style={{
                left: dragOverlay.x + 14,
                top: dragOverlay.y + 14,
              }}
              >
              Drop to add
              </div>
              </>
          )}



          {imageMenu && (
            <div
              ref={imageMenuRef}
              className="fixed z-[500] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-2xl py-1 w-[232px] max-h-[80vh] overflow-y-auto"
              style={{ top: imageMenu.y, left: imageMenu.x }}
              onMouseDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              {imageMenu.mode === "caption" ? (
                <>
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
                    <Pencil size={10} /> Image caption
                  </div>
                  <div className="px-2 pb-2">
                    <input
                      ref={captionInputRef}
                      type="text"
                      value={captionDraft}
                      onChange={(e) => setCaptionDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          e.stopPropagation();
                          saveCaptionInline();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          e.stopPropagation();
                          backToMainMenu();
                        }
                      }}
                      placeholder="Describe this image…"
                      className="w-full bg-[#0f1315] border border-[#30363d] rounded px-2 py-1.5 text-xs text-gray-100 outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <div className="flex gap-1.5 mt-2">
                      <button
                        onClick={backToMainMenu}
                        className="flex-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 hover:bg-[#2a3136] rounded transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={saveCaptionInline}
                        className="flex-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                </>
              ) : imageMenu.mode === "rename" ? (
                <>
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
                    <FileText size={10} /> Rename image
                  </div>
                  <div className="px-2 pb-2">
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={renameDraft}
                      onChange={(e) => {
                        setRenameDraft(e.target.value);
                        if (renameError) setRenameError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          e.stopPropagation();
                          void saveRename();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          e.stopPropagation();
                          backToMainMenu();
                        }
                      }}
                      placeholder="new-filename"
                      className="w-full bg-[#0f1315] border border-[#30363d] rounded px-2 py-1.5 text-xs text-gray-100 outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    {renameError && (
                      <div className="text-[10px] text-red-400 mt-1 break-words">
                        {renameError}
                      </div>
                    )}
                    <div className="flex gap-1.5 mt-2">
                      <button
                        onClick={backToMainMenu}
                        className="flex-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 hover:bg-[#2a3136] rounded transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => void saveRename()}
                        className="flex-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
                      >
                        Rename
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <>
                <div className="py-1">
                {IMAGE_WIDTH_PRESETS.map((preset) => {
                  const Icon = preset.icon;
                  return (
                    <button
                    key={preset.label}
                    onClick={() =>
                      applyImageWidth(imageMenu.blockId, preset.px)
                    }
                    className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
                    >
                    <Icon size={13} />
                    <span>{preset.label}</span>
                    </button>
                  );
                })}
                </div>

                <div className="border-t border-[#2a3136] mt-1 pt-1 px-2 pb-1 flex items-center gap-1">
                <button
                onClick={() =>
                  applyImageAlignment(imageMenu.blockId, "left")
                }
                className={alignBtnClass(
                  imageMenu.textAlignment === "left"
                )}
                title="Align left"
                >
                <AlignLeft size={13} />
                </button>
                <button
                onClick={() =>
                  applyImageAlignment(imageMenu.blockId, "center")
                }
                className={alignBtnClass(
                  imageMenu.textAlignment === "center"
                )}
                title="Align center"
                >
                <AlignCenter size={13} />
                </button>
                <button
                onClick={() =>
                  applyImageAlignment(imageMenu.blockId, "right")
                }
                className={alignBtnClass(
                  imageMenu.textAlignment === "right"
                )}
                title="Align right"
                >
                <AlignRight size={13} />
                </button>
                </div>

                  <div className="border-t border-[#2a3136] mt-1 pt-1">
                    <button
                      onClick={enterCaptionMode}
                      className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
                    >
                      <Pencil size={13} />
                      <span>
                        {imageMenu.caption ? "Edit caption" : "Add caption"}
                      </span>
                    </button>
                    <button
                      onClick={togglePreview}
                      className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
                      title={
                        previewOn
                          ? "Switch back to full width"
                          : `Shrink to ${PREVIEW_WIDTH_PX}px preview (same as BlockNote's default)`
                      }
                    >
                      {previewOn ? <EyeOff size={13} /> : <Eye size={13} />}
                      <span>Toggle preview</span>
                    </button>
                    {imageIsLocal && (
                      <button
                        onClick={enterRenameMode}
                        className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
                      >
                        <FileText size={13} />
                        <span>Rename image…</span>
                      </button>
                    )}
                  </div>

                  <div className="border-t border-[#2a3136] mt-1 pt-1">
                    <button
                      onClick={() => replaceImage(imageMenu.blockId)}
                      className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
                    >
                      <Replace size={13} />
                      <span>Replace image…</span>
                    </button>
                  </div>

                  <div className="border-t border-[#2a3136] mt-1 pt-1">
                    <button
                      onClick={() => downloadImage(imageMenu.url)}
                      className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
                    >
                      <Download size={13} />
                      <span>Download image</span>
                    </button>
                    <button
                      onClick={() => openImageExternal(imageMenu.url)}
                      className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
                    >
                      <ExternalLink size={13} />
                      <span>Open in system viewer</span>
                    </button>
                    <button
                      onClick={() => copyImageUrl(imageMenu.url)}
                      className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
                    >
                      <Copy size={13} />
                      <span>Copy image URL</span>
                    </button>
                  </div>

                  <div className="border-t border-[#2a3136] mt-1 pt-1">
                    <button
                      onClick={() => removeImageBlock(imageMenu.blockId)}
                      className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-[#2a3136] flex items-center gap-2"
                    >
                      <Trash2 size={13} />
                      <span>Delete image</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {pasteMenu && (() => {
            const platform = detectPlatform(pasteMenu.url);
            const preview = humanizeUrlTitle(pasteMenu.url);
            return (
              <div
                ref={pasteMenuRef}
                className="fixed z-[500] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-2xl py-1 w-64"
                style={{ top: pasteMenu.y, left: pasteMenu.x }}
                onMouseDown={(e) => e.preventDefault()}
              >
                {platform && (
                  <div className="px-3 pt-1.5 pb-1.5 border-b border-[#2a3136] flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: platform.accent }}
                    />
                    <span className="text-[10px] uppercase tracking-wider text-gray-400 flex-shrink-0">
                      {platform.label}
                    </span>
                    <span
                      className="text-[10px] text-gray-500 truncate ml-auto"
                      title={preview}
                    >
                      {preview}
                    </span>
                  </div>
                )}
                <button
                  onClick={() => pasteAsText(pasteMenu.url)}
                  className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
                >
                  <TypeIcon size={13} /> <span>Paste as text</span>
                </button>
                <button
                  onClick={() => pasteAsLink(pasteMenu.url, "bookmark")}
                  className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2 border-t border-[#2a3136]"
                >
                  <LinkIcon size={13} /> <span>Paste as bookmark</span>
                </button>
                {pasteMenuCanEmbed && (
                  <button
                    onClick={() => pasteAsLink(pasteMenu.url, "embed")}
                    className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2 border-t border-[#2a3136]"
                  >
                    <PlayIcon size={13} /> <span>Embed</span>
                  </button>
                )}
              </div>
            );
          })()}

          {linkPickerOpen && (
            <div
              className="fixed inset-0 z-[300] bg-black/60 flex items-start justify-center pt-24"
              onClick={closeLinkPicker}
            >
              <div
                className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[480px] max-w-[92vw] flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="px-3 py-2 border-b border-[#2a3136] bg-[#1a1e21]">
                  <input
                    autoFocus
                    type="text"
                    value={linkQuery}
                    onChange={(e) => setLinkQuery(e.target.value)}
                    placeholder="Search notes…"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && filteredNotes[0]) {
                        insertNoteLink(filteredNotes[0]);
                      } else if (e.key === "Escape") {
                        closeLinkPicker();
                      }
                    }}
                    className="w-full bg-transparent border-none outline-none text-sm text-gray-100 placeholder-gray-500"
                  />
                </div>
                <div className="max-h-[50vh] overflow-y-auto">
                  {loadingNotes && (
                    <div className="px-3 py-2 text-xs text-gray-500">
                      Loading notes…
                    </div>
                  )}
                  {!loadingNotes && filteredNotes.length === 0 && (
                    <div className="px-3 py-2 text-xs text-gray-500 italic">
                      No matches.
                    </div>
                  )}
                  {filteredNotes.map((n) => (
                    <button
                      key={n.path}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insertNoteLink(n);
                      }}
                      className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
                    >
                      <span className="flex-shrink-0 w-5 text-center">
                        {n.icon || "📄"}
                      </span>
                      <span className="truncate">{n.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {pendingImageUrl && (
            <div
              className="fixed inset-0 z-[400] bg-black/70 flex items-center justify-center p-6"
              onKeyDown={(e) => {
                if (e.key === "Escape") resolveImageDelete("cancel");
              }}
            >
              <div className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[440px] max-w-[92vw] overflow-hidden">
                <div className="px-4 py-3 border-b border-[#2a3136] flex items-center gap-2">
                  <AlertTriangle size={14} className="text-amber-400" />
                  <span className="text-sm font-medium text-gray-100">
                    Delete this photo?
                  </span>
                  <button
                    onClick={() => resolveImageDelete("cancel")}
                    className="ml-auto text-gray-500 hover:text-gray-300 cursor-pointer p-0.5"
                    title="Cancel"
                  >
                    <X size={14} />
                  </button>
                </div>

                <div className="p-4">
                  <div className="w-full h-44 bg-[#0f1315] rounded-md overflow-hidden flex items-center justify-center mb-4">
                    <img
                      src={pendingImageUrl}
                      alt=""
                      className="max-w-full max-h-full object-contain"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = "none";
                      }}
                    />
                  </div>

                  {pendingImageDelete.length > 1 && (
                    <p className="text-[11px] text-gray-500 mb-2">
                      1 of {pendingImageDelete.length} pending
                    </p>
                  )}

                  <p className="text-xs text-gray-400 leading-relaxed">
                    The image was removed from this note.
                    {canDeleteFromDisk
                      ? " Do you also want to delete the file from disk?"
                      : " This image isn't stored in this note's folder, so it can only be removed from the note."}
                  </p>

                  <div className="flex flex-col gap-2 mt-4">
                    <button
                      onClick={() => resolveImageDelete("cancel")}
                      className="w-full text-xs px-3 py-2 rounded text-gray-300 hover:text-gray-100 hover:bg-[#2a3136] border border-[#2a3136] transition-colors cursor-pointer"
                    >
                      Cancel — keep image in note
                    </button>
                    <button
                      onClick={() => resolveImageDelete("note-only")}
                      className="w-full text-xs px-3 py-2 rounded bg-[#2a3136] hover:bg-[#30363d] text-gray-100 transition-colors cursor-pointer"
                    >
                      Remove from note, keep file
                    </button>
                    {canDeleteFromDisk && (
                      <button
                        onClick={() => resolveImageDelete("note-and-disk")}
                        className="w-full flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded bg-red-600/90 hover:bg-red-500 text-white transition-colors cursor-pointer"
                      >
                        <Trash2 size={12} />
                        Remove from note &amp; move file to trash
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </NoteContext.Provider>
    );
  }
);

NoteBody.displayName = "NoteBody";
export default NoteBody;
