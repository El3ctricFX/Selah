// src/ImageGallery.tsx
import { createReactBlockSpec } from "@blocknote/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Plus, Loader2, Trash2, Maximize2, MoveRight, X,
  Merge, SplitSquareHorizontal, RotateCcw,
} from "lucide-react";
import { useNoteMode } from "./useNoteMode";
import { useNoteContext } from "./NoteContext";
import { saveImageToNoteAssets } from "./imageAssets";
import PhotoLightbox from "./PhotoLightbox";

export interface GalleryCell {
  src: string;
  caption?: string;
  colspan?: number;
  rowspan?: number;
  fit?: "contain" | "cover";
}

type CoverMarker = { covered: true };
type Slot = GalleryCell | CoverMarker;
type GalleryGrid = Slot[][];

const EMPTY_CELL: GalleryCell = { src: "" };
const DEFAULT_GRID: GalleryGrid = [[EMPTY_CELL]];

const DEFAULT_COL_WIDTH = 1;
const DEFAULT_ROW_HEIGHT = 220;
const MIN_COL_WIDTH = 0.3;
const MIN_ROW_HEIGHT = 80;

export const GALLERY_MOVE_EVENT = "gallery-cell-move";
export const GALLERY_EDGE_DROP_EVENT = "gallery-edge-drop";
export const GALLERY_EDGE_HOVER_EVENT = "gallery-edge-hover";

// ── Helpers ──────────────────────────────────────────────────────────
function isCover(slot: Slot | undefined | null): slot is CoverMarker {
  return !!slot && (slot as any).covered === true;
}
function getCell(slot: Slot | undefined | null): GalleryCell | null {
  if (!slot || isCover(slot)) return null;
  return slot as GalleryCell;
}
function cloneGrid(g: GalleryGrid): GalleryGrid {
  return g.map((row) =>
    row.map((s) => (isCover(s) ? { covered: true } : { ...s }))
  );
}

function parseGrid(raw: string): GalleryGrid {
  if (!raw) return cloneGrid(DEFAULT_GRID);
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return cloneGrid(DEFAULT_GRID);
    }
    const cols = Math.max(
      ...parsed.map((r: any) => (Array.isArray(r) ? r.length : 0)),
      1
    );
    return parsed.map((r: any) => {
      const row: Slot[] = Array.isArray(r) ? [...r] : [];
      while (row.length < cols) row.push({ ...EMPTY_CELL });
      return row.slice(0, cols).map((c: any) => {
        if (c && c.covered === true) return { covered: true };
        if (!c || typeof c !== "object") return { ...EMPTY_CELL };
        const cell: GalleryCell = {
          src: typeof c.src === "string" ? c.src : "",
          caption: typeof c.caption === "string" ? c.caption : "",
        };
        if (typeof c.colspan === "number" && c.colspan > 1) {
          cell.colspan = Math.floor(c.colspan);
        }
        if (typeof c.rowspan === "number" && c.rowspan > 1) {
          cell.rowspan = Math.floor(c.rowspan);
        }
        if (c.fit === "cover" || c.fit === "contain") {
          cell.fit = c.fit;
        }
        return cell;
      });
    });
  } catch {
    return cloneGrid(DEFAULT_GRID);
  }
}

function serializeGrid(grid: GalleryGrid): string {
  return JSON.stringify(grid);
}

function parseNumberArray(raw: string, length: number, def: number): number[] {
  let arr: number[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      arr = parsed.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    }
  } catch {}
  while (arr.length < length) arr.push(def);
  return arr.slice(0, length);
}

function parseColWidths(raw: string, cols: number): number[] {
  return parseNumberArray(raw, cols, DEFAULT_COL_WIDTH);
}
function parseRowHeights(raw: string, rows: number): number[] {
  return parseNumberArray(raw, rows, DEFAULT_ROW_HEIGHT);
}

// ── Cell extraction / rebuild ────────────────────────────────────────
interface CellRecord {
  r: number; c: number; rs: number; cs: number;
  src: string; caption: string;
  fit?: "contain" | "cover";
}

function extractCells(grid: GalleryGrid): {
  rows: number; cols: number; cells: CellRecord[];
} {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const cells: CellRecord[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const slot = grid[r]?.[c];
      if (!slot || isCover(slot)) continue;
      const cell = slot as GalleryCell;
      cells.push({
        r, c,
        rs: Math.max(1, cell.rowspan ?? 1),
                 cs: Math.max(1, cell.colspan ?? 1),
                 src: cell.src || "",
                 caption: cell.caption || "",
                 fit:
                 cell.fit === "cover"
                 ? "cover"
                 : cell.fit === "contain"
                 ? "contain"
                 : undefined,
      });
    }
  }
  return { rows, cols, cells };
}

function buildGrid(rows: number, cols: number, cells: CellRecord[]): GalleryGrid {
  const grid: GalleryGrid = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ ...EMPTY_CELL }))
  );
  for (const cell of cells) {
    if (cell.r < 0 || cell.c < 0) continue;
    if (cell.r >= rows || cell.c >= cols) continue;
    const slot: GalleryCell = { src: cell.src, caption: cell.caption };
    if (cell.cs > 1) slot.colspan = cell.cs;
    if (cell.rs > 1) slot.rowspan = cell.rs;
    if (cell.fit === "cover" || cell.fit === "contain") slot.fit = cell.fit;
    grid[cell.r][cell.c] = slot;
    for (let dr = 0; dr < cell.rs; dr++) {
      for (let dc = 0; dc < cell.cs; dc++) {
        if (dr === 0 && dc === 0) continue;
        const rr = cell.r + dr;
        const cc = cell.c + dc;
        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
          grid[rr][cc] = { covered: true };
        }
      }
    }
  }
  return grid;
}

