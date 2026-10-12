// src/TagEditor.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { Plus, Tag as TagIcon, X } from "lucide-react";
import { parseNoteFile } from "./noteFormat";

export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Vault-wide tag scan with a small TTL cache ─────────────────────────────
// Walking every note on every keystroke would be insane; caching the result
// for a few seconds makes autocomplete feel instant while still picking up
// newly-added tags reasonably quickly.
let tagCache: { vaultPath: string; tags: string[]; ts: number } | null = null;
const TAG_CACHE_TTL_MS = 5_000;

export function invalidateTagCache(): void {
  tagCache = null;
}

async function walkNotesForTags(
  dir: string,
  out: Set<string>,
  depth: number
): Promise<void> {
  if (depth > 8) return;
  try {
    const entries = await readDir(dir);
    for (const e of entries) {
      if (!e.name) continue;
      if (e.name.startsWith(".")) continue;
      if (e.name === "assets" || e.name === "_attachments") continue;
      const full = await join(dir, e.name);
      if (e.isDirectory) {
        await walkNotesForTags(full, out, depth + 1);
      } else if (e.name.endsWith(".selah")) {
        try {
          const raw = await readTextFile(full);
          const { frontmatter } = parseNoteFile(raw);
          if (Array.isArray(frontmatter.tags)) {
            for (const t of frontmatter.tags) {
              if (typeof t === "string" && t) out.add(t);
            }
          }
        } catch {}
      }
    }
  } catch {}
}

export async function scanAllVaultTags(
  vaultPath: string,
  force = false
): Promise<string[]> {
  if (!vaultPath) return [];
  if (
    !force &&
    tagCache &&
    tagCache.vaultPath === vaultPath &&
    Date.now() - tagCache.ts < TAG_CACHE_TTL_MS
  ) {
    return tagCache.tags;
  }
  const set = new Set<string>();
  await walkNotesForTags(vaultPath, set, 0);
  const list = Array.from(set).sort((a, b) => a.localeCompare(b));
  tagCache = { vaultPath, tags: list, ts: Date.now() };
  return list;
}

// ── The editor ─────────────────────────────────────────────────────────────
export default function TagEditor({
  tags,
  allTags,
  onChange,
  readOnly,
}: {
  tags: string[];
  allTags: string[];
  onChange: (next: string[]) => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Suggestions: existing vault tags, minus ones already on this note,
  // filtered by whatever's been typed. Capped at 8 so the dropdown stays
  // compact.
  const suggestions = useMemo(() => {
    const onNote = new Set(tags);
    const q = draft.trim().toLowerCase();
    const pool = allTags.filter((t) => !onNote.has(t));
    if (!q) return pool.slice(0, 8);
    return pool.filter((t) => t.includes(q)).slice(0, 8);
  }, [draft, allTags, tags]);

  const addTag = (raw: string) => {
    const tag = normalizeTag(raw);
    if (!tag) return;
    if (tags.includes(tag)) {
      setDraft("");
      return;
    }
    onChange([...tags, tag].sort());
    setDraft("");
    setHighlight(0);
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  useEffect(() => {
    if (!editing) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [editing]);

  // Commit whatever's been typed when clicking away, then close.
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      if (draft.trim()) addTag(draft);
      setEditing(false);
      setDraft("");
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, draft, tags]);

  if (readOnly && tags.length === 0) return null;

  return (
    <div
      ref={wrapRef}
      className="flex items-center justify-center gap-1.5 flex-wrap"
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-[#1e2327] border border-[#2a3136] text-gray-300 hover:border-[#3a4147] transition-colors"
        >
          <TagIcon size={9} className="text-gray-500 flex-shrink-0" />
          <span className="truncate max-w-[140px]" title={tag}>{tag}</span>
          {!readOnly && (
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="text-gray-500 hover:text-red-400 -mr-0.5 flex-shrink-0"
              title="Remove tag"
            >
              <X size={10} />
            </button>
          )}
        </span>
      ))}

      {!readOnly && !editing && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-dashed border-[#30363d] text-gray-500 hover:text-gray-200 hover:border-[#3a4147] transition-colors"
          title="Add tag"
        >
          <Plus size={10} />
          <span>Tag</span>
        </button>
      )}

      {!readOnly && editing && (
        <div className="relative">
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
                // Prefer what the user typed. Fall back to the highlighted
                // suggestion if the draft is empty — that's the "open the
                // box and pick an existing tag" case.
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
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
                setDraft("");
              } else if (e.key === "Backspace" && !draft && tags.length > 0) {
                e.preventDefault();
                removeTag(tags[tags.length - 1]);
              }
            }}
            placeholder="tag name…"
            className="bg-[#0f1315] border border-[#30363d] rounded-full px-2 py-0.5 text-[11px] text-gray-200 outline-none focus:ring-1 focus:ring-blue-500 w-32"
          />

          {suggestions.length > 0 && (
            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 z-50 bg-[#1e2327] border border-[#2a3136] rounded-md shadow-xl py-1 w-48 max-h-60 overflow-y-auto">
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
      )}
    </div>
  );
}