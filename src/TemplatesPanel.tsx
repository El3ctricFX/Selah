// src/TemplatesPanel.tsx
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { Plus, Trash2, Pencil, Download, Check } from "lucide-react";
import { parseNoteFile } from "./noteFormat";
import {
    loadTemplateData,
    saveTemplateData,
    TEMPLATE_PRESETS,
    type NoteTemplate,
    type TemplateData,
    type TemplatePreset,
} from "./templates";

type Target = { key: string; label: string; hint: string };

const ABBA_SECTIONS: { id: string; label: string }[] = [
    { id: "prayers", label: "Prayer" },
{ id: "studies", label: "Bible Study" },
{ id: "testimonies", label: "Testimonies" },
{ id: "events", label: "Events" },
];

const btn =
"flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200 disabled:opacity-40 cursor-pointer";
const primary =
"flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-40 cursor-pointer font-medium";

const newId = () => `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export default function TemplatesPanel({ vaultPath }: { vaultPath: string }) {
    const [data, setData] = useState<TemplateData>({ templates: [], defaults: {} });
    const [targets, setTargets] = useState<Target[]>([]);
    const [editing, setEditing] = useState<NoteTemplate | null>(null);
    const [msg, setMsg] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const d = await loadTemplateData(vaultPath);
            let cats: any[] = [];
            try {
                const raw = await readTextFile(await join(vaultPath, ".vault_metadata.json"));
                cats = JSON.parse(raw).categories || [];
            } catch {}
            const t: Target[] = [];
            for (const c of cats) {
                if (!c?.id) continue;
                const name = `${c.icon || ""} ${c.name}`.trim();
                if (c.mode === "journal") t.push({ key: c.id, label: name, hint: "new daily entries" });
                else if (c.mode === "notes") t.push({ key: c.id, label: name, hint: "new notes" });
                else if (c.mode === "entries") t.push({ key: c.id, label: name, hint: "new entries" });
                else if (c.mode === "abba") {
                    for (const s of ABBA_SECTIONS) {
                        t.push({ key: `${c.id}:${s.id}`, label: `${name} › ${s.label}`, hint: "new items" });
                    }
                }
            }
            if (!cancelled) {
                setData(d);
                setTargets(t);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [vaultPath]);

    const persist = async (next: TemplateData) => {
        setData(next);
        try {
            await saveTemplateData(vaultPath, next);
        } catch (e) {
            console.error("[templates] save failed:", e);
        }
    };

    const saveEditing = async () => {
        if (!editing) return;
        const t: NoteTemplate = { ...editing, name: editing.name.trim() || "Untitled template" };
        const exists = data.templates.some((x) => x.id === t.id);
        await persist({
            ...data,
            templates: exists
            ? data.templates.map((x) => (x.id === t.id ? t : x))
            : [...data.templates, t],
        });
        setEditing(null);
    };

    const removeTemplate = async (id: string) => {
        const defaults = { ...data.defaults };
        for (const k of Object.keys(defaults)) if (defaults[k] === id) delete defaults[k];
        await persist({ templates: data.templates.filter((t) => t.id !== id), defaults });
    };

    const addPreset = async (p: TemplatePreset) => {
        await persist({
            ...data,
            templates: [...data.templates, { id: newId(), name: p.name, icon: p.icon, body: p.body, presetId: p.id }],
        });
    };

    const importFromNote = async () => {
        setMsg(null);
        try {
            const picked = await open({
                multiple: false,
                defaultPath: vaultPath,
                    filters: [{ name: "Selah note", extensions: ["selah"] }],
            });
            if (!picked || typeof picked !== "string") return;
            const { frontmatter, body } = parseNoteFile(await readTextFile(picked));
            const base = (picked.split(/[/\\]/).pop() || "Template").replace(/\.selah$/i, "");
            setEditing({
                id: newId(),
                       name: (frontmatter.title as string) || base,
                       icon: (frontmatter.icon as string) || "📝",
                       body: body.trim(),
            });
            if (body.includes("assets/")) {
                setMsg("This note references images/files. Those don't get copied into new notes, so remove them from the template text.");
            }
        } catch (e: any) {
            setMsg(e?.message ?? String(e));
        }
    };

    const setDefault = async (key: string, templateId: string) => {
        const defaults = { ...data.defaults };
        if (templateId) defaults[key] = templateId;
        else delete defaults[key];
        await persist({ ...data, defaults });
    };

    return (
        <div className="p-5 space-y-6">
        <p className="text-[11px] text-gray-500 leading-snug">
        Templates are reusable starting text for new notes. None are set by default. Use one
        manually from the <span className="font-mono">/</span> menu (“Insert template”), or pick a
        default below so it fills in automatically. Placeholders:{" "}
        <span className="font-mono">{"{{date}} {{weekday}} {{time}} {{month}} {{year}}"}</span>. For
        journal days, <span className="font-mono">{"{{date}}"}</span> is that day's date.
        </p>

        {msg && (
            <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-300">
            {msg}
            </div>
        )}

        {/* ── My templates ── */}
        <div>
        <div className="flex items-center gap-2 mb-2">
        <div className="text-[10px] uppercase tracking-wider text-gray-500">My templates</div>
        <div className="ml-auto flex gap-2">
        <button className={btn} onClick={importFromNote}>
        <Download size={12} /> From a note…
        </button>
        <button
        className={primary}
        onClick={() => setEditing({ id: newId(), name: "", icon: "📝", body: "" })}
        >
        <Plus size={12} /> New template
        </button>
        </div>
        </div>

        {data.templates.length === 0 && !editing && (
            <p className="text-xs text-gray-500 italic py-2">
            No templates yet. Create one, import it from a note you've written, or add a preset
            below.
            </p>
        )}

        <div className="space-y-1.5">
        {data.templates.map((t) => (
            <div
            key={t.id}
            className="flex items-center gap-2 rounded-md border border-[#2a3136] bg-[#131819] px-3 py-2"
            >
            <span className="text-base w-6 text-center">{t.icon || "📝"}</span>
            <span className="flex-1 min-w-0 text-xs text-gray-100 truncate">{t.name}</span>
            <button
            className="p-1 text-gray-500 hover:text-gray-100"
            title="Edit"
            onClick={() => setEditing(t)}
            >
            <Pencil size={12} />
            </button>
            <button
            className="p-1 text-gray-500 hover:text-red-400"
            title="Delete"
            onClick={() => removeTemplate(t.id)}
            >
            <Trash2 size={12} />
            </button>
            </div>
        ))}
        </div>

        {editing && (
            <div className="mt-3 rounded-md border border-[#2a3136] bg-[#131819] p-3 space-y-2">
            <div className="flex gap-2">
            <input
            value={editing.icon}
            onChange={(e) => setEditing({ ...editing, icon: e.target.value })}
            className="w-12 text-center bg-[#0f1315] border border-[#30363d] rounded px-1 py-1.5 text-sm text-gray-100 outline-none"
            placeholder="📝"
            />
            <input
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            placeholder="Template name"
            className="flex-1 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1.5 text-xs text-gray-100 outline-none focus:ring-1 focus:ring-blue-500"
            />
            </div>
            <textarea
            value={editing.body}
            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
            spellCheck={false}
            placeholder={"## Heading\n- bullet\n- [ ] checkbox\n\nWrite the template as Markdown."}
            className="w-full h-56 bg-[#0f1315] border border-[#30363d] rounded p-2 text-xs text-gray-200 font-mono leading-relaxed outline-none focus:ring-1 focus:ring-blue-500 resize-y"
            />
            <div className="flex gap-2 justify-end">
            <button className={btn} onClick={() => setEditing(null)}>
            Cancel
            </button>
            <button className={primary} onClick={saveEditing}>
            <Check size={12} /> Save template
            </button>
            </div>
            </div>
        )}
        </div>

        {/* ── Auto-apply ── */}
        <div className="border-t border-[#2a3136] pt-5">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
        Use automatically
        </div>
        {targets.length === 0 ? (
            <p className="text-xs text-gray-500 italic">No categories found.</p>
        ) : (
            <div className="space-y-1.5">
            {targets.map((t) => (
                <div key={t.key} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-200 truncate">{t.label}</div>
                <div className="text-[10px] text-gray-600">{t.hint}</div>
                </div>
                <select
                value={data.templates.some((x) => x.id === data.defaults[t.key]) ? data.defaults[t.key] : ""}
                onChange={(e) => setDefault(t.key, e.target.value)}
                className="w-48 bg-[#131819] border border-[#2a3136] rounded px-2 py-1.5 text-xs text-gray-200 outline-none"
                >
                <option value="">None</option>
                {data.templates.map((x) => (
                    <option key={x.id} value={x.id}>
                    {x.icon} {x.name}
                    </option>
                ))}
                </select>
                </div>
            ))}
            </div>
        )}
        </div>

        {/* ── Presets ── */}
        <div className="border-t border-[#2a3136] pt-5">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
        Presets (optional)
        </div>
        <div className="space-y-1.5">
        {TEMPLATE_PRESETS.map((p) => {
            const added = data.templates.some((t) => t.presetId === p.id);
            return (
                <div
                key={p.id}
                className="flex items-center gap-2 rounded-md border border-[#2a3136] bg-[#131819] px-3 py-2"
                >
                <span className="text-base w-6 text-center">{p.icon}</span>
                <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-100 truncate">{p.name}</div>
                <div className="text-[10px] text-gray-500 truncate">{p.description}</div>
                </div>
                {added ? (
                    <span className="text-[11px] text-green-400 flex items-center gap-1">
                    <Check size={12} /> Added
                    </span>
                ) : (
                    <button className={btn} onClick={() => addPreset(p)}>
                    <Plus size={11} /> Add
                    </button>
                )}
                </div>
            );
        })}
        </div>
        <p className="text-[10px] text-gray-600 mt-2">
        Adding a preset copies it into “My templates”, where you can edit it freely.
        </p>
        </div>
        </div>
    );
}