// ── Grid operations ──────────────────────────────────────────────────
function addRow(grid: GalleryGrid, where: "top" | "bottom"): GalleryGrid {
  const { rows, cols, cells } = extractCells(grid);
  const shifted = cells.map((cell) =>
    where === "top" ? { ...cell, r: cell.r + 1 } : cell
  );
  return buildGrid(rows + 1, cols, shifted);
}
function addColumn(grid: GalleryGrid, where: "left" | "right"): GalleryGrid {
  const { rows, cols, cells } = extractCells(grid);
  const shifted = cells.map((cell) =>
    where === "left" ? { ...cell, c: cell.c + 1 } : cell
  );
  return buildGrid(rows, cols + 1, shifted);
}
function deleteRow(grid: GalleryGrid, delR: number): GalleryGrid {
  const { rows, cols, cells } = extractCells(grid);
  if (rows <= 1) return grid;
  const kept: CellRecord[] = [];
  for (const cell of cells) {
    const bottom = cell.r + cell.rs;
    if (bottom <= delR) kept.push(cell);
    else if (cell.r > delR) kept.push({ ...cell, r: cell.r - 1 });
    else if (cell.r === delR) {
      if (cell.rs === 1) continue;
      kept.push({ ...cell, rs: cell.rs - 1 });
    } else {
      kept.push({ ...cell, rs: cell.rs - 1 });
    }
  }
  return buildGrid(rows - 1, cols, kept);
}
function deleteColumn(grid: GalleryGrid, delC: number): GalleryGrid {
  const { rows, cols, cells } = extractCells(grid);
  if (cols <= 1) return grid;
  const kept: CellRecord[] = [];
  for (const cell of cells) {
    const right = cell.c + cell.cs;
    if (right <= delC) kept.push(cell);
    else if (cell.c > delC) kept.push({ ...cell, c: cell.c - 1 });
    else if (cell.c === delC) {
      if (cell.cs === 1) continue;
      kept.push({ ...cell, cs: cell.cs - 1 });
    } else {
      kept.push({ ...cell, cs: cell.cs - 1 });
    }
  }
  return buildGrid(rows, cols - 1, kept);
}
function mergeRight(grid: GalleryGrid, r: number, c: number): GalleryGrid | null {
  const { rows, cols, cells } = extractCells(grid);
  const cur = cells.find((x) => x.r === r && x.c === c);
  if (!cur) return null;
  const targetC = c + cur.cs;
  if (targetC >= cols) return null;
  const right = cells.find((x) => x.r === r && x.c === targetC);
  if (!right || right.rs !== cur.rs) return null;
  const next = cells
    .filter((x) => !(x.r === right.r && x.c === right.c))
    .map((x) =>
      x.r === cur.r && x.c === cur.c ? { ...x, cs: cur.cs + right.cs } : x
    );
  return buildGrid(rows, cols, next);
}
function mergeDown(grid: GalleryGrid, r: number, c: number): GalleryGrid | null {
  const { rows, cols, cells } = extractCells(grid);
  const cur = cells.find((x) => x.r === r && x.c === c);
  if (!cur) return null;
  const targetR = r + cur.rs;
  if (targetR >= rows) return null;
  const below = cells.find((x) => x.r === targetR && x.c === c);
  if (!below || below.cs !== cur.cs) return null;
  const next = cells
    .filter((x) => !(x.r === below.r && x.c === below.c))
    .map((x) =>
      x.r === cur.r && x.c === cur.c ? { ...x, rs: cur.rs + below.rs } : x
    );
  return buildGrid(rows, cols, next);
}
function unmerge(grid: GalleryGrid, r: number, c: number): GalleryGrid {
  const { rows, cols, cells } = extractCells(grid);
  const cur = cells.find((x) => x.r === r && x.c === c);
  if (!cur) return grid;
  if (cur.cs === 1 && cur.rs === 1) return grid;
  const next = cells.filter((x) => !(x.r === cur.r && x.c === cur.c));
  for (let dr = 0; dr < cur.rs; dr++) {
    for (let dc = 0; dc < cur.cs; dc++) {
      if (dr === 0 && dc === 0) next.push({ ...cur, cs: 1, rs: 1 });
      else {
        next.push({
          r: cur.r + dr, c: cur.c + dc, rs: 1, cs: 1, src: "", caption: "",
        });
      }
    }
  }
  return buildGrid(rows, cols, next);
}

function resolveSrc(src: string): string {
  if (!src) return "";
  if (/^(https?:|data:|blob:|asset:)/i.test(src)) return src;
  try { return convertFileSrc(src); } catch { return src; }
}

// Shared resize-handle renderer. Vertical handle on the right edge,
// horizontal handle on the bottom edge, both centered on the boundary.
function ResizeHandles({
  showLeft, showRight, showTop, showBottom,
  onStartColLeft, onStartColRight,
  onStartRowTop, onStartRowBottom,
}: {
  showLeft: boolean;
  showRight: boolean;
  showTop: boolean;
  showBottom: boolean;
  onStartColLeft: (e: React.MouseEvent) => void;
  onStartColRight: (e: React.MouseEvent) => void;
  onStartRowTop: (e: React.MouseEvent) => void;
  onStartRowBottom: (e: React.MouseEvent) => void;
}) {
  return (
    <>
    {showLeft && (
      <div
      onMouseDown={onStartColLeft}
      onClick={(e) => e.stopPropagation()}
      className="absolute z-30 cursor-col-resize hover:bg-blue-500/60 transition-colors"
      style={{ top: 0, bottom: 0, left: -3, width: 6 }}
      title="Drag to resize column"
      />
    )}
    {showRight && (
      <div
      onMouseDown={onStartColRight}
      onClick={(e) => e.stopPropagation()}
      className="absolute z-30 cursor-col-resize hover:bg-blue-500/60 transition-colors"
      style={{ top: 0, bottom: 0, right: -3, width: 6 }}
      title="Drag to resize column"
      />
    )}
    {showTop && (
      <div
      onMouseDown={onStartRowTop}
      onClick={(e) => e.stopPropagation()}
      className="absolute z-30 cursor-row-resize hover:bg-blue-500/60 transition-colors"
      style={{ left: 0, right: 0, top: -3, height: 6 }}
      title="Drag to resize row"
      />
    )}
    {showBottom && (
      <div
      onMouseDown={onStartRowBottom}
      onClick={(e) => e.stopPropagation()}
      className="absolute z-30 cursor-row-resize hover:bg-blue-500/60 transition-colors"
      style={{ left: 0, right: 0, bottom: -3, height: 6 }}
      title="Drag to resize row"
      />
    )}
    </>
  );
}

