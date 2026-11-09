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
  coverOverlayColor?: string;
  coverOverlayOpacity?: number;
  titleColor?: string;
  docWidth?: string;
  created?: string;
  modified?: string;
  mode?: string;
  tags?: string[];
  [key: string]: unknown;
}

const PLAIN_STRING_KEYS = new Set([
  "icon", "color", "coverType", "coverValue", "iconAnchor", "titleAnchor",
    "titleFont", "docWidth", "mode", "created", "modified",
  "coverOverlayColor", "titleColor",
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

    if (val.startsWith("json:")) {
      try {
        fm[key] = JSON.parse(val.slice(5));
        continue;
      } catch {
        // fall through to plain string handling
      }
    }

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

  // Normalize ONLY the trailing newlines: collapse a run of them to a
  // single newline. Everything else — leading whitespace, trailing spaces
  // on the last line, blank lines mid-file — is preserved verbatim. The
  // old code called `trimEnd()`, which silently deleted trailing blank
  // lines and spaces on every save.
  const normalizedBody = body.replace(/\n+$/, "");
  return normalizedBody ? `${fmBlock}${normalizedBody}\n` : fmBlock;
}

interface ColumnSpec {
  width: string;
  content: string;
}

interface Segment {
  kind: "md" | "columns" | "callout" | "bookmark" | "video" | "audio" | "attachment" | "scripture" | "dmarchive" | "imagegallery";
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
    meta: string;
  };
  video?: {
    src: string;
    caption: string;
    fileName: string;
  };
  audio?: {
    src: string;
    caption: string;
    fileName: string;
  };
  attachment?: {
    src: string;
    caption: string;
    fileName: string;
  };
  scripture?: {
    reference: string;
    text: string;
    collapsed: boolean;
  };
  dmarchive?: {
    platform: string;
    who: string;
    link: string;
    date: string;
    caption: string;
    collapsed: boolean;
    srcs: string;
  };
  imagegallery?: {
    grid: string;
    gap: number;
    colWidths: string;
    rowHeights: string;
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
const SELF_CONTAINED_BLOCK_RE = /^:::\s+(bookmark|video|audio|attachment|scripture|dmarchive|imagegallery)\b/;

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
          meta: unescapeAttr(attrs.meta || ""),
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

    if (trimmed.startsWith("::: audio")) {
      flush();
      const attrs = parseAttrs(trimmed);
      i++;
      if (i < lines.length && lines[i].trim() === ":::") i++;
      out.push({
        kind: "audio",
        audio: {
          src: unescapeAttr(attrs.src || ""),
          caption: unescapeAttr(attrs.caption || ""),
          fileName: unescapeAttr(attrs.fileName || ""),
        },
      });
      continue;
    }

    if (trimmed.startsWith("::: attachment")) {
      flush();
      const attrs = parseAttrs(trimmed);
      i++;
      if (i < lines.length && lines[i].trim() === ":::") i++;
      out.push({
        kind: "attachment",
        attachment: {
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
          collapsed: attrs.collapsed === "true",
        },
      });
      continue;
    }

    if (trimmed.startsWith("::: dmarchive")) {
      flush();
      const attrs = parseAttrs(trimmed);
      i++;
      if (i < lines.length && lines[i].trim() === ":::") i++;
      out.push({
        kind: "dmarchive",
        dmarchive: {
          platform: unescapeAttr(attrs.platform || "discord"),
          who: unescapeAttr(attrs.who || ""),
          link: unescapeAttr(attrs.link || ""),
          date: unescapeAttr(attrs.date || ""),
          caption: unescapeAttr(attrs.caption || ""),
          collapsed: attrs.collapsed === "true",
          srcs: unescapeAttr(attrs.srcs || ""),
        },
      });
      continue;
    }

    if (trimmed.startsWith("::: imagegallery")) {
      flush();
      const attrs = parseAttrs(trimmed);
      i++;
      if (i < lines.length && lines[i].trim() === ":::") i++;
      out.push({
        kind: "imagegallery",
        imagegallery: {
          grid: unescapeAttr(attrs.grid || "[]"),
               gap: attrs.gap ? Number(attrs.gap) : 8,
               colWidths: unescapeAttr(attrs.colWidths || "[]"),
               rowHeights: unescapeAttr(attrs.rowHeights || "[]"),
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
const TC_START = "{{";
const TC_SEP = "}}";
const TC_END = "{{/}}";

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

function hexToColorName(hex: string): string {
  if (!hex || !hex.startsWith("#")) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return hex;

  // Catch teal/cyan (like #00ffaa) and map it to green
  if (r < 80 && g > 180 && b > 100) return "green";

  if (g > 150 && r < 120 && b < 120) return "green";
  // Loosened the blue check from < 120 to < 180 to catch pale golds like #fedf8b (b=139)
  if (r > 200 && g > 180 && b < 180) return "yellow";
  if (r > 200 && g < 120 && b < 120) return "red";
  if (r > 200 && g > 100 && g < 200 && b < 120) return "orange";
  if (r < 120 && g > 100 && b > 150) return "blue";
  if (r > 150 && g < 120 && b > 150) return "purple";
  if (r > 200 && g < 150 && b > 150) return "pink";
  if (r < 100 && g < 100 && b < 100) return "gray";
  return "default";
}

function parseMarkerMeta(meta: string): {
  textColor?: string;
  backgroundColor?: string;
  underline?: boolean;
} {
  if (meta.startsWith("#")) {
    return { textColor: hexToColorName(meta) };
  }
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
    if (key === "c") result.textColor = hexToColorName(val);
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

  // Fallback: catch raw `c=#hex` or `c=colorname` strings that lost their invisible markers
  const out: any[] = [];
  for (const run of runs) {
    if (run.type === "text" && run.text.includes("c=")) {
      const parts = run.text.split(/(c=#[0-9a-fA-F]{3,6}|c=[a-zA-Z]+)/);
      for (let j = 0; j < parts.length; j++) {
        if (j % 2 === 1) {
          const colorStr = parts[j].replace("c=", "");
          const color = hexToColorName(colorStr);
          if (parts[j + 1] !== undefined) {
            out.push({ type: "text", text: parts[j + 1], styles: { ...run.styles, textColor: color } });
            j++;
          } else {
            out.push({ type: "text", text: parts[j], styles: run.styles });
          }
        } else if (parts[j]) {
          out.push({ type: "text", text: parts[j], styles: run.styles });
        }
      }
    } else {
      out.push(run);
    }
  }
  return out;
}

function sameStyles(a: any, b: any): boolean {
  const keysA = a ? Object.keys(a).filter((k) => a[k]) : [];
  const keysB = b ? Object.keys(b).filter((k) => b[k]) : [];
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => a[k] === b[k]);
}

function decodeColorsInContent(content: any[]): any[] {
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
  if (!Array.isArray(blocks)) return [];
  return blocks.map(decodeColorsInBlock);
}

// ── Image width encoding ────────────────────────────────────────────────────
const IMG_WIDTH_RE = /[?&]w=(\d+)$/;

function extractImageWidths(blocks: any[]): any[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.map((b) => {
    let next = b;
    if (b?.type === "image" && typeof b.props?.url === "string") {
      const m = b.props.url.match(IMG_WIDTH_RE);
      if (m) {
        const cleanUrl = b.props.url.slice(0, -m[0].length);
        next = {
          ...b,
          props: {
            ...b.props,
            url: cleanUrl,
            previewWidth: Number(m[1]),
          },
        };
      }
    }
    if (Array.isArray(next.children) && next.children.length > 0) {
      next = { ...next, children: extractImageWidths(next.children) };
    }
    return next;
  });
}

function mergeQuoteLines(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inQuote = false;
  let quoteLines: string[] = [];

  const flushQuote = () => {
    if (inQuote) {
      // If all lines look like plain text, merge them with <br>.
      // This prevents BlockNote from treating them as separate paragraphs (which adds indents).
      const isPlainText = quoteLines.every(l => !l.match(/^([-*+]|\d+\.)\s/));
      if (isPlainText) {
        out.push('> ' + quoteLines.join('<br>'));
      } else {
        // If there are lists inside the quote, keep them on separate lines.
        out.push(...quoteLines.map(l => '> ' + l));
      }
      inQuote = false;
      quoteLines = [];
    }
  };

  for (const line of lines) {
    const match = line.match(/^([ \t]*>)[ \t]?(.*)$/);
    if (match) {
      inQuote = true;
      quoteLines.push(match[2].replace(/\\$/, '').trimEnd());
    } else {
      flushQuote();
      out.push(line);
    }
  }
  flushQuote();
  return out.join('\n');
}

function injectLinks(blocks: any[], links: { url: string, label: string }[]): any[] {
  for (const b of blocks) {
    if (Array.isArray(b.content)) {
      const newContent: any[] = [];
      for (const node of b.content) {
        if (node.type === "text" && node.text.includes("SELAHPLACEHOLDERLINK")) {
          const parts = node.text.split(/(SELAHPLACEHOLDERLINK\d+)/);
          for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 1) {
              const match = parts[i].match(/\d+/);
              if (match) {
                const idx = parseInt(match[0]);
                const linkData = links[idx];
                if (linkData) {
                  newContent.push({
                    type: "link",
                    href: linkData.url,
                    content: [{ type: "text", text: linkData.label, styles: {} }]
                  });
                }
              }
            } else if (parts[i]) {
              newContent.push({ ...node, text: parts[i] });
            }
          }
        } else {
          newContent.push(node);
        }
      }
      b.content = newContent;
    }
    if (Array.isArray(b.children)) {
      injectLinks(b.children, links);
    }
  }
  return blocks;
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

      const text = seg.text;

      // NEW: Extract custom plugin blocks (HTML comments)
      const pluginRegex = /<!--\s*selah-plugin:\s*(\{[\s\S]*?)\s*-->/g;
      let match;
      let lastIndex = 0;

      const parseTextSegment = async (t: string) => {
        if (!t.trim()) return;

        // Strip any trailing backslashes globally. This fixes existing notes
        // that were saved with hard-break backslashes and prevents the
        // parser from misinterpreting them as nested quotes.
        let cleanT = mergeQuoteLines(t);

        // BlockNote silently drops nested lists if they use tabs. Convert to spaces.
        cleanT = cleanT.replace(/\t/g, "    ");

        // Remove the invisible markers so BlockNote doesn't render them as tofu boxes.
        // We leave the raw "c=#hex" text, and our decoder fallback will catch it.
        cleanT = cleanT.replace(/[\uE000\uE001\uE002]/g, "");

        // DEEP FIX: Extract standard markdown links before BlockNote's parser can break them
        const extractedLinks: { url: string, label: string }[] = [];
        cleanT = cleanT.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
            // Ignore wiki links (they get processed later)
            if (url.startsWith("[[")) return match;
            const id = extractedLinks.length;
            extractedLinks.push({ url: url.replace(/^<|>$/g, ""), label });
            return `SELAHPLACEHOLDERLINK${id}`;
        });

        const divRegex = /<div\s+align="(center|right|left|justify)">([\s\S]*?)<\/div>/g;
        let divMatch;
        let divLastIndex = 0;
        while ((divMatch = divRegex.exec(cleanT)) !== null) {
          if (divMatch.index > divLastIndex) {
            const prevText = cleanT.slice(divLastIndex, divMatch.index);
            if (prevText.trim()) {
              const parsed = await editor.tryParseMarkdownToBlocks(prevText);
              const decoded = decodeColorsInBlocks(parsed);
              blocks.push(...extractImageWidths(injectLinks(decoded, extractedLinks)));
            }
          }
          const align = divMatch[1];
          const innerText = divMatch[2];
          if (innerText.trim()) {
            const parsed = await editor.tryParseMarkdownToBlocks(innerText);
            const decoded = decodeColorsInBlocks(parsed);
            const aligned = decoded.map((b) => ({
              ...b,
              props: { ...b.props, textAlignment: align },
            }));
            blocks.push(...extractImageWidths(injectLinks(aligned, extractedLinks)));
          }
          divLastIndex = divRegex.lastIndex;
        }
        if (divLastIndex < cleanT.length) {
          const restText = cleanT.slice(divLastIndex);
          if (restText.trim()) {
            const parsed = await editor.tryParseMarkdownToBlocks(restText);
            const decoded = decodeColorsInBlocks(parsed);
            blocks.push(...extractImageWidths(injectLinks(decoded, extractedLinks)));
          }
        }
      };

      while ((match = pluginRegex.exec(text)) !== null) {
        const textBefore = text.slice(lastIndex, match.index);
        await parseTextSegment(textBefore);

        try {
          const parsed = JSON.parse(match[1]);
          blocks.push(parsed);
        } catch (e) {
          console.error("Failed to parse plugin block", e);
        }

        lastIndex = pluginRegex.lastIndex;
      }

      const textAfter = text.slice(lastIndex);
      await parseTextSegment(textAfter);

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
          meta: b.meta,
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
    } else if (seg.kind === "audio") {
      const a = seg.audio!;
      blocks.push({
        type: "audio",
        props: { src: a.src, caption: a.caption, fileName: a.fileName },
      });
    } else if (seg.kind === "attachment") {
      const f = seg.attachment!;
      blocks.push({
        type: "attachment",
        props: { src: f.src, caption: f.caption, fileName: f.fileName },
      });
    } else if (seg.kind === "scripture") {
      const s = seg.scripture!;
      blocks.push({
        type: "scripture",
        props: {
          reference: s.reference,
          text: s.text,
          collapsed: s.collapsed,
        },
      });
    } else if (seg.kind === "dmarchive") {
      const d = seg.dmarchive!;
      blocks.push({
        type: "dmarchive",
        props: {
          platform: d.platform,
          who: d.who,
          link: d.link,
          date: d.date,
          caption: d.caption,
          collapsed: d.collapsed,
          srcs: d.srcs,
        },
      });
    } else if (seg.kind === "imagegallery") {
      const g = seg.imagegallery!;
      blocks.push({
        type: "imagegallery",
        props: {
          grid: g.grid,
          gap: typeof g.gap === "number" ? g.gap : 8,
          colWidths: g.colWidths ?? "[]",
          rowHeights: g.rowHeights ?? "[]",
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

function escapeMarkdownAlt(s: string): string {
  return String(s).replace(/([\\\[\]])/g, "\\$1");
}

async function serializeBlockList(
  editor: BlockNoteEditor<any, any, any>,
  blocks: any[]
): Promise<string> {
  const chunks: string[] = [];
  let pending: any[] = [];

  const flush = async () => {
    if (!pending.length) return;

    let currentAlign = pending[0].props?.textAlignment || "left";
    let currentChunk: any[] = [];

    const pushChunk = async (chunk: any[], align: string) => {
      if (!chunk.length) return;
      const md = await editor.blocksToMarkdownLossy(encodeColorsInBlocks(chunk));
      if (md.trim()) {
        if (align !== "left") {
          chunks.push(`<div align="${align}">\n\n${md.trim()}\n\n</div>`);
        } else {
          chunks.push(md.trim());
        }
      }
    };

    for (const b of pending) {
      const align = b.props?.textAlignment || "left";
      if (align !== currentAlign) {
        await pushChunk(currentChunk, currentAlign);
        currentChunk = [b];
        currentAlign = align;
      } else {
        currentChunk.push(b);
      }
    }
    await pushChunk(currentChunk, currentAlign);
    pending = [];
  };

  const CORE_BLOCKS = new Set([
  "paragraph", "heading", "bulletListItem", "numberedListItem",
  "checkListItem", "image", "video", "audio", "file", "table",
  "quote", "divider", "codeBlock",
  "scripture", "callout", "bookmark", "dmarchive", "imagegallery",
  "attachment", "columnList", "column",
]);

  for (const block of blocks) {
    // NEW: Handle custom plugin blocks
    if (!CORE_BLOCKS.has(block.type)) {
      await flush();
      const jsonStr = JSON.stringify({ type: block.type, props: block.props });
      chunks.push(`<!-- selah-plugin: ${jsonStr} -->`);
    } else if (block.type === "columnList") {
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
    } else if (block.type === "audio") {
      await flush();
      const p = block.props || {};
      chunks.push(
        `::: audio src="${escAttr(p.src)}" caption="${escAttr(
          p.caption
        )}" fileName="${escAttr(p.fileName)}"`
      );
    } else if (block.type === "attachment") {
      await flush();
      const p = block.props || {};
      chunks.push(
        `::: attachment src="${escAttr(p.src)}" caption="${escAttr(
          p.caption
        )}" fileName="${escAttr(p.fileName)}"`
      );
    } else if (block.type === "scripture") {
      await flush();
      const p = block.props || {};
      chunks.push(
        `::: scripture reference="${escAttr(p.reference)}" text="${escAttr(
          p.text
        )}" collapsed="${p.collapsed ? "true" : "false"}"`
      );
    } else if (block.type === "dmarchive") {
      await flush();
      const p = block.props || {};
      chunks.push(
        `::: dmarchive platform="${escAttr(
          p.platform || "discord"
        )}" who="${escAttr(p.who)}" link="${escAttr(
          p.link
        )}" date="${escAttr(p.date)}" caption="${escAttr(
          p.caption
        )}" collapsed="${p.collapsed ? "true" : "false"}" srcs="${escAttr(
          p.srcs
        )}"`
      );
    } else if (block.type === "imagegallery") {
      await flush();
      const p = block.props || {};
      chunks.push(
        `::: imagegallery grid="${escAttr(p.grid || "[]")}" gap="${escAttr(p.gap ?? 8)}" colWidths="${escAttr(p.colWidths || "[]")}" rowHeights="${escAttr(p.rowHeights || "[]")}"`
      );
    } else if (block.type === "quote") {
      await flush();
      const inner = await editor.blocksToMarkdownLossy(
        encodeColorsInBlocks([{ type: "paragraph", content: block.content }])
      );

      // Standardize quote lines: strip any backslashes BlockNote adds for hard breaks.
      const lines = inner.trim().split('\n');
      const quoted = lines.map(l => {
        const clean = l.replace(/\\$/, '').trimEnd();
        return clean ? `> ${clean}` : '>';
      }).join('\n');

      chunks.push(quoted);
    } else if (block.type === "divider") {
      await flush();
      chunks.push('---');
    } else if (block.type === "image") {
      const p = block.props || {};
      const pw = typeof p.previewWidth === "number" && p.previewWidth > 0
        ? Math.round(p.previewWidth)
        : null;
      if (!pw) {
        pending.push(block);
      } else {
        await flush();
        const url = String(p.url || "");
        const caption = escapeMarkdownAlt(String(p.caption || ""));
        const sep = url.includes("?") ? "&" : "?";
        chunks.push(`![${caption}](${url}${sep}w=${pw})`);
      }
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
    } else if (seg.kind === "audio") {
      const a = seg.audio!;
      out.push(`[${a.caption || a.fileName || "Audio"}](${a.src})`);
    } else if (seg.kind === "attachment") {
      const f = seg.attachment!;
      out.push(`[${f.caption || f.fileName || "File"}](${f.src})`);
    } else if (seg.kind === "scripture") {
      const s = seg.scripture!;
      out.push(`> **${s.reference}** (KJV)\n>\n> ${s.text}`);
    } else if (seg.kind === "dmarchive") {
      const d = seg.dmarchive!;
      const headerParts = [d.platform, d.who || "Conversation", d.date].filter(
        Boolean
      );
      const header = headerParts.join(" · ");
      if (d.link) {
        out.push(`**[${header}](${d.link})**`);
      } else {
        out.push(`**${header}**`);
      }
      if (d.caption) out.push(`> ${d.caption}`);
      const srcs = d.srcs.split("\u001E").filter(Boolean);
      for (const src of srcs) {
        out.push(`![Screenshot](${src})`);
      }
    } else if (seg.kind === "imagegallery") {
      try {
        const grid = JSON.parse(seg.imagegallery?.grid || "[]");
        if (Array.isArray(grid)) {
          for (const row of grid) {
            if (!Array.isArray(row)) continue;
            for (const cell of row) {
              if (cell?.src) out.push(`![${cell.caption || ""}](${cell.src})`);
            }
          }
        }
      } catch {}
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
  return serializeNoteFile(exportFm, out.join("\n"));
}
