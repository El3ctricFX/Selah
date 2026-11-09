// src/DataPanel.tsx
import { useEffect, useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, readDir } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import {
    Upload, Download, Package, FileText, AlertTriangle, Check, Loader2,
    Search, FileUp, FolderOpen, X,
} from "lucide-react";
import {
    listVaultNotes, inspectForExport, exportPack, loadPack, importPack,
    analyzeMarkdown, commitMarkdownImport, collectMarkdownInFolder,
    findMissingFilesInFolder,
    type VaultNote, type LoadedPack, type ImportPlan, type PlannedRef,
} from "./notePorting";

type Cat = { id: string; name: string; icon: string; mode: string; dirName: string };

function formatPrettyDate(iso: string, fallbackName: string = "", folder: string = ""): string {
  // 1. Check if the filename is a text date like "October 17, 2026"
  const cleanName = fallbackName.replace(/\.selah$/i, "");
  const parsedNameDate = Date.parse(cleanName);
  if (!isNaN(parsedNameDate) && cleanName.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4})/i)) {
    return new Date(parsedNameDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  // 2. Look for YYYY-MM-DD or YYYY/MM/DD in the filename or folder path
  const textToSearch = `${folder} ${fallbackName}`;
  const match = textToSearch.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (match) {
    const d = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00`);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
  }

  // 3. Fallback to the raw ISO timestamp, forcing local noon if it's just a date
  if (iso) {
    const dateOnly = iso.match(/^(\d{4}-\d{2}-\d{2})/);
    if (dateOnly) {
       const d = new Date(`${dateOnly[1]}T12:00:00`);
       if (!isNaN(d.getTime())) return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } else {
       const d = new Date(iso);
       if (!isNaN(d.getTime())) return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
  }
  return "";
}

export default function DataPanel({ vaultPath }: { vaultPath: string }) {
    const [cats, setCats] = useState<Cat[]>([]);
    const [catId, setCatId] = useState("");

    // Folder selection state
    const [folders, setFolders] = useState<string[]>([]);
    const [selectedFolder, setSelectedFolder] = useState("");
    const [isCreatingFolder, setIsCreatingFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");

    // export
    const [notes, setNotes] = useState<VaultNote[] | null>(null);
    const [picking, setPicking] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [query, setQuery] = useState("");
    const [warn, setWarn] = useState<{ types: string[]; byNote: { title: string; types: string[] }[] } | null>(null);

    // import
    const [pack, setPack] = useState<LoadedPack | null>(null);
    const [plan, setPlan] = useState<ImportPlan | null>(null);

    const [busy, setBusy] = useState<string | null>(null);
    const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const meta = JSON.parse(await readTextFile(await join(vaultPath, ".vault_metadata.json")));
                // Include EVERY category that has an ID
                const list: Cat[] = (meta.categories || [])
                    .filter((c: any) => c && c.id)
                    .map((c: any): Cat => ({
                        id:      c.id,
                        name:    c.name || c.id,
                        icon:    c.icon || "📄",
                        mode:    c.mode || "notes",
                        dirName: c.dirName || c.id,
                    }));
                setCats(list);
                setCatId((prev) => prev || list[0]?.id || "");
            } catch { setCats([]); }
        })();
    }, [vaultPath]);

    // Load existing folders (including nested ones) when a "Notes" category is selected
    useEffect(() => {
        (async () => {
            const c = cats.find(x => x.id === catId);
            if (!c || c.mode !== 'notes') {
                setFolders([]);
                setSelectedFolder("");
                setIsCreatingFolder(false);
                setNewFolderName("");
                return;
            }
            try {
                const dir = await join(vaultPath, c.dirName);
                const allFolders: string[] = [];

                // Recursive function to find all folders
                const walk = async (currentDir: string, currentPath: string, depth: number) => {
                    if (depth > 5) return; // Prevent going too deep
                    try {
                        const entries = await readDir(currentDir);
                        for (const e of entries) {
                            if (!e.name || e.name.startsWith('.') || e.name === 'assets' || e.name === '_attachments') continue;
                            if (e.isDirectory) {
                                const newPath = currentPath ? `${currentPath}/${e.name}` : e.name;
                                allFolders.push(newPath);
                                await walk(await join(currentDir, e.name), newPath, depth + 1);
                            }
                        }
                    } catch {}
                };

                await walk(dir, "", 0);
                setFolders(allFolders.sort());
            } catch {
                setFolders([]);
            }
        })();
    }, [catId, cats, vaultPath]);

    const destDir = async (): Promise<string | null> => {
        const c = cats.find((x) => x.id === catId);
        if (!c) return null;

        const isStructured = ["journal", "journals", "daily", "diary", "entries", "gallery", "abba"].includes(String(c.mode || "").toLowerCase());
        if (isStructured) {
            return await join(vaultPath, c.dirName);
        }

        let finalSub = selectedFolder;
        if (isCreatingFolder && newFolderName.trim()) {
            finalSub = newFolderName.trim().replace(/[\\/:*?"<>|]/g, "-");
        }

        return finalSub ? await join(vaultPath, c.dirName, finalSub) : await join(vaultPath, c.dirName);
    };

    const fail = (e: any) => { console.error(e); setMsg({ text: e?.message ?? String(e), error: true }); setBusy(null); };

    // ── export ────────────────────────────────────────────────────────────
    const openPicker = async () => {
        setPicking(true);
        if (!notes) setNotes(await listVaultNotes(vaultPath));
    };

        const norm = (s: string) => s.toLowerCase().replace(/[,\s]+/g, " ").trim();

        const shown = useMemo(() => {
            const q = norm(query);
            if (!q) return notes || [];
            return (notes || []).filter((n) => {
                const prettyDate = formatPrettyDate(n.created, n.base, n.folder);
                return norm(
                    `${n.title} ${n.base} ${n.folder} ${n.created} ${n.modified} ${prettyDate} ${n.snippet}`
                ).includes(q);
            });
        }, [notes, query]);

        const toggle = (p: string) =>
        setSelected((prev) => { const n = new Set(prev); n.has(p) ? n.delete(p) : n.add(p); return n; });

        const runExport = async () => {
            setWarn(null);
            try {
                const dest = await save({
                    defaultPath: "Selah-notes.selahpack",
                        filters: [{ name: "Selah note pack", extensions: ["selahpack"] }],
                });
                if (!dest) return;
                setBusy("Exporting…"); setMsg(null);
                const r = await exportPack(Array.from(selected), dest, setBusy);
                setBusy(null);
                setMsg({ text: `Exported ${r.notes} note${r.notes === 1 ? "" : "s"} with ${r.files} media file${r.files === 1 ? "" : "s"}.` });
            } catch (e) { fail(e); }
        };

        const startExport = async () => {
            if (selected.size === 0) return;
            setMsg(null);
            try {
                setBusy("Checking notes…");
                const info = await inspectForExport(Array.from(selected));
                setBusy(null);
                if (info.types.length > 0) { setWarn(info); return; }
                await runExport();
            } catch (e) { fail(e); }
        };

        // ── import: pack ──────────────────────────────────────────────────────
        const pickPack = async () => {
            setMsg(null); setPlan(null);
            try {
                const picked = await open({ multiple: false, filters: [{ name: "Selah note pack", extensions: ["selahpack"] }] });
                if (!picked || typeof picked !== "string") return;
                setBusy("Reading pack…");
                setPack(await loadPack(picked));
                setBusy(null);
            } catch (e) { fail(e); }
        };

        const runPackImport = async () => {
            if (!pack) return;
            try {
                const dir = await destDir();
                if (!dir) { setMsg({ text: "Pick a destination category first.", error: true }); return; }
                setBusy("Importing…");
                const r = await importPack(pack, dir, setBusy);
                setBusy(null); setPack(null);
                setMsg({ text: `Imported ${r.imported.length} note${r.imported.length === 1 ? "" : "s"}.` });
            } catch (e) { fail(e); }
        };

        // ── import: markdown ──────────────────────────────────────────────────
        const analyze = async (sources: { absPath: string; rootDir: string | null }[]) => {
            const dir = await destDir();
            if (!dir) { setMsg({ text: "Pick a destination category first.", error: true }); return; }
            if (sources.length === 0) { setMsg({ text: "No markdown files found.", error: true }); return; }
            setBusy("Reading files and checking links…");
            const c = cats.find((x) => x.id === catId);
            const isJournal = ["journal", "journals", "daily", "diary"].includes(String(c?.mode || "").toLowerCase());
            setPlan(await analyzeMarkdown(sources, dir, isJournal));
            setBusy(null);
        };

        const pickMdFiles = async () => {
            setMsg(null); setPack(null);
            try {
                const picked = await open({ multiple: true, filters: [{ name: "Markdown", extensions: ["md", "markdown"] }] });
                if (!picked) return;
                const list = (Array.isArray(picked) ? picked : [picked]).filter((p): p is string => typeof p === "string");
                await analyze(list.map((absPath) => ({ absPath, rootDir: null })));
            } catch (e) { fail(e); }
        };

        const pickMdFolder = async () => {
            setMsg(null); setPack(null);
            try {
                const picked = await open({ directory: true, multiple: false });
                if (!picked || typeof picked !== "string") return;
                setBusy("Scanning folder…");
                const files = await collectMarkdownInFolder(picked);
                await analyze(files.map((absPath) => ({ absPath, rootDir: picked })));
            } catch (e) { fail(e); }
        };

        const patchRef = (nid: string, token: string, p: Partial<PlannedRef>) =>
        setPlan((pl) => pl && {
            ...pl,
            notes: pl.notes.map((n) => n.id !== nid ? n : {
                ...n, refs: n.refs.map((r) => r.token !== token ? r : { ...r, ...p }),
            }),
        });

        const browseFor = async (nid: string, r: PlannedRef) => {
            const picked = await open({ multiple: false });
            if (picked && typeof picked === "string") patchRef(nid, r.token, { resolved: picked, decision: "accepted" });
        };

        const browseForFolder = async (nid: string, r: PlannedRef) => {
            const picked = await open({ directory: true, multiple: false });
            if (!picked || typeof picked !== "string") return;
            setBusy("Searching folder…");
            try {
                const foundMap = await findMissingFilesInFolder(picked, [r.name]);
                const match = foundMap.get(r.name.toLowerCase());
                if (match) {
                    patchRef(nid, r.token, { resolved: match, decision: "accepted" });
                } else {
                    setMsg({ text: `Couldn't find "${r.name}" in that folder.`, error: true });
                }
            } catch (e) { fail(e); }
            setBusy(null);
        };

        const searchFolderBulk = async () => {
            if (!plan) return;
            const picked = await open({ directory: true, multiple: false });
            if (!picked || typeof picked !== "string") return;
            setBusy("Scanning folder for missing files…");
            try {
                const pendingRefs = plan.notes.flatMap(n => n.refs.filter(r => r.decision === "pending"));
                if (pendingRefs.length === 0) return;

                const uniqueNames = Array.from(new Set(pendingRefs.map(r => r.name)));
                const foundMap = await findMissingFilesInFolder(picked, uniqueNames);

                let foundCount = 0;
                const newPlan = { ...plan };
                newPlan.notes = newPlan.notes.map(n => ({
                    ...n,
                    refs: n.refs.map(r => {
                        if (r.decision === "pending") {
                            const match = foundMap.get(r.name.toLowerCase());
                            if (match) {
                                foundCount++;
                                return { ...r, resolved: match, decision: "accepted" as const };
                            }
                        }
                        return r;
                    })
                }));

                setPlan(newPlan);
                setBusy(null);

                if (foundCount > 0) {
                    setMsg({ text: `Found ${foundCount} missing file${foundCount === 1 ? "" : "s"} in that folder!` });
                } else {
                    setMsg({ text: `Couldn't find any of the missing files in that folder.`, error: true });
                }
            } catch (e) { fail(e); }
        };

        const skipAll = () =>
        setPlan((pl) => pl && {
            ...pl,
            notes: pl.notes.map((n) => ({
                ...n, refs: n.refs.map((r) => r.decision === "pending" ? { ...r, decision: "skipped" as const } : r),
            })),
        });

        const pending = useMemo(() => {
            if (!plan) return [] as { nid: string; title: string; ref: PlannedRef }[];
            return plan.notes.flatMap((n) =>
            n.refs.filter((r) => r.decision === "pending").map((ref) => ({ nid: n.id, title: n.base, ref })));
        }, [plan]);

        const runMdImport = async () => {
            if (!plan) return;
            try {
                setBusy("Importing…");
                const r = await commitMarkdownImport(plan, setBusy);
                setBusy(null); setPlan(null);
                setMsg({
                    text: `Imported ${r.notes} note${r.notes === 1 ? "" : "s"}, copied ${r.copied} file${r.copied === 1 ? "" : "s"}` +
                    (r.skipped ? `, ${r.skipped} reference${r.skipped === 1 ? "" : "s"} left as "missing".` : "."),
                });
            } catch (e) { fail(e); }
        };

        const btn = "flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200 disabled:opacity-40 cursor-pointer";
        const primary = "flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-40 cursor-pointer font-medium";

        const totalRefs = plan ? plan.notes.reduce((n, x) => n + x.refs.length, 0) : 0;

        return (
            <div className="p-5 space-y-6">
            {msg && (
                <div className={`flex items-start gap-2 rounded-md border p-3 text-xs ${
                    msg.error ? "border-red-500/30 bg-red-500/5 text-red-300" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"}`}>
                    {msg.error ? <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" /> : <Check size={13} className="mt-0.5 flex-shrink-0" />}
                    <span className="flex-1 break-words">{msg.text}</span>
                    <button onClick={() => setMsg(null)}><X size={12} /></button>
                    </div>
            )}
            {busy && (
                <div className="flex items-center gap-2 text-xs text-gray-400">
                <Loader2 size={13} className="animate-spin" /> {busy}
                </div>
            )}

            {/* ── EXPORT ─────────────────────────────────────────────────── */}
            <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5">
            <Upload size={10} /> Export notes
            </div>
            <p className="text-[11px] text-gray-500 mb-3 leading-snug">
            Bundles the notes you pick, plus all their photos, audio, video and files, into one
            <span className="font-mono"> .selahpack</span> file you can import into another vault or send to a friend.
            Links between notes ([[wiki links]]) aren't followed, so export linked notes together.
            </p>

            {!picking ? (
                <button className={btn} onClick={openPicker}><Package size={12} /> Choose notes…</button>
            ) : (
                <div className="rounded-md border border-[#2a3136] bg-[#131819]">
                <div className="p-2 border-b border-[#2a3136] flex items-center gap-2">
                <div className="relative flex-1">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                <input
                value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notes…"
                className="w-full bg-[#0f1315] border border-[#30363d] rounded pl-8 pr-2 py-1.5 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
                />
                </div>
                <button className="text-[11px] text-gray-400 hover:text-gray-100 px-2"
                onClick={() => setSelected(new Set(shown.map((n) => n.path)))}>Select shown</button>
                <button className="text-[11px] text-gray-400 hover:text-gray-100 px-2"
                onClick={() => setSelected(new Set())}>None</button>
                </div>
                <div className="max-h-64 overflow-y-auto divide-y divide-[#1a1e21]">
                {notes === null && <div className="p-3 text-xs text-gray-500">Loading notes…</div>}
                {notes && shown.length === 0 && <div className="p-3 text-xs text-gray-500 italic">No notes found.</div>}
                {shown.map((n) => {
                    // Figure out the category name from the folder path
                    const topFolder = n.folder.split("/")[0];
                    const catName = cats.find(c => c.dirName === topFolder)?.name || topFolder;
                    const dateStr = formatPrettyDate(n.created || n.modified, n.base, n.folder);

                    return (
                    <label key={n.path} className="flex items-center gap-2 px-3 py-1.5 hover:bg-[#141819] cursor-pointer">
                    <input type="checkbox" checked={selected.has(n.path)} onChange={() => toggle(n.path)} className="accent-blue-500" />
                    <span className="w-5 text-center flex-shrink-0">{n.icon || "📄"}</span>
                    <span className="flex-1 min-w-0">
                    <span className="block text-xs text-gray-200 truncate">{n.title}</span>
                    {(catName || dateStr) && (
                        <span className="block text-[10px] text-gray-500 truncate">
                        {[catName, dateStr].filter(Boolean).join(" · ")}
                        </span>
                    )}
                    </span>
                    </label>
                    );
                })}
                </div>
                <div className="p-2 border-t border-[#2a3136] flex items-center justify-between">
                <span className="text-[11px] text-gray-500">{selected.size} selected</span>
                <button className={primary} disabled={selected.size === 0 || !!busy} onClick={startExport}>
                <Download size={12} /> Export {selected.size || ""} note{selected.size === 1 ? "" : "s"}…
                </button>
                </div>
                </div>
            )}

            {warn && (
                <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[11px] text-amber-300">
                <div className="flex items-center gap-2 font-medium mb-1"><AlertTriangle size={13} /> Some notes use plugin blocks</div>
                <p className="leading-snug mb-2">
                Whoever opens this pack needs the plugin(s) that provide these block types, otherwise those blocks may not display:
                </p>
                <ul className="mb-2 space-y-0.5">
                {warn.byNote.map((b) => (
                    <li key={b.title}><span className="text-amber-200">{b.title}</span> — <span className="font-mono">{b.types.join(", ")}</span></li>
                ))}
                </ul>
                <div className="flex gap-2">
                <button className={btn} onClick={() => setWarn(null)}>Cancel</button>
                <button className={primary} onClick={runExport}>Ignore & export anyway</button>
                </div>
                </div>
            )}
            </div>

            {/* ── IMPORT ─────────────────────────────────────────────────── */}
            <div className="border-t border-[#2a3136] pt-5">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5">
            <Download size={10} /> Import notes
            </div>

            <div className={`grid ${!["journal", "journals", "daily", "diary", "entries", "gallery", "abba"].includes(String(cats.find(c => c.id === catId)?.mode || "").toLowerCase()) ? "grid-cols-2" : "grid-cols-1"} gap-2 mb-3`}>
            <div>
            <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-1">Destination category</label>
            <select
            value={catId} onChange={(e) => {
                setCatId(e.target.value);
                setSelectedFolder("");
                setIsCreatingFolder(false);
                setNewFolderName("");
            }}
            className="w-full bg-[#131819] border border-[#2a3136] rounded px-2 py-1.5 text-xs text-gray-200 outline-none"
            >
            {cats.length === 0 && <option value="">No categories — create one first</option>}
            {cats.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
            </select>
            </div>

            {/* Folder Dropdown for Notes Categories */}
            {!["journal", "journals", "daily", "diary", "entries", "gallery", "abba"].includes(String(cats.find(c => c.id === catId)?.mode || "").toLowerCase()) && (
                <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-1">Into folder (optional)</label>
                {!isCreatingFolder ? (
                    <select
                        value={selectedFolder}
                        onChange={(e) => {
                            if (e.target.value === "__NEW__") {
                                setIsCreatingFolder(true);
                                setSelectedFolder("");
                            } else {
                                setSelectedFolder(e.target.value);
                            }
                        }}
                        className="w-full bg-[#131819] border border-[#2a3136] rounded px-2 py-1.5 text-xs text-gray-200 outline-none"
                    >
                        <option value="">(Root - No folder)</option>
                        {folders.map(f => <option key={f} value={f}>{f}</option>)}
                        <option value="__NEW__">+ Create new folder...</option>
                    </select>
                ) : (
                    <div className="flex gap-2">
                        <input
                            autoFocus
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            placeholder="New folder name..."
                            className="w-full bg-[#131819] border border-[#2a3136] rounded px-2 py-1.5 text-xs text-gray-200 outline-none"
                        />
                        <button
                            onClick={() => setIsCreatingFolder(false)}
                            className="px-2 py-1.5 bg-[#2a3136] hover:bg-[#30363d] rounded text-xs text-gray-200"
                        >
                            Cancel
                        </button>
                    </div>
                )}
                </div>
            )}
            </div>

            <div className="flex flex-wrap gap-2">
            <button className={btn} onClick={pickPack} disabled={!!busy || !catId}><Package size={12} /> Selah pack…</button>
            <button className={btn} onClick={pickMdFiles} disabled={!!busy || !catId}><FileUp size={12} /> Markdown files…</button>
            <button className={btn} onClick={pickMdFolder} disabled={!!busy || !catId}><FolderOpen size={12} /> Markdown folder…</button>
            </div>
            <p className="text-[10px] text-gray-600 mt-2 leading-snug">
            For Notion or Obsidian, import the whole <strong>folder</strong> (unzip a Notion export first) so images and
            linked notes can be found. Links between the imported notes are converted to Selah [[links]] and
            image paths are rewritten.
            </p>

            {/* pack preview */}
            {pack && (
                <div className="mt-3 rounded-md border border-[#2a3136] bg-[#131819] p-3 text-xs">
                <div className="text-gray-200 mb-1">{pack.manifest.notes.length} note{pack.manifest.notes.length === 1 ? "" : "s"} in this pack</div>
                <div className="text-[11px] text-gray-500 mb-2 max-h-24 overflow-y-auto">
                {pack.manifest.notes.map((n) => <div key={n.dir} className="truncate">• {n.title}</div>)}
                </div>
                {pack.missingPluginTypes.length > 0 && (
                    <div className="mb-2 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-300">
                    <div className="flex items-center gap-1.5 font-medium"><AlertTriangle size={12} /> Missing plugin blocks</div>
                    These notes use block types you don't have installed:{" "}
                    <span className="font-mono">{pack.missingPluginTypes.join(", ")}</span>. They may not display until you install the matching plugin.
                    </div>
                )}
                <div className="flex gap-2">
                <button className={btn} onClick={() => setPack(null)}>Cancel</button>
                <button className={primary} onClick={runPackImport} disabled={!!busy}>
                {pack.missingPluginTypes.length > 0 ? "Ignore & import anyway" : "Import"}
                </button>
                </div>
                </div>
            )}

            {/* markdown plan */}
            {plan && (
                <div className="mt-3 rounded-md border border-[#2a3136] bg-[#131819] p-3 text-xs">
                <div className="text-gray-200">
                {plan.notes.length} note{plan.notes.length === 1 ? "" : "s"} ready ·{" "}
                {totalRefs} image/file reference{totalRefs === 1 ? "" : "s"} ·{" "}
                {totalRefs - pending.length} found
                {pending.length > 0 && <span className="text-amber-300"> · {pending.length} need your help</span>}
                </div>

                {pending.length > 0 && (
                    <div className="mt-3 space-y-2">
                    <div className="flex items-center justify-between mb-3 border-b border-[#2a3136] pb-2">
                        <span className="text-[11px] text-amber-200 font-medium">Missing Files ({pending.length})</span>
                        <button className={btn} onClick={searchFolderBulk} disabled={!!busy}>
                            <FolderOpen size={11} /> Search Folder for all…
                        </button>
                    </div>
                    {pending.map(({ nid, title, ref }) => (
                        <div key={ref.token} className="rounded border border-amber-500/30 bg-amber-500/5 p-2">
                        <div className="text-[11px] text-amber-200 flex items-center gap-1.5">
                        <FileText size={11} /> <span className="truncate">{title}</span>
                        </div>
                        <div className="text-[11px] text-gray-300 mt-0.5">
                        Couldn't find <span className="font-mono">{ref.name}</span>
                        </div>
                        <div className="text-[10px] text-gray-500 font-mono break-all">{ref.raw}</div>

                        {ref.candidates.length > 0 && (
                            <div className="mt-1.5">
                            <div className="text-[11px] text-gray-300 mb-1">Is this the right file?</div>
                            {ref.candidates.map((c) => (
                                <div key={c} className="flex items-center gap-2 mb-1">
                                <span className="flex-1 text-[10px] text-gray-400 font-mono break-all">{c}</span>
                                <button className={primary} onClick={() => patchRef(nid, ref.token, { resolved: c, decision: "accepted" })}>
                                Yes, use it
                                </button>
                                </div>
                            ))}
                            </div>
                        )}
                        <div className="flex flex-wrap gap-2 mt-1.5">
                        <button className={btn} onClick={() => browseFor(nid, ref)}>
                        <FileUp size={11} /> {ref.candidates.length ? "Pick a different file…" : "Find file…"}
                        </button>
                        <button className={btn} onClick={() => browseForFolder(nid, ref)}>
                        <FolderOpen size={11} /> Find folder…
                        </button>
                        <button className={btn} onClick={() => patchRef(nid, ref.token, { decision: "skipped" })}>Skip</button>
                        </div>
                        </div>
                    ))}
                    <button className="text-[11px] text-gray-400 hover:text-gray-100" onClick={skipAll}>
                    Skip all {pending.length} remaining
                    </button>
                    </div>
                )}

                <div className="flex gap-2 mt-3">
                <button className={btn} onClick={() => setPlan(null)}>Cancel</button>
                <button className={primary} onClick={runMdImport} disabled={!!busy || pending.length > 0}>
                Import {plan.notes.length} note{plan.notes.length === 1 ? "" : "s"}
                </button>
                </div>
                {pending.length > 0 && (
                    <p className="text-[10px] text-gray-600 mt-1.5">Resolve or skip the items above to continue.</p>
                )}
                </div>
            )}
            </div>
            </div>
        );
}
