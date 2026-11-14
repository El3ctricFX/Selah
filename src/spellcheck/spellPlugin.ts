// src/spellcheck/spellPlugin.ts
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { getSpell, isSpellcheckEnabled, getIgnoreList, getNoteIgnoreList } from "./spellcheck";

export const SpellPluginKey = new PluginKey("spellcheck");

export const spellPlugin = new Plugin({
    key: SpellPluginKey,
    state: {
        init: () => DecorationSet.empty,
                                      apply: (tr, old) => {
                                          const meta = tr.getMeta(SpellPluginKey);
                                          if (meta instanceof DecorationSet) return meta;
                                          if (meta === "clear") return DecorationSet.empty;
                                          if (tr.docChanged) return old; // will be rebuilt by the checker
                                          return old.map(tr.mapping, tr.doc);
                                      },
    },
    props: {
        decorations(state) {
            return SpellPluginKey.getState(state) as DecorationSet;
        },
    },
});

const isLetter = (c: string) => /[A-Za-z']/.test(c);

/** Anything we don't want to flag. */
function isSkippableWord(raw: string): boolean {
    if (raw.length < 2) return true;
    if (/^\d+$/.test(raw)) return true;
    if (/^[A-Z]{2,5}$/.test(raw)) return true; // acronym
    if (raw.startsWith("'") || raw.endsWith("'")) return true;
    if (raw.toLowerCase() === "ok") return false; // let nspell decide
    return false;
}

/**
 * Walk the doc, check every word, and build a DecorationSet.
 * Skips code blocks, links, and anything that looks like a URL/email.
 */
export async function computeSpellDecorations(
    doc: PMNode,
    notePath: string,
    frontmatterIgnore: string[] = []
): Promise<DecorationSet> {
    if (!isSpellcheckEnabled()) return DecorationSet.empty;

    const spell = await getSpell();
    if (!spell) return DecorationSet.empty;

    const ignore = new Set([...getIgnoreList(), ...frontmatterIgnore.map(w => w.toLowerCase())]);
    const decos: Decoration[] = [];
    const cache = new Map<string, boolean>(); // word(lowercase) → isWrong

    doc.descendants((node, pos) => {
        if (!node.isText || !node.text) return;

        // Skip inline code.
        const marks = node.marks || [];
        if (marks.some((m) => m.type.name === "code")) return;
        // Skip text inside a link — links point at arbitrary URLs.
        if (marks.some((m) => m.type.name === "link")) return;

        const text = node.text;
        let i = 0;
        while (i < text.length) {
            if (!isLetter(text[i])) { i++; continue; }
            const start = i;
            while (i < text.length && isLetter(text[i])) i++;
            const end = i;
            const raw = text.slice(start, end);

            if (isSkippableWord(raw)) continue;

            const lower = raw.toLowerCase();
            if (ignore.has(lower)) continue;

            let wrong: boolean;
            if (cache.has(lower)) {
                wrong = cache.get(lower)!;
            } else {
                // nspell.correct() is happy with either casing.
                wrong = !(spell.correct(raw) || spell.correct(lower));
                cache.set(lower, wrong);
            }
            if (!wrong) continue;

            decos.push(
                Decoration.inline(pos + start, pos + end, {
                    class: "spell-error",
                    "data-word": raw,
                }),
            );
        }
    });

    return DecorationSet.create(doc, decos);
}

export function applySpellDecorations(view: any, decos: DecorationSet) {
    if (!view?.state?.tr) return;
    try {
        view.dispatch(view.state.tr.setMeta(SpellPluginKey, decos));
    } catch {}
}

export function clearSpellDecorations(view: any) {
    if (!view?.state?.tr) return;
    try {
        view.dispatch(view.state.tr.setMeta(SpellPluginKey, "clear"));
    } catch {}
}
