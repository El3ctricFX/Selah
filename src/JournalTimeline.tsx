// src/JournalTimeline.tsx
import { useEffect, useMemo, useState } from "react";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { parseNoteFile } from "./noteFormat";

interface TimelineEntry {
  path: string;
  fileName: string;
  year: number;
  month: number;
  day: number;
  title: string;
  icon: string;
  image: string | null;
  snippet: string;
  wordCount: number;
}

interface Props {
  journalDir: string;
  onOpenDay: (year: number, month: number, day: number) => void;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAY_RE = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\.(selah|md)$/;

const timelineCache = new Map<string, TimelineEntry[]>();

function invalidateTimelineCache(journalDir?: string) {
  if (journalDir) timelineCache.delete(journalDir);
  else timelineCache.clear();
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function resolveImage(raw: string, noteDir: string): string {
  if (!raw) return "";
  if (/^(https?:|data:|blob:|asset:)/i.test(raw)) return raw;

  let url = raw.replace(/^<|>$/g, "");
  url = safeDecode(url);

  if (/^([a-zA-Z]:[\\/]|\/)/.test(url)) {
    try {
      return convertFileSrc(url);
    } catch {
      return url;
    }
  }
  const sep = noteDir.includes("\\") ? "\\" : "/";
  const joined = noteDir.replace(/[\\/]+$/, "") + sep + url;
  try {
    return convertFileSrc(joined);
  } catch {
    return joined;
  }
}

function extractFirstImage(body: string, noteDir: string): string | null {
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  const m = re.exec(body);
  if (!m) return null;
  return resolveImage(m[1], noteDir);
}

/**
 * Reduce a note body to plain prose for the timeline snippet.
 *
 * The `:::` block syntax is a multi-line container format. Its opening lines
 * carry attributes and its bodies contain the real content. Instead of
 * enumerating every block type, we:
 *
 *   1. Extract the human-readable bit from the two self-contained blocks
 *      that carry one (video caption, bookmark title).
 *   2. Nuke every remaining `:::` line and its attributes in a single pass,
 *      regardless of what keyword follows.
 *   3. Strip standard markdown.
 *   4. Collapse whitespace.
 *
 * The net effect: a note made of two image columns reads as the surrounding
 * text, not as `::: columns ::: column width="1.34…" :::`.
 */
function stripMarkdown(md: string): string {
  let s = md;

  // ── 1. Keep useful text from self-contained blocks ──────────────────────
  // Video: keep the caption if the attribute exists on the same line.
  s = s.replace(
    /:::\s*video\b[^\n]*?\bcaption="([^"]*)"[^\n]*/g,
    (_m, cap: string) => (cap ? ` ${cap} ` : " ")
  );
  // Bookmark: keep the title if the attribute exists on the same line.
  s = s.replace(
    /:::\s*bookmark\b[^\n]*?\btitle="([^"]*)"[^\n]*/g,
    (_m, title: string) => (title ? ` ${title} ` : " ")
  );

  // ── 2. Remove every remaining `:::` fence line ──────────────────────────
  // This handles all of:
  //   ::: columns
  //   ::: column width="1.34…"
  //   ::: callout icon="💡" color="gray"
  //   ::: bookmark mode="bookmark" url="…"
  //   ::: video src="…" caption="" fileName="…"
  //   :::                       (bare closer)
  // The `\w+` matches the keyword, then `(?:="[^"]*")?` matches an optional
  // unkeyed attribute, then `(?:\s+\w+(?:="[^"]*")?)*` matches any run of
  // key="value" pairs. Only the fence and its attributes get removed; the
  // content on subsequent lines is left untouched.
  s = s.replace(/:::\s*\w+(?:="[^"]*")?(?:\s+\w+(?:="[^"]*")?)*/g, "");

  // ── 3. Anything still matching bare `:::` (weird edge cases) ────────────
  s = s.replace(/:::/g, "");

  // ── 4. Standard markdown ────────────────────────────────────────────────
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\n{2,}/g, " \n ")
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

async function parseEntry(
  path: string,
  fileName: string,
  year: number,
  month: number,
  day: number
): Promise<TimelineEntry | null> {
  try {
    const raw = await readTextFile(path);
    const { frontmatter, body } = parseNoteFile(raw);
    const noteDir = path.substring(
      0,
      Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
    );

    let image: string | null = null;
    if (frontmatter.coverType === "image" && frontmatter.coverValue) {
      image = resolveImage(String(frontmatter.coverValue), noteDir);
    } else {
      image = extractFirstImage(body, noteDir);
    }

    const plain = stripMarkdown(body);
    const snippet = plain.slice(0, 420);
    const wordCount = countWords(plain);

    return {
      path,
      fileName,
      year,
      month,
      day,
      title: (frontmatter.title as string) || "",
      icon: (frontmatter.icon as string) || "",
      image,
      snippet,
      wordCount,
    };
  } catch {
    return null;
  }
}

