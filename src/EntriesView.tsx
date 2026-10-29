// src/EntriesView.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Search, Trash2, X, Calendar, Tag as TagIcon, FileText, Pencil, Smile } from "lucide-react";
import DateTimePickerModal from "./DateTimePickerModal";
import EmojiPicker, { Theme, EmojiStyle } from "emoji-picker-react";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useModal } from "./Modal";
import { moveToTrash } from "./trash";
import TagPickerModal from "./TagPickerModal";
import { parseNoteFile, serializeNoteFile } from "./noteFormat";
import { invalidateTagCache } from "./TagEditor";
import {
    listEntries, createEntry, formatEntryDate, monthLabel, type EntryItem,
} from "./entries";

interface Props {
    sectionDir: string;
    sectionName: string;
    sectionIcon: string;
    onOpenNote: (note: { path: string; name: string }) => void;
}

export default function EntriesView({ sectionDir, sectionName, sectionIcon, onOpenNote }: Props) {
    const [items, setItems] = useState<EntryItem[] | null>(null);
    const [query, setQuery] = useState("");
    const [ctx, setCtx] = useState<{ item: EntryItem; x: number; y: number } | null>(null);
    const [tagPickerItem, setTagPickerItem] = useState<EntryItem | null>(null);
    const [allTags, setAllTags] = useState<string[]>([]);
    const [iconPicker, setIconPicker] = useState<{ item: EntryItem; top: number; left: number } | null>(null);
    const [dateTimePickerItem, setDateTimePickerItem] = useState<EntryItem | null>(null);
    const iconPickerRef = useRef<HTMLDivElement>(null);
    const { modal, promptAsync, confirmAsync } = useModal();

    const load = async () => {
        const loaded = await listEntries(sectionDir);
        setItems(loaded);
        const t = new Set<string>();
        loaded.forEach(it => (it.tags || []).forEach(tag => t.add(tag)));
        setAllTags(Array.from(t).sort());
    };

    useEffect(() => {
        load();
        const fn = () => load();
        const events = ["file-changed", "folder-changed", "note-frontmatter-changed", "note-deleted"];
        events.forEach((e) => window.addEventListener(e, fn));
        return () => events.forEach((e) => window.removeEventListener(e, fn));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sectionDir]);

    // Close the right-click menu on outside click or Escape.
    useEffect(() => {
        if (!ctx) return;
        const close = () => setCtx(null);
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCtx(null); };
        document.addEventListener("click", close);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("click", close);
            document.removeEventListener("keydown", onKey);
        };
    }, [ctx]);

    // Close the Emoji Picker on outside click or Escape.
    useEffect(() => {
        if (!iconPicker) return;
        const onDown = (e: MouseEvent) => {
            if (iconPickerRef.current?.contains(e.target as Node)) return;
            setIconPicker(null);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setIconPicker(null);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [iconPicker]);

    const newEntry = async () => {
        const { path, fileName } = await createEntry(sectionDir);
        await load();
        onOpenNote({ path, name: fileName });
    };

    const removeEntry = async (it: EntryItem) => {
        const ok = await confirmAsync(`Move "${it.title || "this entry"}" to the trash?`);
        if (!ok) return;

        try {
            // 1. Physically move the file to trash FIRST
            await moveToTrash(it.path);
        } catch (e: any) {
            console.error("[entries] moveToTrash failed:", e);
            await confirmAsync(`Could not delete the file. It might be locked by another app.\n\nError: ${e?.message ?? String(e)}`);
            return; // Stop here if the deletion failed
        }

        // 2. Tell the app to switch views
        window.dispatchEvent(new CustomEvent("note-deleted", { detail: { path: it.path } }));

        // 3. Force the sidebar to refresh its tree
        const folder = it.path.substring(0, Math.max(it.path.lastIndexOf("/"), it.path.lastIndexOf("\\")));
        window.dispatchEvent(new CustomEvent("folder-changed", { detail: { path: folder } }));

        // 4. Reload the main view
        await load();
    };

    const renameEntry = async (it: EntryItem) => {
        setCtx(null);
        const next = await promptAsync("Rename entry:", it.title || "Untitled entry");
        if (!next || next === it.title) return;
        try {
            const raw = await readTextFile(it.path);
            const { frontmatter, body } = parseNoteFile(raw);
            const fm: any = { ...frontmatter, title: next.trim() };
            if (frontmatter.freezeModified !== true) {
                fm.modified = new Date().toISOString();
            }
            await writeTextFile(it.path, serializeNoteFile(fm, body));
            window.dispatchEvent(new CustomEvent("file-changed", { detail: { path: it.path } }));
            window.dispatchEvent(new CustomEvent("note-frontmatter-changed", { detail: { path: it.path } }));
            await load();
        } catch (e) { console.error("[entries] rename failed:", e); }
    };

    // Parses a loose date string into a YYYY-MM-DD value. Accepts
    // ISO, US slash format, "October 4, 2026", "Oct 4", "today" etc.
    function parseFlexibleDateInput(raw: string): string | null {
        const s = raw.trim().toLowerCase();
        if (!s) return null;
        const today = new Date();
        const ymd = (d: Date) =>
            `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

        if (s === "today" || s === "now") return ymd(today);
        if (s === "yesterday") { const d = new Date(today); d.setDate(d.getDate() - 1); return ymd(d); }
        if (s === "tomorrow")  { const d = new Date(today); d.setDate(d.getDate() + 1); return ymd(d); }

        let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
        if (m) {
            const y = +m[1], mo = +m[2], dd = +m[3];
            if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31)
                return `${y}-${String(mo).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
        }
        m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
        if (m) {
            let y = +m[3]; if (y < 100) y += 2000;
            const mo = +m[1], dd = +m[2];
            if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31)
                return `${y}-${String(mo).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
        }
        const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
        m = s.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,\s]+(\d{2,4})$/);
        if (m) {
            const idx = MONTHS.findIndex((x) => x.startsWith(m![1]));
            if (idx >= 0) {
                let y = +m[3]; if (y < 100) y += 2000;
                const dd = +m[2];
                if (dd >= 1 && dd <= 31)
                    return `${y}-${String(idx + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
            }
        }
        return null;
    }

    const changeDate = (it: EntryItem) => {
        setCtx(null);
        setDateTimePickerItem(it);
    };



    const applyIcon = async (emoji: string) => {
        if (!iconPicker) return;
        try {
            const raw = await readTextFile(iconPicker.item.path);
            const { frontmatter, body } = parseNoteFile(raw);
            const merged: any = { ...frontmatter };
            if (emoji) merged.icon = emoji;
            else delete merged.icon;
            await writeTextFile(iconPicker.item.path, serializeNoteFile(merged, body));
            window.dispatchEvent(new CustomEvent("file-changed", { detail: { path: iconPicker.item.path } }));
            window.dispatchEvent(new CustomEvent("note-frontmatter-changed", { detail: { path: iconPicker.item.path } }));
            await load();
        } catch (e) { console.error("[entries] icon failed:", e); }
        if (emoji === '') setIconPicker(null);
    };

    const commitTags = async (next: string[]) => {
        if (!tagPickerItem) return;
        try {
            const raw = await readTextFile(tagPickerItem.path);
            const { frontmatter, body } = parseNoteFile(raw);
            const merged: any = { ...frontmatter };
            if (next.length > 0) merged.tags = next;
            else delete merged.tags;
            await writeTextFile(tagPickerItem.path, serializeNoteFile(merged, body));
            window.dispatchEvent(new CustomEvent("file-changed", { detail: { path: tagPickerItem.path } }));
            window.dispatchEvent(new CustomEvent("note-frontmatter-changed", { detail: { path: tagPickerItem.path } }));
            invalidateTagCache();
            await load();
        } catch (e) {
            console.error("[entries] save tags failed:", e);
        }
    };

    const handleContextMenu = (e: React.MouseEvent, it: EntryItem) => {
        e.preventDefault();
        e.stopPropagation();
        const W = 240;
        const H = 260;
        setCtx({
            item: it,
            x: Math.min(e.clientX, window.innerWidth - W - 8),
               y: Math.min(e.clientY, window.innerHeight - H - 8),
        });
    };

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!items) return [];
        if (!q) return items;
        return items.filter((i) =>
        [i.title, i.preview, formatEntryDate(i.date), ...(i.tags || [])]
        .join(" ").toLowerCase().includes(q)
        );
    }, [items, query]);

    const groups = useMemo(() => {
        const out: { label: string; items: EntryItem[] }[] = [];
        for (const it of filtered) {
            const label = monthLabel(it.date);
            const last = out[out.length - 1];
            if (last && last.label === label) last.items.push(it);
            else out.push({ label, items: [it] });
        }
        return out;
    }, [filtered]);

    return (
        <div
        className="w-full h-full overflow-y-auto bg-[#0f1315]"
        onContextMenu={(e) => {
            // Suppress the native browser menu in the empty space
            if (e.target === e.currentTarget) e.preventDefault();
        }}
        >
        {modal}

        {dateTimePickerItem && (
          <DateTimePickerModal
            initialIso={dateTimePickerItem.created ? new Date(dateTimePickerItem.created).toISOString() : new Date().toISOString()}
            title={dateTimePickerItem.title || "this entry"}
            onClose={() => setDateTimePickerItem(null)}
            onSave={async (iso) => {
              try {
                const raw = await readTextFile(dateTimePickerItem.path);
                const { frontmatter, body } = parseNoteFile(raw);
                const fm: any = {
                  ...frontmatter,
                  date: iso.slice(0, 10),
                  created: iso,
                };
                if (frontmatter.freezeModified !== true) {
                  fm.modified = new Date().toISOString();
                }
                await writeTextFile(dateTimePickerItem.path, serializeNoteFile(fm, body));
                window.dispatchEvent(new CustomEvent("file-changed", { detail: { path: dateTimePickerItem.path } }));
                window.dispatchEvent(new CustomEvent("note-frontmatter-changed", { detail: { path: dateTimePickerItem.path } }));
                await load();
              } catch (e) { console.error("[entries] change date failed:", e); }
            }}
          />
        )}

        {ctx && (
            <div
            data-menu
            className="fixed z-[400] bg-[#1e2327] border border-[#2a3136] rounded shadow-xl py-1 w-60"
            style={{ top: ctx.y, left: ctx.x }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
            >
            <button
            type="button"
            onClick={() => { const n = ctx.item; setCtx(null); onOpenNote({ path: n.path, name: n.fileName }); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]"
            >
            <FileText size={13} /> <span>Open</span>
            </button>
            <button
            type="button"
            onClick={() => { void renameEntry(ctx.item); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2"
            >
            <Pencil size={13} /> <span>Rename</span>
            </button>
            <button
            type="button"
            onClick={() => {
                const W = 340;
                const H = 460;
                setIconPicker({
                    item: ctx.item,
                    top: Math.max(12, Math.min(ctx.y, window.innerHeight - H - 12)),
                    left: Math.max(12, Math.min(ctx.x, window.innerWidth - W - 12)),
                });
                setCtx(null);
            }}
            className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2"
            >
            <Smile size={13} /> <span>Change icon</span>
            </button>
            <button
            type="button"
            onClick={() => { setTagPickerItem(ctx.item); setCtx(null); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]"
            >
            <TagIcon size={13} /> <span>Edit tags…</span>
            </button>
            <button
            type="button"
            onClick={() => { void changeDate(ctx.item); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2"
            >
            <Calendar size={13} /> <span>Change date…</span>
            </button>

            <button
            type="button"
            onClick={() => { const it = ctx.item; setCtx(null); void removeEntry(it); }}
            className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-[#2a3136] flex items-center space-x-2"
            >
            <Trash2 size={13} /> <span>Move to trash</span>
            </button>
            </div>
        )}

        {tagPickerItem && (
            <TagPickerModal
            noteTitle={tagPickerItem.title || "this entry"}
            initialTags={tagPickerItem.tags || []}
            allTags={allTags}
            onCommit={commitTags}
            onClose={() => setTagPickerItem(null)}
            />
        )}

        {iconPicker && createPortal(
            <div
                ref={iconPickerRef}
                className="fixed z-[500] bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl overflow-hidden"
                style={{ top: iconPicker.top, left: iconPicker.left }}
            >
                <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a3136]">
                    <span className="text-xs text-gray-400 truncate">
                        Icon for <span className="text-gray-200">{iconPicker.item.title || "this entry"}</span>
                    </span>
                    <button
                        onClick={() => setIconPicker(null)}
                        className="text-gray-500 hover:text-gray-300 p-0.5"
                    >
                        <X size={12} />
                    </button>
                </div>
                <EmojiPicker
                    theme={Theme.DARK}
                    emojiStyle={EmojiStyle.NATIVE}
                    onEmojiClick={(d) => applyIcon(d.emoji)}
                    width={320}
                    height={360}
                    previewConfig={{ showPreview: false }}
                />
                <button
                    onClick={() => applyIcon('')}
                    className="w-full text-left text-xs text-gray-500 hover:text-red-400 hover:bg-[#2a3136] px-3 py-2 border-t border-[#2a3136]"
                >
                    Remove icon
                </button>
            </div>,
            document.body
        )}

        <div className="max-w-3xl mx-auto px-8 py-8">
        <div className="flex items-center justify-between mb-5 gap-3">
        <div className="flex items-center gap-3 min-w-0">
        <span className="text-4xl leading-none">{sectionIcon || "📔"}</span>
        <h2 className="text-3xl font-bold text-gray-100 truncate">{sectionName}</h2>
        </div>
        <button
        onClick={newEntry}
        className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium flex-shrink-0"
        >
        <Plus size={14} /> <span>New Entry</span>
        </button>
        </div>

        {items && items.length > 0 && (
            <div className="relative mb-6">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
            <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search entries and tags…"
            className="w-full bg-[#161a1d] border border-[#2a3136] rounded pl-9 pr-8 py-2 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
            />
            {query && (
                <button onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-200 p-1">
                <X size={12} />
                </button>
            )}
            </div>
        )}

        {items === null ? (
            <div className="text-center py-12 text-sm text-gray-500">Loading…</div>
        ) : items.length === 0 ? (
            <div className="flex flex-col items-center text-gray-500 mt-20 gap-3">
            <span className="text-4xl opacity-50">{sectionIcon || "📔"}</span>
            <p className="text-sm">No entries yet.</p>
            <button onClick={newEntry} className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded font-medium">
            <Plus size={13} /> New Entry
            </button>
            </div>
        ) : groups.length === 0 ? (
            <div className="text-center py-8 text-sm text-gray-500 italic">No matches.</div>
        ) : (
            groups.map((g) => (
                <div key={g.label} className="mb-8">
                <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-3 flex items-center gap-3">
                <span>{g.label}</span>
                <span className="flex-1 h-px bg-[#1e2327]" />
                </div>
                <div className="space-y-2">
                {g.items.map((it) => (
                    <div
                    key={it.path}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenNote({ path: it.path, name: it.fileName })}
                    onKeyDown={(e) => { if (e.key === "Enter") onOpenNote({ path: it.path, name: it.fileName }); }}
                    onContextMenu={(e) => handleContextMenu(e, it)}
                    className="relative rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] transition-colors p-4 cursor-pointer"
                    >
                    <div className="flex items-start gap-3">
                    <span className="text-2xl leading-none flex-shrink-0">{it.icon || "📝"}</span>
                    <div className="flex-1 min-w-0">
                    <div className="text-base font-semibold text-gray-100 truncate">
                    {it.title || "Untitled entry"}
                    </div>
                    {it.date && (
                        <div className="flex items-center gap-1 text-xs text-gray-500 mt-0.5">
                        <Calendar size={10} /> {formatEntryDate(it.date)}

                        </div>
                    )}
                    {it.tags && it.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                        {it.tags.slice(0, 3).map((t) => (
                            <span
                            key={t}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-[#1e2327] border border-[#2a3136] text-gray-400 truncate max-w-[80px]"
                            title={t}
                            >
                            {t}
                            </span>
                        ))}
                        {it.tags.length > 3 && (
                            <span className="text-[10px] text-gray-500" title={it.tags.join(", ")}>
                            +{it.tags.length - 3}
                            </span>
                        )}
                        </div>
                    )}
                    {it.preview && (
                        <p className="text-xs text-gray-400 mt-2 leading-relaxed line-clamp-2">{it.preview}</p>
                    )}
                    </div>
                    </div>
                    </div>
                ))}
                </div>
                </div>
            ))
        )}
        </div>
        </div>
    );
}
