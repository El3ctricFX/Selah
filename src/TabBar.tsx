// src/TabBar.tsx
import { Plus, X } from "lucide-react";

export const TAB_BAR_HEIGHT = 34;

export interface TabBarItem {
    id: string;
    label: string;
    icon?: string;
}

export default function TabBar({
    tabs, activeId, onSelect, onClose, onNew, leftInset,
}: {
    tabs: TabBarItem[];
    activeId: string;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onNew: () => void;
    leftInset?: boolean;
}) {
    return (
        <div
        className="absolute top-0 left-0 right-0 z-[80] flex items-end gap-0.5 bg-[#161a1d] border-b border-[#2a3136] pr-2 select-none overflow-x-auto"
        style={{ height: TAB_BAR_HEIGHT, paddingLeft: leftInset ? 52 : 8 }}
        >
        {tabs.map((t) => {
            const active = t.id === activeId;
            return (
                <div
                key={t.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(t.id)}
                onAuxClick={(e) => {
                    if (e.button === 1) { e.preventDefault(); onClose(t.id); }
                }}
                title={t.label}
                className={`group flex items-center gap-1.5 px-3 rounded-t-md text-xs cursor-pointer flex-shrink-0 min-w-[110px] max-w-[200px] transition-colors ${
                    active
                    ? "bg-[#0f1315] text-gray-100"
                    : "text-gray-400 hover:bg-[#1e2327] hover:text-gray-200"
                }`}
                style={{ height: TAB_BAR_HEIGHT - 5 }}
                >
                {t.icon && <span className="flex-shrink-0 text-sm leading-none">{t.icon}</span>}
                <span className="truncate flex-1">{t.label}</span>
                {tabs.length > 1 && (
                    <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
                    className="flex-shrink-0 p-0.5 rounded text-gray-500 hover:text-gray-100 hover:bg-[#2a3136] opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Close tab (Ctrl+W)"
                    >
                    <X size={11} />
                    </button>
                )}
                </div>
            );
        })}
        <button
        type="button"
        onClick={onNew}
        className="flex-shrink-0 mb-1 ml-1 p-1 rounded text-gray-500 hover:text-gray-100 hover:bg-[#1e2327] transition-colors"
        title="New tab (Ctrl+T)"
        >
        <Plus size={14} />
        </button>
        </div>
    );
}
