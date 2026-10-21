// src/ScriptureBlock.tsx
import { createReactBlockSpec } from "@blocknote/react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  BookOpen, Copy, Check, ExternalLink, Loader2, X, RefreshCw,
  ChevronDown, ChevronRight, Trash2,
} from "lucide-react";
import { useNoteMode } from "./useNoteMode";

interface BibleVerse {
  reference: string;
  text: string;
  translation_name: string;
}

/** Render a verse block. Input lines look like "16 For God so loved…" for
 *  numbered verses, or plain prose for the fallback / single-verse case. */
function VerseText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div
      className="text-sm text-gray-200 leading-relaxed space-y-1.5"
      style={{ fontFamily: "Georgia, 'Times New Roman', serif", userSelect: "text" }}
    >
      {lines.map((line, i) => {
        const m = line.match(/^(\d+)\s+(.+)$/);
        if (m) {
          return (
            <div key={i} className="flex gap-2 items-baseline">
              <span
                className="text-blue-400/80 text-[10px] tabular-nums select-none flex-shrink-0 text-right"
                style={{
                  fontFamily:
                    "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
                  minWidth: "1.5rem",
                }}
              >
                {m[1]}
              </span>
              <span className="flex-1">{m[2]}</span>
            </div>
          );
        }
        return <div key={i}>{line}</div>;
      })}
    </div>
  );
}

