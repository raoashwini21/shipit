import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  Ship, ShipWheel, Sailboat, Compass, Telescope, LifeBuoy, ArrowLeft, ArrowRight, ScrollText, Images, Captions, SearchCheck,
  Link2, FileUp, FolderOpen, Trash2, X, Check, CircleCheck, CircleAlert, TriangleAlert, LoaderCircle, RotateCcw,
  Bold, Italic, Heading1, Heading2, Heading3, Pilcrow, Feather, ImagePlus, WandSparkles, KeyRound, Database,
  Globe, Hash, Eye, EyeOff, Copy, Sparkles, FileType2, Tag, Quote, MousePointerClick, CloudUpload, Anchor,
} from 'lucide-react';
import mammoth from 'mammoth';
import {
  extractDocId, cleanGoogleHtml, detectTitle, countImages, slugify, sanitizeListsForWebflow, lookupAlt,
  formatBytes, injectImages,
} from './lib/html.js';
import { needsUpload, uploadImage } from './lib/images.js';
import OceanScene from './OceanScene.jsx';

/* ───────────────────────── constants ───────────────────────── */

const STEPS = [
  {
    label: 'Content', icon: ScrollText, eyebrow: 'Source',
    title: <>Bring in your <em>draft</em></>,
    sub: "Paste a Google Doc link or drop in a .docx — we'll tidy up the formatting, lists and links.",
  },
  {
    label: 'Images', icon: Images, eyebrow: 'Visuals',
    title: <>Gather your <em>visuals</em></>,
    sub: 'Images are placed in filename order, replacing the images in your doc one by one. Extras go at the end.',
  },
  {
    label: 'Alt Text', icon: Captions, eyebrow: 'Accessibility',
    title: <>Describe every <em>image</em></>,
    sub: 'Good alt text helps screen readers and search engines. Match it to images by file name.',
  },
  {
    label: 'Meta', icon: Compass, eyebrow: 'SEO',
    title: <>Polish for <em>search</em></>,
    sub: 'Title, slug and the snippet people see on Google before they ever click.',
  },
  {
    label: 'Preview', icon: Telescope, eyebrow: 'Review',
    title: <>The final <em>read-through</em></>,
    sub: 'Everything here is editable. Click a link to change or remove it.',
  },
  {
    label: 'Publish', icon: Sailboat, eyebrow: 'Launch',
    title: <>Ship it to <em>Webflow</em></>,
    sub: 'Images sail to the Webflow CDN first, then your post docks in the collection as a draft.',
  },
];

const FIELD_DEFS = [
  { key: 'body', label: 'Post body (rich text)', placeholder: 'post-body' },
  { key: 'metaTitle', label: 'Meta title', placeholder: 'meta-title' },
  { key: 'metaDesc', label: 'Meta description', placeholder: 'meta-description' },
  { key: 'excerpt', label: 'Excerpt / summary', placeholder: 'excerpt' },
];

const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

function readFileAsDataUrl(f) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: f.name, dataUrl: reader.result, size: f.size });
    reader.readAsDataURL(f);
  });
}

function readFileAsText(f) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => resolve('');
    reader.readAsText(f);
  });
}

/* ───────────────────────── small components ───────────────────────── */

function StepHead({ index }) {
  const st = STEPS[index];
  const Icon = st.icon;
  return (
    <div className="step-head">
      <div className="step-glyph"><Icon size={26} strokeWidth={1.5} /></div>
      <div>
        <div className="eyebrow">Step {String(index + 1).padStart(2, '0')} — {st.eyebrow}</div>
        <h2 className="step-title">{st.title}</h2>
        <p className="step-sub">{st.sub}</p>
      </div>
    </div>
  );
}

