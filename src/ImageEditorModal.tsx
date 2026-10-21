import { useState, useCallback, useEffect } from "react";
import ReactCrop, { type Crop, type PixelCrop } from "react-image-crop";
import { X, Check, RotateCw, Loader2 } from "lucide-react";
import { readFile } from "@tauri-apps/plugin-fs";
import { assetUrlToAbsolutePath } from "./imageAssets";

const getCroppedImg = async (imageEl: HTMLImageElement, pixelCrop: PixelCrop): Promise<Blob | null> => {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const scaleX = imageEl.naturalWidth / imageEl.width;
  const scaleY = imageEl.naturalHeight / imageEl.height;

  // CLAMP: Ensure the crop never extends past the image boundaries
  const x = Math.max(0, pixelCrop.x);
  const y = Math.max(0, pixelCrop.y);
  const width = Math.min(imageEl.width - x, pixelCrop.width);
  const height = Math.min(imageEl.height - y, pixelCrop.height);

  canvas.width = width * scaleX;
  canvas.height = height * scaleY;

  ctx.drawImage(
    imageEl,
    x * scaleX,
    y * scaleY,
    width * scaleX,
    height * scaleY,
    0,
    0,
    width * scaleX,
    height * scaleY
  );

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/webp", 0.9);
  });
};

const rotateImageSrc = (src: string, degrees: number): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(src);

      const rotRad = (degrees * Math.PI) / 180;
      const bBoxWidth = Math.abs(Math.cos(rotRad) * img.width) + Math.abs(Math.sin(rotRad) * img.height);
      const bBoxHeight = Math.abs(Math.sin(rotRad) * img.width) + Math.abs(Math.cos(rotRad) * img.height);

      canvas.width = bBoxWidth;
      canvas.height = bBoxHeight;

      ctx.translate(bBoxWidth / 2, bBoxHeight / 2);
      ctx.rotate(rotRad);
      ctx.translate(-img.width / 2, -img.height / 2);
      ctx.drawImage(img, 0, 0);

      resolve(canvas.toDataURL("image/webp", 0.95));
    };
    img.src = src;
  });
};

export default function ImageEditorModal({
  imageUrl,
  initialCrop,
  onClose,
  onSave,
}: {
  imageUrl: string;
  initialCrop?: any;
  onClose: () => void;
  onSave: (blob: Blob, percentCrop: any) => Promise<void>;
}) {
  const [baseUrl, setBaseUrl] = useState<string>(""); 
  const [displayUrl, setDisplayUrl] = useState<string>(""); 
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const [rotation, setRotation] = useState(0);
  const [saving, setSaving] = useState(false);
  const [imgRef, setImgRef] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const abs = assetUrlToAbsolutePath(imageUrl);
        if (abs) {
          const bytes = await readFile(abs);
          const blob = new Blob([bytes as any], { type: "image/png" });
          const url = URL.createObjectURL(blob);
          if (!cancelled) {
            setBaseUrl(url);
            setDisplayUrl(url);
          }
        } else {
          if (!cancelled) {
            setBaseUrl(imageUrl);
            setDisplayUrl(imageUrl);
          }
        }
      } catch (e) {
        console.error("Failed to load image for cropping:", e);
        if (!cancelled) {
          setBaseUrl(imageUrl);
          setDisplayUrl(imageUrl);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [imageUrl]);

  const handleRotate = async () => {
    const nextRot = (rotation + 90) % 360;
    setRotation(nextRot);
    setCrop(undefined); 
    setCompletedCrop(undefined);
    const rotated = await rotateImageSrc(baseUrl, nextRot);
    setDisplayUrl(rotated);
  };

  const onLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setImgRef(img);
    
    if (initialCrop && rotation === 0) {
      // Clamp the initial crop to ensure it never exceeds 100%
      setCrop({
        unit: '%',
        x: Math.max(0, initialCrop.x),
        y: Math.max(0, initialCrop.y),
        width: Math.min(100, initialCrop.width),
        height: Math.min(100, initialCrop.height),
      });
    } else {
      // Set to 100% of the actual image bounds
      setCrop({ unit: '%', x: 0, y: 0, width: 100, height: 100 });
    }
  }, [initialCrop, rotation]);

  const handleSave = async () => {
    if (!displayUrl || !imgRef) return;
    setSaving(true);
    try {
      const finalCrop = completedCrop || {
        unit: 'px',
        x: 0,
        y: 0,
        width: imgRef.width,
        height: imgRef.height
      };

      const blob = await getCroppedImg(imgRef, finalCrop as PixelCrop);
      if (blob) {
        // Calculate percentage crop and clamp it
        const percentCrop = {
          unit: '%',
          x: Math.max(0, (finalCrop.x / imgRef.width) * 100),
          y: Math.max(0, (finalCrop.y / imgRef.height) * 100),
          width: Math.min(100, (finalCrop.width / imgRef.width) * 100),
          height: Math.min(100, (finalCrop.height / imgRef.height) * 100),
        };
        await onSave(blob, percentCrop);
      }
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  if (!displayUrl) {
    return (
      <div className="fixed inset-0 z-[600] bg-black/90 flex flex-col items-center justify-center">
        <Loader2 className="animate-spin text-blue-500 mb-2" size={24} />
        <span className="text-gray-400 text-sm">Loading image…</span>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[600] bg-black/90 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 bg-[#1e2327] border-b border-[#2a3136]">
        <h3 className="text-sm font-medium text-gray-100">Crop & Rotate</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRotate}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-[#2a3136] rounded transition-colors"
          >
            <RotateCw size={13} /> Rotate 90°
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-white hover:bg-[#2a3136] rounded transition-colors"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden flex items-center justify-center p-8">
      {/* Using flex here ensures the wrapper shrinks exactly to the image size */}
      <div className="relative flex items-center justify-center max-w-full max-h-full">
      <ReactCrop
      crop={crop}
      onChange={(c) => setCrop(clampCrop(c))}
      onComplete={(c) => setCompletedCrop(c)}
      >
      <img
      src={displayUrl}
      onLoad={onLoad}
      alt="Crop me"
      style={{
        maxHeight: 'calc(100vh - 200px)',
          maxWidth: '100%',
          display: 'block',
          margin: 0,
          padding: 0,
          border: 'none',
          // objectFit is REMOVED here so the box wraps the photo tightly
      }}
      />
      </ReactCrop>
      </div>
      </div>

      <div className="px-4 py-4 bg-[#1e2327] border-t border-[#2a3136] flex items-center justify-end gap-4">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !completedCrop}
          className="flex items-center gap-1.5 px-6 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded font-medium transition-colors"
        >
          <Check size={16} /> {saving ? "Saving…" : "Save Changes"}
        </button>
      </div>
    </div>
  );
}
