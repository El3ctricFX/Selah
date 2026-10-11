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
  // match the frontmatter block.
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

    // `json:` prefix — used for arrays of objects (e.g. links) and any
    // non-primitive value that must round-trip through frontmatter verbatim.
    if (val.startsWith("json:")) {
      try {
        fm[key] = JSON.parse(val.slice(5));
        continue;
      } catch {
        // fall through to plain string handling
      }
    }

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
      // Simple arrays of short strings keep the classic [a, b, c] form.
      // Anything else — arrays of objects, strings with commas or newlines —
      // gets JSON-encoded behind the `json:` prefix so it round-trips.
      const simple = v.every(
        (x) => typeof x === "string" && !/[\n\r,]/.test(x)
      );
      if (simple) {
        lines.push(`${k}: [${v.join(", ")}]`);
      } else {
        lines.push(`${k}: json:${JSON.stringify(v)}`);
      }
    } else if (v !== null && typeof v === "object") {
      lines.push(`${k}: json:${JSON.stringify(v)}`);
    } else if (typeof v === "string") {
      // Safety: any string value that contains a newline, colon, or other
      // YAML-significant character gets JSON-quoted so parsing on the next
      // read can't misinterpret it.
      if (!PLAIN_STRING_KEYS.has(k) && isRiskyString(v)) {
        lines.push(`${k}: ${JSON.stringify(v)}`);
      } else {
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
  kind: "md" | "columns" | "callout" | "bookmark" | "video" | "scripture";
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
  scripture?: {
    reference: string;
    text: string;
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
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");
}

function escAttr(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#10;");
}

const NESTED_BLOCK_RE = /^:::\s+(columns|column|callout)\b/;
const SELF_CONTAINED_BLOCK_RE = /^:::\s+(bookmark|video|scripture)\b/;

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

    if (trimmed.startsWith("::: scripture")) {
      flush();
      const attrs = parseAttrs(trimmed);
      i++;
      if (i < lines.length && lines[i].trim() === ":::") i++;
      out.push({
        kind: "scripture",
        scripture: {
          reference: unescapeAttr(attrs.reference || ""),
          text: unescapeAttr(attrs.text || ""),
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

function sanitizeColumnWidth(raw: unknown): string | number {
  if (raw === undefined || raw === null) return "1fr";

  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : "1fr";
  }

  const trimmed = String(raw).trim();
  if (!trimmed) return "1fr";

  const frMatch = trimmed.match(/^(\d+(?:\.\d+)?)fr$/);
  if (frMatch) {
    const n = Number(frMatch[1]);
    return Number.isFinite(n) && n > 0 ? `${frMatch[1]}fr` : "1fr";
  }

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : "1fr";
  }

  const pxMatch = trimmed.match(/^(\d+(?:\.\d+)?)px$/);
  if (pxMatch) {
    const n = Number(pxMatch[1]);
    return Number.isFinite(n) && n > 0 ? n : "1fr";
  }

  return "1fr";
}

function decodeColumnWidth(raw: unknown): string | number {
  return sanitizeColumnWidth(raw);
}

function encodeColumnWidth(raw: unknown): string {
  return String(sanitizeColumnWidth(raw));
}

// ── Inline style markers ────────────────────────────────────────────────────
//
// BlockNote's markdown serializer only round-trips a subset of inline styles.
// textColor and backgroundColor are dropped entirely; underline survives on
// some platforms and not others. We smuggle all three through as invisible
// private-use characters around the text.
//
// Format:  <START><key=value;key=value;…><SEP>text<END>
//
// Keys:
//   c = textColor       (e.g. "c=blue")
//   b = backgroundColor (e.g. "b=yellow")
//   u = underline       (e.g. "u=1")
//
// Two rules keep this reliable:
//
//   1. NEVER let a marker pair span a newline. BlockNote splits text nodes at
//      hard breaks during the markdown round-trip, and a marker whose START,
//      SEP, and END end up in different text nodes can't be reassembled on
//      the way back — which is why color used to break on Shift+Enter. We
//      split the text at '\n' before encoding so each line gets its own
//      self-contained marker pair.
//
//   2. On decode, merge adjacent text nodes that share identical styles
//      first. This heals the case where markdown parsing split a marker pair
//      across nodes for any other reason.

const TC_START = "\uE000";
const TC_SEP = "\uE002";
const TC_END = "\uE001";

function hasEncodableStyles(styles: any): boolean {
  return !!(styles?.textColor || styles?.backgroundColor || styles?.underline);
}

function buildMarkerMeta(styles: any): string {
  const parts: string[] = [];
  if (styles?.textColor) parts.push(`c=${styles.textColor}`);
  if (styles?.backgroundColor) parts.push(`b=${styles.backgroundColor}`);
  if (styles?.underline) parts.push(`u=1`);
  return parts.join(";");
}

function parseMarkerMeta(meta: string): {
  textColor?: string;
  backgroundColor?: string;
  underline?: boolean;
} {
  // Legacy format (pre-fix): just the color name, e.g. "blue".
  if (!meta.includes("=")) {
    return { textColor: meta || undefined };
  }
  const result: {
    textColor?: string;
    backgroundColor?: string;
    underline?: boolean;
  } = {};
  for (const kv of meta.split(";")) {
    const eq = kv.indexOf("=");
    if (eq === -1) continue;
    const key = kv.slice(0, eq).trim();
    const val = kv.slice(eq + 1).trim();
    if (key === "c") result.textColor = val;
    else if (key === "b") result.backgroundColor = val;
    else if (key === "u") result.underline = val === "1" || val === "true";
  }
  return result;
}

function encodeColorsInContent(content: any[]): any[] {
  const out: any[] = [];
  for (const node of content) {
    if (node?.type === "text" && hasEncodableStyles(node.styles)) {
      const restStyles = { ...node.styles };
      delete restStyles.textColor;
      delete restStyles.backgroundColor;
      delete restStyles.underline;

      const meta = buildMarkerMeta(node.styles);
      const prefix = `${TC_START}${meta}${TC_SEP}`;

      // Split on '\n' and emit each line as its own self-contained run so
      // a marker pair never spans a hard break.
      const pieces = String(node.text).split(/(\n)/);
      for (const piece of pieces) {
        if (piece === "\n") {
          out.push({ type: "text", text: "\n", styles: restStyles });
        } else if (piece.length > 0) {
          out.push({
            type: "text",
            text: `${prefix}${piece}${TC_END}`,
            styles: restStyles,
          });
        }
      }
    } else if (node?.type === "link" && Array.isArray(node.content)) {
      out.push({ ...node, content: encodeColorsInContent(node.content) });
    } else {
      out.push(node);
    }
  }
  return out;
}

function encodeColorsInBlock(block: any): any {
  const next = { ...block };
  if (Array.isArray(block.content)) {
    next.content = encodeColorsInContent(block.content);
  }
  if (Array.isArray(block.children)) {
    next.children = block.children.map(encodeColorsInBlock);
  }
  return next;
}

function encodeColorsInBlocks(blocks: any[]): any[] {
  return blocks.map(encodeColorsInBlock);
}

function expandColorMarkers(text: string, baseStyles: any): any[] {
  const runs: any[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(TC_START, i);
    if (start === -1) {
      if (i < text.length) {
        runs.push({ type: "text", text: text.slice(i), styles: baseStyles });
      }
      break;
    }
    if (start > i) {
      runs.push({ type: "text", text: text.slice(i, start), styles: baseStyles });
    }
    const sep = text.indexOf(TC_SEP, start);
    if (sep === -1) {
      runs.push({ type: "text", text: text.slice(start), styles: baseStyles });
      break;
    }
    const end = text.indexOf(TC_END, sep);
    if (end === -1) {
      runs.push({ type: "text", text: text.slice(start), styles: baseStyles });
      break;
    }
    const meta = text.slice(start + TC_START.length, sep);
    const inner = text.slice(sep + TC_SEP.length, end);
    const style = parseMarkerMeta(meta);
    runs.push({
      type: "text",
      text: inner,
      styles: { ...baseStyles, ...style },
    });
    i = end + TC_END.length;
  }
  return runs;
}

/** Two style bags are "the same" if every truthy key matches. Falsy keys
 *  (undefined, false, "") are ignored so `{bold:false}` and `{}` compare
 *  equal — which is what we want for healing split markers. */
function sameStyles(a: any, b: any): boolean {
  const keysA = a ? Object.keys(a).filter((k) => a[k]) : [];
  const keysB = b ? Object.keys(b).filter((k) => b[k]) : [];
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => a[k] === b[k]);
}

function decodeColorsInContent(content: any[]): any[] {
  // Pass 1: merge adjacent text nodes that share identical styles.
  const merged: any[] = [];
  for (const node of content) {
    const prev = merged[merged.length - 1];
    if (
      prev?.type === "text" &&
      node?.type === "text" &&
      typeof prev.text === "string" &&
      typeof node.text === "string" &&
      sameStyles(prev.styles, node.styles)
    ) {
      merged[merged.length - 1] = { ...prev, text: prev.text + node.text };
    } else {
      merged.push(node);
    }
  }

  // Pass 2: decode markers.
  const out: any[] = [];
  for (const node of merged) {
    if (
      node?.type === "text" &&
      typeof node.text === "string" &&
      node.text.includes(TC_START)
    ) {
      out.push(...expandColorMarkers(node.text, node.styles || {}));
    } else if (node?.type === "link" && Array.isArray(node.content)) {
      out.push({ ...node, content: decodeColorsInContent(node.content) });
    } else {
      out.push(node);
    }
  }
  return out;
}

function decodeColorsInBlock(block: any): any {
  const next = { ...block };
  if (Array.isArray(block.content)) {
    next.content = decodeColorsInContent(block.content);
  }
  if (Array.isArray(block.children)) {
    next.children = block.children.map(decodeColorsInBlock);
  }
  return next;
}

function decodeColorsInBlocks(blocks: any[]): any[] {
  return blocks.map(decodeColorsInBlock);
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
      blocks.push(...decodeColorsInBlocks(parsed));
    } else if (seg.kind === "columns") {
      const columnChildren = await Promise.all(
        (seg.columns || []).map(async (col) => {
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
        const decoded = decodeColorsInBlocks(parsed);
        const first = decoded[0]?.content;
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
    } else if (seg.kind === "scripture") {
      const s = seg.scripture!;
      blocks.push({
        type: "scripture",
        props: {
          reference: s.reference,
          text: s.text,
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
    const md = await editor.blocksToMarkdownLossy(encodeColorsInBlocks(pending));
    if (md.trim()) chunks.push(md.trim());
    pending = [];
  };

  for (const block of blocks) {
    if (block.type === "columnList") {
      await flush();
      const colTexts: string[] = [];
      for (const col of block.children || []) {
        const inner = await serializeBlockList(editor, col.children || []);
        const width = encodeColumnWidth(col.props?.width);
        colTexts.push(`::: column width="${width}"\n${inner.trimEnd()}\n:::`);
      }
      chunks.push(`::: columns\n${colTexts.join("\n")}\n:::`);
    } else if (block.type === "callout") {
      await flush();
      const inner = await editor.blocksToMarkdownLossy(
        encodeColorsInBlocks([{ type: "paragraph", content: block.content }])
      );
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
    } else if (block.type === "scripture") {
      await flush();
      const p = block.props || {};
      chunks.push(
        `::: scripture reference="${escAttr(p.reference)}" text="${escAttr(
          p.text
        )}"`
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
    } else if (seg.kind === "scripture") {
      const s = seg.scripture!;
      out.push(`> **${s.reference}** (KJV)\n>\n> ${s.text}`);
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