function Dropzone({ icon, title, sub, onFiles, onClick, accept }) {
  const Icon = icon;
  const [over, setOver] = useState(false);
  return (
    <div
      className={`dropzone${over ? ' over' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files || []).filter((f) => !accept || accept(f));
        if (files.length) onFiles(files);
      }}
    >
      <div className="dropzone-icon"><Icon size={22} strokeWidth={1.6} /></div>
      <div className="dropzone-title">{title}</div>
      <div className="dropzone-sub">{sub}</div>
    </div>
  );
}

function CharField({ label, value, max, children }) {
  const ratio = value.length / max;
  const tone = ratio > 1 ? 'over' : ratio > 0.9 ? 'warn' : '';
  return (
    <div className="field">
      <label className="label">
        <span>{label}</span>
        <span className={`count ${tone}`}>{value.length} / {max}</span>
      </label>
      {children}
      <div className={`meter ${tone}`}><span style={{ width: `${Math.min(100, ratio * 100)}%` }} /></div>
    </div>
  );
}

function ToolButton({ title, onPress, children }) {
  return (
    <button className="tool" title={title} onMouseDown={(e) => { e.preventDefault(); onPress(); }}>
      {children}
    </button>
  );
}

/* ───────────────────────── main component ───────────────────────── */

export default function App() {
  const [step, setStep] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showToken, setShowToken] = useState(false);

  // Settings
  const [apiToken, setApiToken] = useState(() => localStorage.getItem('shipit_token') || '');
  const [collectionId, setCollectionId] = useState(() => localStorage.getItem('shipit_collection') || '');
  const [siteId, setSiteId] = useState(() => localStorage.getItem('shipit_siteid') || '');

  // Field mapping
  const [collectionFields, setCollectionFields] = useState([]);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [fieldsError, setFieldsError] = useState('');
  const [fieldMap, setFieldMap] = useState(() => {
    const defaults = { body: 'post-body', metaTitle: 'meta-title', metaDesc: 'meta-description', excerpt: 'excerpt' };
    try {
      const saved = JSON.parse(localStorage.getItem('shipit_fieldmap') || '{}');
      // Migrate stale 'post-summary' → 'excerpt'
      if (saved.excerpt === 'post-summary') saved.excerpt = 'excerpt';
      return {
        body: saved.body || defaults.body,
        metaTitle: saved.metaTitle || defaults.metaTitle,
        metaDesc: saved.metaDesc || defaults.metaDesc,
        excerpt: saved.excerpt || defaults.excerpt,
      };
    } catch {
      return defaults;
    }
  });

  // Step 1
  const [contentMode, setContentMode] = useState('url'); // 'url' | 'upload'
  const [docUrl, setDocUrl] = useState('');
  const [htmlContent, setHtmlContent] = useState('');
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState('');
  const [contentTitle, setContentTitle] = useState('');
  const [sourceName, setSourceName] = useState('');

  // Step 2 & 3
  const [images, setImages] = useState([]);
  const [altTexts, setAltTexts] = useState({});
  const [altTextRaw, setAltTextRaw] = useState('');
  const [appliedSig, setAppliedSig] = useState('');

  // Step 4
  const [metaTitle, setMetaTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [seoTitle, setSeoTitle] = useState('');
  const [metaDesc, setMetaDesc] = useState('');
  const [excerpt, setExcerpt] = useState('');

  // Step 5
  const previewRef = useRef(null);

  // Step 6
  const [phase, setPhase] = useState('idle'); // idle | uploading | publishing | blocked | done | error
  const [uploads, setUploads] = useState([]);
  const [publishResult, setPublishResult] = useState(null);
  const failedSrcsRef = useRef(new Set());
  const [copied, setCopied] = useState(false);

  const fileInputRef = useRef(null);
  const imgInputRef = useRef(null);
  const imgFolderInputRef = useRef(null);
  const altFolderInputRef = useRef(null);

  /* persist settings */
  useEffect(() => { localStorage.setItem('shipit_token', apiToken); }, [apiToken]);
  useEffect(() => { localStorage.setItem('shipit_collection', collectionId); }, [collectionId]);
  useEffect(() => { localStorage.setItem('shipit_siteid', siteId); }, [siteId]);
  useEffect(() => { localStorage.setItem('shipit_fieldmap', JSON.stringify(fieldMap)); }, [fieldMap]);

  const connected = !!apiToken && !!collectionId;

  const fetchCollectionFields = useCallback(async () => {
    if (!apiToken || !collectionId) { setFieldsError('Enter API Token and Collection ID first.'); return; }
    setFieldsLoading(true);
    setFieldsError('');
    try {
      const resp = await fetch('/api/fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collectionId, apiToken }),
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { error: text }; }
      if (!resp.ok) {
        setFieldsError(data.message || data.error || 'Failed to fetch fields');
        return;
      }
      const fields = data.fields || data || [];
      setCollectionFields(Array.isArray(fields) ? fields : []);
    } catch (e) {
      setFieldsError(e.message);
    } finally {
      setFieldsLoading(false);
    }
  }, [apiToken, collectionId]);

  /* ── Step 1 handlers ── */

  const loadContent = useCallback((cleaned, name) => {
    setHtmlContent(cleaned);
    setSourceName(name);
    setAppliedSig('');
    const title = detectTitle(cleaned);
    setContentTitle(title);
    // Pre-fill meta from the doc title, but never clobber something the user typed.
    if (title && !metaTitle) {
      setMetaTitle(title);
      setSlug(slugify(title));
      setSeoTitle(title);
    }
  }, [metaTitle]);

  const fetchGoogleDoc = useCallback(async () => {
    const docId = extractDocId(docUrl);
    if (!docId) { setContentError('That doesn’t look like a Google Docs link. Expected https://docs.google.com/document/d/…'); return; }
    setContentLoading(true);
    setContentError('');
    try {
      const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=html`;
      const resp = await fetch(CORS_PROXY + encodeURIComponent(exportUrl));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      const raw = await resp.text();
      loadContent(cleanGoogleHtml(raw), 'Google Doc');
    } catch (e) {
      setContentError('Couldn’t fetch the document — make sure link sharing is on. (' + e.message + ')');
    } finally {
      setContentLoading(false);
    }
  }, [docUrl, loadContent]);

  const parseDocx = useCallback(async (file) => {
    if (!file) return;
    setContentLoading(true);
    setContentError('');
    try {
      const arrayBuf = await file.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer: arrayBuf });
      loadContent(cleanGoogleHtml(result.value), file.name);
    } catch (e2) {
      setContentError('Failed to parse .docx: ' + e2.message);
    } finally {
      setContentLoading(false);
    }
  }, [loadContent]);

  /* ── Step 2 handlers ── */

  const addImageFiles = useCallback((fileList) => {
    const files = fileList.filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    Promise.all(files.map(readFileAsDataUrl)).then((results) => {
      setImages((prev) => {
        const seen = new Set(prev.map((p) => p.name));
        const merged = [...prev, ...results.filter((r) => !seen.has(r.name))];
        return merged.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      });
    });
  }, []);

  const removeImage = useCallback((idx) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  /* ── Step 3 handlers ── */

  const parseAltTexts = useCallback((text) => {
    setAltTextRaw(text);
    const map = {};
    text.split('\n').forEach((line) => {
      const sep = line.indexOf(' - ');
      if (sep > 0) {
        const fname = line.substring(0, sep).trim();
        const alt = line.substring(sep + 3).trim();
        if (fname && alt) map[fname] = alt;
      }
    });
    setAltTexts(map);
  }, []);

  const addAltFiles = useCallback(async (files) => {
    const map = {};
    const lines = [];
    for (const f of files) {
      const altText = (await readFileAsText(f)).trim();
      if (!altText) continue;
      // File name IS the image name (e.g. "hero.webp" or "hero.webp.txt")
      const key = f.name.replace(/\.txt$/i, '');
      map[key] = altText.replace(/\s*\n\s*/g, ' ');
      lines.push(`${key} - ${map[key]}`);
    }
    if (!lines.length) return;
    setAltTexts((prev) => ({ ...prev, ...map }));
    setAltTextRaw((prev) => (prev ? prev + '\n' + lines.join('\n') : lines.join('\n')).trim());
  }, []);

  const imageSig = useMemo(
    () => JSON.stringify(images.map((img) => [img.name, img.size, lookupAlt(altTexts, img.name)])),
    [images, altTexts]
  );
  const imagesApplied = images.length > 0 && appliedSig === imageSig;

  const applyImages = useCallback(() => {
    if (!images.length) return;
    setHtmlContent((html) => injectImages(html, images, altTexts));
    setAppliedSig(imageSig);
  }, [images, altTexts, imageSig]);

  /* ── Navigation ── */

  const goTo = useCallback((next) => {
    // Keep edits made in the Preview step.
    if (step === 4 && previewRef.current) setHtmlContent(previewRef.current.innerHTML);
    // Apply images/alt text automatically when moving past those steps.
    if ((step === 1 || step === 2) && next > step && images.length && appliedSig !== imageSig) applyImages();
    setStep(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [step, images.length, appliedSig, imageSig, applyImages]);

  const canNext = useMemo(() => {
    if (step === 0) return !!htmlContent;
    if (step === 3) return !!metaTitle.trim() && !!slug.trim();
    return true;
  }, [step, htmlContent, metaTitle, slug]);

  const imageCount = useMemo(() => countImages(htmlContent), [htmlContent]);
  const contentSize = useMemo(() => new Blob([htmlContent]).size, [htmlContent]);
  const wordCount = useMemo(() => {
    const text = new DOMParser().parseFromString(htmlContent, 'text/html').body.textContent || '';
    return text.split(/\s+/).filter(Boolean).length;
  }, [htmlContent]);
  const altMatched = images.filter((img) => !!lookupAlt(altTexts, img.name)).length;

  /* ── Publish ── */

  const handlePublish = useCallback(async ({ skipFailed = false } = {}) => {
    setPublishResult(null);
    const updateUpload = (id, patch) => setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
    const doc = new DOMParser().parseFromString(sanitizeListsForWebflow(htmlContent), 'text/html');

    if (skipFailed) {
      doc.querySelectorAll('img').forEach((img) => {
        if (!failedSrcsRef.current.has(img.getAttribute('src'))) return;
        const parent = img.parentElement;
        img.remove();
        if (parent && parent !== doc.body && !parent.textContent.trim() && !parent.querySelector('img')) parent.remove();
      });
    }

    // ── 1. Upload every image that isn't on the Webflow CDN yet ──
    const jobs = [];
    doc.querySelectorAll('img').forEach((img, i) => {
      const src = img.getAttribute('src') || '';
      const kind = needsUpload(src);
      if (!kind) return;
      const name = img.getAttribute('data-shipit-name') || img.getAttribute('alt') || `image-${i + 1}`;
      jobs.push({ id: jobs.length, img, src, kind, name });
    });

    setUploads(jobs.map((j) => ({ id: j.id, name: j.name, thumb: j.src, status: 'pending', message: 'Waiting…' })));
    const failed = new Set();

    if (jobs.length) {
      setPhase('uploading');
      for (const job of jobs) {
        updateUpload(job.id, { status: 'working', message: 'Preparing…' });
        try {
          const { url, cached, optimized } = await uploadImage(job, {
            siteId,
            apiToken,
            onStage: (stage) => updateUpload(job.id, {
              message: stage === 'optimizing' ? 'Optimizing…' : 'Uploading to Webflow CDN…',
            }),
          });
          job.img.setAttribute('src', url);
          updateUpload(job.id, {
            status: 'done',
            message: cached ? 'Already uploaded' : optimized ? 'Uploaded · resized to fit' : 'Uploaded',
          });
        } catch (e) {
          failed.add(job.src);
          updateUpload(job.id, { status: 'error', message: e.message });
        }
      }
    }

    failedSrcsRef.current = failed;
    if (failed.size) {
      // Never publish broken images or placeholder text — let the user decide.
      setPhase('blocked');
      return;
    }

    // ── 2. Create the CMS item ──
    doc.querySelectorAll('[data-shipit-name]').forEach((el) => el.removeAttribute('data-shipit-name'));
    const finalHtml = doc.body.innerHTML;

    const fieldData = { name: metaTitle, slug };
    if (fieldMap.body) fieldData[fieldMap.body] = finalHtml;
    if (fieldMap.metaTitle) fieldData[fieldMap.metaTitle] = seoTitle;
    if (fieldMap.metaDesc) fieldData[fieldMap.metaDesc] = metaDesc;
    if (fieldMap.excerpt) fieldData[fieldMap.excerpt] = excerpt;

    setPhase('publishing');
    try {
      const resp = await fetch('/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collectionId, apiToken, fieldData }),
      });
      let data;
      const text = await resp.text();
      try { data = JSON.parse(text); } catch { data = { error: text }; }
      if (!resp.ok) {
        let detail = data.message || data.msg || data.error || '';
        if (data.details) detail += '\n' + JSON.stringify(data.details, null, 2);
        if (!detail) detail = JSON.stringify(data);
        setPublishResult({ ok: false, error: `HTTP ${resp.status}: ${detail}` });
        setPhase('error');
      } else {
        setPublishResult({ ok: true, id: data.id || data._id, images: jobs.length });
        setPhase('done');
      }
    } catch (e) {
      setPublishResult({ ok: false, error: e.message });
      setPhase('error');
    }
  }, [htmlContent, apiToken, collectionId, siteId, metaTitle, slug, seoTitle, metaDesc, excerpt, fieldMap]);

  const startOver = useCallback(() => {
    setStep(0);
    setDocUrl(''); setHtmlContent(''); setContentTitle(''); setSourceName(''); setContentError('');
    setImages([]); setAltTexts({}); setAltTextRaw(''); setAppliedSig('');
    setMetaTitle(''); setSlug(''); setSeoTitle(''); setMetaDesc(''); setExcerpt('');
    setPhase('idle'); setUploads([]); setPublishResult(null);
    window.scrollTo({ top: 0 });
  }, []);

  const busy = phase === 'uploading' || phase === 'publishing';
  const doneUploads = uploads.filter((u) => u.status === 'done').length;
  const failedUploads = uploads.filter((u) => u.status === 'error').length;

  /* ────────────────────────── render ────────────────────────── */

  return (
    <>
      <OceanScene />

      {/* ── Header ── */}
      <header className="header">
        <div className="brand">
          <div className="brand-mark"><Ship size={20} strokeWidth={2} /></div>
          <div>
            <div className="brand-name">Ship<em>It</em></div>
            <div className="brand-sub">by SalesRobot</div>
          </div>
        </div>
        <div className="header-actions">
          <button
            className={`status-pill ${connected ? 'on' : 'off'}`}
            onClick={() => setShowSettings(true)}
            style={{ cursor: 'pointer' }}
            title={connected ? 'Webflow connected' : 'Add Webflow credentials'}
          >
            <span className="status-dot" />
            <span className="status-text">{connected ? 'Webflow connected' : 'Not connected'}</span>
          </button>
          <button className="btn btn-sm" onClick={() => setShowSettings(true)}>
            <ShipWheel size={15} /> Settings
          </button>
        </div>
      </header>

      {/* ── Stepper ── */}
      <nav className="stepper" aria-label="Progress">
        {STEPS.map((st, i) => {
          const Icon = st.icon;
          const active = i === step;
          const done = i < step;
          return (
            <div key={st.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {i > 0 && <span className={`step-rule${i <= step ? ' done' : ''}`} />}
              <button
                className={`step${active ? ' active' : ''}${done ? ' done' : ''}`}
                onClick={() => done && !busy && goTo(i)}
                aria-current={active ? 'step' : undefined}
              >
                <span className="step-icon">{done ? <Check size={14} strokeWidth={2.5} /> : <Icon size={14} />}</span>
                <span className="step-label">{st.label}</span>
              </button>
            </div>
          );
        })}
      </nav>

      <main className="main" key={step}>
        <StepHead index={step} />

        {/* ──────── STEP 1: CONTENT ──────── */}
        {step === 0 && (
          <>
            <div className="card">
              <div className="segmented">
                <button className={contentMode === 'url' ? 'on' : ''} onClick={() => setContentMode('url')}>
                  <Link2 size={16} /> Google Doc link
                </button>
                <button className={contentMode === 'upload' ? 'on' : ''} onClick={() => setContentMode('upload')}>
                  <FileUp size={16} /> Upload .docx
                </button>
              </div>

              {contentMode === 'url' ? (
                <form onSubmit={(e) => { e.preventDefault(); if (docUrl.trim() && !contentLoading) fetchGoogleDoc(); }}>
                  <label className="label">Google Docs URL</label>
                  <div className="row">
                    <div className="input-wrap grow">
                      <Globe size={16} />
                      <input
                        className="input"
                        placeholder="https://docs.google.com/document/d/…"
                        value={docUrl}
                        onChange={(e) => setDocUrl(e.target.value)}
                      />
                    </div>
                    <button type="submit" className="btn btn-sea" disabled={contentLoading || !docUrl.trim()}>
                      {contentLoading ? <LoaderCircle size={16} className="spin" /> : <WandSparkles size={16} />}
                      {contentLoading ? 'Fetching…' : 'Import'}
                    </button>
                  </div>
                  <p className="faint mt-8">The doc needs “Anyone with the link can view” sharing.</p>
                </form>
              ) : (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".docx"
                    hidden
                    onChange={(e) => { parseDocx(e.target.files?.[0]); e.target.value = ''; }}
                  />
                  <Dropzone
                    icon={contentLoading ? LoaderCircle : FileType2}
                    title={contentLoading ? 'Reading your document…' : 'Drop a .docx here'}
                    sub="or click to browse your files"
                    onClick={() => fileInputRef.current?.click()}
                    onFiles={(files) => parseDocx(files[0])}
                    accept={(f) => /\.docx$/i.test(f.name)}
                  />
                </>
              )}

              {contentError && (
                <div className="notice err mt-16" style={{ marginBottom: 0 }}>
                  <CircleAlert size={16} /> <span>{contentError}</span>
                </div>
              )}
            </div>

            {htmlContent && (
              <div className="card">
                <div className="card-head">
                  <div className="card-title"><Feather size={17} /> {contentTitle || 'Content loaded'}</div>
                  <div className="row">
                    {sourceName && <span className="chip sea"><Sparkles size={12} /> {sourceName}</span>}
                    <span className="chip"><Database size={12} /> {formatBytes(contentSize)}</span>
                    <span className="chip"><Images size={12} /> {imageCount} image{imageCount === 1 ? '' : 's'}</span>
                  </div>
                </div>
                <div className="paper short" dangerouslySetInnerHTML={{ __html: htmlContent }} />
              </div>
            )}
          </>
        )}

        {/* ──────── STEP 2: IMAGES ──────── */}
        {step === 1 && (
          <div className="card">
            <input ref={imgInputRef} type="file" accept="image/*" multiple hidden
              onChange={(e) => { addImageFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
            <input ref={imgFolderInputRef} type="file" webkitdirectory="" directory="" multiple hidden
              onChange={(e) => { addImageFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />

            <Dropzone
              icon={ImagePlus}
              title="Drop images here"
              sub="JPG, PNG, WebP, GIF or SVG · large files are resized automatically"
              onClick={() => imgInputRef.current?.click()}
              onFiles={addImageFiles}
              accept={(f) => f.type.startsWith('image/')}
            />
            <div className="row mt-12" style={{ justifyContent: 'space-between' }}>
              <button className="btn btn-sm" onClick={() => imgFolderInputRef.current?.click()}>
                <FolderOpen size={15} /> Choose a folder
              </button>
              <span className="faint">
                {images.length} added · {imageCount} in document
              </span>
            </div>

            {images.length > 0 && (
              <div className="img-grid mt-16">
                {images.map((img, i) => (
                  <div key={img.name} className="img-card" style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>
                    <img src={img.dataUrl} alt={img.name} />
                    <span className="img-index">#{i + 1}</span>
                    <button className="img-del" onClick={() => removeImage(i)} title="Remove"><Trash2 size={13} /></button>
                    <div className="img-meta">
                      <div className="img-name" title={img.name}>{img.name}</div>
                      <div className="faint" style={{ fontSize: 11 }}>{formatBytes(img.size)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ──────── STEP 3: ALT TEXT ──────── */}
        {step === 2 && (
          <>
            <div className="card">
              <input ref={altFolderInputRef} type="file" webkitdirectory="" directory="" multiple hidden
                onChange={(e) => { addAltFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
              <div className="card-head">
                <div className="card-title"><Quote size={17} /> Alt text</div>
                <div className="row">
                  {images.length > 0 && (
                    <span className={`chip ${altMatched === images.length ? 'ok' : 'warn'}`}>
                      <Tag size={12} /> {altMatched}/{images.length} matched
                    </span>
                  )}
                  <button className="btn btn-sm" onClick={() => altFolderInputRef.current?.click()}>
                    <FolderOpen size={15} /> Load folder
                  </button>
                </div>
              </div>
              <p className="muted" style={{ marginBottom: 12 }}>
                One line per image as <code>file-name - description</code>, or load a folder of text files named
                after each image (<code>hero.webp.txt</code>).
              </p>
              <textarea
                className="textarea mono"
                rows={7}
                placeholder={'hero.webp - A team collaborating around a laptop\nfeature.jpg - Dashboard showing weekly reply rates'}
                value={altTextRaw}
                onChange={(e) => parseAltTexts(e.target.value)}
              />
            </div>

            {images.length > 0 ? (
              <div className="card">
                <div className="card-head">
                  <div className="card-title"><MousePointerClick size={17} /> How images will appear</div>
                  {imagesApplied ? (
                    <span className="chip ok"><CircleCheck size={12} /> Applied to post</span>
                  ) : (
                    <button className="btn btn-sm btn-sea" onClick={applyImages}>
                      <WandSparkles size={15} /> Apply to post
                    </button>
                  )}
                </div>
                <div className="img-grid">
                  {images.map((img, i) => {
                    const alt = lookupAlt(altTexts, img.name);
                    return (
                      <div key={img.name} className={`img-card${alt ? ' matched' : ''}`}>
                        <img src={img.dataUrl} alt={alt || img.name} />
                        <span className="img-index">#{i + 1}</span>
                        {alt && <span className="img-badge"><CircleCheck size={16} /></span>}
                        <div className="img-meta">
                          <div className="img-name" title={img.name}>{img.name}</div>
                          <div className={`img-alt${alt ? '' : ' missing'}`}>{alt || 'No alt text yet'}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="faint mt-12">Images are applied automatically when you continue.</p>
              </div>
            ) : (
              <div className="notice info"><Images size={16} /> <span>No images added — you can skip this step.</span></div>
            )}
          </>
        )}

        {/* ──────── STEP 4: META ──────── */}
        {step === 3 && (
          <>
            <div className="card">
              <div className="field">
                <label className="label"><span>Title <span className="req">*</span></span></label>
                <input
                  className="input"
                  value={metaTitle}
                  onChange={(e) => { setMetaTitle(e.target.value); setSlug(slugify(e.target.value)); }}
                  placeholder="Blog post title"
                  style={{ fontSize: 16 }}
                />
              </div>
              <div className="field">
                <label className="label"><span>Slug <span className="req">*</span></span></label>
                <div className="input-wrap">
                  <Hash size={15} />
                  <input className="input mono" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="blog-post-slug" />
                </div>
              </div>
              <CharField label="Meta title" value={seoTitle} max={60}>
                <input className="input" value={seoTitle} onChange={(e) => setSeoTitle(e.target.value)} placeholder="SEO title for search engines" />
              </CharField>
              <CharField label="Meta description" value={metaDesc} max={160}>
                <textarea className="textarea" rows={3} value={metaDesc} onChange={(e) => setMetaDesc(e.target.value)} placeholder="A short, compelling summary for search results" />
              </CharField>
              <CharField label="Excerpt" value={excerpt} max={300}>
                <textarea className="textarea" rows={3} value={excerpt} onChange={(e) => setExcerpt(e.target.value)} placeholder="Shown on blog listing cards" />
              </CharField>
            </div>

            <div className="card">
              <div className="card-head">
                <div className="card-title"><Globe size={17} /> Google preview</div>
              </div>
              <div className="serp">
                <div className="serp-site">
                  <div className="serp-fav"><Anchor size={13} /></div>
                  <div>
                    <div className="serp-domain">yourdomain.com</div>
                    <div className="serp-path">https://yourdomain.com › blog › {slug || 'page-slug'}</div>
                  </div>
                </div>
                <div className="serp-title">{seoTitle || metaTitle || 'Page title'}</div>
                <div className="serp-desc">
                  {metaDesc || 'Add a meta description to see how your page will appear in Google search results.'}
                </div>
              </div>
            </div>
          </>
        )}

        {/* ──────── STEP 5: PREVIEW ──────── */}
        {step === 4 && (
          <div>
            <div className="toolbar">
              <ToolButton title="Bold" onPress={() => document.execCommand('bold')}><Bold size={16} /></ToolButton>
              <ToolButton title="Italic" onPress={() => document.execCommand('italic')}><Italic size={16} /></ToolButton>
              <span className="tool-sep" />
              <ToolButton title="Heading 1" onPress={() => document.execCommand('formatBlock', false, 'h1')}><Heading1 size={16} /></ToolButton>
              <ToolButton title="Heading 2" onPress={() => document.execCommand('formatBlock', false, 'h2')}><Heading2 size={16} /></ToolButton>
              <ToolButton title="Heading 3" onPress={() => document.execCommand('formatBlock', false, 'h3')}><Heading3 size={16} /></ToolButton>
              <ToolButton title="Paragraph" onPress={() => document.execCommand('formatBlock', false, 'p')}><Pilcrow size={16} /></ToolButton>
              <span className="tool-sep" />
              <ToolButton
                title="Insert link"
                onPress={() => {
                  const url = prompt('Enter URL:');
                  if (!url) return;
                  document.execCommand('createLink', false, url);
                  const sel = window.getSelection();
                  const anchor = sel?.anchorNode?.parentElement?.closest('a');
                  if (anchor) {
                    anchor.setAttribute('target', '_blank');
                    anchor.setAttribute('rel', 'noopener noreferrer');
                  }
                }}
              >
                <Link2 size={16} />
              </ToolButton>
              <span className="faint"><Feather size={13} /> Editing live</span>
            </div>
            <div
              ref={previewRef}
              className="paper"
              contentEditable
              suppressContentEditableWarning
              onClick={(e) => {
                const anchor = e.target.closest('a');
                if (!anchor) return;
                e.preventDefault();
                const newHref = prompt('Edit link URL (leave empty to remove the link):', anchor.getAttribute('href') || '');
                if (newHref === null) return;
                if (newHref.trim() === '') {
                  const frag = document.createDocumentFragment();
                  while (anchor.firstChild) frag.appendChild(anchor.firstChild);
                  anchor.replaceWith(frag);
                } else {
                  anchor.setAttribute('href', newHref);
                  anchor.setAttribute('target', '_blank');
                  anchor.setAttribute('rel', 'noopener noreferrer');
                }
              }}
              dangerouslySetInnerHTML={{ __html: htmlContent }}
            />
          </div>
        )}

        {/* ──────── STEP 6: PUBLISH ──────── */}
        {step === 5 && (
          <>
            {phase !== 'done' && (
              <div className="card">
                <div className="summary">
                  <div className="summary-item wide">
                    <div className="summary-key"><Feather size={12} /> Title</div>
                    <div className={`summary-val${metaTitle ? '' : ' empty'}`}>{metaTitle || 'Not set'}</div>
                  </div>
                  <div className="summary-item">
                    <div className="summary-key"><Hash size={12} /> Slug</div>
                    <div className="summary-val mono">{slug || '—'}</div>
                  </div>
                  <div className="summary-item">
                    <div className="summary-key"><SearchCheck size={12} /> Meta title</div>
                    <div className={`summary-val${seoTitle ? '' : ' empty'}`}>{seoTitle || 'Not set'}</div>
                  </div>
                  <div className="summary-item wide">
                    <div className="summary-key"><Quote size={12} /> Meta description</div>
                    <div className={`summary-val${metaDesc ? '' : ' empty'}`}>{metaDesc || 'Not set'}</div>
                  </div>
                  <div className="summary-item">
                    <div className="summary-key"><Feather size={12} /> Length</div>
                    <div className="summary-val">{wordCount.toLocaleString()} words · ~{Math.max(1, Math.round(wordCount / 230))} min read</div>
                  </div>
                  <div className="summary-item">
                    <div className="summary-key"><Images size={12} /> Images</div>
                    <div className="summary-val">{imageCount}</div>
                  </div>
                </div>
              </div>
            )}

            {!connected && (
              <div className="notice warn">
                <KeyRound size={16} />
                <span>
                  <strong>Webflow isn’t connected yet.</strong> Add your API token and collection ID in{' '}
                  <button className="link-btn" onClick={() => setShowSettings(true)}>Settings</button>.
                </span>
              </div>
            )}
            {connected && !fieldMap.body && (
              <div className="notice warn">
                <TriangleAlert size={16} />
                <span><strong>Post body field slug is empty.</strong> Set your CMS field slugs in{' '}
                  <button className="link-btn" onClick={() => setShowSettings(true)}>Settings</button>.</span>
              </div>
            )}
            {connected && !siteId && imageCount > 0 && (
              <div className="notice warn">
                <CloudUpload size={16} />
                <span><strong>Site ID missing.</strong> It’s needed to upload images to the Webflow CDN —{' '}
                  <button className="link-btn" onClick={() => setShowSettings(true)}>add it in Settings</button>.</span>
              </div>
            )}

            {(phase === 'idle' || phase === 'error') && !publishResult?.ok && (
              <div className="launch">
                <button className="btn btn-sea btn-lg" disabled={!connected} onClick={() => handlePublish()}>
                  <Sailboat size={18} /> {phase === 'error' ? 'Try again' : 'Set sail — push as draft'}
                </button>
                <span className="faint">Creates a draft item — nothing goes live until you publish it in Webflow.</span>
              </div>
            )}

            {(busy || phase === 'blocked' || (uploads.length > 0 && phase !== 'done' && phase !== 'idle')) && (
              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    {busy ? <LifeBuoy size={17} className="spin" /> : phase === 'blocked' ? <CircleAlert size={17} /> : <CloudUpload size={17} />}
                    {phase === 'uploading' && `Uploading images · ${doneUploads}/${uploads.length}`}
                    {phase === 'publishing' && 'Creating your draft in Webflow…'}
                    {phase === 'blocked' && `${failedUploads} image${failedUploads === 1 ? '' : 's'} couldn’t be uploaded`}
                    {phase === 'error' && 'Images uploaded'}
                  </div>
                </div>
                {uploads.length > 0 && (
                  <div className="progress">
                    <span style={{ width: `${((doneUploads + failedUploads) / uploads.length) * 100}%` }} />
                    <Sailboat className="progress-boat" size={20} style={{ left: `${((doneUploads + failedUploads) / uploads.length) * 100}%` }} />
                  </div>
                )}
                {phase === 'blocked' && (
                  <p className="muted mt-12">
                    Nothing was published. Retry the failed images, or publish without them — they’ll be left out
                    entirely rather than showing up as text.
                  </p>
                )}
                <div className="uploads">
                  {uploads.map((u) => (
                    <div key={u.id} className={`upload-row ${u.status}`}>
                      <img className="upload-thumb" src={u.thumb} alt="" />
                      <div className="grow">
                        <div className="upload-name" title={u.name}>{u.name}</div>
                        <div className="upload-msg">{u.message}</div>
                      </div>
                      <div className="upload-state">
                        {u.status === 'working' && <LoaderCircle size={16} className="spin" />}
                        {u.status === 'done' && <CircleCheck size={16} />}
                        {u.status === 'error' && <CircleAlert size={16} />}
                      </div>
                    </div>
                  ))}
                </div>
                {phase === 'blocked' && (
                  <div className="row mt-16" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn" onClick={() => handlePublish({ skipFailed: true })}>
                      Publish without them
                    </button>
                    <button className="btn btn-sea" onClick={() => handlePublish()}>
                      <RotateCcw size={15} /> Retry failed
                    </button>
                  </div>
                )}
              </div>
            )}

            {publishResult?.ok && (
              <div className="result ok">
                <div className="result-icon"><Anchor size={32} strokeWidth={2} /></div>
                <div className="result-title">Shipped.</div>
                <p className="muted mt-8">
                  “{metaTitle}” is waiting as a draft in your Webflow collection
                  {publishResult.images ? ` with ${publishResult.images} image${publishResult.images === 1 ? '' : 's'} on the CDN` : ''}.
                </p>
                {publishResult.id && (
                  <div className="row mt-16" style={{ justifyContent: 'center' }}>
                    <span className="chip">Item ID · {publishResult.id}</span>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        navigator.clipboard?.writeText(publishResult.id);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }}
                    >
                      {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                )}
                <button className="btn btn-sea mt-16" onClick={startOver} style={{ marginTop: 24 }}>
                  <Ship size={16} /> Ship another post
                </button>
              </div>
            )}

            {publishResult && !publishResult.ok && (
              <div className="result err">
                <div className="result-icon"><TriangleAlert size={32} /></div>
                <div className="result-title">Webflow said no.</div>
                <p className="muted mt-8">Your images are safe on the CDN — fix the issue below and try again.</p>
                <pre>{publishResult.error}</pre>
              </div>
            )}
          </>
        )}
      </main>

      {/* ── Bottom Nav ── */}
      <div className="navbar">
        <button className="btn btn-ghost" disabled={step === 0 || busy} onClick={() => goTo(step - 1)}>
          <ArrowLeft size={16} /> Back
        </button>
        <div className="nav-progress">
          <div className="nav-dots">
            {STEPS.map((st, i) => <span key={st.label} className={i === step ? 'active' : i < step ? 'done' : ''} />)}
          </div>
          <span className="nav-text">{step + 1} of {STEPS.length}</span>
        </div>
        {step < STEPS.length - 1 ? (
          <button className="btn btn-sea" disabled={!canNext} onClick={() => goTo(step + 1)}>
            {step === STEPS.length - 2 ? 'Review & ship' : 'Continue'} <ArrowRight size={16} />
          </button>
        ) : (
          <span style={{ width: 90 }} />
        )}
      </div>

      {/* ── Settings Modal ── */}
      {showSettings && (
        <div className="modal" onMouseDown={() => setShowSettings(false)}>
          <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
            <button className="btn btn-ghost btn-sm modal-close" onClick={() => setShowSettings(false)} aria-label="Close">
              <X size={18} />
            </button>
            <h2 className="modal-title"><ShipWheel size={24} /> Settings</h2>
            <p className="muted">Stored only in this browser.</p>

            <div className="modal-section">
              <div className="modal-section-title"><KeyRound size={15} /> Webflow connection</div>
              <div className="field mt-12">
                <label className="label">API token</label>
                <div className="input-wrap">
                  <KeyRound size={15} />
                  <input
                    type={showToken ? 'text' : 'password'}
                    className="input mono"
                    value={apiToken}
                    onChange={(e) => setApiToken(e.target.value)}
                    placeholder="Site API token with CMS + Assets write access"
                  />
                  <button className="input-action" onClick={() => setShowToken((v) => !v)} title={showToken ? 'Hide' : 'Show'}>
                    {showToken ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <div className="field">
                <label className="label">Blog collection ID</label>
                <div className="input-wrap">
                  <Database size={15} />
                  <input className="input mono" value={collectionId} onChange={(e) => setCollectionId(e.target.value)} placeholder="e.g. 6123abc…" />
                </div>
              </div>
              <div className="field">
                <label className="label"><span>Site ID</span><span className="count">for image uploads</span></label>
                <div className="input-wrap">
                  <Globe size={15} />
                  <input className="input mono" value={siteId} onChange={(e) => setSiteId(e.target.value)} placeholder="e.g. 6123abc…" />
                </div>
                <p className="faint mt-8">Webflow → Site settings → General → Site ID. The token needs <code>assets:write</code>.</p>
              </div>
            </div>

            <div className="modal-section">
              <div className="modal-section-title"><Tag size={15} /> CMS field slugs</div>
              <p className="faint">The exact slugs from your collection’s field settings.</p>
              <div className="field-grid">
                {FIELD_DEFS.map(({ key, label, placeholder }) => (
                  <div key={key}>
                    <label className="label">{label}</label>
                    <input
                      className="input mono"
                      value={fieldMap[key] || ''}
                      onChange={(e) => setFieldMap((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder={placeholder}
                      list="shipit-field-slugs"
                    />
                  </div>
                ))}
              </div>
              <datalist id="shipit-field-slugs">
                {collectionFields.map((f) => <option key={f.id || f.slug} value={f.slug}>{f.displayName}</option>)}
              </datalist>
              <div className="row mt-12">
                <button className="btn btn-sm" disabled={fieldsLoading || !connected} onClick={fetchCollectionFields}>
                  {fieldsLoading ? <LoaderCircle size={14} className="spin" /> : <WandSparkles size={14} />}
                  {fieldsLoading ? 'Detecting…' : 'Auto-detect fields'}
                </button>
                {collectionFields.length > 0 && (
                  <span className="chip ok"><CircleCheck size={12} /> {collectionFields.length} fields found — pick from the suggestions</span>
                )}
              </div>
              {fieldsError && <div className="notice err mt-12" style={{ marginBottom: 0 }}><CircleAlert size={15} /> {fieldsError}</div>}
            </div>

            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 26 }}>
              <button className="btn btn-sea" onClick={() => setShowSettings(false)}>
                <Check size={16} /> Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
