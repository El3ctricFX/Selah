// src/DateTimePickerModal.tsx
import { useState, useEffect, useMemo, useRef } from "react";
import { X, Calendar, Clock, ChevronDown } from "lucide-react";

// ── Custom Select Component ──────────────────────────────────────────────
function CustomSelect({
  value,
  onChange,
  options,
  className,
  align = "left",
}: {
  value: string | number;
  onChange: (val: any) => void;
  options: { label: string; value: string | number }[];
  className?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef({ text: "", lastTime: 0, timeout: null as any });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (open) {
        e.stopPropagation();
        setOpen(false);
      }
      return;
    }

    if (e.key === "Enter" || e.key === " ") {
      if (!open) {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }

    // Type-to-search logic
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      if (now - searchRef.current.lastTime > 1000) {
        searchRef.current.text = "";
      }

      const char = e.key.toLowerCase();
      const isRepeat = searchRef.current.text === char && now - searchRef.current.lastTime < 1000;

      // If the same key is pressed rapidly, cycle through options starting with that letter
      if (isRepeat) {
        const matches = options.filter(o => String(o.label).toLowerCase().startsWith(char));
        if (matches.length > 0) {
          const currentIdx = matches.findIndex(o => o.value === value);
          const nextIdx = (currentIdx + 1) % matches.length;
          onChange(matches[nextIdx].value);
        }
        searchRef.current.lastTime = now;
        return;
      }

      searchRef.current.text += char;
      searchRef.current.lastTime = now;

      const searchStr = searchRef.current.text;
      const match = options.find(o => String(o.label).toLowerCase().startsWith(searchStr));

      if (match) {
        onChange(match.value);
        if (!open) setOpen(true);
      }

      if (searchRef.current.timeout) clearTimeout(searchRef.current.timeout);
      searchRef.current.timeout = setTimeout(() => {
        searchRef.current.text = "";
      }, 1000);
    }
  };

  return (
    <div className={`relative ${className || ""}`} ref={ref}>
    <button
    type="button"
    onKeyDown={handleKeyDown}
    onClick={() => setOpen((o) => !o)}
    className="w-full flex items-center justify-between bg-[#0f1315] border border-[#30363d] rounded px-2 py-1.5 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
    >
    <span className="truncate">{selected?.label || ""}</span>
    <ChevronDown size={12} className="text-gray-500 flex-shrink-0" />
    </button>

    {open && (
      <div
      className={`absolute top-full mt-1 z-[999] bg-[#1e2327] border border-[#2a3136] rounded shadow-2xl py-1 max-h-60 overflow-y-auto w-full ${
        align === "right" ? "right-0" : "left-0"
      }`}
      >
      {options.map((opt) => (
        <button
        key={opt.value}
        type="button"
        onClick={() => {
          onChange(opt.value);
          setOpen(false);
        }}
        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[#2a3136] transition-colors ${
          opt.value === value ? "text-blue-400 bg-blue-600/10 font-medium" : "text-gray-300"
        }`}
        >
        {opt.label}
        </button>
      ))}
      </div>
    )}
    </div>
  );
}

// ── Main Modal ───────────────────────────────────────────────────────────
export default function DateTimePickerModal({
  initialIso,
  title,
  onSave,
  onClose,
}: {
  initialIso: string;
  title: string;
  onSave: (iso: string) => void;
  onClose: () => void;
}) {
  const initialDate = initialIso ? new Date(initialIso) : new Date();
  const [year, setYear] = useState(initialDate.getFullYear());
  const [month, setMonth] = useState(initialDate.getMonth());
  const [day, setDay] = useState(initialDate.getDate());
  const [hour12, setHour12] = useState(initialDate.getHours() % 12 || 12);
  const [minute, setMinute] = useState(initialDate.getMinutes());
  const [ampm, setAmpm] = useState<"AM" | "PM">(initialDate.getHours() >= 12 ? "PM" : "AM");

  const daysInMonth = useMemo(() => new Date(year, month + 1, 0).getDate(), [year, month]);

  useEffect(() => {
    if (day > daysInMonth) setDay(daysInMonth);
  }, [daysInMonth, day]);

    const handleSave = () => {
      let h24 = hour12;
      if (ampm === "PM" && h24 < 12) h24 += 12;
      if (ampm === "AM" && h24 === 12) h24 = 0;
      const d = new Date(year, month, day, h24, minute, 0, 0);
      onSave(d.toISOString());
      onClose();
    };

    const MONTHS = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];

    const yearOptions = Array.from({ length: 100 }, (_, i) => ({
      label: String(new Date().getFullYear() - 50 + i),
                                                               value: new Date().getFullYear() - 50 + i,
    }));

    return (
      <div className="fixed inset-0 z-[600] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
      data-opaque
      className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[360px] overflow-visible"
      onClick={(e) => e.stopPropagation()}
      >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a3136] bg-[#1a1e21] rounded-t-lg">
      <Calendar size={14} className="text-blue-400" />
      <span className="text-sm font-medium text-gray-100 truncate flex-1">Change Date & Time</span>
      <button onClick={onClose} className="text-gray-500 hover:text-gray-300 p-0.5"><X size={14} /></button>
      </div>

      <div className="p-4 space-y-4">
      <p className="text-xs text-gray-400">
      Editing <span className="text-gray-200 font-medium">"{title}"</span>
      </p>

      <div>
      <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5 flex items-center gap-1.5">
      <Calendar size={10} /> Date
      </label>
      <div className="flex gap-2">
      <CustomSelect
      className="flex-1"
      value={month}
      onChange={setMonth}
      options={MONTHS.map((m, i) => ({ label: m, value: i }))}
      />
      <CustomSelect
      className="w-16"
      value={day}
      onChange={setDay}
      options={Array.from({ length: daysInMonth }, (_, i) => ({ label: String(i + 1), value: i + 1 }))}
      />
      <CustomSelect
      className="w-24"
      value={year}
      onChange={setYear}
      options={yearOptions}
      align="right"
      />
      </div>
      </div>

      <div>
      <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5 flex items-center gap-1.5">
      <Clock size={10} /> Time
      </label>
      <div className="flex gap-2 items-center">
      <CustomSelect
      className="w-16"
      value={hour12}
      onChange={setHour12}
      options={Array.from({ length: 12 }, (_, i) => ({ label: String(i + 1), value: i + 1 }))}
      />
      <span className="text-gray-500">:</span>
      <CustomSelect
      className="w-16"
      value={minute}
      onChange={setMinute}
      options={Array.from({ length: 60 }, (_, i) => ({ label: String(i).padStart(2, "0"), value: i }))}
      />
      <CustomSelect
      className="w-20"
      value={ampm}
      onChange={setAmpm}
      options={[{ label: "AM", value: "AM" }, { label: "PM", value: "PM" }]}
      align="right"
      />
      </div>
      </div>
      </div>

      <div className="flex justify-end gap-2 px-4 py-3 border-t border-[#2a3136] bg-[#1a1e21] rounded-b-lg">
      <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-[#2a3136] rounded transition-colors">Cancel</button>
      <button type="button" onClick={handleSave} className="px-4 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium">Save Changes</button>
      </div>
      </div>
      </div>
    );
}
