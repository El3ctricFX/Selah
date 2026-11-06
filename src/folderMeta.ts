// src/folderMeta.ts
export interface FolderMeta {
  icon?: string;
  color?: string;
}

export type FolderMetaMap = Record<string, FolderMeta>;

// Sidebar folders (years, months) aren't files, so their icon/color lives
// in the vault metadata under `folderMeta`. Key = category id + path parts.
export function makeFolderKey(categoryId: string, ...parts: string[]): string {
  return [categoryId, ...parts].join("/");
}

// Default icon + color for each journal month (1–12). Used whenever the
// user hasn't picked their own.
export const MONTH_DEFAULTS: Record<number, { icon: string; color: string }> = {
  1:  { icon: "❄️",  color: "blue"   }, // Ice Blue
  2:  { icon: "❤️",  color: "pink"   }, // Deep Rose
  3:  { icon: "🌱",  color: "green"  }, // Sage Green
  4:  { icon: "🍃",  color: "green"  }, // Sage Green
  5:  { icon: "☀️",  color: "yellow" }, // Bright Yellow
  6:  { icon: "🏖️", color: "teal"   }, // Ocean Teal
  7:  { icon: "🎆",  color: "gold"   }, // Sunset Gold
  8:  { icon: "🌻",  color: "orange" }, // Amber Orange
  9:  { icon: "🍂",  color: "brown"  }, // Rust Brown
  10: { icon: "🎃",  color: "orange" }, // Pumpkin Orange
  11: { icon: "🍁",  color: "red"    }, // Cranberry Red
  12: { icon: "🌲",  color: "green"  }, // Pine Green
};

/** Fills in the month's default icon/color wherever the user hasn't set one. */
export function withMonthDefaults(
  meta: FolderMeta | undefined,
  month: string | number
): FolderMeta {
  const d = MONTH_DEFAULTS[Number(month)];
  if (!d) return meta || {};
  return { ...meta, icon: meta?.icon || d.icon, color: meta?.color || d.color };
}

export const FOLDER_COLORS: Record<string, { label: string; text: string }> = {
  default: { label: "Default", text: "var(--c-folder-default)" },
  gray:    { label: "Gray",    text: "var(--c-folder-gray)" },
  brown:   { label: "Brown",   text: "var(--c-folder-brown)" },
  orange:  { label: "Orange",  text: "var(--c-folder-orange)" },
  yellow:  { label: "Yellow",  text: "var(--c-folder-yellow)" },
  green:   { label: "Green",   text: "var(--c-folder-green)" },
  blue:    { label: "Blue",    text: "var(--c-folder-blue)" },
  purple:  { label: "Purple",  text: "var(--c-folder-purple)" },
  pink:    { label: "Pink",    text: "var(--c-folder-pink)" },
  red:     { label: "Red",     text: "var(--c-folder-red)" },
  teal:    { label: "Teal",    text: "var(--c-folder-teal)" },
  gold:    { label: "Gold",    text: "var(--c-folder-gold)" },
  // Rendering special-cases this one; `text` is only a safe fallback.
  rainbow: { label: "Rainbow", text: "var(--c-folder-rainbow)" },
};

export function colorForFolder(meta?: FolderMeta): string {
  if (!meta?.color) return FOLDER_COLORS.default.text;
  return FOLDER_COLORS[meta.color]?.text ?? FOLDER_COLORS.default.text;
}

/** True when the stored color is the rainbow preset. */
export function isRainbowColor(color?: string | null): boolean {
  return color === "rainbow";
}
