// src/templates.ts
import { readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { writeFileAtomic } from "./safeWrite";

export interface NoteTemplate {
    id: string;
    name: string;
    icon: string;
    body: string;
    /** Set when the template was copied from a built-in preset. */
    presetId?: string;
}

export interface TemplateData {
    templates: NoteTemplate[];
    /** key = category id, or "<categoryId>:<abbaSection>" -> template id */
    defaults: Record<string, string>;
}

let vaultRoot: string | null = null;
export function setTemplateVault(p: string | null) {
    vaultRoot = p;
}

const norm = (p: string) => p.replace(/\\/g, "/");

/** Strip leading spaces/tabs from every line so `##` headings survive
 *  pasted or preset-inherited indentation. */
function stripLeadingIndent(text: string): string {
    return text
        .split("\n")
        .map((line) => line.replace(/^[ \t]+/, ""))
        .join("\n");
}

async function readMeta(vault: string): Promise<any> {
    try {
        return JSON.parse(await readTextFile(await join(vault, ".vault_metadata.json")));
    } catch {
        return {};
    }
}

export async function loadTemplateData(vault: string | null = vaultRoot): Promise<TemplateData> {
    if (!vault) return { templates: [], defaults: {} };
    const meta = await readMeta(vault);
    return {
        templates: Array.isArray(meta.templates) ? meta.templates : [],
        defaults:
            meta.templateDefaults && typeof meta.templateDefaults === "object"
            ? meta.templateDefaults
            : {},
    };
}

export async function saveTemplateData(vault: string, data: TemplateData): Promise<void> {
    const meta = await readMeta(vault);
    meta.templates = data.templates.map((t) => ({ ...t, body: stripLeadingIndent(t.body) }));
    meta.templateDefaults = data.defaults;
    await writeFileAtomic(
        await join(vault, ".vault_metadata.json"),
                          JSON.stringify(meta, null, 2)
    );
    window.dispatchEvent(new Event("metadata-changed"));
}

/** Fills {{date}}, {{weekday}}, {{time}}, {{month}}, {{year}}. */
export function expandTemplate(body: string, date: Date = new Date()): string {
    return stripLeadingIndent(body).replace(/\{\{(date|weekday|time|year|month)\}\}/g, (_m, k: string) => {
        switch (k) {
            case "date":
                return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
            case "weekday":
                return date.toLocaleDateString("en-US", { weekday: "long" });
            case "time":
                return new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
            case "year":
                return String(date.getFullYear());
            default:
                return date.toLocaleDateString("en-US", { month: "long" });
        }
    });
}

/** "October 12, 2026.selah" -> Date, else null. */
export function journalDayFromPath(path: string): Date | null {
    const name = norm(path).split("/").pop() || "";
    const m = name.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\.selah$/);
    if (!m) return null;
    const d = new Date(`${m[1]} ${m[2]}, ${m[3]} 12:00:00`);
    return isNaN(d.getTime()) ? null : d;
}

/**
 * Returns the (expanded) default template body for whatever category owns
 * `dir`, or "" when no default is set. `section` is for Abba sub-sections
 * ("prayers" | "studies" | "events" | "testimonies").
 */
export async function getDefaultTemplateBody(
    dir: string,
    opts: { section?: string; date?: Date } = {}
): Promise<string> {
    if (!vaultRoot) return "";
    try {
        const meta = await readMeta(vaultRoot);
        if (!Array.isArray(meta.templates) || !meta.templateDefaults) return "";
        const root = norm(vaultRoot).replace(/\/+$/, "");
        const d = norm(dir);
        if (!d.startsWith(root + "/")) return "";
        const first = d.slice(root.length + 1).split("/")[0];
        const cat = (meta.categories || []).find((c: any) => c.dirName && c.dirName === first);
        if (!cat) return "";
        const key = opts.section ? `${cat.id}:${opts.section}` : cat.id;
        const t = meta.templates.find((x: NoteTemplate) => x.id === meta.templateDefaults[key]);
        if (!t || !String(t.body || "").trim()) return "";
        return expandTemplate(String(t.body), opts.date).replace(/\s+$/, "") + "\n";
    } catch {
        return "";
    }
}

// ── Optional presets (nothing is applied unless the user adds one) ──────
export interface TemplatePreset {
    id: string;
    name: string;
    icon: string;
    description: string;
    body: string;
}

export const TEMPLATE_PRESETS: TemplatePreset[] = [
    {
        id: "daily-reflection",
        name: "Daily Reflection",
        icon: "🌅",
        description: "Gratitude, the day, lessons, tomorrow",
        body: `## Gratitude
        -

        ## What happened today


        ## What I'm learning


        ## Tomorrow
        - [ ] `,
    },
{
    id: "morning-devotion",
    name: "Morning Devotion",
    icon: "☀️",
    description: "Scripture, reflection, prayer for the day",
    body: `## {{weekday}} Devotion

    **Passage:**

    ## What stood out


    ## What I'm asking God for today
    `,
},
{
    id: "soap-study",
    name: "Bible Study (SOAP)",
    icon: "📖",
    description: "Scripture, Observation, Application, Prayer",
    body: `**Passage:**

    ## Scripture


    ## Observation
    What does it say?

    ## Application
    What does it mean for me?

    ## Prayer
    `,
},
{
    id: "prayer-acts",
    name: "Prayer (ACTS)",
    icon: "🙏",
    description: "Adoration, Confession, Thanksgiving, Supplication",
    body: `## Adoration


    ## Confession


    ## Thanksgiving


    ## Supplication
    `,
},
{
    id: "sermon-notes",
    name: "Sermon Notes",
    icon: "⛪",
    description: "Speaker, passage, points, takeaways",
    body: `**Speaker:**
    **Passage:**
    **Date:** {{date}}

    ## Main points
    -

    ## Key verses


    ## Takeaways
    - [ ] `,
},
{
    id: "testimony",
    name: "Testimony Outline",
    icon: "❤️",
    description: "Before, what happened, after",
    body: `## Before


    ## What happened


    ## What changed
    `,
},
{
    id: "weekly-review",
    name: "Weekly Review",
    icon: "🗓️",
    description: "Wins, struggles, focus for next week",
    body: `## Wins
    -

    ## Struggles
    -

    ## What I'm carrying into next week
    - [ ] `,
},
{
    id: "dream-log",
    name: "Dream Log",
    icon: "🌙",
    description: "What happened, feelings, meaning",
    body: `## The dream


    ## How it felt


    ## Possible meaning
    `,
},
{
    id: "jesus-challenge",
    name: "Jesus Challenge (J.E.S.U.S.)",
    icon: "🕊️",
    description: "Journal, Experience, Study, Understand, Speak — a full daily session",
    body: `# {{weekday}}, {{date}}

    **Verse of the day:**

    ---

    ## J — Journal
    *Talk to Jesus like a friend. What's on your heart today?*

    Hi Jesus,




    ## E — Experience
    *Worship. Sit in His presence. Listen.*




    ## S — Study
    *Write the verse. Say it out loud. Memorize it.*

    >




    ## U — Understand
    *What does this teach me about God, myself, and how to apply it?*

    **About God:**


    **About myself:**


    **How to apply it:**




    ## S — Speak
    *Turn it into a prayer. Declare the verse over your life.*




    ---

    **Prayer requests:**
    - `,
},
];
