import { useState, useEffect, useRef, useMemo } from "react";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { Search, Loader2, X } from "lucide-react";
import { parseNoteFile } from "./noteFormat";

type SearchResult = {
    path: string;
    name: string;
    title: string;
    icon: string;
    snippet: string;
};

let searchCache: SearchResult[] | null = null;

export function getSearchCacheSize() {
    return searchCache ? searchCache.length : 0;
}

export function clearSearchCache() {
    searchCache = null;
    window.dispatchEvent(new Event("clear-cache"));
}

export default function GlobalSearch({
    open,
    onClose,
    vaultPath,
    onOpenNote,
}: {
    open: boolean;
    onClose: () => void;
    vaultPath: string;
    onOpenNote: (path: string) => void;
}) {
    const [query, setQuery] = useState("");
    const [allNotes, setAllNotes] = useState<SearchResult[] | null>(null);
    const [loading, setLoading] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const loadingRef = useRef(false);

    useEffect(() => {
        if (open) {
            setQuery("");
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    }, [open]);

    useEffect(() => {
        if (!open) return;

        // If we have the cache, instantly load it
        if (searchCache) {
            setAllNotes(searchCache);
            return;
        }

        // Prevent double-fetching if it's already loading
        if (loadingRef.current) return;

        let cancelled = false;
        loadingRef.current = true;
        setLoading(true);

        (async () => {
            const out: SearchResult[] = [];
            const walk = async (dir: string, depth = 0) => {
                if (depth > 8 || cancelled) return;
                try {
                    const entries = await readDir(dir);
                    for (const e of entries) {
                        if (!e.name || e.name.startsWith(".") || e.name === "assets" || e.name === "_attachments") continue;
                        const full = await join(dir, e.name);
                        if (e.isDirectory) {
                            await walk(full, depth + 1);
                        } else if (e.name.endsWith(".selah")) {
                            try {
                                const raw = await readTextFile(full);
                                const { frontmatter, body } = parseNoteFile(raw);
                                // Strip plugin blocks and custom syntax before basic markdown
                                const plain = body
                                .replace(/<!--[\s\S]*?-->/g, " ") // Remove plugin JSON comments
                                .replace(/:::\s*\w+(?:="[^"]*")?(?:\s+\w+(?:="[^"]*")?)*/g, " ") // Remove ::: block headers
                                .replace(/:::/g, " ")
                                .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // Remove images
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // Keep link text, remove URLs
    .replace(/[#*_>`~\-|\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
                                out.push({
                                    path: full,
                                    name: e.name,
                                    title: (frontmatter.title as string) || e.name.replace(/\.selah$/, ""),
                                         icon: (frontmatter.icon as string) || "📄",
                                         snippet: plain.slice(0, 150),
                                });
                            } catch {}
                        }
                    }
                } catch {}
            };

            await walk(vaultPath);

            if (!cancelled) {
                searchCache = out;
                setAllNotes(out);
                setLoading(false);
            }
            loadingRef.current = false;
        })();

        return () => { cancelled = true; };
    }, [open, vaultPath]);

    // Listen for the global clear cache event from Settings
    useEffect(() => {
        const handleClear = () => {
            setAllNotes(null);
        };
        window.addEventListener("clear-cache", handleClear);
        return () => window.removeEventListener("clear-cache", handleClear);
    }, []);

    const results = useMemo(() => {
        if (!allNotes) return [];
        const q = query.trim().toLowerCase();
        if (!q) return allNotes.slice(0, 50);

        return allNotes.filter(n =>
        n.title.toLowerCase().includes(q) ||
        n.snippet.toLowerCase().includes(q) ||
        n.name.toLowerCase().includes(q)
        ).slice(0, 50);
    }, [allNotes, query]);

    useEffect(() => {
        if (!open) return;
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
            document.addEventListener("keydown", handleKey);
            return () => document.removeEventListener("keydown", handleKey);
    }, [open, onClose]);

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-[1000] bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[15vh]" onClick={onClose}>
        <div
        className="bg-[#1e2327] border border-[#2a3136] rounded-xl shadow-2xl w-[600px] max-w-[90vw] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
        >
        <div className="flex items-center px-4 py-3 border-b border-[#2a3136] bg-[#1a1e21]">
        <Search size={16} className="text-gray-500 mr-3 flex-shrink-0" />
        <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search all notes..."
        className="flex-1 bg-transparent border-none outline-none text-sm text-gray-100 placeholder-gray-500"
        />
        {loading && <Loader2 size={14} className="animate-spin text-blue-400 ml-3" />}
        <button onClick={onClose} className="ml-3 text-gray-500 hover:text-gray-300 p-1">
        <X size={16} />
        </button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto">
        {!loading && results.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-gray-500 italic">
            No results found for "{query}"
            </div>
        )}
        {results.map(n => (
            <button
            key={n.path}
            onClick={() => { onOpenNote(n.path); onClose(); }}
            className="w-full text-left px-4 py-2.5 hover:bg-[#2a3136] border-b border-[#2a3136]/50 flex items-start gap-3 transition-colors"
            >
            <span className="text-lg flex-shrink-0 mt-0.5">{n.icon}</span>
            <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-100 truncate">{n.title}</div>
            {n.snippet && (
                <div className="text-[11px] text-gray-500 mt-0.5 line-clamp-1">{n.snippet}</div>
            )}
            </div>
            </button>
        ))}
        </div>
        </div>
        </div>
    );
}
