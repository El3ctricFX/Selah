// src/entries.ts
import { readDir, readTextFile, writeTextFile, mkdir } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { parseNoteFile } from "./noteFormat";

export interface EntryItem {
    path: string;
    fileName: string;
    title: string;
    icon: string;
    /** YYYY-MM-DD, or "" if none */
    date: string;
    created: number;
    preview: string;
    wordCount: number;
    tags: string[];
}

export function todayYmd(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "2026-10-04" → "October 4, 2026" */
export function formatEntryDate(ymd: string): string {
    const m = ymd?.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return "";
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export function monthLabel(ymd: string): string {
    const m = ymd?.match(/^(\d{4})-(\d{2})/);
    if (!m) return "No date";
    return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString("en-US", {
        year: "numeric", month: "long",
    });
}

function makePreview(body: string): string {
    return body
    .replace(/^:::.*$/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*_>`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function listEntries(dir: string): Promise<EntryItem[]> {
    let entries: any[] = [];
    try { entries = await readDir(dir); } catch { return []; }
    const out: EntryItem[] = [];
    for (const e of entries) {
        if (!e.name || e.name.startsWith(".") || e.isDirectory) continue;
        if (!e.name.endsWith(".selah")) continue;
        const full = await join(dir, e.name);
        try {
            const { frontmatter: fm, body } = parseNoteFile(await readTextFile(full));
            const createdMs = typeof fm.created === "string" ? new Date(fm.created).getTime() : 0;
            const created = Number.isFinite(createdMs) ? createdMs : 0;
            let date = typeof fm.date === "string" ? fm.date.slice(0, 10) : "";
            if (!date && created) date = new Date(created).toISOString().slice(0, 10);
            const plain = makePreview(body);
            out.push({
                path: full,
                fileName: e.name,
                title: (fm.title as string) || "",
                     icon: (fm.icon as string) || "",
                     date,
                     created,
                     preview: plain.slice(0, 180),
                     wordCount: plain ? plain.split(" ").length : 0,
                     tags: Array.isArray(fm.tags) ? (fm.tags as any[]).filter((t): t is string => typeof t === "string") : [],
            });
        } catch {}
    }
    out.sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        return b.created - a.created;
    });
    return out;
}

export async function createEntry(dir: string): Promise<{ path: string; fileName: string }> {
    await mkdir(dir, { recursive: true });
    const fileName = `Entry-${Date.now()}.selah`;
    const path = await join(dir, fileName);
    const now = new Date().toISOString();
    await writeTextFile(
        path,
        `---\ndate: ${todayYmd()}\ncreated: ${now}\nmodified: ${now}\n---\n\n`
    );
    return { path, fileName };
}
