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
  default: { label: "Default", text: "#9ca3af" },
  gray:    { label: "Gray",    text: "#9ca3af" },
  brown:   { label: "Brown",   text: "#b08872" },
  orange:  { label: "Orange",  text: "#e5a05e" },
  yellow:  { label: "Yellow",  text: "#e5c95e" },
  green:   { label: "Green",   text: "#6dbb8a" },
  blue:    { label: "Blue",    text: "#5e9ee5" },
  purple:  { label: "Purple",  text: "#b38ee5" },
  pink:    { label: "Pink",    text: "#e58eb5" },
  red:     { label: "Red",     text: "#e57a7a" },
};

export function colorForFolder(meta?: FolderMeta): string {
  if (!meta?.color) return FOLDER_COLORS.default.text;
  return FOLDER_COLORS[meta.color]?.text ?? FOLDER_COLORS.default.text;
}