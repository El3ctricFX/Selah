// src/metadataRepair.ts
import { readDir, readTextFile, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { writeFileAtomic } from "./safeWrite";

export interface RepairResult {
    added: Array<{ id: string; name: string; dirName: string; mode: string; reason: string }>;
    kept: number;
    unknownFolders: Array<{ name: string; reason: string }>;
    orphanedCategories: Array<{ id: string; name: string; dirName: string }>;
    beforeCount: number;
    afterCount: number;
}

export interface RepairPreview {
    additions: Array<{ dirName: string; suggestedName: string; suggestedMode: string; reason: string }>;
    unknownFolders: Array<{ name: string; reason: string }>;
    orphanedCategories: Array<{ id: string; name: string; dirName: string }>;
    hasMetadataFile: boolean;
    metadataReadable: boolean;
}

const RESERVED = new Set([
    ".plugins", ".git", ".obsidian", ".trash", "node_modules",
    "assets", "_attachments", "proxy", "thumb",
]);

const SUBFOLDER_SKIP = new Set([
    "assets", "_attachments", "proxy", "thumb",
    "originals", "previews", "proxy videos",
]);

const MAX_DEPTH = 8;

/** Recursively check whether a folder contains any .selah file at any
 *  depth up to MAX_DEPTH. Skips reserved/sidecar folder names. */
async function containsSelahRecursive(
    absPath: string,
    depth = 0,
): Promise<boolean> {
    if (depth > MAX_DEPTH) return false;
    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
        entries = (await readDir(absPath)) as any;
    } catch {
        return false;
    }

    for (const e of entries) {
        if (!e.name || e.name.startsWith(".")) continue;
        if (!e.isDirectory && e.name.endsWith(".selah")) return true;
    }

    for (const e of entries) {
        if (!e.name || e.name.startsWith(".")) continue;
        if (!e.isDirectory) continue;
        if (SUBFOLDER_SKIP.has(e.name)) continue;
        if (await containsSelahRecursive(await join(absPath, e.name), depth + 1)) {
            return true;
        }
    }

    return false;
}

/** Shallow check used for mode inference. Looks at the candidate folder's
 *  top-level entries only, so it doesn't get confused by deep notes. */
function inferModeFromTopLevel(
    entries: Array<{ name: string; isDirectory: boolean }>,
): { mode: "journal" | "notes" | "entries" | "abba" | "gallery"; reason: string } {
    const yearFolders = entries.filter(
        (e) => e.isDirectory && /^\d{4}$/.test(e.name),
    );
    if (yearFolders.length > 0) {
        return {
            mode: "journal",
            reason: `Contains ${yearFolders.length} year folder${yearFolders.length === 1 ? "" : "s"} at the top level`,
        };
    }

    const rootSelahFiles = entries.filter(
        (e) => !e.isDirectory && e.name.endsWith(".selah"),
    );
    const subDirs = entries.filter(
        (e) =>
        e.isDirectory &&
        !e.name.startsWith(".") &&
        !SUBFOLDER_SKIP.has(e.name),
    );

    if (rootSelahFiles.length === 0 && subDirs.length > 0) {
        return {
            mode: "abba",
            reason: `No .selah files at the top level, but ${subDirs.length} subfolder${subDirs.length === 1 ? "" : "s"}`,
        };
    }

    return {
        mode: "notes",
        reason: `Contains ${rootSelahFiles.length} top-level .selah file${rootSelahFiles.length === 1 ? "" : "s"}`,
    };
}

interface MetadataShape {
    categories: any[];
    categoryOrder: string[];
    folderMeta: Record<string, any>;
    activeCategory: string | null;
    [k: string]: any;
}

async function readMetadataLoose(
    metaPath: string,
): Promise<{ meta: MetadataShape; readable: boolean; exists: boolean }> {
    let raw: string | null = null;
    let fileExists = false;
    try {
        fileExists = await exists(metaPath);
        if (fileExists) raw = await readTextFile(metaPath);
    } catch {}

    const base: MetadataShape = {
        categories: [],
        categoryOrder: [],
        folderMeta: {},
        activeCategory: null,
    };

    if (!raw) return { meta: base, readable: false, exists: fileExists };

    try {
        const parsed = JSON.parse(raw);
        return {
            meta: { ...base, ...parsed },
            readable: true,
            exists: fileExists,
        };
    } catch {
        const salvaged: MetadataShape = { ...base };
        const catMatches = raw.matchAll(
            /\{[^{}]*"id"\s*:\s*"([^"]+)"[^{}]*"name"\s*:\s*"([^"]+)"[^{}]*"dirName"\s*:\s*"([^"]+)"[^{}]*\}/g,
        );
        for (const m of catMatches) {
            const [, id, name, dirName] = m;
            // If the id is the well-known builtin, keep it deletable=false.
            const builtin = id === "journal";
            salvaged.categories.push({
                id,
                name,
                dirName,
                mode: builtin ? "journal" : "notes",
                icon: builtin ? "📅" : "🗒️",
                ...(builtin ? { builtin: true } : {}),
            });
        }
        const orderMatch = raw.match(/"categoryOrder"\s*:\s*\[([^\]]*)\]/);
        if (orderMatch) {
            salvaged.categoryOrder = orderMatch[1]
            .split(",")
            .map((s) => s.trim().replace(/^"|"$/g, ""))
            .filter(Boolean);
        }
        return { meta: salvaged, readable: false, exists: fileExists };
    }
}

