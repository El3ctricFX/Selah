// src/PaneShell.tsx
import type { ReactNode } from "react";
import { X, ArrowLeftRight } from "lucide-react";
import { ForceReadContext, PaneActiveContext } from "./paneContext";

export default function PaneShell({
    children, split, isSecond, title, focused, forceRead,
    onFocus, onClose, onSwap,
}: {
    children: ReactNode;
    split: boolean;
    isSecond: boolean;
    title: string;
    focused: boolean;
    forceRead: boolean;
    onFocus: () => void;
    onClose: () => void;
    onSwap: () => void;
}) {
    return (
        <ForceReadContext.Provider value={forceRead}>
        <PaneActiveContext.Provider value={focused || !split}>
        <div
        data-pane={isSecond ? "split" : "main"}
        onMouseDownCapture={onFocus}
        onFocusCapture={onFocus}
        className={`relative h-full min-w-0 flex-1 flex flex-col overflow-hidden ${
            split && isSecond ? "border-l border-[#2a3136]" : ""
        }`}
        >
        {split && (
            <div
            className="flex items-center gap-1 px-2 h-7 flex-shrink-0 bg-[#161a1d] border-b border-[#2a3136] text-[11px] select-none"
            style={{ boxShadow: focused ? "inset 0 2px 0 var(--c-accent)" : undefined }}
            >
            <span className={`truncate flex-1 ${focused ? "text-gray-100" : "text-gray-500"}`}>
            {title}
            </span>
            {forceRead && (
                <span
                className="text-[9px] uppercase tracking-wider text-amber-400/80 flex-shrink-0"
                title="This is open in the other pane, so this copy is read-only"
                >
                read-only copy
                </span>
            )}
            {isSecond && (
                <button
                type="button"
                onClick={onSwap}
                className="p-1 rounded text-gray-500 hover:text-gray-100 hover:bg-[#2a3136]"
                title="Swap panes"
                >
                <ArrowLeftRight size={12} />
                </button>
            )}
            <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-gray-500 hover:text-gray-100 hover:bg-[#2a3136]"
            title="Close pane"
            >
            <X size={12} />
            </button>
            </div>
        )}
        <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0">{children}</div>
        </div>
        </div>
        </PaneActiveContext.Provider>
        </ForceReadContext.Provider>
    );
}
