// src/noteFormat.ts
import type { BlockNoteEditor } from "@blocknote/core";

export interface Frontmatter {
  icon?: string;
  title?: string;
  color?: string;
  coverType?: string;
  coverValue?: string;
  coverPosX?: number;
  coverPosY?: number;
  coverOpacity?: number;
  coverBlur?: number;
  coverRadius?: number;
  coverFeather?: number;
  coverTextShadow?: boolean;
  iconAnchor?: string;
  iconX?: number;
  iconY?: number;
  titleAnchor?: string;
  titleX?: number;
  titleY?: number;
  titleFont?: string;
  docWidth?: string;
  created?: string;
  modified?: string;
  mode?: string;
  tags?: string[];
  [key: string]: unknown;
}

/** Keys we always leave as plain strings, never quote. */
const PLAIN_STRING_KEYS = new Set([
  "icon", "color", "coverType", "coverValue", "iconAnchor", "titleAnchor",
  "titleFont", "docWidth", "mode", "created", "modified",
]);

function isRiskyString(v: string): boolean {
  if (!v) return false;
  if (/[\r\n:#]/.test(v)) return true;
  if (/^[-\[\{>]/.test(v)) return true;
  if (v === "true" || v === "false") return true;
  if (/^-?\d+(\.\d+)?$/.test(v)) return true;
  if (v.startsWith("[") && v.endsWith("]")) return true;
  if (v.startsWith("{") && v.endsWith("}")) return true;
  return false;
}

export function parseNoteFile(raw: string): { frontmatter: Frontmatter; body: string } {
  // Strip a UTF-8 BOM and any leading whitespace/blank lines before we try to
  // match the frontmatter block. Without this, a file that starts with
  // "\uFEFF---" or "\n---" is treated as pure body and all frontmatter is lost.
  const cleaned = raw.replace(/^\uFEFF/, "").replace(/^[ \t]*\r?\n/, "");
  const match = cleaned.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };

  const fm: Frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (!key) continue;

    // JSON-quoted strings get unquoted with proper escape handling.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      if (val.startsWith('"')) {
        try {
          fm[key] = JSON.parse(val);
          continue;
        } catch {
          // fall through to plain strip
        }
      }
      fm[key] = val.slice(1, -1);
      continue;
    }

    if (val.startsWith("[") && val.endsWith("]")) {
      fm[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (val === "true") {
      fm[key] = true;
    } else if (val === "false") {
      fm[key] = false;
    } else if (/^-?\d+(\.\d+)?$/.test(val)) {
      fm[key] = Number(val);
    } else {
      fm[key] = val;
    }
  }
  return { frontmatter: fm, body: match[2] };
}

export function serializeNoteFile(fm: Frontmatter, body: string): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v === "") continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}: [${v.join(", ")}]`);
    } else if (typeof v === "string") {
      // Safety: any string value that contains a newline, colon, or other
      // YAML-significant character gets JSON-quoted so parsing on the next
      // read can't misinterpret it (and so multi-line values don't shred the
      // frontmatter block into extra keys).
      if (!PLAIN_STRING_KEYS.has(k) && isRiskyString(v)) {
        lines.push(`${k}: ${JSON.stringify(v)}`);
      } else {
        // Even "plain" keys are safe to quote if they contain newlines — do
        // it, because otherwise a newline splits into two frontmatter keys.
        if (/[\r\n]/.test(v)) {
          lines.push(`${k}: ${JSON.stringify(v)}`);
        } else {
          lines.push(`${k}: ${v}`);
        }
      }
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  const fmBlock = lines.length ? `---\n${lines.join("\n")}\n---\n\n` : "";
  return `${fmBlock}${body.trimEnd()}\n`;
}

interface ColumnSpec {
  width: string;
  content: string;
}

interface Segment {
  kind: "md" | "columns" | "callout" | "bookmark" | "video";
  text?: string;
  columns?: ColumnSpec[];
  callout?: { icon: string; color: string; inner: string };
  bookmark?: {
    url: string;
    title: string;
    description: string;
    icon: string;
    image: string;
    mode: "bookmark" | "embed";
  };
  video?: {
    src: string;
    caption: string;
    fileName: string;
  };
}

function parseAttrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out[m[1]] = m[2];
  return out;
}

function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#10;/g, "\n");
}

function escAttr(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, " ");
}

/**
 * `::: <keyword>` lines that open a *nested* block whose body is terminated
 * by a matching bare `:::`. These must increment nesting depth so the parser
 * doesn't mistake a nested closer for the enclosing block's closer.
 */
const NESTED_BLOCK_RE = /^:::\s+(columns|column|callout)\b/;

/**
 * `::: <keyword>` lines for blocks that carry all their data on the opening
 * line and have no body / closer. They never affect nesting depth.
 */
const SELF_CONTAINED_BLOCK_RE = /^:::\s+(bookmark|video)\b/;

/**
 * Scan forward from `start` looking for the bare `:::` that closes the block
 * we're already inside. Tracks nesting depth: nested `:::` openers increment
 * it, bare `:::` lines decrement it, and we return when depth would go below
 * zero (i.e. we found the closer for our block).
 *
 * Self-contained blocks (`::: bookmark`, `::: video`) don't affect depth —
 * they have no body and no closer.
 *
 * Returns the lines strictly between the fences (excluding the opening line
 * and the closing `:::`) plus the index just past the closer.
 */
function readUntilCloser(
  lines: string[],
  start: number
): { content: string[]; end: number } {
  const content: string[] = [];
  let depth = 0;
  let i = start;
  while (i < lines.length) {
    const t = lines[i].trim();

    if (SELF_CONTAINED_BLOCK_RE.test(t)) {
      content.push(lines[i]);
      i++;
      continue;
    }

    if (NESTED_BLOCK_RE.test(t)) {
      depth++;
      content.push(lines[i]);
      i++;
      continue;
    }

    if (t === ":::") {
      if (depth === 0) {
        return { content, end: i + 1 };
      }
      depth--;
      content.push(lines[i]);
      i++;
      continue;
    }

    content.push(lines[i]);
    i++;
  }

  // Malformed input — no closer found. Treat EOF as the close.
  return { content, end: i };
}

function splitNoteBody(body: string): Segment[] {
  const lines = body.split(/\r?\n/);
  const out: Segment[] = [];
  let buf: string[] = [];
  let i = 0;

  const flush = () => {
    if (buf.length) {
      out.push({ kind: "md", text: buf.join("\n") });
      buf = [];
    }
  };

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (trimmed === "::: columns") {
      flush();
      i++;
      const { content, end } = readUntilCloser(lines, i);
      i = end;

      // The columns body is a sequence of `::: column width="..."` blocks.
      // Each column's own content may itself contain nested `:::` blocks;
      // readUntilCloser handles that when we recurse per column.
      const cols: ColumnSpec[] = [];
      let j = 0;
      while (j < content.length) {
        const line = content[j].trim();
        if (line === "::: column" || line.startsWith("::: column ")) {
          const attrs = parseAttrs(line);
          const width = attrs.width || "1fr";
          j++;
          const { content: colContent, end: colEnd } = readUntilCloser(content, j);
          j = colEnd;
          cols.push({
            width,
            content: colContent.join("\n").trimEnd(),
          });
        } else {
          j++;
        }
      }
      out.push({ kind: "columns", columns: cols });
      continue;
    }

    if (trimmed.startsWith("::: callout")) {
      flush();
      const attrs = parseAttrs(trimmed);
      i++;
      const { content: inner, end } = readUntilCloser(lines, i);
      i = end;
      out.push({
        kind: "callout",
        callout: {
          icon: attrs.icon || "💡",
          color: attrs.color || "gray",
          inner: inner.join("\n").trimEnd(),
        },
      });
      continue;
    }

    if (trimmed.startsWith("::: bookmark")) {
      flush();
      const attrs = parseAttrs(trimmed);
      i++;
      // Bookmarks have no body. Older files have no closer; new ones don't
      // either — but be lenient and skip a bare `:::` if present.
      if (i < lines.length && lines[i].trim() === ":::") i++;
      const mode = attrs.mode === "embed" ? "embed" : "bookmark";
      out.push({
        kind: "bookmark",
        bookmark: {
          url: unescapeAttr(attrs.url || ""),
          title: unescapeAttr(attrs.title || ""),
          description: unescapeAttr(attrs.description || ""),
          icon: unescapeAttr(attrs.icon || ""),
          image: unescapeAttr(attrs.image || ""),
          mode,
        },
      });
      continue;
    }

    if (trimmed.startsWith("::: video")) {
      flush();
      const attrs = parseAttrs(trimmed);
      i++;
      if (i < lines.length && lines[i].trim() === ":::") i++;
      out.push({
        kind: "video",
        video: {
          src: unescapeAttr(attrs.src || ""),
          caption: unescapeAttr(attrs.caption || ""),
          fileName: unescapeAttr(attrs.fileName || ""),
        },
      });
      continue;
    }

    buf.push(lines[i]);
    i++;
  }

  flush();
  return out;
}

/**
 * Canonicalize a column width to a value `@blocknote/xl-multi-column` can
 * actually use.
 *
 * The library stores width in one of two shapes:
 *   - the literal string "1fr" for flexible sizing
 *   - a NUMBER in pixels after the user drags the resize handle
 *
 * Its drag handler has a bug: if it's given a string it can't numerically
 * coerce (like "1fr"), it falls into a `currentWidth + delta` path where
 * `delta` is NaN, and produces values like "1frNaNNaNNaN". That garbage
 * round-trips through the serializer verbatim, and on the next load the
 * library can't parse it — so it silently refuses to attach a resize handle
 * and the column stays frozen.
 *
 * We collapse every known-bad shape back to a value the library understands.
 * Corrupted files self-heal on open, and the library's output can never be
 * persisted in a broken state either.
 *
 * Returns: a positive number (pixels), an fr string like "2fr", or "1fr".
 */
function sanitizeColumnWidth(raw: unknown): string | number {
  if (raw === undefined || raw === null) return "1fr";

  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : "1fr";
  }

  const trimmed = String(raw).trim();
  if (!trimmed) return "1fr";

  // Exact "Nfr" — the only fr form the library emits. Preserve it as a string.
  const frMatch = trimmed.match(/^(\d+(?:\.\d+)?)fr$/);
  if (frMatch) {
    const n = Number(frMatch[1]);
    return Number.isFinite(n) && n > 0 ? `${frMatch[1]}fr` : "1fr";
  }

  // Bare number: "312", "0.5"
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : "1fr";
  }

  // "300px"
  const pxMatch = trimmed.match(/^(\d+(?:\.\d+)?)px$/);
  if (pxMatch) {
    const n = Number(pxMatch[1]);
    return Number.isFinite(n) && n > 0 ? n : "1fr";
  }

  // Anything else is corruption ("1frNaNNaN…", "NaN", "undefined", …) that
  // would break `grid-template-columns` and kill the resize handle. Reset.
  return "1fr";
}

function decodeColumnWidth(raw: unknown): string | number {
  return sanitizeColumnWidth(raw);
}

function encodeColumnWidth(raw: unknown): string {
  return String(sanitizeColumnWidth(raw));
}

async function parseBodyToBlocks(
  editor: BlockNoteEditor<any, any, any>,
  body: string
): Promise<any[]> {
  const segments = splitNoteBody(body);
  const blocks: any[] = [];

  for (const seg of segments) {
    if (seg.kind === "md") {
      if (!seg.text?.trim()) continue;
      const parsed = await editor.tryParseMarkdownToBlocks(seg.text);
      blocks.push(...parsed);
    } else if (seg.kind === "columns") {
      const columnChildren = await Promise.all(
        (seg.columns || []).map(async (col) => {
          // Recurse so callouts / bookmarks / videos nested inside a column
          // survive the round-trip. The previous implementation called
          // tryParseMarkdownToBlocks directly, which silently dropped them.
          const inner = await parseBodyToBlocks(editor, col.content || "");
          return {
            type: "column",
            props: { width: decodeColumnWidth(col.width) },
            children: inner.length ? inner : [{ type: "paragraph" }],
          };
        })
      );
      if (columnChildren.length) {
        blocks.push({ type: "columnList", children: columnChildren });
      }
    } else if (seg.kind === "callout") {
      const innerText = seg.callout?.inner || "";
      let content: any[] = [];
      if (innerText.trim()) {
        const parsed = await editor.tryParseMarkdownToBlocks(innerText);
        const first = parsed[0]?.content;
        content = Array.isArray(first) ? first : [];
      }
      blocks.push({
        type: "callout",
        props: {
          icon: seg.callout?.icon || "💡",
          color: seg.callout?.color || "gray",
        },
        content,
      });
    } else if (seg.kind === "bookmark") {
      const b = seg.bookmark!;
      blocks.push({
        type: "bookmark",
        props: {
          url: b.url,
          title: b.title,
          description: b.description,
          icon: b.icon,
          image: b.image,
          mode: b.mode,
        },
      });
    } else if (seg.kind === "video") {
      const v = seg.video!;
      blocks.push({
        type: "video",
        props: {
          src: v.src,
          caption: v.caption,
          fileName: v.fileName,
        },
      });
    }
  }

  return blocks.length ? blocks : [{ type: "paragraph" }];
}

export async function noteBodyToBlocks(
  editor: BlockNoteEditor<any, any, any>,
  body: string
): Promise<any[]> {
  return parseBodyToBlocks(editor, body);
}

async function serializeBlockList(
  editor: BlockNoteEditor<any, any, any>,
  blocks: any[]
): Promise<string> {
  const chunks: string[] = [];
  let pending: any[] = [];

  const flush = async () => {
    if (!pending.length) return;
    const md = await editor.blocksToMarkdownLossy(pending);
    if (md.trim()) chunks.push(md.trim());
    pending = [];
  };

  for (const block of blocks) {
    if (block.type === "columnList") {
      await flush();
      const colTexts: string[] = [];
      for (const col of block.children || []) {
        // Recurse so custom blocks inside columns serialize with their
        // correct `:::` fences instead of being dropped by the built-in
        // markdown serializer.
        const inner = await serializeBlockList(editor, col.children || []);
        const width = encodeColumnWidth(col.props?.width);
        colTexts.push(`::: column width="${width}"\n${inner.trimEnd()}\n:::`);
      }
      chunks.push(`::: columns\n${colTexts.join("\n")}\n:::`);
    } else if (block.type === "callout") {
      await flush();
      const inner = await editor.blocksToMarkdownLossy([
        { type: "paragraph", content: block.content },
      ]);
      const icon = (block.props?.icon as string) || "💡";
      const color = (block.props?.color as string) || "gray";
      chunks.push(
        `::: callout icon="${escAttr(icon)}" color="${escAttr(color)}"\n${inner.trim()}\n:::`
      );
    } else if (block.type === "bookmark") {
      await flush();
      const p = block.props || {};
      const mode = p.mode === "embed" ? "embed" : "bookmark";
      chunks.push(
        `::: bookmark mode="${mode}" url="${escAttr(p.url)}" title="${escAttr(
          p.title
        )}" description="${escAttr(p.description)}" icon="${escAttr(
          p.icon
        )}" image="${escAttr(p.image)}"`
      );
    } else if (block.type === "video") {
      await flush();
      const p = block.props || {};
      chunks.push(
        `::: video src="${escAttr(p.src)}" caption="${escAttr(
          p.caption
        )}" fileName="${escAttr(p.fileName)}"`
      );
    } else {
      pending.push(block);
    }
  }
  await flush();

  return chunks.join("\n\n");
}

