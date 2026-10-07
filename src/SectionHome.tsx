import { useState, useEffect } from "react";
import { readDir, mkdir, writeTextFile, readTextFile, remove, rename } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { ChevronRight, ChevronDown, Plus, FileText, Trash2, Smile } from "lucide-react";
import { useModal } from "./Modal";

interface SectionHomeProps {
  vaultPath: string;
  sectionDir: string;
  sectionName: string;
  sectionIcon: string;
  onOpenNote: (note: { path: string; name: string }) => void;
  activeNotePath?: string;
}

// A clean, flat "page" for a Notes section - this replaces the old nested
// file-tree that used to render inline in the sidebar. Notes still support
// light nesting (a note can hold sub-notes) and manual drag-to-reorder, but
// it's presented as a simple list you land on, not an explorer.
export default function SectionHome({ vaultPath, sectionDir, sectionName, sectionIcon, onOpenNote, activeNotePath }: SectionHomeProps) {
  const [tree, setTree] = useState<any[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{ node: any; x: number; y: number } | null>(null);
  const [draggedItem, setDraggedItem] = useState<any>(null);
  const [dropIndicator, setDropIndicator] = useState<{ node: any; position: "above" | "below" | "inside" } | null>(null);
  const { modal, promptAsync, confirmAsync } = useModal();

  const getParentDir = (p: string) => {
    const normalized = p.replace(/\\/g, "/");
    const idx = normalized.lastIndexOf("/");
    return idx === -1 ? p : p.substring(0, idx);
  };

  const parseFrontmatterIcon = (content: string) => {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
    if (!match) return null;
    for (const line of match[1].split("\n")) {
      const [key, ...val] = line.split(":");
      if (key.trim().toLowerCase() === "icon") return val.join(":").trim();
    }
    return null;
  };

  const readMetadata = async () => {
    try {
      const raw = await readTextFile(await join(vaultPath, ".vault_metadata.json"));
      return JSON.parse(raw);
    } catch {
      return { icons: {}, order: {}, sections: [], sectionOrder: [] };
    }
  };

  const saveMetadata = async (meta: any) => {
    try {
      await writeTextFile(await join(vaultPath, ".vault_metadata.json"), JSON.stringify(meta, null, 2));
    } catch (e) {
      console.error("Failed to save metadata:", e);
    }
  };

  const readTree = async (dirPath: string, metaOrder: Record<string, string[]>, ignoreFileName: string | null = null): Promise<any[]> => {
    try {
      const entries = await readDir(dirPath);
      const items: any[] = [];
      const filesMap = new Map<string, string>();
      const dirsList: { name: string; path: string }[] = [];

      for (const entry of entries) {
        if (entry.name?.startsWith(".") || entry.name === "assets") continue;
        if (entry.name === ignoreFileName) continue;
        const fullPath = await join(dirPath, entry.name);
        if (entry.isDirectory) dirsList.push({ name: entry.name, path: fullPath });
        else if (entry.name?.endsWith(".md")) filesMap.set(entry.name, fullPath);
      }

      for (const dir of dirsList) {
        const matchingMdName = `${dir.name}.md`;
        let folderNotePath = filesMap.get(matchingMdName);
        if (!folderNotePath) {
          folderNotePath = await join(dir.path, matchingMdName);
          try {
            await readTextFile(folderNotePath);
          } catch {
            await writeTextFile(folderNotePath, `---\nicon: 📄\n---\n` + JSON.stringify([]));
          }
        }
        filesMap.delete(matchingMdName);

        let icon = null;
        try {
          icon = parseFrontmatterIcon(await readTextFile(folderNotePath));
        } catch {}

        const children = await readTree(dir.path, metaOrder, matchingMdName);
        items.push({ id: dir.name, name: dir.name, fileName: matchingMdName, path: folderNotePath, dirPath: dir.path, type: "page-folder", icon, children });
      }

      for (const [fileName, filePath] of filesMap.entries()) {
        let icon = null;
        try {
          icon = parseFrontmatterIcon(await readTextFile(filePath));
        } catch {}
        const cleanName = fileName.replace(/\.md$/i, "");
        items.push({ id: fileName, name: cleanName, fileName: `${cleanName}.md`, path: filePath, type: "note", icon, children: [] });
      }

      const customOrder = metaOrder[dirPath];
      if (customOrder && Array.isArray(customOrder)) {
        items.sort((a, b) => {
          const iA = customOrder.indexOf(a.id);
          const iB = customOrder.indexOf(b.id);
          if (iA !== -1 && iB !== -1) return iA - iB;
          if (iA !== -1) return -1;
          if (iB !== -1) return 1;
          return 0;
        });
      }
      return items;
    } catch {
      return [];
    }
  };

  const load = async () => {
    const meta = await readMetadata();
    setTree(await readTree(sectionDir, meta.order || {}));
  };

  useEffect(() => {
    load();
    window.addEventListener("vault-changed", load);
    return () => window.removeEventListener("vault-changed", load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionDir]);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  const createNote = async (targetParentPath: string) => {
    const filename = `Note-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
    try {
      const filePath = await join(targetParentPath, filename);
      await writeTextFile(filePath, `---\nicon: 📄\n---\n` + JSON.stringify([]));
      const meta = await readMetadata();
      const currentOrder = meta.order?.[targetParentPath] || [];
      const newMeta = { ...meta, order: { ...meta.order, [targetParentPath]: [...currentOrder, filename] } };
      await saveMetadata(newMeta);
      await load();
      onOpenNote({ path: filePath, name: filename });
      setExpanded((prev) => ({ ...prev, [targetParentPath]: true }));
    } catch {}
  };

  const createNoteInside = async (node: any) => {
    try {
      let targetDir = node.dirPath || sectionDir;
      if (node.type === "page-folder") {
        targetDir = node.dirPath;
      } else if (node.type === "note") {
        const parentDir = getParentDir(node.path);
        const cleanName = node.name.replace(/\.md$/i, "");
        const newDirPath = await join(parentDir, cleanName);
        await mkdir(newDirPath);
        const newNotePath = await join(newDirPath, `${cleanName}.md`);
        await rename(node.path, newNotePath);
        targetDir = newDirPath;
      }
      const subNoteFilename = `Note-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
      const subNotePath = await join(targetDir, subNoteFilename);
      await writeTextFile(subNotePath, `---\nicon: 📄\n---\n` + JSON.stringify([]));
      await load();
      onOpenNote({ path: subNotePath, name: subNoteFilename });
      const expandKey = node.type === "note" ? node.path : node.dirPath;
      setExpanded((prev) => ({ ...prev, [expandKey]: true }));
    } catch (err) {
      console.error("Failed to create note inside:", err);
    }
    setContextMenu(null);
  };

  const updateFileIcon = async (filePath: string, newIcon: string) => {
    try {
      let content = "";
      try {
        content = await readTextFile(filePath);
      } catch {
        content = JSON.stringify([]);
      }
      const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
      let updatedContent = "";
      if (match) {
        let fm = match[1];
        const body = match[2];
        fm = /^icon\s*:/im.test(fm) ? fm.replace(/^icon\s*:.*$/gim, `icon: ${newIcon}`) : `icon: ${newIcon}\n` + fm;
        updatedContent = `---\n${fm}\n---\n${body}`;
      } else {
        updatedContent = `---\nicon: ${newIcon}\n---\n${content}`;
      }
      await writeTextFile(filePath, updatedContent);
      await load();
    } catch (e) {
      console.error("Failed to update icon:", e);
    }
  };

  const changeIcon = async (node: any) => {
    setContextMenu(null);
    const emoji = await promptAsync(`Enter an emoji icon for ${node.name}:`);
    if (!emoji) return;
    await updateFileIcon(node.path, emoji);
  };

  const handleDelete = async (node: any) => {
    setContextMenu(null);
    const ok = await confirmAsync(`Delete "${node.name}" and all its contents?`);
    if (!ok) return;
    try {
      const targetPath = node.type === "page-folder" ? node.dirPath : node.path;
      await remove(targetPath, { recursive: true });
      await load();
    } catch {}
  };

  const handleDragStart = (e: React.DragEvent, node: any) => {
    e.stopPropagation();
    setDraggedItem(node);
  };
  const handleDragOver = (e: React.DragEvent, node: any) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const pos = y < rect.height * 0.3 ? "above" : y > rect.height * 0.7 ? "below" : "inside";
    setDropIndicator({ node, position: pos });
  };
  const handleDragLeave = () => setDropIndicator(null);

  const handleDrop = async (e: React.DragEvent, targetNode: any, parentDirPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggedItem) return setDropIndicator(null);

    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const dropAction = y < rect.height * 0.3 ? "above" : y > rect.height * 0.7 ? "below" : "inside";
    setDropIndicator(null);

    const isDraggedFolder = draggedItem.type === "page-folder";
    const draggedSourcePath = isDraggedFolder ? draggedItem.dirPath : draggedItem.path;
    const draggedId = draggedItem.id;
    const draggedTargetName = isDraggedFolder ? draggedItem.name : draggedItem.fileName;

    if (dropAction === "inside") {
      let targetDir = parentDirPath;
      if (targetNode.type === "page-folder") {
        targetDir = targetNode.dirPath;
      } else if (targetNode.type === "note") {
        const parentDir = getParentDir(targetNode.path);
        const targetCleanName = targetNode.name.replace(/\.md$/i, "");
        const newDirPath = await join(parentDir, targetCleanName);
        try {
          await mkdir(newDirPath);
          await rename(targetNode.path, await join(newDirPath, targetNode.fileName));
          targetDir = newDirPath;
          setExpanded((prev) => ({ ...prev, [newDirPath]: true }));
        } catch {
          targetDir = newDirPath;
        }
      }
      const newPath = await join(targetDir, draggedTargetName);
      if (newPath === draggedSourcePath || draggedSourcePath.startsWith(newPath + "\\")) return setDraggedItem(null);
      try {
        await rename(draggedSourcePath, newPath);
        setDraggedItem(null);
        await load();
      } catch (err) {
        console.error("Failed to move inside:", err);
        setDraggedItem(null);
      }
    } else {
      const targetDir = parentDirPath;
      const newPath = await join(targetDir, draggedTargetName);
      try {
        if (draggedSourcePath !== newPath) await rename(draggedSourcePath, newPath);
        const meta = await readMetadata();
        let currentOrder = meta.order?.[targetDir];
        if (!currentOrder) {
          try {
            const entries = await readDir(targetDir);
            currentOrder = entries.filter((e) => !e.name?.startsWith(".") && e.name !== "assets").map((e) => e.name);
          } catch {
            currentOrder = [];
          }
        }
        const cleanOrder = [...currentOrder].filter((n) => n !== draggedId);
        const targetIdx = cleanOrder.indexOf(targetNode.id);
        if (targetIdx !== -1) cleanOrder.splice(dropAction === "above" ? targetIdx : targetIdx + 1, 0, draggedId);
        else cleanOrder.push(draggedId);
        await saveMetadata({ ...meta, order: { ...meta.order, [targetDir]: cleanOrder } });
        setDraggedItem(null);
        await load();
      } catch (err) {
        console.error("Failed to reorder:", err);
        setDraggedItem(null);
      }
    }
  };

  const handleDropToRoot = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggedItem) return;
    const isDraggedFolder = draggedItem.type === "page-folder";
    const draggedSourcePath = isDraggedFolder ? draggedItem.dirPath : draggedItem.path;
    const draggedId = draggedItem.id;
    const draggedTargetName = isDraggedFolder ? draggedItem.name : draggedItem.fileName;
    const newPath = await join(sectionDir, draggedTargetName);
    if (newPath === draggedSourcePath) return setDraggedItem(null);

    try {
      if (draggedSourcePath !== newPath) await rename(draggedSourcePath, newPath);
      const meta = await readMetadata();
      let currentOrder = meta.order?.[sectionDir];
      if (!currentOrder) {
        try {
          const entries = await readDir(sectionDir);
          currentOrder = entries.filter((e) => !e.name?.startsWith(".") && e.name !== "assets").map((e) => e.name);
        } catch {
          currentOrder = [];
        }
      }
      const cleanOrder = [...currentOrder].filter((n) => n !== draggedId);
      cleanOrder.push(draggedId);
      await saveMetadata({ ...meta, order: { ...meta.order, [sectionDir]: cleanOrder } });
      setDraggedItem(null);
      await load();
    } catch (err) {
      console.error("Failed to move to root:", err);
      setDraggedItem(null);
    }
  };

  const renderTree = (nodes: any[], depth: number, parentDirPath: string) => {
    return nodes.map((node) => {
      const isActive = activeNotePath === node.path;
      const expandKey = node.dirPath || node.path;
      const isExpanded = expanded[expandKey];
      const hasChildren = node.children && node.children.length > 0;
      const above = dropIndicator?.node === node && dropIndicator?.position === "above";
      const below = dropIndicator?.node === node && dropIndicator?.position === "below";
      const inside = dropIndicator?.node === node && dropIndicator?.position === "inside";

      return (
        <div key={expandKey} className="relative">
          {above && <div className="absolute -top-px left-0 right-0 h-0.5 bg-blue-500 z-20 pointer-events-none" />}
          <div
            draggable
            onDragStart={(e) => handleDragStart(e, node)}
            onDragOver={(e) => handleDragOver(e, node)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, node, parentDirPath)}
            className={`flex items-center justify-between py-2 px-3 rounded-md cursor-pointer group transition-colors ${
              isActive ? "bg-[#1e2327] text-green-400" : "text-gray-300 hover:bg-[#181c1f]"
            } ${inside ? "ring-1 ring-blue-500 bg-blue-500/10" : ""}`}
            style={{ paddingLeft: `${depth * 16 + 12}px` }}
            onClick={() => node.path && onOpenNote({ path: node.path, name: node.fileName || `${node.name}.md` })}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu({ node, x: e.clientX, y: e.clientY });
            }}
          >
            <div className="flex items-center space-x-2 truncate">
              {hasChildren ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpanded((prev) => ({ ...prev, [expandKey]: !isExpanded }));
                  }}
                  className="text-gray-500 hover:text-gray-200 flex-shrink-0"
                >
                  {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
              ) : (
                <span className="w-[13px] flex-shrink-0" />
              )}
              <span className="text-sm flex-shrink-0">{node.icon || "📄"}</span>
              <span className="text-sm truncate">{node.name}</span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                createNoteInside(node);
              }}
              className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-gray-200 p-1 rounded transition-opacity"
              title="New note inside"
            >
              <Plus size={13} />
            </button>
          </div>
          {below && <div className="absolute -bottom-px left-0 right-0 h-0.5 bg-blue-500 z-20 pointer-events-none" />}
          {isExpanded && hasChildren && <div>{renderTree(node.children, depth + 1, node.dirPath || parentDirPath)}</div>}
        </div>
      );
    });
  };

  return (
    <div className="w-full h-full overflow-y-auto bg-[#0f1315]">
      {modal}
      <div className="max-w-2xl mx-auto px-8 py-10">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-semibold text-gray-100 flex items-center space-x-2">
            <span>{sectionIcon}</span>
            <span>{sectionName}</span>
          </h2>
          <button
            onClick={() => createNote(sectionDir)}
            className="flex items-center space-x-1.5 text-sm bg-[#1e2327] hover:bg-[#2a3136] border border-[#30363d] px-3 py-1.5 rounded transition-colors cursor-pointer"
          >
            <Plus size={14} /> <span>New Note</span>
          </button>
        </div>

        {tree.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-gray-500 mt-16">
            <FileText size={28} className="mb-3 opacity-60" />
            <p className="text-sm">No notes yet. Create your first one above.</p>
          </div>
        ) : (
          <div
            className="space-y-0.5"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              if (e.target === e.currentTarget) handleDropToRoot(e);
            }}
          >
            {renderTree(tree, 0, sectionDir)}
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          className="fixed z-50 bg-[#1e2327] border border-[#2a3136] rounded shadow-xl py-1 w-48"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => createNoteInside(contextMenu.node)} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]">
            <FileText size={14} /> <span>Create Note Inside</span>
          </button>
          <button onClick={() => changeIcon(contextMenu.node)} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]">
            <Smile size={14} /> <span>Change Icon</span>
          </button>
          <button onClick={() => handleDelete(contextMenu.node)} className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-[#2a3136] flex items-center space-x-2">
            <Trash2 size={14} /> <span>Delete</span>
          </button>
        </div>
      )}
    </div>
  );
}