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
