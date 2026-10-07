// src/NoteBody.tsx
import { BlockNoteSchema, combineByGroup, filterSuggestionItems } from "@blocknote/core";
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
import { readTextFile, writeTextFile, readDir } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Trash2,
  AlertTriangle,
  X,
  Link as LinkIcon,
  Type as TypeIcon,
  Play as PlayIcon,
} from "lucide-react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { createCallout } from "./Callout";
import { createBookmark } from "./Bookmark";
import { isReliablyEmbeddable } from "./embeds";
import { useNoteMode } from "./useNoteMode";
import {
  noteBodyToBlocks,
  blocksToNoteBody,
  parseNoteFile,
  serializeNoteFile,
} from "./noteFormat";
import type { Frontmatter } from "./noteFormat";
import {
  saveImageToNoteAssets,
  writeImageBytesToNoteAssets,
  markdownImagesToAssetUrls,
  markdownImagesToRelativePaths,
  assetUrlToAbsolutePath,
  isInsideNoteAssets,
  deleteImageFromNoteAssets,
} from "./imageAssets";

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
  // Called when the user clicks an image. Receives every image src in the
  // note (in DOM order) plus the index of the one that was clicked.
  onImageClick?: (srcs: string[], index: number) => void;
}

export interface NoteBodyHandle {
  updateFrontmatter: (patch: Partial<Frontmatter>) => Promise<void>;
  flush: () => Promise<void>;
  /** Tell the component to skip its unmount flush. Used before a rename so
   *  the debounced save can't recreate the old file at the stale path. */
  dispose: () => void;
  /** Undo a prior dispose() so the debounced save can run again. */
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
      } else if (e.name.endsWith(".note")) {
        let icon = "";
        try {
          const raw = await readTextFile(full);
          const { frontmatter } = parseNoteFile(raw);
          icon = (frontmatter.icon as string) || "";
        } catch {}
        out.push({
          path: full,
          name: e.name.replace(/\.note$/, ""),
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

const URL_RE = /^https?:\/\/\S+$/i;
const DEBOUNCE_MS = 500;

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

    const frontmatterRef = useRef<Frontmatter>({});
    const isNewFileRef = useRef(false);
    const dirtyRef = useRef(false);
    const bracketTriggerRef = useRef(false);
    /** Set by dispose() to suppress the unmount flush (used before a rename). */
    const disposedRef = useRef(false);

    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

    const prevImageUrlsRef = useRef<Set<string>>(new Set());
    const handlingDeleteRef = useRef(false);

    const { mode } = useNoteMode();

    const editor = useCreateBlockNote({
      schema: withMultiColumn(
        BlockNoteSchema.create().extend({
          blockSpecs: {
            callout: createCallout(),
            bookmark: createBookmark(),
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
      try {
        const rawBody = await blocksToNoteBody(editor, editor.document);
        const body = markdownImagesToRelativePaths(rawBody, noteDirOf(path));
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

        await writeTextFile(path, serializeNoteFile(fm, body));
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

    const scheduleSave = () => {
      dirtyRef.current = true;
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        queueWrite(saveBody);
      }, DEBOUNCE_MS);
    };

    const flush = async () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (!dirtyRef.current) {
        await writeQueueRef.current;
        return;
      }
      await queueWrite(saveBody);
    };

    const insertImageBlocks = useCallback(
      (urls: string[]) => {
        if (!editor || urls.length === 0) return;
        try {
          const cursor = editor.getTextCursorPosition?.();
          const refBlock =
            cursor?.block || editor.document[editor.document.length - 1];
          if (!refBlock) return;
          editor.insertBlocks(
            urls.map((url) => ({
              type: "image",
              props: { url, caption: "" },
            })),
            refBlock,
            "after"
          );
        } catch (e) {
          console.error("[image] insert failed:", e);
        }
      },
      [editor]
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

    const wrapperRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const el = wrapperRef.current;
      if (!el) return;

      const handler = (e: ClipboardEvent) => {
        if (isLoading) return;

        const items = e.clipboardData?.items;

        if (items) {
          const files: File[] = [];
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === "file" && item.type.startsWith("image/")) {
              const f = item.getAsFile();
              if (f) files.push(f);
            }
          }
          if (files.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            saveAndInsertImageFiles(files);
            return;
          }
        }

        const text = e.clipboardData?.getData("text/plain")?.trim() || "";
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

      el.addEventListener("paste", handler, true);
      return () => el.removeEventListener("paste", handler, true);
    }, [isLoading, saveAndInsertImageFiles, editor]);

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
        const cursor = editor.getTextCursorPosition?.();
        const refBlock =
          cursor?.block || editor.document[editor.document.length - 1];
        if (!refBlock) return;

        const inserted = editor.insertBlocks(
          [
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
          ],
          refBlock,
          "after"
        );
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

          const transformedBody = markdownImagesToAssetUrls(body, noteDirOf(path));
          const blocks = await noteBodyToBlocks(editor, transformedBody);
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
        // If the parent called dispose() (typically right before a rename),
        // skip the flush — otherwise the debounced save would recreate the
        // old file at the stale `path` with only the in-memory body.
        if (disposedRef.current) return;
        flush();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path]);

    // Persist any pending image-delete prompt across remounts. Without this,
    // navigating away and back while the confirm modal is open silently
    // discards the user's chance to cancel.
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
            await writeTextFile(
              path,
              serializeNoteFile(frontmatterRef.current, "")
            );
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
            await writeTextFile(path, serializeNoteFile(merged, body));
            window.dispatchEvent(
              new CustomEvent("file-changed", { detail: { path } })
            );
          } catch (e) {
            console.error("Failed to update frontmatter", e);
          }
        });
      },
    }));

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

    const getSlashMenuItems = useMemo(() => {
      return async (query: string) => {
        const defaultItems = getDefaultReactSlashMenuItems(editor);
        const lastBasicBlockIndex = defaultItems.findLastIndex(
          (item) => item.group === "Basic blocks"
        );
        const extra = [
          insertCallout(editor),
          insertNoteLinkMenuItem(),
          insertImageMenuItem(),
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
    }, [editor, openLinkPicker, insertImageMenuItem]);

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

    return (
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
    );
  }
);

NoteBody.displayName = "NoteBody";
export default NoteBody;