// ── Empty cell ───────────────────────────────────────────────────────
function EmptyCell({
  row, col, blockId, colspan, rowspan, isEdit, busy,
  canResizeCol, canResizeRow,
  canResizeLeft, canResizeTop,
  onResizeColStart, onResizeRowStart,
  onResizeColLeftStart, onResizeRowTopStart,
  onImport, onContextMenu,
}: {
  row: number; col: number; blockId: string;
  colspan: number; rowspan: number;
  isEdit: boolean; busy: boolean;
  canResizeCol: boolean; canResizeRow: boolean;
  canResizeLeft: boolean; canResizeTop: boolean;
  onResizeColStart: (e: React.MouseEvent) => void;
  onResizeRowStart: (e: React.MouseEvent) => void;
  onResizeColLeftStart: (e: React.MouseEvent) => void;
  onResizeRowTopStart: (e: React.MouseEvent) => void;
  onImport: (r: number, c: number) => void;
  onContextMenu: (e: React.MouseEvent, r: number, c: number) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <div
      data-gallery-block-id={blockId}
      data-gallery-row={row}
      data-gallery-col={col}
      className={`relative rounded-md overflow-hidden transition-all bg-[#0f1315] border-2 border-dashed ${
        dragOver
          ? "border-blue-400 ring-2 ring-blue-400/60"
          : "border-[#2a3136] hover:border-[#3a4147]"
      } ${isEdit ? "cursor-pointer" : "cursor-default"}`}
      style={{
        gridColumn: `${col + 1} / span ${colspan}`,
        gridRow: `${row + 1} / span ${rowspan}`,
      }}
      onContextMenu={(e) => { if (isEdit) onContextMenu(e, row, col); }}
      onDragOver={(e) => {
        if (!isEdit) return;
        if (!e.dataTransfer.types.includes("text/x-gallery-cell")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!isEdit) return;
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        try {
          const raw = e.dataTransfer.getData("text/x-gallery-cell");
          if (!raw) return;
          const p = JSON.parse(raw);
          if (!p || typeof p.src !== "string" || !p.src) return;
          window.dispatchEvent(
            new CustomEvent(GALLERY_MOVE_EVENT, {
              detail: {
                fromBlockId: p.blockId ?? blockId,
                fromRow: typeof p.row === "number" ? p.row : -1,
                fromCol: typeof p.col === "number" ? p.col : -1,
                toBlockId: blockId, toRow: row, toCol: col, src: p.src,
              },
            })
          );
        } catch {}
      }}
      onClick={() => { if (isEdit && !busy) onImport(row, col); }}
      title={isEdit ? "Click to import a photo" : "Empty slot"}
    >
      <div className="absolute inset-0 flex items-center justify-center text-gray-600 pointer-events-none">
      {busy
        ? <Loader2 size={20} className="animate-spin text-gray-400" />
        : <Plus size={22} />}
        </div>
        {isEdit && (
          <ResizeHandles
          showLeft={canResizeLeft}
          showRight={canResizeCol}
          showTop={canResizeTop}
          showBottom={canResizeRow}
          onStartColLeft={onResizeColLeftStart}
          onStartColRight={onResizeColStart}
          onStartRowTop={onResizeRowTopStart}
          onStartRowBottom={onResizeRowStart}
          />
        )}
    </div>
  );
}

// ── Filled cell ──────────────────────────────────────────────────────
function FilledCell({
  cell, row, col, blockId, colspan, rowspan, isEdit,
  canResizeCol, canResizeRow,
  canResizeLeft, canResizeTop,
  onResizeColStart, onResizeRowStart,
  onResizeColLeftStart, onResizeRowTopStart,
  onClear, onOpen, onContextMenu,
}: {
  cell: GalleryCell; row: number; col: number; blockId: string;
  colspan: number; rowspan: number; isEdit: boolean;
  canResizeCol: boolean; canResizeRow: boolean;
  canResizeLeft: boolean; canResizeTop: boolean;
  onResizeColStart: (e: React.MouseEvent) => void;
  onResizeRowStart: (e: React.MouseEvent) => void;
  onResizeColLeftStart: (e: React.MouseEvent) => void;
  onResizeRowTopStart: (e: React.MouseEvent) => void;
  onClear: (r: number, c: number) => void;
  onOpen: (r: number, c: number) => void;
  onContextMenu: (e: React.MouseEvent, r: number, c: number) => void;
}) {
  const [hover, setHover] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  return (
    <div
      data-gallery-block-id={blockId}
      data-gallery-row={row}
      data-gallery-col={col}
      className={`relative overflow-hidden group ${
        cell.fit === "cover"
          ? "rounded-none border-0 bg-transparent"
          : "rounded-md border border-[#2a3136] bg-[#0f1315]"
      } ${dragOver ? "ring-2 ring-blue-400" : ""}`}
      style={{
        gridColumn: `${col + 1} / span ${colspan}`,
        gridRow: `${row + 1} / span ${rowspan}`,
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onContextMenu={(e) => { if (isEdit) onContextMenu(e, row, col); }}
      draggable={isEdit}
      onDragStart={(e) => {
        if (!isEdit) return;
        e.stopPropagation();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(
          "text/x-gallery-cell",
          JSON.stringify({ blockId, row, col, src: cell.src })
        );
      }}
      onDragEnd={() => setDragOver(false)}
      onDragOver={(e) => {
        if (!isEdit) return;
        if (!e.dataTransfer.types.includes("text/x-gallery-cell")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!isEdit) return;
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        try {
          const raw = e.dataTransfer.getData("text/x-gallery-cell");
          if (!raw) return;
          const p = JSON.parse(raw);
          if (!p || typeof p.src !== "string" || !p.src) return;
          if (p.blockId === blockId && p.row === row && p.col === col) return;
          window.dispatchEvent(
            new CustomEvent(GALLERY_MOVE_EVENT, {
              detail: {
                fromBlockId: p.blockId ?? blockId,
                fromRow: typeof p.row === "number" ? p.row : -1,
                fromCol: typeof p.col === "number" ? p.col : -1,
                toBlockId: blockId, toRow: row, toCol: col, src: p.src,
              },
            })
          );
        } catch {}
      }}
      onClick={() => onOpen(row, col)}
    >
    <img
    src={resolveSrc(cell.src)}
    alt={cell.caption || ""}
    draggable={false}
    style={{
      objectFit: cell.fit === "cover" ? "cover" : "contain",
      margin: 0,
      border: "none",
      borderRadius: 0,
    }}
    className="absolute inset-0 w-full h-full select-none pointer-events-none block"
    />
      {isEdit && hover && (
        <div className="absolute inset-0 bg-black/45 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClear(row, col); }}
            className="p-1.5 rounded bg-black/70 hover:bg-red-600 text-white transition-colors"
            title="Remove photo"
          >
            <Trash2 size={13} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpen(row, col); }}
            className="p-1.5 rounded bg-black/70 hover:bg-black text-white transition-colors"
            title="View full size"
          >
            <Maximize2 size={13} />
          </button>
        </div>
      )}
      {isEdit && (
        <ResizeHandles
        showLeft={canResizeLeft}
        showRight={canResizeCol}
        showTop={canResizeTop}
        showBottom={canResizeRow}
        onStartColLeft={onResizeColLeftStart}
        onStartColRight={onResizeColStart}
        onStartRowTop={onResizeRowTopStart}
        onStartRowBottom={onResizeRowStart}
        />
      )}
      </div>
  );
}

