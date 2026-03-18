import "../styles/components/ImageAttachmentBar.css";
import { useState, useCallback, useEffect } from "react";
import { readImageBase64 } from "../api/clipboard";
import { X, Maximize2 } from "lucide-react";

export interface ImageAttachment {
  path: string;
  name: string;
}

interface ImageAttachmentBarProps {
  images: ImageAttachment[];
  onRemove: (path: string) => void;
}

/** Load image as base64 data URI via Rust backend. */
function useImageDataUri(path: string): string | null {
  const [dataUri, setDataUri] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    readImageBase64(path)
      .then((uri) => { if (!cancelled) setDataUri(uri); })
      .catch(() => { if (!cancelled) setDataUri(null); });
    return () => { cancelled = true; };
  }, [path]);
  return dataUri;
}

function Thumbnail({ img, onExpand, onRemove }: { img: ImageAttachment; onExpand: (path: string) => void; onRemove: (path: string) => void }) {
  const dataUri = useImageDataUri(img.path);

  return (
    <div className="image-attachment-thumb">
      {dataUri ? (
        <img
          src={dataUri}
          alt={img.name}
          className="image-attachment-img"
          onClick={() => onExpand(img.path)}
          title={`${img.name} — Click to preview`}
        />
      ) : (
        <div className="image-attachment-img image-attachment-loading" />
      )}
      <button
        className="image-attachment-expand"
        onClick={() => onExpand(img.path)}
        title="Preview"
      >
        <Maximize2 size={8} strokeWidth={2.5} />
      </button>
      <button
        className="image-attachment-remove"
        onClick={() => onRemove(img.path)}
        title="Remove"
      >
        <X size={8} strokeWidth={2.5} />
      </button>
      <span className="image-attachment-name">{img.name}</span>
    </div>
  );
}

function ExpandedPreview({ path, onClose }: { path: string; onClose: () => void }) {
  const dataUri = useImageDataUri(path);

  return (
    <div className="image-attachment-overlay" onClick={onClose}>
      <div className="image-attachment-overlay-content" onClick={(e) => e.stopPropagation()}>
        {dataUri && (
          <img
            src={dataUri}
            alt="Preview"
            className="image-attachment-overlay-img"
          />
        )}
        <button
          className="image-attachment-overlay-close"
          onClick={onClose}
          title="Close"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
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
          <Thumbnail key={img.path} img={img} onExpand={handleExpand} onRemove={onRemove} />
        ))}
      </div>

      {expandedImage && (
        <ExpandedPreview path={expandedImage} onClose={handleCloseExpand} />
      )}
    </>
  );
}
