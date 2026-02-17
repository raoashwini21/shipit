import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Send, Settings, ChevronLeft, ChevronRight, Upload, Link, Link2, FileText, Image, Eye, Rocket, Check, AlertTriangle, X, Type, Globe, CheckCircle2, FileUp, Trash2, FolderOpen, Bold, Italic, Heading1, Heading2, Heading3, MessageSquareText } from 'lucide-react';
import mammoth from 'mammoth';

/* ───────────────────────── constants ───────────────────────── */
const ACCENT = '#6366f1';
const ACCENT_HOVER = '#818cf8';
const BG = '#0f0f12';
const SURFACE = '#1a1a20';
const SURFACE2 = '#25252d';
const BORDER = '#2e2e38';
const TEXT = '#e4e4e7';
const TEXT_DIM = '#9ca3af';
const FONT_SANS = "'DM Sans', sans-serif";
const FONT_MONO = "'JetBrains Mono', monospace";

const STEPS = [
  { label: 'Content', icon: FileText },
  { label: 'Images', icon: Image },
  { label: 'Alt Text', icon: MessageSquareText },
  { label: 'Meta', icon: Type },
  { label: 'Preview', icon: Eye },
  { label: 'Publish', icon: Rocket },
];

const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

/* ───────────────────────── helpers ───────────────────────── */

function extractDocId(url) {
  const m = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function cleanGoogleHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Convert Google Docs flat lists to proper nested lists.
  // Google Docs outputs <li style="margin-left:XXpt"> instead of nested <ul>/<ol>.
  doc.querySelectorAll('ul, ol').forEach((list) => {
    const items = Array.from(list.querySelectorAll(':scope > li'));
    items.forEach((li) => {
      const ml = parseFloat(li.style.marginLeft || li.style.paddingLeft || '0');
      // level 0 = no indent, level 1 = ~36pt, level 2 = ~72pt, etc.
      const level = ml > 10 ? Math.round(ml / 36) : 0;
      li.dataset.nestLevel = level;
    });

    // Build nested structure
    for (let i = items.length - 1; i >= 0; i--) {
      const li = items[i];
      const level = parseInt(li.dataset.nestLevel || '0');
      if (level > 0) {
        // Find the nearest preceding <li> with a lower level
        let parent = null;
        for (let j = i - 1; j >= 0; j--) {
          const prevLevel = parseInt(items[j].dataset.nestLevel || '0');
          if (prevLevel < level) {
            parent = items[j];
            break;
          }
        }
        if (parent) {
          let subList = parent.querySelector(':scope > ul, :scope > ol');
          if (!subList) {
            subList = doc.createElement(list.tagName.toLowerCase());
            parent.appendChild(subList);
          }
          subList.appendChild(li);
        }
      }
      delete li.dataset.nestLevel;
    }
  });

  // Convert bold spans
  doc.querySelectorAll('span').forEach((span) => {
    const fw = span.style.fontWeight;
    if (fw === 'bold' || fw === '700' || parseInt(fw) >= 700) {
      const strong = doc.createElement('strong');
      strong.innerHTML = span.innerHTML;
      span.replaceWith(strong);
    }
  });

  // Convert italic spans
  doc.querySelectorAll('span').forEach((span) => {
    if (span.style.fontStyle === 'italic') {
      const em = doc.createElement('em');
      em.innerHTML = span.innerHTML;
      span.replaceWith(em);
    }
  });

  // Strip classes and styles from all elements
  doc.querySelectorAll('*').forEach((el) => {
    el.removeAttribute('class');
    el.removeAttribute('style');
    el.removeAttribute('id');
  });

  // Unwrap plain spans (no attributes left)
  doc.querySelectorAll('span').forEach((span) => {
    if (span.attributes.length === 0) {
      const frag = doc.createDocumentFragment();
      while (span.firstChild) frag.appendChild(span.firstChild);
      span.replaceWith(frag);
    }
  });

  // Remove empty <p>
  doc.querySelectorAll('p').forEach((p) => {
    if (!p.textContent.trim() && !p.querySelector('img')) {
      p.remove();
    }
  });

  // Set links to target=_blank
  doc.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    // Unwrap Google redirects
    const href = a.getAttribute('href') || '';
    const redir = href.match(/google\.com\/url\?.*?url=([^&]+)/);
    if (redir) {
      try { a.setAttribute('href', decodeURIComponent(redir[1])); } catch (_) { /* noop */ }
    }
  });

  return doc.body.innerHTML;
}

function detectTitle(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const h = doc.querySelector('h1, h2');
  return h ? h.textContent.trim() : '';
}

