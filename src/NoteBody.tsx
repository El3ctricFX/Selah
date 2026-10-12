// src/NoteBody.tsx
import { BlockNoteSchema, combineByGroup, filterSuggestionItems } from "@blocknote/core";
import { insertOrUpdateBlockForSlashMenu } from "@blocknote/core/extensions";
import {
  useCreateBlockNote,
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  FormattingToolbar,
  useBlockNoteEditor,
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
import { openUrl, openPath } from "@tauri-apps/plugin-opener";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Trash2,
  AlertTriangle,
  X,
  Link as LinkIcon,
  Type as TypeIcon,
  Play as PlayIcon,
  Maximize2,
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
} from "./imageAssets";
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

const URL_RE = /^https?:\/\/\S+$/i;
const DEBOUNCE_MS = 150;
const MAX_DEBOUNCE_MS = 2000;

const NOTE_LINK_KEY = new PluginKey("note-links");

function buildNoteLinkDecorations(doc: any): DecorationSet {
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
  state: {
    init: (_: any, state: any) => buildNoteLinkDecorations(state.doc),
    apply: (tr: any, _old: any) => {
      if (tr.docChanged) return buildNoteLinkDecorations(tr.doc);
      return _old;
    },
  },
  props: {
    decorations(state: any) {
      return NOTE_LINK_KEY.getState(state);
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

/**
 * BlockNote's default formatting toolbar morphs into an image-actions bar
 * when an image is selected. We already have a right-click menu for those,
 * so hide the toolbar entirely on node selections — but keep it for normal
 * text selections so bold/italic/links still work.
 */
function NoteFormattingToolbar() {
  const editor = useBlockNoteEditor();
  const tiptap: any = (editor as any)._tiptapEditor;
  const selection = tiptap?.state?.selection;

  // A NodeSelection (image, video, etc.) has `.node` set; a text selection
  // does not. Hide the toolbar in that case.
  if (selection?.node) return null;

  // Belt and braces: also hide it whenever the selected block is a file-type
  // block (image/video/audio/file), even if the selection isn't a NodeSelection.
  try {
    const blockType = editor.getTextCursorPosition().block.type;
    if (["image", "video", "audio", "file"].includes(blockType)) return null;
  } catch {
    /* no cursor position yet; fall through */
  }

  return <FormattingToolbar />;
}

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
      (blocksToInsert: any[]): any[] => {
        if (!editor || blocksToInsert.length === 0) return [];
        try {
          const cursor = editor.getTextCursorPosition?.();
          const refBlock =
            cursor?.block || editor.document[editor.document.length - 1];
          if (!refBlock) return [];

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
      return () => {
        try {
          tiptap.unregisterPlugin(NOTE_LINK_KEY);
        } catch {}
      };
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

      const clearHighlights = () => {
        document
          .querySelectorAll<HTMLElement>("[data-drop-highlight]")
          .forEach((n) => {
            n.removeAttribute("data-drop-highlight");
            n.style.outline = "";
            n.style.outlineOffset = "";
          });
      };

      const cleanup = () => {
        if (ghostEl) {
          ghostEl.remove();
          ghostEl = null;
        }
        document.body.style.cursor = "";
        clearHighlights();
      };

      const blockIdFromImg = (img: HTMLImageElement): string | null => {
        const blockEl = img.closest("[data-id]") as HTMLElement | null;
        return blockEl?.getAttribute("data-id") || null;
      };

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
            textAlignment =
            (bp?.textAlignment as string) || "left";
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
        const col = under?.closest(
          ".bn-block-column, [data-node-type='column']"
        ) as HTMLElement | null;
        if (col) {
          col.setAttribute("data-drop-highlight", "1");
          col.style.outline = "2px solid #3b82f6";
          col.style.outlineOffset = "-2px";
        }
      };

      const onMouseUp = (e: MouseEvent) => {
        if (!pending) return;
        const wasDragging = !!ghostEl;
        const blockId = pending.blockId;
        pending = null;
        cleanup();

        if (!wasDragging) return;

        const under = document.elementFromPoint(
          e.clientX,
          e.clientY
        ) as HTMLElement | null;
        const col = under?.closest(
          ".bn-block-column, [data-node-type='column']"
        ) as HTMLElement | null;
        if (!col) return;

        const colId = col.getAttribute("data-id");
        if (!colId) return;

        const srcEl = document.querySelector(
          `[data-id="${blockId}"]`
        ) as HTMLElement | null;
        if (
          srcEl?.closest(".bn-block-column, [data-node-type='column']") === col
        )
          return;

        try {
          const block = editor.getBlock(blockId);
          if (!block) return;
          editor.insertBlocks(
            [
              {
                type: block.type,
                props: { ...(block.props as any) },
              } as any,
            ],
            colId,
            "nested" as any
          );
          editor.removeBlocks([blockId]);
        } catch (err) {
          console.error("[drag] move into column failed:", err);
        }
      };

      const onDragStart = (e: DragEvent) => {
        const target = e.target as HTMLElement;
        if (target.tagName === "IMG" && el.contains(target)) {
          e.preventDefault();
        }
      };

      el.addEventListener("contextmenu", onContextMenu);
      el.addEventListener("mousedown", onMouseDown);
      el.addEventListener("dragstart", onDragStart, true);
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);

      return () => {
        el.removeEventListener("contextmenu", onContextMenu);
        el.removeEventListener("mousedown", onMouseDown);
        el.removeEventListener("dragstart", onDragStart, true);
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
        const body = dmarchiveSrcsToRelativePaths(withVideos, noteDirOf(path));
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
      (urls: string[]) => {
        if (!editor || urls.length === 0) return;
        insertBlocksSmart(
          urls.map((url) => ({
            type: "image",
            props: { url, caption: "" },
          }))
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
          console.log("[paste] no clipboardData on event");
          return;
        }

        const collected: File[] = [];

        if (cd.items && cd.items.length > 0) {
          for (let i = 0; i < cd.items.length; i++) {
            const item = cd.items[i];
            console.log(`[paste] item[${i}] kind=${item.kind} type=${item.type}`);
            if (item.kind !== "file") continue;
            if (!/^image\/|^video\//i.test(item.type)) continue;
            const f = item.getAsFile();
            if (f) collected.push(f);
          }
        }
        if (collected.length === 0 && cd.files && cd.files.length > 0) {
          for (let i = 0; i < cd.files.length; i++) {
            const f = cd.files[i];
            console.log(
              `[paste] file[${i}] name=${f.name} type=${f.type} size=${f.size}`
            );
            if (/^image\/|^video\//i.test(f.type)) collected.push(f);
          }
        }

        console.log(
          "[paste] collected:",
          collected.length,
          collected.map((f) => `${f.name || "<clipboard>"} (${f.type}, ${f.size}b)`)
        );

        if (collected.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          const imgs = collected.filter((f) => f.type.startsWith("image/"));
          const vids = collected.filter((f) => f.type.startsWith("video/"));
          if (imgs.length > 0) saveAndInsertImageFiles(imgs);
          if (vids.length > 0) saveAndInsertVideoFiles(vids);
          return;
        }

        void (async () => {
          try {
            const pngBytes = await invoke<number[] | null>(
              "read_clipboard_image_png"
            );
            if (!pngBytes || pngBytes.length === 0) return;
            e.preventDefault();
            e.stopPropagation();
            const uint8 = new Uint8Array(pngBytes);
            const name = `pasted-${Date.now()}.png`;
            const dest = await writeImageBytesToNoteAssets(path, uint8, name);
            const url = convertFileSrc(dest);
            insertImageBlocks([url]);
          } catch (err) {
            console.error("[paste] Rust clipboard fallback failed:", err);
          }
        })();

        const text = cd.getData("text/plain")?.trim() || "";
        if (!URL_RE.test(text)) return;

        const tiptap: any = (editor as any)._tiptapEditor;
        if (!tiptap) return;
        const sel = tiptap.state.selection;
        if (!sel || !sel.empty) return;

        e.preventDefault();
        e.stopPropagation();

        const { from } = sel;
        let coords: { left: number; bottom: number } = { left: 40, bottom: 40 };
        try {
          const c = tiptap.view.coordsAtPos(from);
          coords = { left: c.left, bottom: c.bottom };
        } catch {}

        setPasteMenu({
          url: text,
          x: Math.min(Math.max(8, coords.left), window.innerWidth - 260),
          y: Math.min(coords.bottom + 6, window.innerHeight - 160),
        });
      };

      document.addEventListener("paste", handler, true);
      return () => document.removeEventListener("paste", handler, true);
    }, [isLoading, saveAndInsertImageFiles, saveAndInsertVideoFiles, editor]);

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
      try {
        const inserted = insertBlocksSmart([
          {
            type: "bookmark",
            props: {
              url,
              title: url,
              description: "",
              icon: "",
              image: "",
              mode: linkMode,
            },
          },
        ]);
        const newId = inserted?.[0]?.id;
        if (!newId) return;

        try {
          const meta: any = await invoke("fetch_link_metadata", { url });
          if (meta) {
            editor.updateBlock(newId, {
              props: {
                url,
                title: meta.title || url,
                description: meta.description || "",
                icon: meta.favicon || "",
                image: meta.image || "",
                mode: linkMode,
              },
            });
          }
        } catch (err) {
          console.warn("[bookmark] metadata fetch failed:", err);
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
          const blocks = await noteBodyToBlocks(editor, withDmArchives);
          if (isMounted && editor) {
            editor.replaceBlocks(
              editor.document,
              blocks.length ? blocks : [{ type: "paragraph" }]
            );
            prevImageUrlsRef.current = new Set(
              collectImageUrls(editor.document)
            );
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

      if (!handlingDeleteRef.current) {
        const currentUrls = collectImageUrls(editor.document);
        const currentSet = new Set(currentUrls);
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
            if (urls.length > 0) insertImageBlocks(urls);
          } catch (e) {
            console.error("[image] picker failed:", e);
          }
        },
        aliases: ["image", "img", "photo", "picture", "upload"],
        group: "Basic blocks",
        icon: <span className="text-base">🖼️</span>,
      }),
      [path, insertImageBlocks]
    );

    const insertVideoMenuItem = useCallback(
      () => ({
        title: "Upload video",
        subtext: "Insert a video from your computer",
        onItemClick: async () => {
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
            insertBlocksSmart([
              {
                type: "video",
                props: { src: url, caption: "", fileName },
              },
            ]);
          } catch (e) {
            console.error("[video] picker failed:", e);
          }
        },
        aliases: ["video", "movie", "film", "clip", "upload"],
        group: "Basic blocks",
        icon: <span className="text-base">🎬</span>,
      }),
      [path, insertBlocksSmart]
    );

    const insertScriptureMenuItem = useCallback(
      () => ({
        title: "Bible verse",
        subtext: "Look up a KJV verse",
        onItemClick: () => {
          insertBlocksSmart([
            { type: "scripture", props: { reference: "", text: "" } },
          ]);
        },
        aliases: ["scripture", "bible", "verse", "kjv"],
        group: "Basic blocks",
        icon: <span className="text-base">📖</span>,
      }),
      [insertBlocksSmart]
    );

    const insertDmArchiveMenuItem = useCallback(
      () => ({
        title: "DM archive",
        subtext: "Collapsible archive of chat screenshots",
        onItemClick: () => {
          try {
            const today = new Date().toISOString().slice(0, 10);
            const inserted = insertBlocksSmart([
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
            ]);
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
    }, [editor, openLinkPicker, insertImageMenuItem, insertVideoMenuItem, insertScriptureMenuItem, insertDmArchiveMenuItem]);

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
            formattingToolbar={NoteFormattingToolbar}
            onChange={handleContentChange}
          >
            <SuggestionMenuController
              triggerCharacter="/"
              getItems={getSlashMenuItems}
            />
          </BlockNoteView>

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

          {pasteMenu && (
            <div
              ref={pasteMenuRef}
              className="fixed z-[500] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-2xl py-1 w-60"
              style={{ top: pasteMenu.y, left: pasteMenu.x }}
              onMouseDown={(e) => e.preventDefault()}
            >
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
          )}

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