/* Image upload pipeline: prepares images in the browser and pushes them to
 * the Webflow CDN through /api/upload-image, one at a time. */

// Vercel rejects request bodies over 4.5 MB. Base64 adds ~33%, so anything
// above ~3 MB of raw bytes has to be shrunk before it leaves the browser.
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const MAX_DIMENSION = 2400;

const WEBFLOW_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif']);

const WEBFLOW_CDN = /(^|\.)(website-files\.com|webflow\.com|webflow\.io)$/i;
const GOOGLE_HOSTS = /(^|\.)(googleusercontent\.com|ggpht\.com|docs\.google\.com)$/i;

// Successful uploads, so "retry" and re-publishing don't re-upload anything.
const uploadCache = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseDataUrl(src) {
  const m = src.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (!m) return null;
  const type = m[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  const base64 = m[2] ? m[3] : btoa(unescape(encodeURIComponent(decodeURIComponent(m[3]))));
  return { type, base64, bytes: Math.floor((base64.length * 3) / 4) };
}

function cacheKey(siteId, src) {
  // Cheap fingerprint of a (possibly huge) data URL.
  let h = 2166136261;
  const step = Math.max(1, Math.floor(src.length / 4096));
  for (let i = 0; i < src.length; i += step) h = Math.imul(h ^ src.charCodeAt(i), 16777619);
  return `${siteId}:${src.length}:${h >>> 0}`;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The browser can't read this image format. Export it as PNG or JPG."));
    img.src = src;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Re-encode an image as WebP (or JPEG), shrinking until it fits the upload limit. */
async function recompress(src) {
  const img = await loadImage(src);
  let scale = Math.min(1, MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
  let quality = 0.88;
  for (let attempt = 0; attempt < 8; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    let blob = await canvasToBlob(canvas, 'image/webp', quality);
    // Browsers without WebP encoding hand back PNG — use JPEG instead.
    if (!blob || blob.type !== 'image/webp') blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    if (blob && blob.size <= MAX_UPLOAD_BYTES) {
      return { type: blob.type, base64: await blobToBase64(blob), bytes: blob.size, optimized: true };
    }
    if (quality > 0.7) quality -= 0.08;
    else scale *= 0.8;
  }
  throw new Error('Image is too large to upload even after compression.');
}

/** Returns { type, base64, bytes, optimized } ready for /api/upload-image. */
export async function prepareImage(src) {
  const parsed = parseDataUrl(src);
  if (!parsed) throw new Error('Unreadable image data.');
  if (WEBFLOW_TYPES.has(parsed.type) && parsed.bytes <= MAX_UPLOAD_BYTES) return { ...parsed, optimized: false };
  if (parsed.type === 'image/svg+xml') throw new Error('SVG is larger than 3 MB — simplify it or export as PNG.');
  if (parsed.type === 'image/gif') throw new Error('GIF is larger than 3 MB — compress it first (animation would be lost otherwise).');
  return recompress(src);
}

/** Which <img> sources need to be uploaded to Webflow before publishing. */
export function needsUpload(src) {
  if (!src) return null;
  if (src.startsWith('data:')) return 'data';
  try {
    const { hostname, protocol } = new URL(src);
    if (WEBFLOW_CDN.test(hostname)) return null;
    if (protocol === 'https:' && GOOGLE_HOSTS.test(hostname)) return 'remote';
  } catch { /* relative or malformed — leave as is */ }
  return null;
}

async function postUpload(payload) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch('/api/upload-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      if (resp.ok && data?.url) return data;

      let message = data?.error || text.slice(0, 200) || `HTTP ${resp.status}`;
      if (resp.status === 413) message = 'Image is too large for the upload server.';
      if (resp.status === 504) message = 'Upload timed out.';
      lastErr = new Error(message);
      // 4xx (other than rate limiting) won't get better by retrying.
      if (resp.status < 500 && resp.status !== 429) break;
    } catch (e) {
      lastErr = new Error(`Network error: ${e.message}`);
    }
    await sleep(1000 * 2 ** attempt);
  }
  throw lastErr;
}

/**
 * Upload one image. `job` is { src, kind, name }. Returns the CDN URL.
 * `onStage` receives 'optimizing' | 'uploading' for status display.
 */
export async function uploadImage(job, { siteId, apiToken, onStage }) {
  if (!siteId) throw new Error('Add your Webflow Site ID in Settings to upload images.');
  const key = cacheKey(siteId, job.src);
  if (uploadCache.has(key)) return { url: uploadCache.get(key), cached: true };

  let payload;
  let optimized = false;
  if (job.kind === 'remote') {
    payload = { siteId, apiToken, fileName: job.name, sourceUrl: job.src };
  } else {
    onStage?.('optimizing');
    const prepared = await prepareImage(job.src);
    optimized = prepared.optimized;
    payload = { siteId, apiToken, fileName: job.name, fileBase64: prepared.base64, contentType: prepared.type };
  }

  onStage?.('uploading');
  const data = await postUpload(payload);
  uploadCache.set(key, data.url);
  return { url: data.url, optimized };
}