// ── Edge plus (small drop zone centered on the + button) ─────────────
const ZONE_HALF = 14; // 28×28 total

function EdgePlus({
  side, blockId, visible, active, onClick, onHoverChange, onImageDrop,
}: {
  side: "top" | "bottom" | "left" | "right";
  blockId: string;
  visible: boolean;
  active: boolean;
  onClick: () => void;
  onHoverChange: (v: boolean) => void;
  onImageDrop: (side: "top" | "bottom" | "left" | "right", payload: any) => void;
}) {
  const [nativeDragOver, setNativeDragOver] = useState(false);

  const zonePos: React.CSSProperties =
    side === "top"
      ? { top: -ZONE_HALF, left: "50%", transform: "translateX(-50%)", width: ZONE_HALF * 2, height: ZONE_HALF * 2 }
      : side === "bottom"
        ? { bottom: -ZONE_HALF, left: "50%", transform: "translateX(-50%)", width: ZONE_HALF * 2, height: ZONE_HALF * 2 }
        : side === "left"
          ? { left: -ZONE_HALF, top: "50%", transform: "translateY(-50%)", width: ZONE_HALF * 2, height: ZONE_HALF * 2 }
          : { right: -ZONE_HALF, top: "50%", transform: "translateY(-50%)", width: ZONE_HALF * 2, height: ZONE_HALF * 2 };

  const title =
    side === "top" ? "Add row above (or drop a photo here)"
    : side === "bottom" ? "Add row below (or drop a photo here)"
    : side === "left" ? "Add column to the left (or drop a photo here)"
    : "Add column to the right (or drop a photo here)";

  const isActive = active || nativeDragOver;

  return (
    <div
      data-gallery-block-id={blockId}
      data-gallery-edge-side={side}
      style={{
        position: "absolute",
        zIndex: 22,
        ...zonePos,
        background: isActive ? "rgba(59,130,246,0.14)" : "transparent",
        borderRadius: 8,
        transition: "background 120ms",
      }}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("text/x-gallery-cell")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setNativeDragOver(true);
      }}
      onDragLeave={() => setNativeDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setNativeDragOver(false);
        let raw = "";
        try { raw = e.dataTransfer.getData("text/x-gallery-cell"); } catch {}
        if (!raw) return;
        try {
          const p = JSON.parse(raw);
          if (!p || typeof p.src !== "string" || !p.src) return;
          onImageDrop(side, p);
        } catch {}
      }}
    >
      <button
        type="button"
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onClick={onClick}
        style={{
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? "auto" : "none",
          transition: "opacity 120ms, background 120ms, border-color 120ms, color 120ms",
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
        }}
        className={`w-6 h-6 rounded-full border flex items-center justify-center shadow-lg ${
          isActive
            ? "bg-blue-600 border-blue-500 text-white"
            : "bg-[#1e2327] border-[#3a4147] hover:bg-blue-600 hover:border-blue-500 text-gray-300 hover:text-white"
        }`}
        title={title}
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