function newCategoryId(): string {
    return `cat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function previewVaultMetadataRepair(
    vaultPath: string,
): Promise<RepairPreview> {
    const metaPath = await join(vaultPath, ".vault_metadata.json");
    const { meta, readable, exists: metaExists } = await readMetadataLoose(metaPath);

    const coveredDirNames = new Set<string>();
    for (const c of meta.categories) {
        if (c?.dirName && typeof c.dirName === "string") coveredDirNames.add(c.dirName);
    }

    let rootEntries: Array<{ name: string; isDirectory: boolean }> = [];
    try {
        rootEntries = (await readDir(vaultPath)) as any;
    } catch {}

    const additions: RepairPreview["additions"] = [];
    const unknownFolders: RepairPreview["unknownFolders"] = [];

    for (const e of rootEntries) {
        if (!e.name || e.name.startsWith(".")) continue;
        if (!e.isDirectory) continue;
        if (RESERVED.has(e.name)) continue;
        if (coveredDirNames.has(e.name)) continue;

        const absPath = await join(vaultPath, e.name);
        const hasSelah = await containsSelahRecursive(absPath);

        if (!hasSelah) {
            unknownFolders.push({
                name: e.name,
                reason: `No .selah files found anywhere inside (searched up to ${MAX_DEPTH} levels deep).`,
            });
            continue;
        }

        let inner: Array<{ name: string; isDirectory: boolean }> = [];
        try {
            inner = (await readDir(absPath)) as any;
        } catch {}

        const { mode, reason } = inferModeFromTopLevel(inner);
        additions.push({
            dirName: e.name,
            suggestedName: e.name,
            suggestedMode: mode,
            reason,
        });
    }

    const orphanedCategories: RepairPreview["orphanedCategories"] = [];
    for (const c of meta.categories) {
        if (!c?.dirName) continue;
        const p = await join(vaultPath, c.dirName);
        const stillThere = await exists(p).catch(() => false);
        if (!stillThere) {
            orphanedCategories.push({
                id: c.id,
                name: c.name,
                dirName: c.dirName,
            });
        }
    }

    return {
        additions,
        unknownFolders,
        orphanedCategories,
        hasMetadataFile: metaExists,
        metadataReadable: readable,
    };
}

export async function applyVaultMetadataRepair(
    vaultPath: string,
): Promise<RepairResult> {
    const metaPath = await join(vaultPath, ".vault_metadata.json");
    const { meta, readable } = await readMetadataLoose(metaPath);
    const beforeCount = meta.categories.length;

    const preview = await previewVaultMetadataRepair(vaultPath);

    // There should be at most one builtin journal. If the current metadata
    // already has one (e.g. the salvage kept the `journal` id), don't add
    // another. If not, promote the first journal we add.
    const hasBuiltinJournal = meta.categories.some(
        (c: any) => c?.builtin === true && c?.mode === "journal",
    );
    let journalPromoted = hasBuiltinJournal;

    const added: RepairResult["added"] = [];
    for (const p of preview.additions) {
        const id = newCategoryId();
        const icon =
        p.suggestedMode === "journal" ? "📅" :
        p.suggestedMode === "gallery" ? "🎨" :
        p.suggestedMode === "entries" ? "📔" :
        p.suggestedMode === "abba" ? "🙏" :
        "🗒️";
        const isFirstJournal =
            p.suggestedMode === "journal" &&
            !journalPromoted &&
            !meta.categories.some(
                (c: any) => c?.mode === "journal" && c?.builtin === true,
            );
        if (isFirstJournal) journalPromoted = true;
        meta.categories.push({
            id,
            name: p.suggestedName,
            icon,
            mode: p.suggestedMode,
            dirName: p.dirName,
            ...(isFirstJournal ? { builtin: true } : {}),
        });
        if (!meta.categoryOrder.includes(id)) meta.categoryOrder.push(id);
        added.push({
            id,
            name: p.suggestedName,
            dirName: p.dirName,
            mode: p.suggestedMode,
            reason: p.reason,
        });
    }

    for (const c of meta.categories) {
        if (!c.icon) c.icon = "🗒️";
        if (!c.mode) c.mode = "notes";
    }

    // Promote the first journal to builtin if none is — protects the
    // Daily Journal from deletion after a metadata wipe + repair cycle.
    const anyBuiltinJournal = meta.categories.some(
        (c: any) => c?.mode === "journal" && c?.builtin === true,
    );
    if (!anyBuiltinJournal) {
        const firstJournal = meta.categories.find(
            (c: any) => c?.mode === "journal",
        );
        if (firstJournal) firstJournal.builtin = true;
    }

    if (added.length > 0 || !readable) {
        await writeFileAtomic(
            metaPath,
            JSON.stringify(meta, null, 2),
                              { allowShrink: true },
        );
    }

    return {
        added,
        kept: meta.categories.length - added.length,
        unknownFolders: preview.unknownFolders,
        orphanedCategories: preview.orphanedCategories,
        beforeCount,
        afterCount: meta.categories.length,
    };
}
