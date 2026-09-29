export function extractDocId(url) {
  const m = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

export function cleanGoogleHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // ── Merge Google Docs fragmented lists into properly nested lists ──
  // Google Docs exports each list item as a separate <ul>/<ol> with classes
  // like "lst-kix_abc123-0" (level 0), "lst-kix_abc123-1" (level 1), etc.
  // We merge consecutive same-list-id elements into one nested structure.

  function getListInfo(el) {
    if (!el || (el.tagName !== 'UL' && el.tagName !== 'OL')) return null;
    const cls = el.getAttribute('class') || '';
    // Match lst-kix_XXXX-N or c[0-9] li-bullet-N patterns
    const kixMatch = cls.match(/lst-(\w+)-(\d+)/);
    if (kixMatch) return { listId: kixMatch[1], level: parseInt(kixMatch[2]) };
    // Fallback: detect level from li-bullet-N class on child <li>
    const li = el.querySelector(':scope > li');
    if (li) {
      const liCls = li.getAttribute('class') || '';
      const bulletMatch = liCls.match(/li-bullet-(\d+)/);
      if (bulletMatch) return { listId: '_default', level: parseInt(bulletMatch[1]) };
    }
    return { listId: '_default', level: 0 };
  }

  // Collect consecutive list elements into groups
  const body = doc.body;
  const children = Array.from(body.children);
  let i = 0;
  while (i < children.length) {
    const el = children[i];
    const info = getListInfo(el);
    if (!info) { i++; continue; }

    // Gather all consecutive list elements
    const group = [{ el, info }];
    let j = i + 1;
    while (j < children.length) {
      const nextInfo = getListInfo(children[j]);
      if (!nextInfo) break;
      group.push({ el: children[j], info: nextInfo });
      j++;
    }

    if (group.length > 1) {
      // Build a single nested list from the group
      const rootTag = group[0].el.tagName.toLowerCase();
      const rootList = doc.createElement(rootTag);
      // Stack: array of { list, level }
      const stack = [{ list: rootList, level: 0 }];

      for (const { el: listEl, info: lInfo } of group) {
        const items = Array.from(listEl.querySelectorAll(':scope > li'));
        for (const li of items) {
          const level = lInfo.level;
          // Pop stack until we find the right parent level
          while (stack.length > 1 && stack[stack.length - 1].level >= level) {
            stack.pop();
          }
          const parentList = stack[stack.length - 1].list;

          if (level > stack[stack.length - 1].level) {
            // Need to nest deeper — create sub-list inside last <li> of parent
            const lastLi = parentList.querySelector(':scope > li:last-child');
            if (lastLi) {
              const subTag = listEl.tagName.toLowerCase();
              const subList = doc.createElement(subTag);
              lastLi.appendChild(subList);
              stack.push({ list: subList, level });
              subList.appendChild(li);
            } else {
              parentList.appendChild(li);
            }
          } else {
            parentList.appendChild(li);
          }
        }
      }

      // Replace the first element with the merged list, remove the rest
      group[0].el.replaceWith(rootList);
      for (let k = 1; k < group.length; k++) {
        group[k].el.remove();
      }

      // Re-read children since DOM changed
      i++;
    } else {
      i = j;
    }
  }

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
      try { a.setAttribute('href', decodeURIComponent(redir[1])); } catch { /* noop */ }
    }
  });

  return doc.body.innerHTML;
}

export function detectTitle(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const h = doc.querySelector('h1, h2');
  return h ? h.textContent.trim() : '';
}

export function countImages(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  return doc.querySelectorAll('img').length;
}

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function sanitizeListsForWebflow(html) {
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

export function lookupAlt(altTexts, imageName) {
  if (!altTexts || !imageName) return null;
  // Exact match: altTexts["hero.webp"] for image "hero.webp"
  if (altTexts[imageName]) return altTexts[imageName];
  // Base name match: altTexts["hero"] for image "hero.webp"
  const base = imageName.replace(/\.[^.]+$/, '');
  if (base && altTexts[base]) return altTexts[base];
  return null;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

/**
 * Put the uploaded images into the post, in order: the Nth uploaded image
 * replaces the Nth <img> in the document; extras are appended at the end.
 * The original file name rides along in data-shipit-name so the uploader
 * can give the Webflow asset a sensible name.
 */
export function injectImages(html, images, altTexts) {
  if (!images || !images.length) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const inlineImgs = Array.from(doc.querySelectorAll('img'));
  images.forEach((imgData, i) => {
    let img = inlineImgs[i];
    if (!img) {
      img = doc.createElement('img');
      const p = doc.createElement('p');
      p.appendChild(img);
      doc.body.appendChild(p);
    }
    img.setAttribute('src', imgData.dataUrl);
    img.setAttribute('alt', lookupAlt(altTexts, imgData.name) || imgData.name.replace(/\.[^.]+$/, ''));
    img.setAttribute('data-shipit-name', imgData.name);
  });
  return doc.body.innerHTML;
}
