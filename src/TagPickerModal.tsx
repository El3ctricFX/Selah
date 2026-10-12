// src/TagPickerModal.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Tag as TagIcon, X, Plus, Check } from "lucide-react";
import { normalizeTag } from "./TagEditor";

/**
 * A modal tag editor that shows every tag in the vault as a toggleable
 * chip, plus a text input for creating new ones. Local state drives the
 * UI so clicks feel instant; the actual disk write happens via `onCommit`
 * in the background.
 */
export default function TagPickerModal({
  noteTitle,
  initialTags,
  allTags,
  onCommit,
  onClose,
}: {
  noteTitle: string;
  initialTags: string[];
  allTags: string[];
  onCommit: (next: string[]) => void;
  onClose: () => void;
}) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [draft, setDraft] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const onNote = useMemo(() => new Set(tags), [tags]);

  const suggestions = useMemo(() => {
    const q = draft.trim().toLowerCase();
    const pool = allTags.filter((t) => !onNote.has(t));
    if (!q) return pool.slice(0, 8);
    return pool.filter((t) => t.includes(q)).slice(0, 8);
  }, [draft, allTags, onNote]);

  const commit = (next: string[]) => {
    setTags(next);
    onCommit(next);
  };

  const addTag = (raw: string) => {
    const tag = normalizeTag(raw);
    if (!tag) return;
    if (tags.includes(tag)) {
      setDraft("");
      return;
    }
    commit([...tags, tag].sort());
    setDraft("");
    setHighlight(0);
  };

  const removeTag = (tag: string) => {
    commit(tags.filter((t) => t !== tag));
  };

  const toggleTag = (tag: string) => {
    if (onNote.has(tag)) removeTag(tag);
    else addTag(tag);
  };

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[500] bg-black/70 flex items-start justify-center pt-24"
      onClick={onClose}
    >
      <div
        className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[520px] max-w-[92vw] max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
          <TagIcon size={14} className="text-blue-400 flex-shrink-0" />
          <span className="text-sm font-medium text-gray-100 truncate min-w-0">
            Tags for{" "}
            <span className="text-gray-300">"{noteTitle}"</span>
          </span>
          <button
            onClick={onClose}
            className="ml-auto text-gray-500 hover:text-gray-300 p-0.5 flex-shrink-0"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* ── On this note ─────────────────────────────────────────── */}
          <div className="px-4 pt-4 pb-3">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
              On this note
            </div>

            {tags.length === 0 ? (
              <p className="text-xs text-gray-500 italic mb-2">
                No tags yet. Pick one below or type a new one.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-blue-600/20 border border-blue-500/40 text-blue-200"
                  >
                    <span>{tag}</span>
                    <button
                      type="button"
                      onClick={() => removeTag(tag)}
                      className="text-blue-300/70 hover:text-blue-100 -mr-0.5"
                      title="Remove tag"
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="relative">
              <div className="flex items-center gap-2 bg-[#0f1315] border border-[#30363d] rounded px-3 py-2 focus-within:ring-1 focus-within:ring-blue-500">
                <Plus size={12} className="text-gray-500 flex-shrink-0" />
                <input
                  ref={inputRef}
                  type="text"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setHighlight(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (draft.trim()) addTag(draft);
                      else if (suggestions[highlight]) addTag(suggestions[highlight]);
                    } else if (e.key === "Tab" && suggestions.length > 0) {
                      e.preventDefault();
                      setDraft(suggestions[highlight]);
                    } else if (e.key === "ArrowDown" && suggestions.length > 0) {
                      e.preventDefault();
                      setHighlight((h) => (h + 1) % suggestions.length);
                    } else if (e.key === "ArrowUp" && suggestions.length > 0) {
                      e.preventDefault();
                      setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
                    } else if (e.key === "Backspace" && !draft && tags.length > 0) {
                      e.preventDefault();
                      removeTag(tags[tags.length - 1]);
                    }
                  }}
                  placeholder="Type to create or search…"
                  className="flex-1 bg-transparent border-none outline-none text-xs text-gray-100 placeholder-gray-600"
                />
              </div>

              {suggestions.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 z-10 bg-[#1e2327] border border-[#2a3136] rounded-md shadow-xl py-1 max-h-48 overflow-y-auto">
                  {suggestions.map((s, i) => (
                    <button
                      key={s}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        addTag(s);
                      }}
                      onMouseEnter={() => setHighlight(i)}
                      className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${
                        i === highlight
                          ? "bg-[#2a3136] text-gray-100"
                          : "text-gray-300"
                      }`}
                    >
                      <TagIcon size={10} className="text-gray-500 flex-shrink-0" />
                      <span className="truncate">{s}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── All vault tags ───────────────────────────────────────── */}
          {allTags.length > 0 && (
            <div className="px-4 pt-4 pb-4 border-t border-[#2a3136]">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
                All tags in this vault
              </div>
              <div className="flex flex-wrap gap-1.5">
                {allTags.map((tag) => {
                  const active = onNote.has(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleTag(tag)}
                      className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full transition-colors ${
                        active
                          ? "bg-blue-600 text-white border border-blue-500"
                          : "bg-[#0f1315] text-gray-300 border border-[#2a3136] hover:border-[#3a4147] hover:text-gray-100"
                      }`}
                    >
                      {active && <Check size={11} />}
                      <span>{tag}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
          <span className="text-[10px] text-gray-500">
            {tags.length} tag{tags.length === 1 ? "" : "s"} on this note
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}