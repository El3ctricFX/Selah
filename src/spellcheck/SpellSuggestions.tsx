// src/spellcheck/SpellSuggestions.tsx
import { useEffect, useRef, useState } from "react";
import { BookPlus, Ban, Check } from "lucide-react";
import {
    getSpell,
    addToCustomDictionary,
} from "./spellcheck";

export interface SpellSuggestionsState {
    x: number;
    y: number;
    word: string;
    from: number;
    to: number;
}

export default function SpellSuggestions({
    state,
    onReplace,
    onClose,
    onChanged,
    onIgnoreWord,
}: {
    state: SpellSuggestionsState;
    onReplace: (replacement: string, from: number, to: number) => void;
    onClose: () => void;
    onChanged: () => void;
    onIgnoreWord: (word: string) => void;
}) {
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setSuggestions([]);
        getSpell().then((spell) => {
            if (cancelled) return;
            if (!spell) {
                setLoading(false);
                return;
            }

            const word = state.word;
            const lower = word.toLowerCase();
            const suggestions = new Set<string>();

            const add = (w: string) => {
                if (w !== word) suggestions.add(w);
            };

                // 1. Missing Apostrophe fix (dont -> don't, im -> i'm)
                for (let i = 1; i < lower.length; i++) {
                    const withApostrophe = lower.slice(0, i) + "'" + lower.slice(i);
                    if (spell.correct(withApostrophe)) add(withApostrophe);
                }

                // 1b. Contraction 's fix (heres -> here's)
                if (lower.endsWith("s") && lower.length > 2) {
                    const base = lower.slice(0, -1);
                    if (spell.correct(base)) add(base + "'s");
                }

                // 2. Extra letter (Deletions) (wasl -> was)
                for (let i = 0; i < lower.length; i++) {
                    const deleted = lower.slice(0, i) + lower.slice(i + 1);
                    if (deleted.length > 1 && spell.correct(deleted)) add(deleted);
                }

                // 3. Missing letter (Insertions) (ike -> like, bike)
                const alphabet = "abcdefghijklmnopqrstuvwxyz";
                for (let i = 0; i <= lower.length; i++) {
                    for (const char of alphabet) {
                        const inserted = lower.slice(0, i) + char + lower.slice(i);
                        if (spell.correct(inserted)) add(inserted);
                    }
                }

                // 4. Transposed letters (Swaps)
                for (let i = 0; i < lower.length - 1; i++) {
                    const swapped = lower.slice(0, i) + lower[i + 1] + lower[i] + lower.slice(i + 2);
                    if (spell.correct(swapped)) add(swapped);
                }

                // 5. Replaced letter (Typos)
                for (let i = 0; i < lower.length; i++) {
                    for (const char of alphabet) {
                        const replaced = lower.slice(0, i) + char + lower.slice(i + 1);
                        if (spell.correct(replaced)) add(replaced);
                    }
                }

                // 6. Standard Hunspell suggestions
                for (const s of spell.suggest(word)) add(s);

                // ── Sort and score the candidates ──────────────────────────────
                // A hardcoded frequency list of the most common English words and
                // contractions. This guarantees that "was" beats "wall", and "i'm"
                // beats "if" or "in", regardless of Hunspell's distance scoring.
                const COMMON_WORDS = new Set([
                    "the", "be", "to", "of", "and", "a", "in", "that", "have", "i",
                    "it", "for", "not", "on", "with", "he", "as", "you", "do", "at",
                    "this", "but", "his", "by", "from", "they", "we", "say", "her", "she",
                    "or", "an", "will", "my", "one", "all", "would", "there", "their", "what",
                    "so", "up", "out", "if", "about", "who", "get", "which", "go", "me",
                    "when", "make", "can", "like", "time", "no", "just", "him", "know", "take",
                    "people", "into", "year", "your", "good", "some", "could", "them", "see", "other",
                    "than", "then", "now", "look", "only", "come", "its", "over", "think", "also",
                    "back", "after", "use", "two", "how", "our", "work", "first", "well", "way",
                    "even", "new", "want", "because", "any", "these", "give", "day", "most", "us",
                    "was", "is", "are", "were", "been", "has", "had", "did", "does", "doing",
                    "i'm", "don't", "that's", "aren't", "can't", "won't", "isn't", "wasn't",
                    "weren't", "here's", "there's", "what's", "who's", "where's", "when's",
                    "why's", "how's", "i've", "i'll", "i'd", "you're", "you've", "you'll",
                    "you'd", "he's", "he'll", "he'd", "she's", "she'll", "she'd", "it's",
                    "it'll", "it'd", "we're", "we've", "we'll", "we'd", "they're", "they've",
                    "they'll", "they'd"
                ]);

                const scored = Array.from(suggestions).map((s) => {
                    let score = 0;
                    const sLower = s.toLowerCase();

                    // Massive priority for common English words
                    if (COMMON_WORDS.has(sLower)) score += 100;

                    // Prioritize words that are the same length or 1 char off
                    if (s.length === word.length) score += 10;
                    if (s.length === word.length - 1) score += 5;
                    if (s.length === word.length + 1) score += 5;

                    // Casing penalties (stop "Ike" and "ASL" from showing up first)
                    const isAllCaps = word === word.toUpperCase();
                    const isCapitalized = word[0] === word[0].toUpperCase() && word.slice(1) === word.slice(1).toLowerCase();

                    if (isAllCaps && s !== s.toUpperCase()) score -= 5;
                    if (!isAllCaps && s === s.toUpperCase() && s.length > 1) score -= 20;
                    if (!isCapitalized && !isAllCaps && s[0] === s[0].toUpperCase() && s.slice(1) === s.slice(1).toLowerCase()) score -= 10;

                    // Don't suggest tiny 2-3 letter words for long typos
                    if (s.length <= 3 && word.length >= 5) score -= 10;

                    // Massive boost for inserting a missing apostrophe
                    if (!word.includes("'") && s.includes("'")) score += 80;

                    return { s, score };
                });

                // Highest score first, then alphabetical
                scored.sort((a, b) => {
                    if (b.score !== a.score) return b.score - a.score;
                    return a.s.localeCompare(b.s);
                });

                const list = scored.map((x) => x.s).slice(0, 8);

                if (cancelled) return;
                setSuggestions(list);
            setLoading(false);
        });
        return () => {
            cancelled = true;
        };
    }, [state.word]);

    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            if (ref.current?.contains(e.target as Node)) return;
            onClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
            document.addEventListener("mousedown", onDown);
            document.addEventListener("keydown", onKey);
            return () => {
                document.removeEventListener("mousedown", onDown);
                document.removeEventListener("keydown", onKey);
            };
    }, [onClose]);

    const W = 240;
    const left = Math.max(8, Math.min(state.x, window.innerWidth - W - 8));
    const top = Math.max(8, Math.min(state.y, window.innerHeight - 280));

    return (
        <div
        ref={ref}
        data-menu
        className="fixed z-[600] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-2xl py-1 w-[240px]"
        style={{ top, left }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        >
        <div className="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-gray-500 truncate">
        {loading
            ? `Checking "${state.word}"…`
            : suggestions.length > 0
            ? `"${state.word}"`
            : `No suggestions for "${state.word}"`}
            </div>

            {suggestions.map((s) => (
                <button
                key={s}
                type="button"
                onClick={() => {
                    onReplace(s, state.from, state.to);
                    onClose();
                }}
                className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
                >
                <Check size={12} className="text-blue-400 flex-shrink-0" />
                <span className="truncate">{s}</span>
                </button>
            ))}

            <div className="border-t border-[#2a3136] mt-1 pt-1">
            <button
            type="button"
            onClick={() => {
                addToCustomDictionary(state.word);
                onChanged();
                onClose();
            }}
            className="w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center gap-2"
            >
            <BookPlus size={12} /> Add to dictionary
            </button>
            <button
            type="button"
            onClick={() => {
                onIgnoreWord(state.word);
                onChanged();
                onClose();
            }}
            className="w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center gap-2"
            >
            <Ban size={12} /> Ignore in this note
            </button>
            </div>
            </div>
    );
}