// ── The block ────────────────────────────────────────────────────────
export const createImageGallery = createReactBlockSpec(
  {
    type: "imagegallery",
    propSchema: {
      grid: { default: JSON.stringify(DEFAULT_GRID) },
      gap: { default: 8 },
      colWidths: { default: "[]" },
      rowHeights: { default: "[]" },
    },
    content: "none",
  },
  {
    render: (props) => {
      const live = props.editor.getBlock(props.block.id) ?? props.block;
      const gridRaw = (live.props.grid as string) || "";
      const gap = typeof live.props.gap === "number" ? live.props.gap : 8;

      const grid = useMemo(() => parseGrid(gridRaw), [gridRaw]);
      const cols = grid[0]?.length ?? 0;
      const rows = grid.length;

      const storedColWidths = useMemo(
        () => parseColWidths((live.props.colWidths as string) || "[]", cols),
        [live.props.colWidths, cols]
      );
      const storedRowHeights = useMemo(
        () => parseRowHeights((live.props.rowHeights as string) || "[]", rows),
        [live.props.rowHeights, rows]
      );

      // Local preview overrides during a resize drag; null when idle.
      const [previewColWidths, setPreviewColWidths] = useState<number[] | null>(null);
      const [previewRowHeights, setPreviewRowHeights] = useState<number[] | null>(null);
      const lastColRef = useRef<number[] | null>(null);
      const lastRowRef = useRef<number[] | null>(null);

      const colWidths = previewColWidths ?? storedColWidths;
      const rowHeights = previewRowHeights ?? storedRowHeights;

      const gridRef = useRef<HTMLDivElement>(null);

      const { mode } = useNoteMode();
      const isEdit = mode === "edit";
      const noteCtx = useNoteContext();
      const notePath = noteCtx?.notePath || "";

      const [busyCell, setBusyCell] = useState<string | null>(null);
      const [lightbox, setLightbox] = useState<{ srcs: string[]; index: number } | null>(null);
      const [hoverSide, setHoverSide] = useState<"top" | "bottom" | "left" | "right" | null>(null);
      const [externalHoverSide, setExternalHoverSide] = useState<"top" | "bottom" | "left" | "right" | null>(null);
      const [cellCtx, setCellCtx] = useState<{ x: number; y: number; row: number; col: number } | null>(null);

      const readGrid = useCallback((): GalleryGrid => {
        const cur =
          (props.editor.getBlock(props.block.id)?.props.grid as string) ||
          gridRaw;
        return parseGrid(cur);
      }, [props.editor, props.block.id, gridRaw]);

      const readRowHeights = useCallback((len: number): number[] => {
        const raw =
          (props.editor.getBlock(props.block.id)?.props.rowHeights as string) ||
          "[]";
        return parseRowHeights(raw, len);
      }, [props.editor, props.block.id]);

      const readColWidths = useCallback((len: number): number[] => {
        const raw =
          (props.editor.getBlock(props.block.id)?.props.colWidths as string) ||
          "[]";
        return parseColWidths(raw, len);
      }, [props.editor, props.block.id]);

      const writeGrid = useCallback(
        (next: GalleryGrid, sizes?: { rowHeights?: number[]; colWidths?: number[] }) => {
          try {
            const patch: Record<string, any> = { grid: serializeGrid(next) };
            if (sizes?.rowHeights) patch.rowHeights = JSON.stringify(sizes.rowHeights);
            if (sizes?.colWidths) patch.colWidths = JSON.stringify(sizes.colWidths);
            props.editor.updateBlock(props.block.id, { props: patch });
          } catch (e) {
            console.error("[gallery] updateBlock failed:", e);
          }
        },
        [props.editor, props.block.id]
      );

      // ── Resize drag ─────────────────────────────────────────────
      const startColResize = useCallback(
        (colIdx: number) => (e: React.MouseEvent) => {
          if (!isEdit) return;
          e.preventDefault();
          e.stopPropagation();
          const containerEl = gridRef.current;
          if (!containerEl) return;
          const startSizes = [...storedColWidths];
          if (colIdx < 0 || colIdx + 1 >= startSizes.length) return;
          const rect = containerEl.getBoundingClientRect();
          const startX = e.clientX;
          const sumFrac = startSizes.reduce((a, b) => a + b, 0) || 1;
          const totalGap = Math.max(0, startSizes.length - 1) * gap;
          const available = Math.max(50, rect.width - totalGap);
          const pxPerUnit = available / sumFrac;

          setPreviewColWidths(startSizes);
          lastColRef.current = startSizes;

          const onMove = (ev: MouseEvent) => {
            const dx = ev.clientX - startX;
            const dUnits = dx / pxPerUnit;
            const next = [...startSizes];
            next[colIdx] = Math.max(MIN_COL_WIDTH, startSizes[colIdx] + dUnits);
            next[colIdx + 1] = Math.max(MIN_COL_WIDTH, startSizes[colIdx + 1] - dUnits);
            setPreviewColWidths(next);
            lastColRef.current = next;
          };
          const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            const final = lastColRef.current;
            if (final) {
              writeGrid(readGrid(), { colWidths: final });
            }
            setPreviewColWidths(null);
            lastColRef.current = null;
          };
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
        },
        [isEdit, storedColWidths, gap, writeGrid, readGrid]
      );

      const startRowResize = useCallback(
        (rowIdx: number) => (e: React.MouseEvent) => {
          if (!isEdit) return;
          e.preventDefault();
          e.stopPropagation();
          const startSizes = [...storedRowHeights];
          if (rowIdx < 0 || rowIdx + 1 >= startSizes.length) return;
          const startY = e.clientY;

          setPreviewRowHeights(startSizes);
          lastRowRef.current = startSizes;

          const onMove = (ev: MouseEvent) => {
            const dy = ev.clientY - startY;
            const next = [...startSizes];
            next[rowIdx] = Math.max(MIN_ROW_HEIGHT, startSizes[rowIdx] + dy);
            next[rowIdx + 1] = Math.max(MIN_ROW_HEIGHT, startSizes[rowIdx + 1] - dy);
            setPreviewRowHeights(next);
            lastRowRef.current = next;
          };
          const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            const final = lastRowRef.current;
            if (final) {
              writeGrid(readGrid(), { rowHeights: final });
            }
            setPreviewRowHeights(null);
            lastRowRef.current = null;
          };
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
        },
        [isEdit, storedRowHeights, writeGrid, readGrid]
      );

      // ── CRUD ops that keep sizes in sync ────────────────────────
      const importIntoCell = useCallback(
        async (r: number, c: number) => {
          if (!notePath || !isEdit || busyCell) return;
          const key = `${r}-${c}`;
          try {
            const picked = await open({
              multiple: false,
              filters: [{
                name: "Image",
                extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg"],
              }],
            });
            if (!picked || typeof picked !== "string") return;
            setBusyCell(key);
            const dest = await saveImageToNoteAssets(notePath, picked);
            const url = convertFileSrc(dest);
            const cur = readGrid();
            if (!cur[r] || cur[r][c] === undefined) return;
            const next = cur.map((row) => [...row]);
            next[r][c] = { src: url, caption: "" };
            writeGrid(next);
          } catch (e) {
            console.error("[gallery] import failed:", e);
          } finally {
            setBusyCell(null);
          }
        },
        [notePath, isEdit, busyCell, readGrid, writeGrid]
      );

      const clearCell = useCallback(
        (r: number, c: number) => {
          const cur = readGrid();
          if (!cur[r] || cur[r][c] === undefined) return;
          const next = cur.map((row) => [...row]);
          next[r][c] = { ...EMPTY_CELL };
          writeGrid(next);
        },
        [readGrid, writeGrid]
      );

      const extractCell = useCallback(
        (r: number, c: number) => {
          const cur = readGrid();
          const cell = getCell(cur[r]?.[c]);
          if (!cell?.src) return;
          try {
            props.editor.insertBlocks(
              [{ type: "image", props: { url: cell.src, caption: cell.caption || "" } } as any],
              props.block.id,
              "after"
            );
          } catch (e) {
            console.error("[gallery] extract failed:", e);
            return;
          }
          const next = cur.map((row) => [...row]);
          next[r][c] = { ...EMPTY_CELL };
          writeGrid(next);
        },
        [props.editor, props.block.id, readGrid, writeGrid]
      );

      const doAddRow = useCallback(
        (where: "top" | "bottom") => {
          const cur = readGrid();
          const curRH = readRowHeights(cur.length);
          const nextGrid = addRow(cur, where);
          const nextRH = where === "top"
            ? [DEFAULT_ROW_HEIGHT, ...curRH]
            : [...curRH, DEFAULT_ROW_HEIGHT];
          writeGrid(nextGrid, { rowHeights: nextRH });
        },
        [readGrid, readRowHeights, writeGrid]
      );

      const doAddColumn = useCallback(
        (where: "left" | "right") => {
          const cur = readGrid();
          const width = cur[0]?.length ?? 0;
          const curCW = readColWidths(width);
          const nextGrid = addColumn(cur, where);
          const nextCW = where === "left"
            ? [DEFAULT_COL_WIDTH, ...curCW]
            : [...curCW, DEFAULT_COL_WIDTH];
          writeGrid(nextGrid, { colWidths: nextCW });
        },
        [readGrid, readColWidths, writeGrid]
      );

      const doDeleteRow = useCallback(
        (r: number) => {
          const cur = readGrid();
          if (cur.length <= 1) return;
          const curRH = readRowHeights(cur.length);
          const nextGrid = deleteRow(cur, r);
          const nextRH = curRH.filter((_, idx) => idx !== r);
          writeGrid(nextGrid, { rowHeights: nextRH });
        },
        [readGrid, readRowHeights, writeGrid]
      );

      const doDeleteColumn = useCallback(
        (c: number) => {
          const cur = readGrid();
          const width = cur[0]?.length ?? 0;
          if (width <= 1) return;
          const curCW = readColWidths(width);
          const nextGrid = deleteColumn(cur, c);
          const nextCW = curCW.filter((_, idx) => idx !== c);
          writeGrid(nextGrid, { colWidths: nextCW });
        },
        [readGrid, readColWidths, writeGrid]
      );

      const doMergeRight = useCallback(
        (r: number, c: number) => {
          const next = mergeRight(readGrid(), r, c);
          if (next) writeGrid(next);
        },
        [readGrid, writeGrid]
      );
      const doMergeDown = useCallback(
        (r: number, c: number) => {
          const next = mergeDown(readGrid(), r, c);
          if (next) writeGrid(next);
        },
        [readGrid, writeGrid]
      );
      const doUnmerge = useCallback(
        (r: number, c: number) => writeGrid(unmerge(readGrid(), r, c)),
        [readGrid, writeGrid]
      );

      const doSetFit = useCallback(
        (r: number, c: number, fit: "contain" | "cover") => {
          const cur = readGrid();
          const cell = getCell(cur[r]?.[c]);
          if (!cell?.src) return;
          const next = cur.map((row) => [...row]);
          const target = next[r][c] as GalleryCell;
          next[r][c] = { ...target, fit };
          writeGrid(next);
        },
        [readGrid, writeGrid]
      );

      const doResetSizes = useCallback(() => {
        const cur = readGrid();
        const width = cur[0]?.length ?? 0;
        const nextRH = Array.from({ length: cur.length }, () => DEFAULT_ROW_HEIGHT);
        const nextCW = Array.from({ length: width }, () => DEFAULT_COL_WIDTH);
        writeGrid(cur, { rowHeights: nextRH, colWidths: nextCW });
      }, [readGrid, writeGrid]);

      const openLightbox = useCallback(
        (r: number, c: number) => {
          const cur = readGrid();
          const flat: { src: string; r: number; c: number }[] = [];
          cur.forEach((row, ri) => {
            row.forEach((slot, ci) => {
              const cell = getCell(slot);
              if (cell?.src) flat.push({ src: resolveSrc(cell.src), r: ri, c: ci });
            });
          });
          const idx = flat.findIndex((f) => f.r === r && f.c === c);
          if (idx < 0) return;
          setLightbox({ srcs: flat.map((f) => f.src), index: idx });
        },
        [readGrid]
      );

      const handleCellContextMenu = useCallback(
        (e: React.MouseEvent, r: number, c: number) => {
          e.preventDefault();
          e.stopPropagation();
          const W = 260;
          const H = 320;
          setCellCtx({
            x: Math.min(e.clientX, window.innerWidth - W - 8),
            y: Math.min(e.clientY, window.innerHeight - H - 8),
            row: r,
            col: c,
          });
        },
        []
      );

      const handleEdgeImageDrop = useCallback(
        (side: "top" | "bottom" | "left" | "right", payload: any) => {
          const cur = readGrid();
          const colsN = cur[0]?.length ?? 1;
          const rowsN = cur.length;
          const curRH = readRowHeights(rowsN);
          const curCW = readColWidths(colsN);

          let next: GalleryGrid;
          let nextRH = curRH;
          let nextCW = curCW;
          let newR = 0;
          let newC = 0;

          if (side === "top") {
            next = addRow(cur, "top");
            nextRH = [DEFAULT_ROW_HEIGHT, ...curRH];
            newR = 0; newC = Math.floor(colsN / 2);
          } else if (side === "bottom") {
            next = addRow(cur, "bottom");
            nextRH = [...curRH, DEFAULT_ROW_HEIGHT];
            newR = rowsN; newC = Math.floor(colsN / 2);
          } else if (side === "left") {
            next = addColumn(cur, "left");
            nextCW = [DEFAULT_COL_WIDTH, ...curCW];
            newR = Math.floor(rowsN / 2); newC = 0;
          } else {
            next = addColumn(cur, "right");
            nextCW = [...curCW, DEFAULT_COL_WIDTH];
            newR = Math.floor(rowsN / 2); newC = colsN;
          }

          if (next[newR] && next[newR][newC] !== undefined) {
            next[newR][newC] = { src: payload.src, caption: "" };
          }

          if (
            payload.blockId === props.block.id &&
            typeof payload.row === "number" &&
            typeof payload.col === "number"
          ) {
            let sr = payload.row;
            let sc = payload.col;
            if (side === "top") sr += 1;
            if (side === "left") sc += 1;
            if (!(sr === newR && sc === newC)) {
              if (next[sr] && next[sr][sc] !== undefined) {
                next[sr][sc] = { ...EMPTY_CELL };
              }
            }
          }

          writeGrid(next, { rowHeights: nextRH, colWidths: nextCW });

          if (payload.blockId && payload.blockId !== props.block.id) {
            window.dispatchEvent(
              new CustomEvent(GALLERY_MOVE_EVENT, {
                detail: {
                  fromBlockId: payload.blockId,
                  fromRow: payload.row,
                  fromCol: payload.col,
                  toBlockId: "",
                  toRow: -1,
                  toCol: -1,
                  src: "",
                },
              })
            );
          }
        },
        [props.block.id, readGrid, readRowHeights, readColWidths, writeGrid]
      );

      // Note-body synthetic drag tells us which edge is being hovered.
      useEffect(() => {
        const handler = (e: Event) => {
          const d = (e as CustomEvent).detail;
          if (!d) return;
          if (!d.active) {
            setExternalHoverSide(null);
            return;
          }
          if (d.blockId !== props.block.id) return;
          setExternalHoverSide(d.side);
        };
        window.addEventListener(GALLERY_EDGE_HOVER_EVENT, handler);
        return () =>
          window.removeEventListener(GALLERY_EDGE_HOVER_EVENT, handler);
      }, [props.block.id]);

      // Note-body synthetic drag drops onto an edge.
      useEffect(() => {
        const handler = (e: Event) => {
          const d = (e as CustomEvent).detail;
          if (!d || d.blockId !== props.block.id) return;
          if (!d.side || !d.src) return;
          handleEdgeImageDrop(d.side, d);
        };
        window.addEventListener(GALLERY_EDGE_DROP_EVENT, handler);
        return () =>
          window.removeEventListener(GALLERY_EDGE_DROP_EVENT, handler);
      }, [props.block.id, handleEdgeImageDrop]);

      useEffect(() => {
        if (!cellCtx) return;
        const onDown = () => setCellCtx(null);
        const onKey = (e: KeyboardEvent) => {
          if (e.key === "Escape") setCellCtx(null);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [cellCtx]);

      useEffect(() => {
        const handler = (e: Event) => {
          const d = (e as CustomEvent).detail as any;
          if (!d) return;
          const isDest = d.toBlockId === props.block.id;
          const isSrc = d.fromBlockId === props.block.id;
          if (!isDest && !isSrc) return;
          if (isDest && isSrc && d.fromRow === d.toRow && d.fromCol === d.toCol) return;

          const cur = readGrid();
          const next = cur.map((row) => [...row]);

          let srcToPlace: string = d.src;
          if (isSrc && next[d.fromRow] && next[d.fromRow][d.fromCol]) {
            const cell = getCell(next[d.fromRow][d.fromCol]);
            if (cell) srcToPlace = cell.src;
          }

          if (isSrc) {
            if (next[d.fromRow] && next[d.fromRow][d.fromCol] !== undefined) {
              next[d.fromRow][d.fromCol] = { ...EMPTY_CELL };
            }
          }
          if (isDest) {
            if (next[d.toRow] && next[d.toRow][d.toCol] !== undefined) {
              next[d.toRow][d.toCol] = { src: srcToPlace, caption: "" };
            }
          }
          writeGrid(next);
        };
        window.addEventListener(GALLERY_MOVE_EVENT, handler);
        return () => window.removeEventListener(GALLERY_MOVE_EVENT, handler);
      }, [props.block.id, readGrid, writeGrid]);

      // Drag a gallery photo OUT into the note editor.
      useEffect(() => {
        const handler = (e: DragEvent) => {
          const dt = e.dataTransfer;
          if (!dt) return;
          let raw = "";
          try { raw = dt.getData("text/x-gallery-cell"); } catch {}
          if (!raw) return;

          let payload: any;
          try { payload = JSON.parse(raw); } catch { return; }
          if (!payload || typeof payload.src !== "string" || !payload.src) return;
          if (payload.blockId !== props.block.id) return;

          const target = e.target as HTMLElement | null;
          if (!target) return;
          if (target.closest("[data-gallery-block-id]")) return;

          const editorRoot =
            target.closest(".bn-editor") || target.closest(".ProseMirror");
          if (!editorRoot) return;

          e.preventDefault();
          e.stopPropagation();

          const el = document.elementFromPoint(
            e.clientX, e.clientY
          ) as HTMLElement | null;
          const blockEl = el?.closest("[data-id]") as HTMLElement | null;
          const targetId = blockEl?.getAttribute("data-id") || null;

          let refId: string = props.block.id;
          let side: "before" | "after" = "after";
          if (blockEl && targetId && targetId !== props.block.id) {
            const rect = blockEl.getBoundingClientRect();
            side = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
            refId = targetId;
          }

          try {
            props.editor.insertBlocks(
              [{ type: "image", props: { url: payload.src, caption: "" } } as any],
              refId,
              side
            );
          } catch (err) {
            console.error("[gallery] drag-out insert failed:", err);
            return;
          }

          window.dispatchEvent(
            new CustomEvent(GALLERY_MOVE_EVENT, {
              detail: {
                fromBlockId: props.block.id,
                fromRow: typeof payload.row === "number" ? payload.row : -1,
                fromCol: typeof payload.col === "number" ? payload.col : -1,
                toBlockId: "",
                toRow: -1,
                toCol: -1,
                src: "",
              },
            })
          );

          requestAnimationFrame(() => {
            const tiptap: any = (props.editor as any)._tiptapEditor;
            try {
              if (tiptap?.view && tiptap?.state) {
                tiptap.view.dispatch(tiptap.state.tr);
              }
            } catch {}
            try {
              const sel = tiptap?.state?.selection;
              if (sel?.node) {
                const docSize = tiptap.state.doc.content.size;
                const targetPos = Math.min(docSize, Math.max(1, sel.to + 1));
                tiptap.commands.setTextSelection(targetPos);
              }
            } catch {}
            try { tiptap?.commands?.focus?.(); } catch {}
            try {
              const pmRoot = (editorRoot as HTMLElement).querySelector(
                ".ProseMirror"
              ) as HTMLElement | null;
              if (pmRoot) {
                pmRoot.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
              }
            } catch {}
            try {
              document
                .querySelectorAll<HTMLElement>(
                  ".ProseMirror-dropcursor, .bn-drop-cursor, [class*='dropcursor' i]"
                )
                .forEach((node) => { node.style.display = "none"; node.remove(); });
            } catch {}
          });
        };
        document.addEventListener("drop", handler, true);
        return () => document.removeEventListener("drop", handler, true);
      }, [props.editor, props.block.id]);

      // Context menu info.
      const ctxCell = cellCtx ? grid[cellCtx.row]?.[cellCtx.col] : undefined;
      const ctxIsCover = isCover(ctxCell);
      const ctxReal = getCell(ctxCell);
      const ctxCs = ctxReal?.colspan ?? 1;
      const ctxRs = ctxReal?.rowspan ?? 1;
      const canMergeRight =
        !ctxIsCover && ctxReal != null && cellCtx != null &&
        cellCtx.col + ctxCs < cols;
      const canMergeDown =
        !ctxIsCover && ctxReal != null && cellCtx != null &&
        cellCtx.row + ctxRs < rows;
      const canUnmerge = !ctxIsCover && ctxReal != null && (ctxCs > 1 || ctxRs > 1);

      return (
        <>
        <div
        className="my-4 w-full relative"
        contentEditable={false}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          // The cell's own onContextMenu (if any) has already fired
          // by the time this runs. Stop the event here so ProseMirror
          // never sees it and never turns the right-click into a
          // block selection.
          e.stopPropagation();
        }}
        >
            {isEdit && (
              <>
                <EdgePlus
                  side="top" blockId={props.block.id}
                  visible={hoverSide === "top" || externalHoverSide === "top"}
                  active={externalHoverSide === "top"}
                  onClick={() => doAddRow("top")}
                  onHoverChange={(v) => setHoverSide(v ? "top" : null)}
                  onImageDrop={handleEdgeImageDrop}
                />
                <EdgePlus
                  side="bottom" blockId={props.block.id}
                  visible={hoverSide === "bottom" || externalHoverSide === "bottom"}
                  active={externalHoverSide === "bottom"}
                  onClick={() => doAddRow("bottom")}
                  onHoverChange={(v) => setHoverSide(v ? "bottom" : null)}
                  onImageDrop={handleEdgeImageDrop}
                />
                <EdgePlus
                  side="left" blockId={props.block.id}
                  visible={hoverSide === "left" || externalHoverSide === "left"}
                  active={externalHoverSide === "left"}
                  onClick={() => doAddColumn("left")}
                  onHoverChange={(v) => setHoverSide(v ? "left" : null)}
                  onImageDrop={handleEdgeImageDrop}
                />
                <EdgePlus
                  side="right" blockId={props.block.id}
                  visible={hoverSide === "right" || externalHoverSide === "right"}
                  active={externalHoverSide === "right"}
                  onClick={() => doAddColumn("right")}
                  onHoverChange={(v) => setHoverSide(v ? "right" : null)}
                  onImageDrop={handleEdgeImageDrop}
                />
              </>
            )}

            <div
              ref={gridRef}
              className="grid w-full"
              style={{
                gridTemplateColumns: colWidths.map((w) => `${w}fr`).join(" "),
                gridTemplateRows: rowHeights.map((h) => `${h}px`).join(" "),
                gap: `${gap}px`,
              }}
            >
              {grid.flatMap((row, r) =>
                row.map((slot, c) => {
                  if (isCover(slot)) return null;
                  const cell = slot as GalleryCell;
                  const cs = Math.max(1, cell.colspan ?? 1);
                  const rs = Math.max(1, cell.rowspan ?? 1);
                  const rightIdx = c + cs - 1;
                  const bottomIdx = r + rs - 1;
                  const canResizeCol = rightIdx + 1 < cols;
                  const canResizeRow = bottomIdx + 1 < rows;

                  if (!cell.src) {
                    return (
                      <EmptyCell
                      key={`${r}-${c}`}
                      row={r} col={c} blockId={props.block.id}
                      colspan={cs} rowspan={rs}
                      isEdit={isEdit}
                      busy={busyCell === `${r}-${c}`}
                      canResizeCol={canResizeCol}
                      canResizeRow={canResizeRow}
                      canResizeLeft={c > 0}
                      canResizeTop={r > 0}
                      onResizeColStart={startColResize(rightIdx)}
                      onResizeRowStart={startRowResize(bottomIdx)}
                      onResizeColLeftStart={startColResize(c - 1)}
                      onResizeRowTopStart={startRowResize(r - 1)}
                      onImport={importIntoCell}
                      onContextMenu={handleCellContextMenu}
                      />
                    );
                  }
                  return (
                    <FilledCell
                    key={`${r}-${c}`}
                    cell={cell}
                    row={r} col={c} blockId={props.block.id}
                    colspan={cs} rowspan={rs}
                    isEdit={isEdit}
                    canResizeCol={canResizeCol}
                    canResizeRow={canResizeRow}
                    canResizeLeft={c > 0}
                    canResizeTop={r > 0}
                    onResizeColStart={startColResize(rightIdx)}
                    onResizeRowStart={startRowResize(bottomIdx)}
                    onResizeColLeftStart={startColResize(c - 1)}
                    onResizeRowTopStart={startRowResize(r - 1)}
                    onClear={clearCell}
                    onOpen={openLightbox}
                    onContextMenu={handleCellContextMenu}
                    />
                  );
                })
              )}
            </div>
          </div>

          {cellCtx && (
            <div
              className="fixed z-[600] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-2xl py-1 w-64"
              style={{ top: cellCtx.y, left: cellCtx.x }}
              onMouseDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              {ctxReal?.src && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      extractCell(cellCtx.row, cellCtx.col);
                      setCellCtx(null);
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
                  >
                    <MoveRight size={13} /> <span>Extract to note</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      clearCell(cellCtx.row, cellCtx.col);
                      setCellCtx(null);
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-[#2a3136] flex items-center gap-2 border-b border-[#2a3136]"
                  >
                    <Trash2 size={13} /> <span>Delete photo</span>
                  </button>
                </>
              )}

              {canMergeRight && (
                <button
                  type="button"
                  onClick={() => { doMergeRight(cellCtx.row, cellCtx.col); setCellCtx(null); }}
                  className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
                >
                  <Merge size={13} /> <span>Merge with right</span>
                </button>
              )}
              {canMergeDown && (
                <button
                  type="button"
                  onClick={() => { doMergeDown(cellCtx.row, cellCtx.col); setCellCtx(null); }}
                  className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
                >
                  <Merge size={13} className="rotate-90" /> <span>Merge with below</span>
                </button>
              )}
              {canUnmerge && (
                <button
                  type="button"
                  onClick={() => { doUnmerge(cellCtx.row, cellCtx.col); setCellCtx(null); }}
                  className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
                >
                  <SplitSquareHorizontal size={13} /> <span>Unmerge</span>
                </button>
              )}

              {ctxReal?.src && (
                <div className="border-t border-[#2a3136] mt-1 pt-1 px-3 pb-2">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5 mt-1">
                Image scaling
                </div>
                <div className="flex gap-1">
                <button
                type="button"
                onClick={() => {
                  doSetFit(cellCtx.row, cellCtx.col, "contain");
                  setCellCtx(null);
                }}
                className={`flex-1 px-2 py-1 text-xs rounded border transition-colors ${
                  (ctxReal.fit ?? "contain") === "contain"
                  ? "bg-blue-600 border-blue-500 text-white"
                  : "bg-[#0f1315] border-[#2a3136] text-gray-300 hover:border-[#3a4147]"
                }`}
                title="Whole image visible; may leave empty space"
                >
                Fit
                </button>
                <button
                type="button"
                onClick={() => {
                  doSetFit(cellCtx.row, cellCtx.col, "cover");
                  setCellCtx(null);
                }}
                className={`flex-1 px-2 py-1 text-xs rounded border transition-colors ${
                  ctxReal.fit === "cover"
                  ? "bg-blue-600 border-blue-500 text-white"
                  : "bg-[#0f1315] border-[#2a3136] text-gray-300 hover:border-[#3a4147]"
                }`}
                title="Crops the image to fill the whole cell"
                >
                Fill
                </button>
                </div>
                </div>
              )}

              <div className="border-t border-[#2a3136] mt-1 pt-1">
              <button
              type="button"
              onClick={() => { doResetSizes(); setCellCtx(null); }}
              className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
              >
              <RotateCcw size={13} /> <span>Reset sizes</span>
              </button>
              </div>

              <div className="border-t border-[#2a3136] mt-1 pt-1">
                <button
                  type="button"
                  onClick={() => { doDeleteRow(cellCtx.row); setCellCtx(null); }}
                  disabled={rows <= 1}
                  className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-[#2a3136] flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <X size={13} /> <span>Delete row</span>
                </button>
                <button
                  type="button"
                  onClick={() => { doDeleteColumn(cellCtx.col); setCellCtx(null); }}
                  disabled={cols <= 1}
                  className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-[#2a3136] flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <X size={13} /> <span>Delete column</span>
                </button>
              </div>
            </div>
          )}

          {lightbox && (
            <PhotoLightbox
              srcs={lightbox.srcs}
              index={lightbox.index}
              onClose={() => setLightbox(null)}
              onIndexChange={(i) =>
                setLightbox((p) => (p ? { ...p, index: i } : null))
              }
            />
          )}
        </>
      );
    },
  }
);
