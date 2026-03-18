import "../styles/components/ImageAttachmentBar.css";
import { useState, useCallback, useEffect } from "react";
import { readImageBase64 } from "../api/clipboard";
import { X } from "lucide-react";

export interface ImageAttachment {
  path: string;
  name: string;
}

interface ImageAttachmentBarProps {
  images: ImageAttachment[];
  onDismiss: () => void;
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

function Thumbnail({ img, onExpand }: { img: ImageAttachment; onExpand: (path: string) => void }) {
  const dataUri = useImageDataUri(img.path);

  return (
    <div className="image-attachment-thumb" onClick={() => onExpand(img.path)} title={`${img.name} — Click to preview`}>
      {dataUri ? (
        <img src={dataUri} alt={img.name} className="image-attachment-img" />
      ) : (
        <div className="image-attachment-img image-attachment-loading" />
      )}
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
          <img src={dataUri} alt="Preview" className="image-attachment-overlay-img" />
        )}
        <button className="image-attachment-overlay-close" onClick={onClose} title="Close">
          <X size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

export function ImageAttachmentBar({ images, onDismiss }: ImageAttachmentBarProps) {
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
        <span className="image-attachment-label">
          {images.length === 1 ? "Image attached" : `${images.length} images attached`}
        </span>
        {images.map((img) => (
          <Thumbnail key={img.path} img={img} onExpand={handleExpand} />
        ))}
        <button className="image-attachment-dismiss" onClick={onDismiss} title="Dismiss">
          <X size={12} strokeWidth={2} />
        </button>
      </div>

      {expandedImage && (
        <ExpandedPreview path={expandedImage} onClose={handleCloseExpand} />
      )}
    </>
  );
}