async function loadAllEntries(journalDir: string): Promise<TimelineEntry[]> {
  const cached = timelineCache.get(journalDir);
  if (cached) return cached;

  const out: TimelineEntry[] = [];

  let yearDirs: string[] = [];
  try {
    const entries = await readDir(journalDir);
    yearDirs = entries
      .filter((e) => e.isDirectory && /^\d{4}$/.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }

  for (const yearStr of yearDirs) {
    const yearDirPath = await join(journalDir, yearStr);
    let monthDirs: string[] = [];
    try {
      const entries = await readDir(yearDirPath);
      monthDirs = entries.filter((e) => e.isDirectory).map((e) => e.name);
    } catch {
      continue;
    }

    for (const monthStr of monthDirs) {
      const monthDirPath = await join(yearDirPath, monthStr);
      let files: string[] = [];
      try {
        const entries = await readDir(monthDirPath);
        files = entries
          .filter((e) => !e.isDirectory && e.name && /\.(selah|md)$/i.test(e.name))
          .map((e) => e.name);
      } catch {
        continue;
      }

      const promises = files.map(async (fileName) => {
        const m = fileName.match(DAY_RE);
        if (!m) return null;
        const monthNameLower = m[1].toLowerCase();
        const idx = MONTH_NAMES.findIndex(
          (x) => x.toLowerCase() === monthNameLower
        );
        if (idx === -1) return null;
        const day = Number(m[2]);
        const parsedYear = Number(m[3]);
        const path = await join(monthDirPath, fileName);
        return parseEntry(path, fileName, parsedYear, idx + 1, day);
      });

      const parsed = await Promise.all(promises);
      for (const e of parsed) if (e) out.push(e);
    }
  }

  out.sort((a, b) => {
    if (a.year !== b.year) return b.year - a.year;
    if (a.month !== b.month) return b.month - a.month;
    return b.day - a.day;
  });

  timelineCache.set(journalDir, out);
  return out;
}

export default function JournalTimeline({ journalDir, onOpenDay }: Props) {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(() => {
    return timelineCache.get(journalDir) ?? null;
  });
  const [activeYear, setActiveYear] = useState<number | null>(null);

  useEffect(() => {
    let mounted = true;
    // Always re-parse on mount. The parser is pure and files are on disk;
    // the cost is a handful of small reads. The payoff is that a stale
    // cache (from an HMR reload during development, or a note edited while
    // this view was unmounted) can never leave us showing old snippets.
    invalidateTimelineCache(journalDir);
    (async () => {
      const result = await loadAllEntries(journalDir);
      if (mounted) setEntries(result);
    })();
    return () => {
      mounted = false;
    };
  }, [journalDir]);

  useEffect(() => {
    const onFolderChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail as { path?: string } | undefined;
      const changed = detail?.path;
      if (!changed) {
        invalidateTimelineCache();
        loadAllEntries(journalDir).then(setEntries);
        return;
      }
      if (
        changed === journalDir ||
        changed.startsWith(journalDir + "/") ||
        changed.startsWith(journalDir + "\\")
      ) {
        invalidateTimelineCache(journalDir);
        loadAllEntries(journalDir).then(setEntries);
      }
    };
    const onFileChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail as { path?: string } | undefined;
      const changed = detail?.path;
      if (!changed) return;
      if (
        changed.startsWith(journalDir + "/") ||
        changed.startsWith(journalDir + "\\")
      ) {
        invalidateTimelineCache(journalDir);
        loadAllEntries(journalDir).then(setEntries);
      }
    };
    window.addEventListener("folder-changed", onFolderChanged);
    window.addEventListener("file-changed", onFileChanged);
    return () => {
      window.removeEventListener("folder-changed", onFolderChanged);
      window.removeEventListener("file-changed", onFileChanged);
    };
  }, [journalDir]);

  const years = useMemo(() => {
    if (!entries) return [];
    return Array.from(new Set(entries.map((e) => e.year))).sort(
      (a, b) => b - a
    );
  }, [entries]);

  const grouped = useMemo(() => {
    if (!entries) return [];
    const filtered =
      activeYear == null ? entries : entries.filter((e) => e.year === activeYear);
    const map = new Map<string, TimelineEntry[]>();
    for (const e of filtered) {
      const key = `${e.year}-${String(e.month).padStart(2, "0")}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, list]) => {
        const [y, m] = key.split("-").map(Number);
        return { year: y, month: m, entries: list };
      });
  }, [entries, activeYear]);

  if (entries === null) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        Loading entries…
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-gray-500 text-sm">
        <p>No journal entries yet.</p>
        <p className="text-xs text-gray-600 mt-2">
          Write your first one from the day view.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-[#0f1315]">
      <div className="max-w-6xl mx-auto px-8 py-8">
        <div className="flex items-center gap-2 mb-8 flex-wrap">
          <button
            onClick={() => setActiveYear(null)}
            className={`px-3 py-1 rounded-full text-xs transition-colors cursor-pointer ${
              activeYear === null
                ? "bg-blue-600 text-white"
                : "bg-[#1e2327] text-gray-400 hover:text-gray-100 border border-[#2a3136]"
            }`}
          >
            All
          </button>
          {years.map((y) => (
            <button
              key={y}
              onClick={() => setActiveYear(y)}
              className={`px-3 py-1 rounded-full text-xs transition-colors cursor-pointer ${
                activeYear === y
                  ? "bg-blue-600 text-white"
                  : "bg-[#1e2327] text-gray-400 hover:text-gray-100 border border-[#2a3136]"
              }`}
            >
              {y}
            </button>
          ))}
          <div className="ml-auto text-[11px] text-gray-600">
            {activeYear == null
              ? `${entries.length} entries`
              : `${
                  entries.filter((e) => e.year === activeYear).length
                } entries in ${activeYear}`}
          </div>
        </div>

        {grouped.map((group) => (
          <div key={`${group.year}-${group.month}`} className="mb-10">
            <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-3 flex items-center gap-3">
              <span>
                {MONTH_NAMES[group.month - 1]} {group.year}
              </span>
              <span className="flex-1 h-px bg-[#1e2327]" />
              <span className="text-gray-600 normal-case tracking-normal">
                {group.entries.length}{" "}
                {group.entries.length === 1 ? "entry" : "entries"}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {group.entries.map((entry) => (
                <JournalCard
                  key={entry.path}
                  entry={entry}
                  onClick={() => onOpenDay(entry.year, entry.month, entry.day)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function JournalCard({
  entry,
  onClick,
}: {
  entry: TimelineEntry;
  onClick: () => void;
}) {
  const weekday = new Date(entry.year, entry.month - 1, entry.day).toLocaleString(
    "en-US",
    { weekday: "long" }
  );

  return (
    <button
      onClick={onClick}
      className="group text-left rounded-lg overflow-hidden bg-[#161a1d] border border-[#2a3136] hover:border-[#3a4147] transition-colors flex flex-col cursor-pointer"
    >
      {entry.image ? (
        <div className="w-full h-44 bg-[#0f1315] overflow-hidden">
          <img
            src={entry.image}
            alt=""
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        </div>
      ) : (
        <div className="w-full h-44 bg-gradient-to-br from-[#1a1e21] to-[#0f1315] flex items-center justify-center">
          <div className="text-6xl text-gray-700 font-light select-none tabular-nums">
            {entry.day}
          </div>
        </div>
      )}
      <div className="p-4 flex-1 flex flex-col">
        <div className="flex items-baseline justify-between mb-1.5">
          <div className="text-sm font-semibold text-gray-100 truncate">
            {entry.icon && <span className="mr-1">{entry.icon}</span>}
            {MONTH_NAMES[entry.month - 1]} {entry.day}
          </div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider flex-shrink-0 ml-2">
            {weekday}
          </div>
        </div>
        {entry.title && (
          <div className="text-xs text-gray-300 mb-2 truncate">
            {entry.title}
          </div>
        )}
        {entry.snippet ? (
          <div className="text-xs text-gray-400 leading-relaxed line-clamp-5 flex-1">
            {entry.snippet}
          </div>
        ) : (
          <div className="text-xs text-gray-600 italic flex-1">
            Empty entry
          </div>
        )}
        <div className="text-[10px] text-gray-600 mt-3">
          {entry.wordCount} {entry.wordCount === 1 ? "word" : "words"}
        </div>
      </div>
    </button>
  );
}