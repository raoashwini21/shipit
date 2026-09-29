import crypto from 'crypto';

// Vercel caps request bodies at 4.5 MB, so the browser shrinks images before
// sending them here. `sizeLimit` only matters when running under Next-style
// body parsing; it's kept generous so it never becomes the limiting factor.
export const config = { api: { bodyParser: { sizeLimit: '6mb' } } };

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

// Remote images we're willing to fetch server-side and re-host on Webflow.
// Limited to Google hosts so this endpoint can't be used as an open proxy.
const REMOTE_HOSTS = [/(^|\.)googleusercontent\.com$/i, /(^|\.)ggpht\.com$/i, /^docs\.google\.com$/i];
const MAX_REMOTE_BYTES = 20 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch with retries on 429 / 5xx / network errors, honoring Retry-After. */
async function fetchWithRetry(url, init, { attempts = 4, label = 'request' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url, init);
      if (resp.status !== 429 && resp.status < 500) return resp;
      lastErr = new Error(`${label} returned HTTP ${resp.status}`);
      lastErr.status = resp.status;
      lastErr.body = await resp.text().catch(() => '');
      if (i === attempts - 1) break;
      const retryAfter = Number(resp.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 800 * 2 ** i;
      await sleep(Math.min(wait, 10000));
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(800 * 2 ** i);
    }
  }
  throw lastErr;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function safeFileName(name, contentType) {
  const ext = EXT_BY_TYPE[contentType];
  const base = String(name || 'image')
    .replace(/\.[a-z0-9+]{2,5}$/i, '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'image';
  return `${base}.${ext}`;
}

async function downloadRemote(sourceUrl) {
  let url = sourceUrl;
  for (let hop = 0; hop < 4; hop++) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Invalid image URL'); }
    if (parsed.protocol !== 'https:' || !REMOTE_HOSTS.some((re) => re.test(parsed.hostname))) {
      throw new Error(`Refusing to fetch image from ${parsed.hostname}`);
    }
    const resp = await fetchWithRetry(url, { redirect: 'manual' }, { attempts: 3, label: 'Image download' });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
      url = new URL(resp.headers.get('location'), url).toString();
      continue;
    }
    if (!resp.ok) throw new Error(`Image download failed (HTTP ${resp.status})`);
    const contentType = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_REMOTE_BYTES) throw new Error('Remote image is larger than 20 MB');
    return { buffer: buf, contentType };
  }
  throw new Error('Too many redirects while downloading image');
}

function fail(res, status, stage, error, detail) {
  return res.status(status).json({ error, stage, ...(detail ? { detail } : {}) });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    body = parseJson(body);
    if (!body) return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { siteId, apiToken, fileName, fileBase64, sourceUrl } = body || {};
  let { contentType } = body || {};

  if (!siteId) return fail(res, 400, 'input', 'Missing Site ID — add it in Settings.');
  if (!apiToken) return fail(res, 400, 'input', 'Missing API token.');
  if (!fileBase64 && !sourceUrl) return fail(res, 400, 'input', 'Missing image data.');

  // ── 1. Get the bytes ──
  let fileBuffer;
  try {
    if (fileBase64) {
      fileBuffer = Buffer.from(fileBase64, 'base64');
    } else {
      const dl = await downloadRemote(sourceUrl);
      fileBuffer = dl.buffer;
      contentType = dl.contentType || contentType;
    }
  } catch (e) {
    return fail(res, 502, 'download', e.message);
  }

  contentType = String(contentType || '').toLowerCase();
  if (contentType === 'image/jpg' || contentType === 'image/pjpeg') contentType = 'image/jpeg';
  if (!EXT_BY_TYPE[contentType]) {
    return fail(res, 415, 'input', `Webflow doesn't accept ${contentType || 'this file type'}. Use JPG, PNG, GIF, WebP, SVG or AVIF.`);
  }
  if (!fileBuffer.length) return fail(res, 400, 'input', 'Image is empty.');

  const name = safeFileName(fileName, contentType);
  const fileHash = crypto.createHash('md5').update(fileBuffer).digest('hex');
  const auth = { Authorization: `Bearer ${apiToken}`, accept: 'application/json' };

  try {
    // ── 2. Ask Webflow for an upload slot ──
    const initResp = await fetchWithRetry(
      `https://api.webflow.com/v2/sites/${encodeURIComponent(siteId)}/assets`,
      {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: name, fileHash }),
      },
      { label: 'Webflow asset request' }
    );
    const initText = await initResp.text();
    const initData = parseJson(initText);
    if (!initResp.ok || !initData) {
      const msg = initData?.message || initData?.msg || initText || `HTTP ${initResp.status}`;
      return fail(res, initResp.status || 502, 'webflow', `Webflow rejected the asset: ${msg}`, initData?.details);
    }

    const { uploadUrl, uploadDetails } = initData;
    const assetId = initData.id || initData.assetId || initData._id;
    if (!uploadUrl || !uploadDetails) {
      return fail(res, 502, 'webflow', 'Webflow did not return an upload URL.', initData);
    }

    // ── 3. Upload the bytes to Webflow's S3 bucket ──
    // uploadDetails fields must come first and the file last; FormData keeps
    // insertion order. The file's type must match the signed policy.
    const s3Type = uploadDetails['content-type'] || uploadDetails['Content-Type'] || contentType;
    let s3Resp;
    try {
      s3Resp = await fetchWithRetry(
        uploadUrl,
        {
          method: 'POST',
          get body() {
            const form = new FormData();
            for (const [k, v] of Object.entries(uploadDetails)) form.append(k, String(v));
            form.append('file', new Blob([fileBuffer], { type: s3Type }), name);
            return form;
          },
        },
        { attempts: 3, label: 'Storage upload' }
      );
    } catch (e) {
      return fail(res, 502, 'storage', `Upload to Webflow storage failed: ${e.message}`, e.body?.slice(0, 500));
    }
    if (!s3Resp.ok) {
      const detail = (await s3Resp.text().catch(() => '')).slice(0, 500);
      return fail(res, s3Resp.status, 'storage', `Upload to Webflow storage failed (HTTP ${s3Resp.status}).`, detail);
    }

    // ── 4. Resolve the CDN URL ──
    let url = initData.hostedUrl || initData.url;
    if (!url && assetId) {
      const assetResp = await fetchWithRetry(
        `https://api.webflow.com/v2/assets/${encodeURIComponent(assetId)}`,
        { headers: auth },
        { label: 'Webflow asset lookup' }
      );
      const assetData = parseJson(await assetResp.text());
      url = assetData?.hostedUrl || assetData?.url;
    }
    if (!url) return fail(res, 502, 'webflow', 'Upload finished but Webflow returned no image URL.', initData);

    return res.status(200).json({ url, assetId, fileName: name, bytes: fileBuffer.length });
  } catch (e) {
    return fail(res, 502, 'network', `Couldn't reach Webflow: ${e.message}`);
  }
}