export const createScripture = createReactBlockSpec(
  {
    type: "scripture",
    propSchema: {
      reference: { default: "" },
      text: { default: "" },
      // Whether the verse starts collapsed when the note is opened. `false`
      // preserves the old always-visible behavior for existing verses.
      collapsed: { default: false },
    },
    content: "none",
  },
  {
    render: (props) => {
      const live = props.editor.getBlock(props.block.id) ?? props.block;
      const reference = (live.props.reference as string) || "";
      const text = (live.props.text as string) || "";
      const defaultCollapsed = live.props.collapsed === true;

      const { mode } = useNoteMode();
      const isEdit = mode === "edit";

      // Transient view state — the chevron toggles this. Distinct from the
      // persisted `collapsed` prop, which only controls what happens on
      // the *next* open of the note.
      const [viewOpen, setViewOpen] = useState<boolean>(!defaultCollapsed);
      const [draft, setDraft] = useState(reference);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState<string | null>(null);
      const [copied, setCopied] = useState(false);
      const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

      useEffect(() => { setDraft(reference); }, [reference]);

      useEffect(() => {
        if (!ctxMenu) return;
        const close = () => setCtxMenu(null);
        document.addEventListener("mousedown", close);
        document.addEventListener("click", close);
        return () => {
          document.removeEventListener("mousedown", close);
          document.removeEventListener("click", close);
        };
      }, [ctxMenu]);

      const update = (patch: Record<string, any>) => {
        try {
          props.editor.updateBlock(props.block.id, { props: patch });
        } catch (e) {
          console.error("[scripture] updateBlock failed:", e);
        }
      };

      const fetchVerse = async (ref: string) => {
        setLoading(true);
        setError(null);
        try {
          const verse = await invoke<BibleVerse>("fetch_bible_verse", {
            reference: ref,
          });
          update({ reference: verse.reference, text: verse.text });
        } catch (e: any) {
          setError(typeof e === "string" ? e : e?.message ?? String(e));
        } finally {
          setLoading(false);
        }
      };

      const handleSubmit = () => {
        const ref = draft.trim();
        if (!ref) return;
        fetchVerse(ref);
      };

      const copyVerse = async () => {
        // Reformat into a single inline string for pasting elsewhere.
        const plain = text
          .split("\n")
          .map((l) => l.replace(/^(\d+)\s+/, "[$1] "))
          .join(" ");
        const payload = `${reference} (KJV)\n\n${plain}`;
        try {
          await navigator.clipboard.writeText(payload);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {}
      };

      const openOnline = () => {
        const url = `https://www.biblegateway.com/passage/?search=${encodeURIComponent(
          reference
        )}&version=KJV`;
        openUrl(url).catch(console.error);
      };

      const toggleView = () => setViewOpen((o) => !o);

      const toggleDefault = () => {
        const next = !defaultCollapsed;
        update({ collapsed: next });
        // Mirror the new default in the current view too, so the change
        // is visible immediately rather than only on the next reload.
        setViewOpen(!next);
      };

      // ── Empty state: reference input ────────────────────────────────────
      if (!reference && !loading) {
        return (
          <div
            className="my-3 w-full rounded-md border border-[#2a3136] bg-[#0f1315]"
            contentEditable={false}
            onMouseDown={(e) => {
              if (e.button === 2) {
                e.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCtxMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[#2a3136] bg-[#1a1e21]">
              <BookOpen size={12} className="text-blue-400 flex-shrink-0" />
              <span className="text-xs text-gray-300 font-medium">Bible Verse</span>
              <span className="ml-auto text-[10px] uppercase tracking-wider text-gray-500">
                KJV
              </span>
            </div>

            <div className="p-3">
              <input
                autoFocus
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSubmit();
                  if (e.key === "Escape") {
                    try { props.editor.removeBlocks([props.block.id]); } catch {}
                  }
                }}
                placeholder="Reference… e.g. John 3:16, Psalm 23, Rom 8:28-30"
                className="w-full bg-transparent border-none outline-none text-sm text-gray-100 placeholder-gray-600"
              />
              <div className="mt-2 text-[10px] text-gray-600">
                Enter to look up · Esc to cancel
              </div>

              {error && (
                <div className="mt-2 text-[11px] text-red-400 leading-snug">
                  {error}
                </div>
              )}
            </div>
          </div>
        );
      }

      // ── Loaded state: verse display ─────────────────────────────────────
      const Chevron = viewOpen ? ChevronDown : ChevronRight;

      return (
        <div
          className="my-3 w-full rounded-md border border-[#2a3136] bg-[#161a1d] overflow-hidden"
          contentEditable={false}
          onMouseDown={(e) => {
            if (e.button === 2) {
              e.stopPropagation();
              e.nativeEvent.stopImmediatePropagation();
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setCtxMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[#2a3136] bg-[#1a1e21]">
            <button
              type="button"
              onClick={toggleView}
              className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-black/30 text-gray-400 hover:text-gray-100 transition-colors"
              title={viewOpen ? "Collapse verse (just for now)" : "Expand verse (just for now)"}
            >
              <Chevron size={13} />
            </button>

            <BookOpen size={12} className="text-blue-400 flex-shrink-0" />
            <span className="text-xs font-medium text-gray-100 truncate flex-1">
              {reference}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-gray-500 flex-shrink-0">
              KJV
            </span>

            {isEdit && (
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
                    ? "When this note is opened, this verse starts collapsed. Click to start expanded instead."
                    : "When this note is opened, this verse starts expanded. Click to start collapsed instead."
                }
              >
                {defaultCollapsed ? "closed by default" : "open by default"}
              </button>
            )}
          </div>

          {viewOpen && (
            <div className="px-4 py-3">
              {loading ? (
                <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
                  <Loader2 size={12} className="animate-spin" />
                  <span>Loading…</span>
                </div>
              ) : error ? (
                <div className="text-xs text-red-400 leading-snug">{error}</div>
              ) : (
                <VerseText text={text} />
              )}
            </div>
          )}

          {!viewOpen && text && (
            <div className="px-3 py-1.5 border-t border-[#2a3136] bg-[#0f1315]">
              <p className="text-[11px] text-gray-500 italic truncate">
                {text.split("\n")[0].replace(/^\d+\s+/, "")}
              </p>
            </div>
          )}

          <div className="flex items-center gap-1 px-2 py-1 border-t border-[#2a3136] bg-[#1a1e21]">
            <button
              type="button"
              onClick={() => fetchVerse(reference)}
              className="p-1.5 rounded text-gray-500 hover:text-gray-200 hover:bg-[#2a3136] transition-colors"
              title="Reload verse"
              disabled={loading}
            >
              <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
            </button>
            <button
              type="button"
              onClick={copyVerse}
              className="p-1.5 rounded text-gray-500 hover:text-gray-200 hover:bg-[#2a3136] transition-colors"
              title="Copy verse"
              disabled={!text}
            >
              {copied ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
            </button>
            <button
              type="button"
              onClick={openOnline}
              className="p-1.5 rounded text-gray-500 hover:text-gray-200 hover:bg-[#2a3136] transition-colors"
              title="Open on BibleGateway"
            >
              <ExternalLink size={11} />
            </button>

            <div className="flex-1" />

            {isEdit && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    update({ reference: "", text: "" });
                    setDraft("");
                    setError(null);
                  }}
                  className="p-1.5 rounded text-gray-500 hover:text-blue-400 hover:bg-[#2a3136] transition-colors"
                  title="Edit reference"
                >
                  <BookOpen size={11} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    try { props.editor.removeBlocks([props.block.id]); } catch {}
                  }}
                  className="p-1.5 rounded text-gray-500 hover:text-red-400 hover:bg-[#2a3136] transition-colors"
                  title="Remove verse"
                >
                  <X size={11} />
                </button>
              </>
            )}
          </div>

          {ctxMenu && createPortal(
            <div
              className="fixed z-[600] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-2xl py-1 w-48"
              style={{
                top: Math.min(ctxMenu.y, window.innerHeight - 80),
                left: Math.min(ctxMenu.x, window.innerWidth - 200),
              }}
              onMouseDown={(e) => { if (e.button === 2) { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); } }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button
                type="button"
                onClick={() => {
                  try { props.editor.removeBlocks([props.block.id]); } catch {}
                  setCtxMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-[#2a3136] flex items-center gap-2"
              >
                <Trash2 size={13} /> <span>Delete verse</span>
              </button>
            </div>,
            document.body
          )}
        </div>
      );
    },
  }
);