function countImages(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  return doc.querySelectorAll('img').length;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function sanitizeListsForWebflow(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Add roles for accessibility (preserve nested list structure)
  doc.querySelectorAll('ul, ol').forEach((list) => list.setAttribute('role', 'list'));
  doc.querySelectorAll('li').forEach((li) => {
    li.setAttribute('role', 'listitem');
    // Unwrap <span> inside <li>
    li.querySelectorAll(':scope > span').forEach((span) => {
      const frag = doc.createDocumentFragment();
      while (span.firstChild) frag.appendChild(span.firstChild);
      span.replaceWith(frag);
    });
  });

  // Remove <div> wrappers around lists
  doc.querySelectorAll('div').forEach((div) => {
    const children = Array.from(div.children);
    const hasOnlyLists = children.length > 0 && children.every(
      (c) => c.tagName === 'UL' || c.tagName === 'OL'
    );
    if (hasOnlyLists) {
      const frag = doc.createDocumentFragment();
      while (div.firstChild) frag.appendChild(div.firstChild);
      div.replaceWith(frag);
    }
  });

  return doc.body.innerHTML;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

/* ───────────────────────── styles ───────────────────────── */

const s = {
  app: {
    background: BG,
    minHeight: '100vh',
    fontFamily: FONT_SANS,
    color: TEXT,
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 32px',
    borderBottom: `1px solid ${BORDER}`,
    background: SURFACE,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
  },
  logoBox: {
    width: 42,
    height: 42,
    borderRadius: 10,
    background: `linear-gradient(135deg, ${ACCENT}, #a855f7)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    margin: 0,
    lineHeight: 1.1,
  },
  headerSub: {
    fontSize: 12,
    color: TEXT_DIM,
    margin: 0,
    lineHeight: 1.2,
  },
  gearBtn: {
    background: 'none',
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: '8px 12px',
    color: TEXT_DIM,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    fontFamily: FONT_SANS,
    transition: 'border-color 0.2s, color 0.2s',
  },
  stepper: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 0,
    padding: '24px 32px 0',
  },
  stepItem: (active, done) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 18px',
    borderRadius: 8,
    background: active ? SURFACE2 : 'transparent',
    border: active ? `1px solid ${ACCENT}` : '1px solid transparent',
    cursor: 'default',
    transition: 'all 0.2s',
  }),
  stepNum: (active, done) => ({
    width: 28,
    height: 28,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: FONT_MONO,
    background: done ? ACCENT : active ? ACCENT : SURFACE2,
    color: done || active ? '#fff' : TEXT_DIM,
    border: done || active ? 'none' : `1px solid ${BORDER}`,
    flexShrink: 0,
  }),
  stepLabel: (active) => ({
    fontSize: 13,
    fontWeight: active ? 600 : 400,
    color: active ? TEXT : TEXT_DIM,
  }),
  stepConnector: {
    width: 32,
    height: 1,
    background: BORDER,
    flexShrink: 0,
  },
  main: {
    flex: 1,
    maxWidth: 800,
    width: '100%',
    margin: '0 auto',
    padding: '32px 24px 100px',
  },
  card: {
    background: SURFACE,
    border: `1px solid ${BORDER}`,
    borderRadius: 12,
    padding: 28,
    marginBottom: 20,
  },
  label: {
    display: 'block',
    fontSize: 13,
    fontWeight: 600,
    color: TEXT_DIM,
    marginBottom: 8,
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
  },
  input: {
    width: '100%',
    padding: '10px 14px',
    borderRadius: 8,
    border: `1px solid ${BORDER}`,
    background: SURFACE2,
    color: TEXT,
    fontSize: 14,
    fontFamily: FONT_SANS,
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.2s',
  },
  textarea: {
    width: '100%',
    padding: '10px 14px',
    borderRadius: 8,
    border: `1px solid ${BORDER}`,
    background: SURFACE2,
    color: TEXT,
    fontSize: 14,
    fontFamily: FONT_SANS,
    outline: 'none',
    boxSizing: 'border-box',
    resize: 'vertical',
    minHeight: 60,
    transition: 'border-color 0.2s',
  },
  btn: (primary, disabled) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 22px',
    borderRadius: 8,
    border: primary ? 'none' : `1px solid ${BORDER}`,
    background: disabled
      ? SURFACE2
      : primary
        ? `linear-gradient(135deg, ${ACCENT}, #a855f7)`
        : SURFACE2,
    color: disabled ? TEXT_DIM : '#fff',
    fontSize: 14,
    fontWeight: 600,
    fontFamily: FONT_SANS,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'all 0.2s',
  }),
  navBar: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    background: SURFACE,
    borderTop: `1px solid ${BORDER}`,
    padding: '14px 32px',
    display: 'flex',
    justifyContent: 'space-between',
    zIndex: 50,
  },
  toggle: {
    display: 'flex',
    background: SURFACE2,
    borderRadius: 8,
    border: `1px solid ${BORDER}`,
    overflow: 'hidden',
    marginBottom: 20,
  },
  toggleBtn: (active) => ({
    flex: 1,
    padding: '10px 18px',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: FONT_SANS,
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    background: active ? ACCENT : 'transparent',
    color: active ? '#fff' : TEXT_DIM,
    transition: 'all 0.2s',
  }),
  previewBox: {
    background: '#ffffff',
    color: '#1a1a2e',
    borderRadius: 8,
    padding: '28px 32px',
    maxHeight: 400,
    overflow: 'auto',
    fontSize: 15,
    lineHeight: 1.7,
    fontFamily: "'Georgia', serif",
    border: `1px solid ${BORDER}`,
  },
  tag: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: SURFACE2,
    border: `1px solid ${BORDER}`,
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 12,
    color: TEXT_DIM,
    fontFamily: FONT_MONO,
  },
  modal: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  modalContent: {
    background: SURFACE,
    border: `1px solid ${BORDER}`,
    borderRadius: 14,
    padding: 32,
    width: '100%',
    maxWidth: 480,
    position: 'relative',
  },
  closeBtn: {
    position: 'absolute',
    top: 14,
    right: 14,
    background: 'none',
    border: 'none',
    color: TEXT_DIM,
    cursor: 'pointer',
    padding: 4,
  },
  imgGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: 12,
  },
  imgCard: {
    background: SURFACE2,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
  },
  imgThumb: {
    width: '100%',
    height: 100,
    objectFit: 'cover',
    display: 'block',
  },
  imgInfo: {
    padding: '8px 10px',
    fontSize: 11,
    color: TEXT_DIM,
    fontFamily: FONT_MONO,
    wordBreak: 'break-all',
  },
  serpBox: {
    background: '#fff',
    borderRadius: 8,
    padding: '16px 20px',
    border: `1px solid ${BORDER}`,
    fontFamily: 'Arial, sans-serif',
    maxWidth: 600,
  },
  serpTitle: {
    fontSize: 18,
    color: '#1a0dab',
    lineHeight: 1.3,
    marginBottom: 4,
    cursor: 'pointer',
    fontWeight: 400,
  },
  serpUrl: {
    fontSize: 13,
    color: '#006621',
    marginBottom: 4,
  },
  serpDesc: {
    fontSize: 13,
    color: '#545454',
    lineHeight: 1.5,
  },
  summaryTable: {
    width: '100%',
    borderCollapse: 'separate',
    borderSpacing: 0,
    borderRadius: 8,
    overflow: 'hidden',
    border: `1px solid ${BORDER}`,
  },
  summaryTd: (isLabel) => ({
    padding: '12px 16px',
    borderBottom: `1px solid ${BORDER}`,
    fontSize: 14,
    fontWeight: isLabel ? 600 : 400,
    color: isLabel ? TEXT_DIM : TEXT,
    background: isLabel ? SURFACE2 : 'transparent',
    fontFamily: isLabel ? FONT_SANS : FONT_MONO,
    width: isLabel ? '35%' : '65%',
    wordBreak: 'break-word',
  }),
  charCount: (count, max) => ({
    fontSize: 12,
    fontFamily: FONT_MONO,
    color: count > max ? '#ef4444' : count > max * 0.9 ? '#f59e0b' : TEXT_DIM,
    marginTop: 4,
    textAlign: 'right',
  }),
  successBox: {
    background: 'rgba(34,197,94,0.1)',
    border: '1px solid rgba(34,197,94,0.3)',
    borderRadius: 10,
    padding: 24,
    textAlign: 'center',
  },
  errorBox: {
    background: 'rgba(239,68,68,0.1)',
    border: '1px solid rgba(239,68,68,0.3)',
    borderRadius: 10,
    padding: 24,
    textAlign: 'center',
  },
  badge: (color) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 10px',
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
    background: `${color}18`,
    color: color,
    border: `1px solid ${color}30`,
  }),
  deleteBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
    background: 'rgba(0,0,0,0.6)',
    border: 'none',
    borderRadius: '50%',
    width: 24,
    height: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    color: '#fff',
    padding: 0,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '8px 12px',
    background: SURFACE2,
    border: `1px solid ${BORDER}`,
    borderBottom: 'none',
    borderRadius: '8px 8px 0 0',
    flexWrap: 'wrap',
  },
  toolbarBtn: (active) => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
    height: 34,
    borderRadius: 6,
    border: 'none',
    background: active ? ACCENT : 'transparent',
    color: active ? '#fff' : TEXT_DIM,
    cursor: 'pointer',
    transition: 'all 0.15s',
    padding: 0,
  }),
  toolbarDivider: {
    width: 1,
    height: 22,
    background: BORDER,
    margin: '0 6px',
    flexShrink: 0,
  },
};