export async function blocksToNoteBody(
  editor: BlockNoteEditor<any, any, any>,
  blocks: any[]
): Promise<string> {
  const body = await serializeBlockList(editor, blocks);
  return body + "\n";
}

export function flattenToObsidianMarkdown(raw: string): string {
  const { frontmatter, body } = parseNoteFile(raw);
  const segments = splitNoteBody(body);
  const out: string[] = [];

  for (const seg of segments) {
    if (seg.kind === "md") {
      out.push(seg.text || "");
    } else if (seg.kind === "columns") {
      (seg.columns || []).forEach((col, idx) => {
        out.push(`## Column ${idx + 1}\n\n${col.content}`);
      });
    } else if (seg.kind === "callout") {
      out.push(`> ${seg.callout?.icon || ""} ${seg.callout?.inner || ""}`);
    } else if (seg.kind === "bookmark") {
      const b = seg.bookmark!;
      out.push(`[${b.title || b.url}](${b.url})`);
    } else if (seg.kind === "video") {
      const v = seg.video!;
      out.push(`[${v.caption || "Video"}](${v.src})`);
    }
  }

  const {
    mode: _mode,
    coverType: _ct,
    coverValue: _cv,
    coverPosX: _cpx,
    coverPosY: _cpy,
    title: _t,
    coverOpacity: _co,
    coverBlur: _cb,
    coverRadius: _cr,
    coverFeather: _cf,
    coverTextShadow: _cts,
    iconAnchor: _ia,
    iconX: _ix,
    iconY: _iy,
    titleAnchor: _ta,
    titleX: _tx,
    titleY: _ty,
    titleFont: _tf,
    docWidth: _dw,
    ...exportFm
  } = frontmatter;
  return serializeNoteFile(exportFm, out.join("\n\n"));
}