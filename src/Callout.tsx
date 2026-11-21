// src/Callout.tsx
import { createReactBlockSpec } from "@blocknote/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import EmojiPicker, { Theme, EmojiStyle } from "emoji-picker-react";


// Notion-style dark tinted backgrounds.
const COLORS = {
  gray:   { label: "Gray",   bg: "rgba(143, 143, 143, 0.14)", swatch: "#8f8f8f" },
  brown:  { label: "Brown",  bg: "rgba(159, 107, 84, 0.18)",  swatch: "#9f6b54" },
  orange: { label: "Orange", bg: "rgba(255, 159, 64, 0.16)",  swatch: "#ff9f40" },
  yellow: { label: "Yellow", bg: "rgba(255, 212, 0, 0.14)",   swatch: "#ffd400" },
  green:  { label: "Green",  bg: "rgba(68, 131, 97, 0.18)",   swatch: "#448361" },
  blue:   { label: "Blue",   bg: "rgba(35, 131, 226, 0.14)",  swatch: "#2383e2" },
  purple: { label: "Purple", bg: "rgba(172, 130, 217, 0.16)", swatch: "#ac82d9" },
  pink:   { label: "Pink",   bg: "rgba(226, 110, 176, 0.16)", swatch: "#e26eb0" },
  red:    { label: "Red",    bg: "rgba(255, 100, 100, 0.14)", swatch: "#ff6464" },
} as const;

type ColorKey = keyof typeof COLORS;