/* ───────────────────────── main component ───────────────────────── */

export default function App() {
  const [step, setStep] = useState(0);
  const [showSettings, setShowSettings] = useState(false);

  // Settings
  const [apiToken, setApiToken] = useState(() => localStorage.getItem('shipit_token') || '');
  const [collectionId, setCollectionId] = useState(() => localStorage.getItem('shipit_collection') || '');

  // Step 1
  const [contentMode, setContentMode] = useState('url'); // 'url' | 'upload'
  const [docUrl, setDocUrl] = useState('');
  const [htmlContent, setHtmlContent] = useState('');
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState('');
  const [contentTitle, setContentTitle] = useState('');

  // Step 2
  const [images, setImages] = useState([]);
  const [altTexts, setAltTexts] = useState({});
  const [altTextRaw, setAltTextRaw] = useState('');

  // Step 3
  const [metaTitle, setMetaTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [seoTitle, setSeoTitle] = useState('');
  const [metaDesc, setMetaDesc] = useState('');
  const [excerpt, setExcerpt] = useState('');

  // Step 4
  const previewRef = useRef(null);

  // Step 5
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState(null);

  const fileInputRef = useRef(null);
  const imgInputRef = useRef(null);
  const imgFolderInputRef = useRef(null);
  const altFolderInputRef = useRef(null);

  /* persist settings */
  useEffect(() => { localStorage.setItem('shipit_token', apiToken); }, [apiToken]);
  useEffect(() => { localStorage.setItem('shipit_collection', collectionId); }, [collectionId]);

  /* auto-fill meta from title */
  useEffect(() => {
    if (contentTitle && !metaTitle) {
      setMetaTitle(contentTitle);
      setSlug(slugify(contentTitle));
      setSeoTitle(contentTitle);
    }
  }, [contentTitle]);

  /* ── Step 1 handlers ── */

  const fetchGoogleDoc = useCallback(async () => {
    const docId = extractDocId(docUrl);
    if (!docId) { setContentError('Invalid Google Docs URL. Expected format: https://docs.google.com/document/d/...'); return; }
    setContentLoading(true);
    setContentError('');
    try {
      const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=html`;
      const resp = await fetch(CORS_PROXY + encodeURIComponent(exportUrl));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      const raw = await resp.text();
      const cleaned = cleanGoogleHtml(raw);
      setHtmlContent(cleaned);
      setContentTitle(detectTitle(cleaned));
    } catch (e) {
      setContentError('Failed to fetch document: ' + e.message);
    } finally {
      setContentLoading(false);
    }
  }, [docUrl]);

  const handleDocxUpload = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setContentLoading(true);
    setContentError('');
    try {
      const arrayBuf = await file.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer: arrayBuf });
      const cleaned = cleanGoogleHtml(result.value);
      setHtmlContent(cleaned);
      setContentTitle(detectTitle(cleaned));
    } catch (e2) {
      setContentError('Failed to parse .docx: ' + e2.message);
    } finally {
      setContentLoading(false);
    }
  }, []);

  /* ── Step 2 handlers ── */

  const handleImageUpload = useCallback((e) => {
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
    const sorted = files.sort((a, b) => a.name.localeCompare(b.name));
    const promises = sorted.map(
      (f) =>
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ name: f.name, dataUrl: reader.result, size: f.size });
          reader.readAsDataURL(f);
        })
    );
    Promise.all(promises).then((results) => {
      setImages((prev) => [...prev, ...results]);
    });
    e.target.value = '';
  }, []);

  const removeImage = useCallback((idx) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

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

  const handleAltFolderUpload = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const map = {};
    const lines = [];
    const promises = files.map(
      (f) =>
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const altText = (reader.result || '').trim();
            if (altText) {
              // File name IS the image name (e.g. "hero.webp" or "hero.webp.txt")
              const key = f.name.replace(/\.txt$/i, '');
              map[key] = altText;
              lines.push(`${key} - ${altText}`);
            }
            resolve();
          };
          reader.readAsText(f);
        })
    );
    Promise.all(promises).then(() => {
      setAltTexts((prev) => ({ ...prev, ...map }));
      setAltTextRaw((prev) => {
        const combined = prev ? prev + '\n' + lines.join('\n') : lines.join('\n');
        return combined.trim();
      });
    });
    e.target.value = '';
  }, []);

  const replaceImagesInBlog = useCallback(() => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlContent, 'text/html');
    const inlineImgs = doc.querySelectorAll('img');
    let imgIdx = 0;

    inlineImgs.forEach((img) => {
      if (imgIdx < images.length) {
        const imgData = images[imgIdx];
        img.setAttribute('src', imgData.dataUrl);
        const alt = altTexts[imgData.name] || imgData.name;
        img.setAttribute('alt', alt);
        imgIdx++;
      }
    });

    // Append remaining images at end
    while (imgIdx < images.length) {
      const imgData = images[imgIdx];
      const imgEl = doc.createElement('img');
      imgEl.setAttribute('src', imgData.dataUrl);
      const alt = altTexts[imgData.name] || imgData.name;
      imgEl.setAttribute('alt', alt);
      imgEl.style.maxWidth = '100%';
      const p = doc.createElement('p');
      p.appendChild(imgEl);
      doc.body.appendChild(p);
      imgIdx++;
    }

    setHtmlContent(doc.body.innerHTML);
  }, [htmlContent, images, altTexts]);

  /* ── Step 5 handler ── */

  const handlePublish = useCallback(async () => {
    setPublishing(true);
    setPublishResult(null);
    const finalHtml = sanitizeListsForWebflow(
      previewRef.current ? previewRef.current.innerHTML : htmlContent
    );
    try {
      const resp = await fetch('/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collectionId,
          apiToken,
          fieldData: {
            name: metaTitle,
            slug,
            'post-body': finalHtml,
            'meta-title': seoTitle,
            'meta-description': metaDesc,
            'post-summary': excerpt,
          },
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setPublishResult({ ok: false, error: data.message || data.msg || data.error || JSON.stringify(data) });
      } else {
        setPublishResult({ ok: true, id: data.id || data._id });
      }
    } catch (e) {
      setPublishResult({ ok: false, error: e.message });
    } finally {
      setPublishing(false);
    }
  }, [htmlContent, apiToken, collectionId, metaTitle, slug, seoTitle, metaDesc, excerpt]);

  /* ── Navigation guard ── */

  const canNext = useMemo(() => {
    if (step === 0) return !!htmlContent;
    if (step === 3) return !!metaTitle.trim() && !!slug.trim();
    if (step === 5) return !!apiToken && !!collectionId;
    return true;
  }, [step, htmlContent, metaTitle, slug, apiToken, collectionId]);

  const imageCount = useMemo(() => countImages(htmlContent), [htmlContent]);
  const contentSize = useMemo(() => new Blob([htmlContent]).size, [htmlContent]);

  /* ────────────────────────── render ────────────────────────── */

  return (
    <div style={s.app}>
      {/* ── Header ── */}
      <header style={s.header}>
        <div style={s.headerLeft}>
          <div style={s.logoBox}>
            <Send size={20} color="#fff" />
          </div>
          <div>
            <h1 style={s.headerTitle}>ShipIt</h1>
            <p style={s.headerSub}>by SalesRobot</p>
          </div>
        </div>
        <button
          style={s.gearBtn}
          onClick={() => setShowSettings(true)}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = ACCENT; e.currentTarget.style.color = TEXT; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = BORDER; e.currentTarget.style.color = TEXT_DIM; }}
        >
          <Settings size={16} /> Settings
        </button>
      </header>

      {/* ── Stepper ── */}
      <div style={s.stepper}>
        {STEPS.map((st, i) => {
          const Icon = st.icon;
          const active = i === step;
          const done = i < step;
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
              {i > 0 && <div style={s.stepConnector} />}
              <div style={s.stepItem(active, done)}>
                <div style={s.stepNum(active, done)}>
                  {done ? <Check size={14} /> : i + 1}
                </div>
                <span style={s.stepLabel(active)}>{st.label}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Main content ── */}
      <main style={s.main}>

        {/* ──────── STEP 1: CONTENT ──────── */}
        {step === 0 && (
          <>
            <div style={s.card}>
              <div style={s.toggle}>
                <button
                  style={s.toggleBtn(contentMode === 'url')}
                  onClick={() => setContentMode('url')}
                >
                  <Link size={16} /> Google Doc URL
                </button>
                <button
                  style={s.toggleBtn(contentMode === 'upload')}
                  onClick={() => setContentMode('upload')}
                >
                  <FileUp size={16} /> Upload .docx
                </button>
              </div>

              {contentMode === 'url' ? (
                <div>
                  <label style={s.label}>Google Docs URL</label>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <input
                      type="text"
                      style={{ ...s.input, flex: 1 }}
                      placeholder="https://docs.google.com/document/d/..."
                      value={docUrl}
                      onChange={(e) => setDocUrl(e.target.value)}
                      onFocus={(e) => { e.target.style.borderColor = ACCENT; }}
                      onBlur={(e) => { e.target.style.borderColor = BORDER; }}
                    />
                    <button
                      style={s.btn(true, contentLoading || !docUrl.trim())}
                      disabled={contentLoading || !docUrl.trim()}
                      onClick={fetchGoogleDoc}
                    >
                      {contentLoading ? 'Fetching...' : 'Fetch'}
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <label style={s.label}>Upload .docx file</label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".docx"
                    style={{ display: 'none' }}
                    onChange={handleDocxUpload}
                  />
                  <button
                    style={s.btn(true, contentLoading)}
                    disabled={contentLoading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload size={16} /> {contentLoading ? 'Processing...' : 'Select File'}
                  </button>
                </div>
              )}

              {contentError && (
                <div style={{ marginTop: 14, color: '#ef4444', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AlertTriangle size={14} /> {contentError}
                </div>
              )}
            </div>

            {htmlContent && (
              <div style={s.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>Content Loaded</div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <span style={s.tag}><FileText size={12} /> {formatBytes(contentSize)}</span>
                    <span style={s.tag}><Image size={12} /> {imageCount} images</span>
                  </div>
                </div>
                {contentTitle && (
                  <div style={{ marginBottom: 14, fontSize: 13, color: TEXT_DIM }}>
                    <strong style={{ color: TEXT }}>Title:</strong> {contentTitle}
                  </div>
                )}
                <div
                  style={{ ...s.previewBox, maxHeight: 250 }}
                  dangerouslySetInnerHTML={{ __html: htmlContent }}
                />
              </div>
            )}
          </>
        )}

        {/* ──────── STEP 2: IMAGES ──────── */}
        {step === 1 && (
          <>
            <div style={s.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <label style={{ ...s.label, marginBottom: 0 }}>Upload Images</label>
                <span style={{ fontSize: 12, color: TEXT_DIM }}>{images.length} uploaded</span>
              </div>
              <input
                ref={imgInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={handleImageUpload}
              />
              <input
                ref={imgFolderInputRef}
                type="file"
                webkitdirectory=""
                directory=""
                multiple
                style={{ display: 'none' }}
                onChange={handleImageUpload}
              />
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  style={s.btn(true, false)}
                  onClick={() => imgInputRef.current?.click()}
                >
                  <Upload size={16} /> Select Files
                </button>
                <button
                  style={s.btn(false, false)}
                  onClick={() => imgFolderInputRef.current?.click()}
                >
                  <FolderOpen size={16} /> Upload Folder
                </button>
              </div>
              <p style={{ fontSize: 12, color: TEXT_DIM, marginTop: 8 }}>
                Select individual images or an entire folder. Sorted by filename automatically.
              </p>

              {images.length > 0 && (
                <div style={{ ...s.imgGrid, marginTop: 16 }}>
                  {images.map((img, i) => (
                    <div key={i} style={s.imgCard}>
                      <img src={img.dataUrl} alt={img.name} style={s.imgThumb} />
                      <button style={s.deleteBtn} onClick={() => removeImage(i)} title="Remove"><Trash2 size={12} /></button>
                      <div style={s.imgInfo}>{img.name}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* ──────── STEP 3: ALT TEXT ──────── */}
        {step === 2 && (
          <>
            <div style={s.card}>
              <label style={s.label}>Alt Texts</label>
              <p style={{ fontSize: 12, color: TEXT_DIM, marginBottom: 12 }}>
                Upload a folder of text files — each file named after its image (e.g. <code style={{ fontFamily: FONT_MONO, background: SURFACE2, padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>hero.webp</code> or <code style={{ fontFamily: FONT_MONO, background: SURFACE2, padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>hero.webp.txt</code>), containing the alt text as its content.
              </p>
              <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                <input
                  ref={altFolderInputRef}
                  type="file"
                  webkitdirectory=""
                  directory=""
                  multiple
                  style={{ display: 'none' }}
                  onChange={handleAltFolderUpload}
                />
                <button
                  style={s.btn(true, false)}
                  onClick={() => altFolderInputRef.current?.click()}
                >
                  <FolderOpen size={16} /> Upload Alt Text Folder
                </button>
                {Object.keys(altTexts).length > 0 && (
                  <span style={{ ...s.tag, alignSelf: 'center' }}>
                    <CheckCircle2 size={12} color="#22c55e" /> {Object.keys(altTexts).length} matched
                  </span>
                )}
              </div>
              <textarea
                style={s.textarea}
                rows={6}
                placeholder={"hero.webp - A team collaborating on a project\nfeature.jpg - Dashboard analytics overview\n\n(Auto-filled from folder upload, or type manually)"}
                value={altTextRaw}
                onChange={(e) => parseAltTexts(e.target.value)}
                onFocus={(e) => { e.target.style.borderColor = ACCENT; }}
                onBlur={(e) => { e.target.style.borderColor = BORDER; }}
              />
            </div>

            {/* Image preview with alt text status */}
            {images.length > 0 && (
              <div style={s.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <label style={{ ...s.label, marginBottom: 0 }}>Image &amp; Alt Text Mapping</label>
                  <span style={{ fontSize: 12, color: TEXT_DIM }}>
                    {Object.keys(altTexts).filter((k) => images.some((img) => img.name === k)).length}/{images.length} matched
                  </span>
                </div>
                <div style={{ ...s.imgGrid }}>
                  {images.map((img, i) => {
                    const hasAlt = !!altTexts[img.name];
                    return (
                      <div key={i} style={s.imgCard}>
                        <img src={img.dataUrl} alt={img.name} style={s.imgThumb} />
                        {hasAlt && (
                          <div style={{ position: 'absolute', top: 4, left: 4 }}>
                            <CheckCircle2 size={18} color="#22c55e" />
                          </div>
                        )}
                        <div style={s.imgInfo}>
                          {img.name}
                          {hasAlt && (
                            <div style={{ color: '#22c55e', marginTop: 2, fontSize: 10 }}>{altTexts[img.name]}</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {images.length > 0 && (
              <div style={{ textAlign: 'center', marginTop: 8 }}>
                <button
                  style={s.btn(true, false)}
                  onClick={replaceImagesInBlog}
                >
                  <Image size={16} /> Replace Images in Blog
                </button>
              </div>
            )}
          </>
        )}

        {/* ──────── STEP 4: META ──────── */}
        {step === 3 && (
          <>
            <div style={s.card}>
              <div style={{ marginBottom: 20 }}>
                <label style={s.label}>Title *</label>
                <input
                  type="text"
                  style={s.input}
                  value={metaTitle}
                  onChange={(e) => {
                    setMetaTitle(e.target.value);
                    setSlug(slugify(e.target.value));
                  }}
                  placeholder="Blog post title"
                  onFocus={(e) => { e.target.style.borderColor = ACCENT; }}
                  onBlur={(e) => { e.target.style.borderColor = BORDER; }}
                />
              </div>

              <div style={{ marginBottom: 20 }}>
                <label style={s.label}>Slug *</label>
                <input
                  type="text"
                  style={{ ...s.input, fontFamily: FONT_MONO }}
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="blog-post-slug"
                  onFocus={(e) => { e.target.style.borderColor = ACCENT; }}
                  onBlur={(e) => { e.target.style.borderColor = BORDER; }}
                />
              </div>

              <div style={{ marginBottom: 20 }}>
                <label style={s.label}>Meta Title</label>
                <input
                  type="text"
                  style={s.input}
                  value={seoTitle}
                  onChange={(e) => setSeoTitle(e.target.value)}
                  placeholder="SEO title for search engines"
                  onFocus={(e) => { e.target.style.borderColor = ACCENT; }}
                  onBlur={(e) => { e.target.style.borderColor = BORDER; }}
                />
                <div style={s.charCount(seoTitle.length, 60)}>{seoTitle.length}/60</div>
              </div>

              <div style={{ marginBottom: 20 }}>
                <label style={s.label}>Meta Description</label>
                <textarea
                  style={s.textarea}
                  rows={3}
                  value={metaDesc}
                  onChange={(e) => setMetaDesc(e.target.value)}
                  placeholder="Brief description for search results"
                  onFocus={(e) => { e.target.style.borderColor = ACCENT; }}
                  onBlur={(e) => { e.target.style.borderColor = BORDER; }}
                />
                <div style={s.charCount(metaDesc.length, 160)}>{metaDesc.length}/160</div>
              </div>

              <div>
                <label style={s.label}>Custom Excerpt</label>
                <textarea
                  style={s.textarea}
                  rows={3}
                  value={excerpt}
                  onChange={(e) => setExcerpt(e.target.value)}
                  placeholder="Custom excerpt / post summary"
                  onFocus={(e) => { e.target.style.borderColor = ACCENT; }}
                  onBlur={(e) => { e.target.style.borderColor = BORDER; }}
                />
                <div style={s.charCount(excerpt.length, 300)}>{excerpt.length}/300</div>
              </div>
            </div>

            {/* SERP Preview */}
            <div style={s.card}>
              <label style={{ ...s.label, marginBottom: 14 }}>
                <Globe size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
                Google SERP Preview
              </label>
              <div style={s.serpBox}>
                <div style={s.serpTitle}>
                  {seoTitle || metaTitle || 'Page Title'}
                </div>
                <div style={s.serpUrl}>
                  https://yourdomain.com/blog/{slug || 'page-slug'}
                </div>
                <div style={s.serpDesc}>
                  {metaDesc || 'Add a meta description to see how your page will appear in Google search results.'}
                </div>
              </div>
            </div>
          </>
        )}

        {/* ──────── STEP 5: PREVIEW ──────── */}
        {step === 4 && (
          <div style={s.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <label style={{ ...s.label, marginBottom: 0 }}>Live Preview</label>
              <span style={s.tag}><Eye size={12} /> Editable</span>
            </div>

            {/* ── Formatting Toolbar ── */}
            <div style={s.toolbar}>
              <button
                style={s.toolbarBtn(false)}
                title="Bold"
                onMouseDown={(e) => { e.preventDefault(); document.execCommand('bold'); }}
                onMouseEnter={(e) => { e.currentTarget.style.background = SURFACE; e.currentTarget.style.color = TEXT; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = TEXT_DIM; }}
              >
                <Bold size={16} />
              </button>
              <button
                style={s.toolbarBtn(false)}
                title="Italic"
                onMouseDown={(e) => { e.preventDefault(); document.execCommand('italic'); }}
                onMouseEnter={(e) => { e.currentTarget.style.background = SURFACE; e.currentTarget.style.color = TEXT; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = TEXT_DIM; }}
              >
                <Italic size={16} />
              </button>

              <div style={s.toolbarDivider} />

              <button
                style={s.toolbarBtn(false)}
                title="Heading 1"
                onMouseDown={(e) => { e.preventDefault(); document.execCommand('formatBlock', false, 'h1'); }}
                onMouseEnter={(e) => { e.currentTarget.style.background = SURFACE; e.currentTarget.style.color = TEXT; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = TEXT_DIM; }}
              >
                <Heading1 size={16} />
              </button>
              <button
                style={s.toolbarBtn(false)}
                title="Heading 2"
                onMouseDown={(e) => { e.preventDefault(); document.execCommand('formatBlock', false, 'h2'); }}
                onMouseEnter={(e) => { e.currentTarget.style.background = SURFACE; e.currentTarget.style.color = TEXT; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = TEXT_DIM; }}
              >
                <Heading2 size={16} />
              </button>
              <button
                style={s.toolbarBtn(false)}
                title="Heading 3"
                onMouseDown={(e) => { e.preventDefault(); document.execCommand('formatBlock', false, 'h3'); }}
                onMouseEnter={(e) => { e.currentTarget.style.background = SURFACE; e.currentTarget.style.color = TEXT; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = TEXT_DIM; }}
              >
                <Heading3 size={16} />
              </button>
              <button
                style={s.toolbarBtn(false)}
                title="Normal paragraph"
                onMouseDown={(e) => { e.preventDefault(); document.execCommand('formatBlock', false, 'p'); }}
                onMouseEnter={(e) => { e.currentTarget.style.background = SURFACE; e.currentTarget.style.color = TEXT; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = TEXT_DIM; }}
              >
                <Type size={16} />
              </button>

              <div style={s.toolbarDivider} />

              <button
                style={s.toolbarBtn(false)}
                title="Insert Link"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const url = prompt('Enter URL:');
                  if (url) {
                    document.execCommand('createLink', false, url);
                    // Set target=_blank on newly created link
                    const sel = window.getSelection();
                    if (sel.rangeCount) {
                      const anchor = sel.anchorNode?.parentElement?.closest('a') || sel.anchorNode?.parentElement;
                      if (anchor && anchor.tagName === 'A') {
                        anchor.setAttribute('target', '_blank');
                        anchor.setAttribute('rel', 'noopener noreferrer');
                      }
                    }
                  }
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = SURFACE; e.currentTarget.style.color = TEXT; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = TEXT_DIM; }}
              >
                <Link2 size={16} />
              </button>
            </div>

            <div
              ref={previewRef}
              contentEditable
              suppressContentEditableWarning
              style={{
                ...s.previewBox,
                maxHeight: 'none',
                minHeight: 300,
                outline: 'none',
                cursor: 'text',
                borderRadius: '0 0 8px 8px',
              }}
              onClick={(e) => {
                const anchor = e.target.closest('a');
                if (anchor) {
                  e.preventDefault();
                  const currentHref = anchor.getAttribute('href') || '';
                  const newHref = prompt('Edit link URL:', currentHref);
                  if (newHref !== null) {
                    if (newHref.trim() === '') {
                      // Remove the link, keep the text
                      const frag = document.createDocumentFragment();
                      while (anchor.firstChild) frag.appendChild(anchor.firstChild);
                      anchor.replaceWith(frag);
                    } else {
                      anchor.setAttribute('href', newHref);
                      anchor.setAttribute('target', '_blank');
                      anchor.setAttribute('rel', 'noopener noreferrer');
                    }
                  }
                }
              }}
              dangerouslySetInnerHTML={{ __html: htmlContent }}
            />
          </div>
        )}

        {/* ──────── STEP 6: PUBLISH ──────── */}
        {step === 5 && (
          <>
            <div style={s.card}>
              <label style={{ ...s.label, marginBottom: 16 }}>Pre-Publish Summary</label>
              <table style={s.summaryTable}>
                <tbody>
                  <tr>
                    <td style={s.summaryTd(true)}>Title</td>
                    <td style={s.summaryTd(false)}>{metaTitle || '—'}</td>
                  </tr>
                  <tr>
                    <td style={s.summaryTd(true)}>Slug</td>
                    <td style={s.summaryTd(false)}>{slug || '—'}</td>
                  </tr>
                  <tr>
                    <td style={s.summaryTd(true)}>Meta Title</td>
                    <td style={s.summaryTd(false)}>{seoTitle || '—'}</td>
                  </tr>
                  <tr>
                    <td style={s.summaryTd(true)}>Meta Description</td>
                    <td style={s.summaryTd(false)}>{metaDesc || '—'}</td>
                  </tr>
                  <tr>
                    <td style={s.summaryTd(true)}>Content Size</td>
                    <td style={s.summaryTd(false)}>{formatBytes(contentSize)}</td>
                  </tr>
                  <tr>
                    <td style={s.summaryTd(true)}>Images</td>
                    <td style={s.summaryTd(false)}>{imageCount}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {(!apiToken || !collectionId) && (
              <div style={{ ...s.card, borderColor: '#f59e0b40', background: 'rgba(245,158,11,0.05)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#f59e0b', fontSize: 14 }}>
                  <AlertTriangle size={18} />
                  <span>
                    <strong>Webflow credentials not set.</strong> Open Settings to add your API Token and Collection ID.
                  </span>
                </div>
              </div>
            )}

            {!publishResult && (
              <div style={{ textAlign: 'center', marginTop: 8 }}>
                <button
                  style={s.btn(true, !apiToken || !collectionId || publishing)}
                  disabled={!apiToken || !collectionId || publishing}
                  onClick={handlePublish}
                >
                  <Rocket size={16} /> {publishing ? 'Publishing...' : 'Push as Draft'}
                </button>
              </div>
            )}

            {publishResult && publishResult.ok && (
              <div style={s.successBox}>
                <CheckCircle2 size={40} color="#22c55e" />
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 12, color: '#22c55e' }}>Published Successfully!</div>
                <div style={{ fontSize: 13, color: TEXT_DIM, marginTop: 8, fontFamily: FONT_MONO }}>
                  Item ID: {publishResult.id}
                </div>
              </div>
            )}

            {publishResult && !publishResult.ok && (
              <div style={s.errorBox}>
                <AlertTriangle size={40} color="#ef4444" />
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 12, color: '#ef4444' }}>Publish Failed</div>
                <div style={{ fontSize: 13, color: TEXT_DIM, marginTop: 8, fontFamily: FONT_MONO }}>
                  {publishResult.error}
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* ── Bottom Nav ── */}
      <div style={s.navBar}>
        <button
          style={s.btn(false, step === 0)}
          disabled={step === 0}
          onClick={() => setStep((p) => p - 1)}
        >
          <ChevronLeft size={16} /> Back
        </button>
        {step < 5 ? (
          <button
            style={s.btn(true, !canNext)}
            disabled={!canNext}
            onClick={() => setStep((p) => p + 1)}
          >
            Next <ChevronRight size={16} />
          </button>
        ) : (
          <div />
        )}
      </div>

      {/* ── Settings Modal ── */}
      {showSettings && (
        <div style={s.modal} onClick={() => setShowSettings(false)}>
          <div style={s.modalContent} onClick={(e) => e.stopPropagation()}>
            <button style={s.closeBtn} onClick={() => setShowSettings(false)}>
              <X size={20} />
            </button>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 0, marginBottom: 24 }}>
              <Settings size={18} style={{ verticalAlign: -3, marginRight: 8 }} />
              Settings
            </h2>

            <div style={{ marginBottom: 20 }}>
              <label style={s.label}>Webflow API Token</label>
              <input
                type="password"
                style={s.input}
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder="Enter your Webflow API token"
                onFocus={(e) => { e.target.style.borderColor = ACCENT; }}
                onBlur={(e) => { e.target.style.borderColor = BORDER; }}
              />
            </div>

            <div>
              <label style={s.label}>Blog Collection ID</label>
              <input
                type="text"
                style={{ ...s.input, fontFamily: FONT_MONO }}
                value={collectionId}
                onChange={(e) => setCollectionId(e.target.value)}
                placeholder="e.g. 6123abc..."
                onFocus={(e) => { e.target.style.borderColor = ACCENT; }}
                onBlur={(e) => { e.target.style.borderColor = BORDER; }}
              />
            </div>

            <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end' }}>
              <button style={s.btn(true, false)} onClick={() => setShowSettings(false)}>
                Save & Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
