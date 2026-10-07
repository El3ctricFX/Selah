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
  kind: "md" | "columns" | "callout" | "bookmark";
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
      const cols: ColumnSpec[] = [];
      while (i < lines.length && lines[i].trim() !== ":::") {
        const line = lines[i].trim();
        if (line === "::: column" || line.startsWith("::: column ")) {
          const attrs = parseAttrs(line);
          const width = attrs.width || "1fr";
          i++;
          const colLines: string[] = [];
          while (i < lines.length && lines[i].trim() !== ":::") {
            colLines.push(lines[i]);
            i++;
          }
          cols.push({
            width,
            content: colLines.join("\n").trimEnd(),
          });
          i++;
        } else {
          i++;
        }
      }
      i++;
      out.push({ kind: "columns", columns: cols });
      continue;
    }

    if (trimmed.startsWith("::: callout")) {
      flush();
      const attrs = parseAttrs(trimmed);
      i++;
      const inner: string[] = [];
      while (i < lines.length && lines[i].trim() !== ":::") {
        inner.push(lines[i]);
        i++;
      }
      i++;
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

    buf.push(lines[i]);
    i++;
  }

  flush();
  return out;
}

export async function noteBodyToBlocks(
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
          const inner = await editor.tryParseMarkdownToBlocks(col.content);
          return {
            type: "column",
            props: { width: col.width || "1fr" },
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
    }
  }

  return blocks.length ? blocks : [{ type: "paragraph" }];
}

export async function blocksToNoteBody(
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
        const inner = await editor.blocksToMarkdownLossy(col.children || []);
        const width = (col.props?.width as string) || "1fr";
        colTexts.push(`::: column width="${width}"\n${inner.trim()}\n:::`);
      }
      chunks.push(`::: columns\n${colTexts.join("\n")}\n:::`);
    } else if (block.type === "callout") {
      await flush();
      const inner = await editor.blocksToMarkdownLossy([
        { type: "paragraph", content: block.content },
      ]);
      const icon = (block.props?.icon as string) || "💡";
      const color = (block.props?.color as string) || "gray";
      const safeIcon = String(icon).replace(/"/g, "&quot;");
      chunks.push(
        `::: callout icon="${safeIcon}" color="${color}"\n${inner.trim()}\n:::`
      );
    } else if (block.type === "bookmark") {
      await flush();
      const p = block.props || {};
      const esc = (s: unknown) =>
        String(s ?? "")
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/\n/g, " ");
      const mode = p.mode === "embed" ? "embed" : "bookmark";
      chunks.push(
        `::: bookmark mode="${mode}" url="${esc(p.url)}" title="${esc(
          p.title
        )}" description="${esc(p.description)}" icon="${esc(
          p.icon
        )}" image="${esc(p.image)}"`
      );
    } else {
      pending.push(block);
    }
  }
  await flush();

  return chunks.join("\n\n") + "\n";
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