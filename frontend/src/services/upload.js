const API = import.meta.env.VITE_API_URL || '';

export async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${API}/api/upload`, { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return { url: data.url, filename: data.filename, size: data.size, mimetype: data.mimetype };
}

export function resolveUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//.test(url)) return url;
  return `${API}${url}`;
}

export function isImageMime(mimetype) {
  if (!mimetype) return false;
  return mimetype.startsWith('image/');
}

export function isVideoMime(mimetype) {
  if (!mimetype) return false;
  return mimetype.startsWith('video/');
}

export function isAudioMime(mimetype) {
  if (!mimetype) return false;
  return mimetype.startsWith('audio/');
}

// Downscale an image File to a JPEG thumbnail (max 512px) -> data URL.
export async function makeThumbnail(file, maxDim = 512) {
  try {
    if (!isImageMime(file.type) && !/\.(jpe?g|png|webp|gif)$/i.test(file.name || '')) return '';
    const dataUrl = await fileToDataUrl(file);
    const url = dataUrl;
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, maxDim / Math.max(width, height));
        if (scale >= 1) { resolve(url); return; }
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => resolve(url);
      img.src = url;
    });
  } catch (e) {
    return '';
  }
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}