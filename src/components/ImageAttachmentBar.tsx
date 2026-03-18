import "../styles/components/ImageAttachmentBar.css";
import { useState, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { X, Maximize2 } from "lucide-react";

export interface ImageAttachment {
  path: string;
  name: string;
}

interface ImageAttachmentBarProps {
  images: ImageAttachment[];
  onRemove: (path: string) => void;
}

export function ImageAttachmentBar({ images, onRemove }: ImageAttachmentBarProps) {
  const [expandedImage, setExpandedImage] = useState<string | null>(null);

  const handleExpand = useCallback((path: string) => {
    setExpandedImage(path);
  }, []);

  const handleCloseExpand = useCallback(() => {
    setExpandedImage(null);
  }, []);

  if (images.length === 0) return null;

  return (
    <>
      <div className="image-attachment-bar">
        {images.map((img) => (
          <div key={img.path} className="image-attachment-thumb">
            <img
              src={convertFileSrc(img.path)}
              alt={img.name}
              className="image-attachment-img"
              onClick={() => handleExpand(img.path)}
              title={`${img.name} — Click to preview`}
            />
            <button
              className="image-attachment-expand"
              onClick={() => handleExpand(img.path)}
              title="Preview"
            >
              <Maximize2 size={10} strokeWidth={2} />
            </button>
            <button
              className="image-attachment-remove"
              onClick={() => onRemove(img.path)}
              title="Remove"
            >
              <X size={10} strokeWidth={2} />
            </button>
            <span className="image-attachment-name">{img.name}</span>
          </div>
        ))}
      </div>

      {/* Expanded image overlay */}
      {expandedImage && (
        <div className="image-attachment-overlay" onClick={handleCloseExpand}>
          <div className="image-attachment-overlay-content" onClick={(e) => e.stopPropagation()}>
            <img
              src={convertFileSrc(expandedImage)}
              alt="Preview"
              className="image-attachment-overlay-img"
            />
            <button
              className="image-attachment-overlay-close"
              onClick={handleCloseExpand}
              title="Close"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
