// src/spellcheck/spellcheck.ts
import nspell, { type NSpell } from "nspell";

const IGNORE_KEY = "selah.spell.ignore";
const CUSTOM_KEY = "selah.spell.custom";
const ENABLED_KEY = "selah.spell.enabled";

// Words that shouldn't be flagged (app names, tech terms, common modern words)
const DEFAULT_CUSTOM_WORDS = [
  "selah", "addons", "addon", "tauri", "blocknote", "webview", "webkit",
  "json", "csv", "pdf", "png", "jpg", "jpeg", "webp", "gif", "svg",
  "html", "css", "js", "ts", "jsx", "tsx", "api", "url", "urls",
  "discord", "instagram", "imessage", "whatsapp", "twitter", "messenger",
  "telegram", "signal", "reddit", "youtube", "tiktok", "spotify"
];

let cached: NSpell | null = null;
let loadPromise: Promise<NSpell | null> | null = null;

function readList(key: string): string[] {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
    } catch {
        return [];
    }
}
function writeList(key: string, list: string[]) {
    try {
        localStorage.setItem(key, JSON.stringify(list));
    } catch {}
}

export function isSpellcheckEnabled(): boolean {
    try {
        const v = localStorage.getItem(ENABLED_KEY);
        if (v === null) return true;
        return v === "true";
    } catch {
        return true;
    }
}

export function setSpellcheckEnabled(on: boolean) {
    try {
        localStorage.setItem(ENABLED_KEY, String(on));
    } catch {}
    window.dispatchEvent(new Event("spellcheck-changed"));
}

export function getIgnoreList(): string[] {
    return readList(IGNORE_KEY);
}

export function getCustomDictionary(): string[] {
    const custom = readList(CUSTOM_KEY);
    const merged = new Set([...DEFAULT_CUSTOM_WORDS, ...custom]);
    return Array.from(merged);
}

export function addToCustomDictionary(word: string) {
    const w = word.toLowerCase();
    const list = readList(CUSTOM_KEY);
    if (!list.includes(w)) {
        list.push(w);
        writeList(CUSTOM_KEY, list);
    }
    // If it was on the ignore list, promote it to "known".
    const ignore = readList(IGNORE_KEY);
    if (ignore.includes(w)) {
        writeList(IGNORE_KEY, ignore.filter((x) => x !== w));
    }
    if (cached) {
        try { cached.add(w); } catch {}
    }
    window.dispatchEvent(new Event("spellcheck-changed"));
}

export function removeFromCustomDictionary(word: string) {
    const w = word.toLowerCase();
    writeList(CUSTOM_KEY, readList(CUSTOM_KEY).filter((x) => x !== w));
    // Reload so the word isn't in the in-memory nspell instance.
    cached = null;
    loadPromise = null;
    window.dispatchEvent(new Event("spellcheck-changed"));
}

export function addToIgnoreList(word: string) {
    const w = word.toLowerCase();
    const list = readList(IGNORE_KEY);
    if (!list.includes(w)) {
        list.push(w);
        writeList(IGNORE_KEY, list);
    }
    // If it was a custom word, drop it from the dictionary too.
    const custom = readList(CUSTOM_KEY);
    if (custom.includes(w)) {
        writeList(CUSTOM_KEY, custom.filter((x) => x !== w));
    }
    window.dispatchEvent(new Event("spellcheck-changed"));
}

// ── Note-specific ignore list ──────────────────────────────────────────
export function getNoteIgnoreList(notePath: string): string[] {
    try {
        const raw = localStorage.getItem(`selah.spell.note_ignore.${notePath}`);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
    } catch {
        return [];
    }
}

export function addToNoteIgnoreList(notePath: string, word: string) {
    const w = word.toLowerCase();
    const key = `selah.spell.note_ignore.${notePath}`;
    const list = getNoteIgnoreList(notePath);
    if (!list.includes(w)) {
        list.push(w);
        try {
            localStorage.setItem(key, JSON.stringify(list));
        } catch {}
    }
    window.dispatchEvent(new Event("spellcheck-changed"));
}

export function removeFromIgnoreList(word: string) {
    const w = word.toLowerCase();
    writeList(IGNORE_KEY, readList(IGNORE_KEY).filter((x) => x !== w));
    window.dispatchEvent(new Event("spellcheck-changed"));
}

export function clearIgnoreList() {
    writeList(IGNORE_KEY, []);
    window.dispatchEvent(new Event("spellcheck-changed"));
}

/**
 * Lazily load the bundled Hunspell dictionary. Fails gracefully if the
 * files are missing — spell check just stays off.
 */
const CONTRACTIONS = [
    "i'm", "i've", "i'll", "i'd", "you're", "you've", "you'll", "you'd",
"he's", "he'll", "he'd", "she's", "she'll", "she'd", "it's", "it'll", "it'd",
"we're", "we've", "we'll", "we'd", "they're", "they've", "they'll", "they'd",
"that's", "there's", "what's", "who's", "where's", "when's", "why's", "how's",
"isn't", "aren't", "wasn't", "weren't", "haven't", "hasn't", "hadn't",
"don't", "doesn't", "didn't", "won't", "wouldn't", "shan't", "shouldn't",
"can't", "couldn't", "mustn't", "let's", "that'd", "there'd", "what'd",
"who'd", "where'd", "when'd", "why'd", "how'd", "here's"
];

export async function getSpell(): Promise<NSpell | null> {
    if (cached) return cached;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
        try {
            const [affRes, dicRes] = await Promise.all([
                fetch("/dictionaries/en_US.aff"),
                                                       fetch("/dictionaries/en_US.dic"),
            ]);
            if (!affRes.ok || !dicRes.ok) {
                console.warn(
                    "[spellcheck] could not load dictionary — expected " +
                    "public/dictionaries/en_US.{aff,dic}. " +
                    `aff=${affRes.status} dic=${dicRes.status}`,
                );
                return null;
            }
            const aff = await affRes.text();
            const dic = await dicRes.text();
            const sp = nspell(aff, dic);

            // Inject standard contractions and custom words so the engine
            // actually recognizes them as valid.
            const custom = getCustomDictionary();
            for (const w of [...custom, ...CONTRACTIONS]) {
                try { sp.add(w); } catch {}
            }
            cached = sp;
            return sp;
        } catch (e) {
            console.warn("[spellcheck] failed to initialize:", e);
            return null;
        }
    })();

    return loadPromise;
}