export const createCallout = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      icon: { default: "" },
      color: { default: "gray" },
    },
    content: "inline",
  },
  {
    render: (props) => {
      const live = props.editor.getBlock(props.block.id) ?? props.block;
      const rawIcon = (live.props.icon as string) || "";
const icon = rawIcon === "none" ? "" : rawIcon;
      const colorKey = ((live.props.color as string) || "gray") as ColorKey;
      const activeBg = COLORS[colorKey]?.bg ?? COLORS.gray.bg;

      const [menuOpen, setMenuOpen] = useState(false);
      const [pickerOpen, setPickerOpen] = useState(false);
      const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);

      // BlockNote doesn't reliably re-render block components when the
      // editor's `editable` flag flips, so we mirror it into local state
      // and refresh it on a light interval. The setter bails out when the
      // value hasn't changed, so this doesn't cause needless re-renders.
      const localContentRef = useRef<HTMLDivElement>(null);
      const [isEditable, setIsEditable] = useState<boolean>(true);
      useEffect(() => {
        const read = (): boolean => {
          const ed = props.editor as any;
          if (typeof ed.isEditable === "boolean") return ed.isEditable;
          const el = localContentRef.current;
          return el?.isContentEditable ?? true;
        };
        setIsEditable(read());
        const id = setInterval(() => {
          setIsEditable((prev) => {
            const next = read();
            return prev === next ? prev : next;
          });
        }, 200);
        return () => clearInterval(id);
      }, [props.editor, props.contentRef]);

      const iconRef = useRef<HTMLButtonElement>(null);
      const menuRef = useRef<HTMLDivElement>(null);
      const pickerRef = useRef<HTMLDivElement>(null);

      useEffect(() => {
        if (!menuOpen && !pickerOpen) return;

        const onMouseDown = (e: MouseEvent) => {
          const t = e.target as Node;
          if (iconRef.current?.contains(t)) return;
          if (menuRef.current?.contains(t)) return;
          if (pickerRef.current?.contains(t)) return;
          setMenuOpen(false);
          setPickerOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
          if (e.key === "Escape") {
            setMenuOpen(false);
            setPickerOpen(false);
          }
        };
        document.addEventListener("mousedown", onMouseDown);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onMouseDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [menuOpen, pickerOpen]);

      const computeAnchor = () => {
        const rect = iconRef.current?.getBoundingClientRect();
        if (!rect) return null;
        return { top: rect.bottom + 6, left: rect.left };
      };

      const openMenu = () => {
        if (!isEditable) return;
        const a = computeAnchor();
        if (!a) return;
        setAnchor(a);
        setMenuOpen(true);
        setPickerOpen(false);
      };

      const openPicker = () => {
        if (!isEditable) return;
        const a = computeAnchor();
        if (!a) return;
        setAnchor(a);
        setPickerOpen(true);
        setMenuOpen(false);
      };

      const apply = (patch: Record<string, any>) => {
        try {
          props.editor.updateBlock(props.block.id, { props: patch });
        } catch (err) {
          console.error("[callout] updateBlock failed:", err);
        }
      };

      const applyColor = (c: ColorKey) => {
        apply({ color: c });
      };

      const applyIcon = (emoji: string) => {
        apply({ icon: emoji });
        setPickerOpen(false);
      };

      return (
        <div
          className="flex items-start gap-3 my-2 w-full rounded-md px-4 py-3"
          style={{ backgroundColor: activeBg }}
        >
          {(icon || isEditable) && (
            <div className="flex-shrink-0 pt-0.5">
              <button
                ref={iconRef}
                contentEditable={false}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isEditable) return;
                  if (menuOpen) { setMenuOpen(false); return; }
                  if (pickerOpen) { setPickerOpen(false); return; }
                  openMenu();
                }}
                className={`leading-none w-6 h-6 flex items-center justify-center rounded transition-colors ${isEditable ? "hover:bg-black/20 cursor-pointer" : "cursor-default"} ${icon ? "text-xl" : "text-sm text-gray-500/70"}`}
                title={isEditable ? (icon ? "Change emoji or color" : "Add emoji or change color") : undefined}
              >
                {icon || "+"}
              </button>
            </div>
          )}

          <div
            ref={(node) => {
              (localContentRef as any).current = node;
              if (typeof props.contentRef === "function") {
                props.contentRef(node);
              } else if (props.contentRef && typeof props.contentRef === "object") {
                (props.contentRef as any).current = node;
              }
            }}
            className="flex-1 min-w-0 outline-none text-gray-100 leading-relaxed"
            style={{ minHeight: "1.5em" }}
          />

          {menuOpen && anchor && createPortal(
            <div
              ref={menuRef}
              contentEditable={false}
              className="bg-[#1e2327] border border-[#2a3136] rounded-md shadow-xl py-1 w-56"
              style={{ position: "fixed", top: anchor.top, left: anchor.left, zIndex: 9999 }}
            >
              <button
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); openPicker(); }}
                className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center gap-2 border-b border-[#2a3136]"
              >
                <span className="text-base">😀</span>
                <span>Change Emoji</span>
              </button>
              {icon && (
                <button
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    apply({ icon: "none" });
                    setMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center gap-2 border-b border-[#2a3136]"
                >
                  <span className="text-base opacity-60">🚫</span>
                  <span>Remove Emoji</span>
                </button>
              )}

              <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-gray-500">
                Color
              </div>
              <div className="px-3 pb-3 pt-1 grid grid-cols-5 gap-1.5">
                {(Object.keys(COLORS) as ColorKey[]).map((c) => {
                  const isActive = colorKey === c;
                  return (
                    <button
                      key={c}
                      title={COLORS[c].label}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        applyColor(c);
                      }}
                      className={`w-7 h-7 rounded-full flex items-center justify-center transition-transform hover:scale-110 ${
                        isActive ? "ring-2 ring-white ring-offset-1 ring-offset-[#1e2327]" : ""
                      }`}
                      style={{
                        backgroundColor: COLORS[c].bg,
                        border: `2px solid ${COLORS[c].swatch}`,
                      }}
                    />
                  );
                })}
              </div>
            </div>,
            document.body
          )}

          {pickerOpen && anchor && createPortal(
            <div
              ref={pickerRef}
              contentEditable={false}
              style={{ position: "fixed", top: anchor.top, left: anchor.left, zIndex: 9999 }}
            >
              <EmojiPicker
                theme={Theme.DARK}
                emojiStyle={EmojiStyle.NATIVE}
                onEmojiClick={(emojiData) => applyIcon(emojiData.emoji)}
                width={320}
                height={400}
                previewConfig={{ showPreview: false }}
              />
            </div>,
            document.body
          )}
        </div>
      );
    },
  }
);
