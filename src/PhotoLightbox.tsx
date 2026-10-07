// src/PhotoLightbox.tsx
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from "lucide-react";

/**
 * A URL-based lightbox with zoom + pan. Takes already-resolved src URLs
 * (data:, asset:, http(s):, blob:) — handy for images that are already in
 * the DOM (e.g. BlockNote's editor content).
 */
export default function PhotoLightbox({
  srcs,
  index,
  onClose,
  onIndexChange,
}: {
  srcs: string[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    startX: number;
    startY: number;
    panX: number;
    panY: number;
    moved: boolean;
  } | null>(null);

  const current = srcs[index];

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      else if (e.key === "ArrowRight" && index < srcs.length - 1)
        onIndexChange(index + 1);
      else if (e.key === "+" || e.key === "=")
        setZoom((z) => Math.min(z * 1.25, 8));
      else if (e.key === "-") {
        setZoom((z) => {
          const next = Math.max(z / 1.25, 1);
          if (next === 1) setPan({ x: 0, y: 0 });
          return next;
        });
      } else if (e.key === "0") {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, srcs.length, onClose, onIndexChange]);

  const zoomBy = (factor: number) => {
    setZoom((z) => {
      const next = Math.max(1, Math.min(z * factor, 8));
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return;
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      panX: pan.x,
      panY: pan.y,
      moved: false,
    };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (!d.moved) return;
    setPan({ x: d.panX + dx, y: d.panY + dy });
  };

  const onMouseUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.moved) return;
    if (zoom === 1) zoomBy(2);
  };

  useEffect(() => {
    const up = () => {
      dragRef.current = null;
    };
    document.addEventListener("mouseup", up);
    return () => document.removeEventListener("mouseup", up);
  }, []);

  if (!current) return null;

  return (
    <div
      className="fixed inset-0 z-[500] bg-black/95 flex items-center justify-center overflow-hidden"
      onClick={onClose}
    >
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); zoomBy(1 / 1.25); }}
          disabled={zoom <= 1}
          className="p-2 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors disabled:opacity-30"
          title="Zoom out (-)"
        >
          <ZoomOut size={18} />
        </button>
        <span className="text-white/70 text-xs tabular-nums px-2">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); zoomBy(1.25); }}
          className="p-2 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors"
          title="Zoom in (+)"
        >
          <ZoomIn size={18} />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setZoom(1); setPan({ x: 0, y: 0 }); }}
          className="p-2 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors text-[10px] font-bold"
          title="Reset (0)"
        >
          1×
        </button>
        <button
          type="button"
          onClick={onClose}
          className="p-2 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors"
          title="Close (Esc)"
        >
          <X size={18} />
        </button>
      </div>

      {srcs.length > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (index > 0) onIndexChange(index - 1); }}
            disabled={index === 0}
            className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed z-10"
            title="Previous (←)"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (index < srcs.length - 1) onIndexChange(index + 1); }}
            disabled={index === srcs.length - 1}
            className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed z-10"
            title="Next (→)"
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}

      <div
        className="w-full h-full flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        style={{
          cursor: zoom > 1 ? (dragRef.current ? "grabbing" : "grab") : "zoom-in",
        }}
      >
        <img
          src={current}
          alt=""
          draggable={false}
          className="select-none"
          style={{
            maxWidth: "80vw",
            maxHeight: "78vh",
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "center center",
            transition: dragRef.current?.moved ? "none" : "transform 120ms ease-out",
            userSelect: "none",
          }}
        />
      </div>

      {srcs.length > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/70 bg-black/60 px-3 py-1.5 rounded-full">
          {index + 1} / {srcs.length}
        </div>
      )}

      {zoom === 1 && (
        <div className="absolute bottom-4 right-4 text-[10px] text-white/50 bg-black/60 px-2 py-1 rounded">
          click to zoom · scroll to scale · drag to pan
        </div>
      )}
    </div>
  );
}