// Prefix logging utility
const log = (...args) => console.log("[Draftly]", ...args);

log("content script loaded");

const PALETTES = {
  pink: {
    base: '#EC4899',
    hover: '#DB2777',
    soft: '#FCE7F3',
    border: '#F9A8D4'
  },
  teal: {
    base: '#0D9488',
    hover: '#0F766E',
    soft: '#CCFBF1',
    border: '#5EEAD4'
  },
  crimson: {
    base: '#BE123C',
    hover: '#9F1239',
    soft: '#FFE4E6',
    border: '#FDA4AF'
  },
  gold: {
    base: '#CA8A04',
    hover: '#A16207',
    soft: '#FEF9C3',
    border: '#FDE047'
  },
  ocean: {
    base: '#0369A1',
    hover: '#075985',
    soft: '#E0F2FE',
    border: '#7DD3FC'
  }
};

function applyDynamicAccent(colorName) {
  const palette = PALETTES[colorName] || PALETTES.pink;
  const root = document.documentElement;
  root.style.setProperty('--draftly-accent', palette.base);
  root.style.setProperty('--draftly-accent-hover', palette.hover);
  root.style.setProperty('--draftly-accent-soft', palette.soft);
  root.style.setProperty('--draftly-accent-border', palette.border);
}

// Load default settings and apply color palette immediately
chrome.runtime.sendMessage({ action: 'getSettings' }, (settings) => {
  if (settings && settings.themeColor) {
    applyDynamicAccent(settings.themeColor);
  } else {
    applyDynamicAccent('pink');
  }
});

// Sync settings dynamically when changed in options page
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace !== 'local') return;

  if (changes.themeColor && changes.themeColor.newValue) {
    applyDynamicAccent(changes.themeColor.newValue);
  }

  if (changes.themeMode && changes.themeMode.newValue) {
    if (activePanel) {
      if (changes.themeMode.newValue === 'dark') {
        activePanel.classList.add('theme-dark');
      } else {
        activePanel.classList.remove('theme-dark');
      }
    }
  }
});

/**
 * Extracts the post body and author name for the post associated with the clicked comment box.
 *
 * Architecture detection:
 *  - aria-label "Text editor for creating comment" → FEED (tiptap/ProseMirror, role="listitem" container)
 *  - aria-label "Text editor for creating content" → STANDALONE (ql-editor, role="article" container)
 *
 * Anchors ONLY on ARIA roles, aria-labels, href patterns, and structural position.
 * NO hashed CSS class names used as selectors.
 *
 * @param {HTMLElement} commentBox
 * @returns {Promise<{ author: string|null, body: string|null, extractionError: string|null }>}
 */
async function extractPostContext(commentBox) {
  // STEP 1 — DETECT ARCHITECTURE
  const ariaLabel = commentBox.getAttribute('aria-label') || '';
  let arch = null;
  if (ariaLabel.includes('Text editor for creating comment')) {
    arch = 'feed';
  } else if (ariaLabel.includes('Text editor for creating content') || commentBox.classList.contains('ql-editor')) {
    arch = 'standalone';
  } else {
    log('[extract] STEP 1 FAIL: unknown editor aria-label:', ariaLabel);
    return { author: null, body: null, extractionError: 'step1' };
  }
  log('[extract] STEP 1 OK: arch =', arch);

  // STEP 2 — FIND CONTAINER
  const containerRole = arch === 'feed' ? '[role="listitem"]' : '[role="article"]';
  const container = commentBox.closest(containerRole);
  if (!container) {
    log('[extract] STEP 2 FAIL: container', containerRole, 'not found');
    return { author: null, body: null, extractionError: 'step2' };
  }
  log('[extract] STEP 2 OK: container found', container);

  // Define a helper to check if an element is inside comments section or the comment input
  const commentsSection = container.querySelector('[componentkey^="commentsSectionContainer"], .comments-shared-comment-list, .comments-comments-list, [class*="comments-comments-list"]');
  function isExcluded(el) {
    if (commentBox.contains(el)) return true;
    if (commentsSection && commentsSection.contains(el)) return true;
    return false;
  }

  // ACTIVITY-ANNOTATION PRE-CHECK (between Step 2 and Step 3)
  // LinkedIn renders "X commented on this" / "X reshared this" / "X likes this" cards where
  // the engaging person's profile card appears ABOVE the actual embedded post. Detect this and
  // locate the REAL nested post instead.
  let activityAnnotationDetected = false;
  let activityActor = null; // the person who commented/reshared (skip this profile)

  // Scan the first few text nodes / short paragraphs near the top of the container
  const topTextEls = Array.from(container.querySelectorAll('p, span'))
    .filter(el => !isExcluded(el))
    .slice(0, 12); // only look at the first ~12 candidate elements

  const ACTIVITY_WORDS = ["likes this", "commented", "reshared this", "celebrated this", "found this insightful", "supports this"];

  for (const el of topTextEls) {
    const t = (el.textContent || '').trim().toLowerCase();
    if (ACTIVITY_WORDS.some(word => t === word || t.endsWith(" " + word))) {
      activityAnnotationDetected = true;
      activityActor = (el.textContent || '').trim();
      log('[extract] Detected activity-annotation header: "' + activityActor + '" — searching for nested original post.');
      break;
    }
  }

  // STEP 3 — EXTRACT AUTHOR
  // Candidates: all a[href*="/in/"] links with non-empty text, in DOM order.
  // Accept the FIRST that has a degree marker ("• 1st", "• 2nd", "• 3rd") on itself or
  // a nearby sibling — this identifies the real post author and rejects social-proof
  // annotations ("X commented", "X likes this") which never have a degree marker.
  const DEGREE_RE = /[•·]\s*(?:1st|2nd|3rd|\d+(?:st|nd|rd|th))/i;

  function hasDegreeMarker(el) {
    // Check the link's own text
    if (DEGREE_RE.test(el.textContent)) return true;
    // Check the parent container's text (degree badge is often a sibling span)
    const parent = el.parentElement;
    if (parent && DEGREE_RE.test(parent.textContent)) return true;
    // Walk up one more level
    const grandparent = parent && parent.parentElement;
    if (grandparent && DEGREE_RE.test(grandparent.textContent)) return true;
    return false;
  }

  // Restrict to elements BEFORE the comment box (exclude comment section)
  const allProfileLinks = Array.from(container.querySelectorAll('a[href*="/in/"]'))
    .filter(link => {
      const text = (link.textContent || '').trim();
      if (!text) return false;
      if (isExcluded(link)) return false;
      return true; // We filter for degree marker in next step, let's keep all for logging
    });

  log('[extract] Step 3 Debug: found profile links:', allProfileLinks.map(link => {
    const parentText = link.parentElement ? link.parentElement.textContent.trim().replace(/\s+/g, ' ') : '';
    const gpText = (link.parentElement && link.parentElement.parentElement) ? link.parentElement.parentElement.textContent.trim().replace(/\s+/g, ' ') : '';
    return {
      text: link.textContent.trim().replace(/\s+/g, ' '),
      href: link.getAttribute('href'),
      parentText: parentText.slice(0, 100),
      grandparentText: gpText.slice(0, 100),
      hasMarker: hasDegreeMarker(link)
    };
  }));

  // Now actually filter to those that have the degree marker
  const validProfileLinks = allProfileLinks.filter(link => hasDegreeMarker(link));

  let authorLink = null;
  let authorName = null;

  if (activityAnnotationDetected) {
    // On activity cards: skip the FIRST degree-marked profile (that's the actor who engaged),
    // use the SECOND degree-marked profile (that's the original post author).
    if (validProfileLinks.length >= 2) {
      authorLink = validProfileLinks[1];
      log('[extract] STEP 3 OK (activity card): using 2nd profile as real author');
    } else {
      log('[extract] STEP 3 FAIL (activity card): only', validProfileLinks.length, 'degree-marked profile(s) found — cannot identify nested post author');
      return { author: null, body: null, extractionError: 'step3' };
    }
  } else {
    authorLink = validProfileLinks[0] || null;
  }

  if (authorLink) {
    // Try to extract clean name from nested strong element first
    const strongEl = authorLink.querySelector('strong');
    if (strongEl) {
      authorName = strongEl.textContent.trim();
    } else {
      authorName = (authorLink.textContent || '').trim().split('\n')[0].trim();
    }
    // Clean up degree markers/verified
    authorName = authorName.replace(/\s*[•·]\s*(?:1st|2nd|3rd|\d+(?:st|nd|rd|th))\+?\s*/gi, '').trim();
    authorName = authorName.replace(/\s*[•·]\s*Verified.*$/i, '').trim();
    authorName = authorName.replace(/\s{2,}/g, ' ').trim();
    log('[extract] STEP 3 OK: author =', authorName);
  } else {
    log('[extract] STEP 3 FAIL: no /in/ link with degree marker found');
    return { author: null, body: null, extractionError: 'step3' };
  }

  // STEP 4 — EXTRACT BODY
  let bodyText = null;

  // Helper: run timestamp-anchor + fallback logic on an array of elements
  const TIMESTAMP_RE = /^\s*\d+\s*[smhdw]\w{0,2}\s*(?:[•·]\s*(?:Edited)?\s*[•·]?)?\s*$/i;
  const REACTION_RE  = /^\d[\d,]*\s*(reaction|comment|repost|like|share)/i;

  // For activity cards, only consider elements AFTER the real author link in the DOM
  // (to avoid picking up the actor's bio or the annotation text as the body)
  function elementIsAfterAnchor(el, anchor) {
    if (!anchor) return true; // no restriction if no anchor
    return !!(anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function extractBodyFromElements(els) {
    let tsIndex = -1;
    for (let i = 0; i < els.length; i++) {
      if (TIMESTAMP_RE.test((els[i].textContent || '').trim())) { tsIndex = i; break; }
    }
    if (tsIndex >= 0 && tsIndex + 1 < els.length) {
      const parts = [];
      for (let i = tsIndex + 1; i < els.length; i++) {
        const t = (els[i].textContent || '').trim();
        if (!t || REACTION_RE.test(t)) break;
        parts.push(t);
        if (parts.join(' ').length > 500 && i > tsIndex + 2) break;
      }
      if (parts.length > 0) return parts.join(' ').trim();
    }
    // Fallback: last element with length > 10 that is not a timestamp
    const fallback = [...els].reverse().find(el => {
      const t = (el.textContent || '').trim();
      return t.length > 10 && !TIMESTAMP_RE.test(t);
    });
    return fallback ? (fallback.textContent || '').trim() : null;
  }

  if (arch === 'feed') {
    // For activity cards, scope to DOM elements after the real author link
    const domAnchor = activityAnnotationDetected ? authorLink : null;

    // First attempt: collect <p> tags outside comment box and comments list
    let allPs = Array.from(container.querySelectorAll('p'))
      .filter(p => !isExcluded(p) && elementIsAfterAnchor(p, domAnchor));

    // RETRY: if zero <p> tags found, LinkedIn may not have hydrated yet — wait 300ms and re-query
    if (allPs.length === 0) {
      await new Promise(r => setTimeout(r, 300));
      allPs = Array.from(container.querySelectorAll('p'))
        .filter(p => !isExcluded(p) && elementIsAfterAnchor(p, domAnchor));
      log('[extract] STEP 4 retry after 300ms, p-tag count:', allPs.length);
    }

    if (allPs.length > 0) {
      bodyText = extractBodyFromElements(allPs);
      if (bodyText) log('[extract] STEP 4 OK (p-tags): body length =', bodyText.length);
    }

    // SPAN/DIV FALLBACK: if p-tags produced nothing, try spans and divs
    if (!bodyText) {
      const spanDivs = Array.from(container.querySelectorAll('span, div'))
        .filter(el => {
          if (isExcluded(el)) return false;
          if (!elementIsAfterAnchor(el, domAnchor)) return false;
          // Only leaf-ish elements (avoid giant wrapper divs)
          const t = (el.textContent || '').trim();
          return t.length > 0 && t.length < 2000 && el.children.length < 5;
        });
      log('[extract] STEP 4 fallback to span/div, count:', spanDivs.length);

      if (spanDivs.length > 0) {
        bodyText = extractBodyFromElements(spanDivs);
        if (bodyText) log('[extract] STEP 4 OK (span/div fallback): body length =', bodyText.length);
      }

      // If both strategies failed, log full container structure for diagnosis
      if (!bodyText) {
        log('[extract] STEP 4 FAIL (feed): p-tag texts found:', allPs.map(p => p.textContent.trim()));
        log('[extract] STEP 4 FAIL (feed): container innerHTML (first 3000 chars):',
          container.innerHTML.slice(0, 3000));
        log('[extract] STEP 4 FAIL (feed): no body found after retry + span/div fallback');
        return { author: null, body: null, extractionError: 'step4' };
      }
    }
  } else {
    // STANDALONE — only use stable BEM selectors for post body, no generic fallback
    const bodyEl = container.querySelector('.update-components-text, .feed-shared-update-v2__description');
    if (!bodyEl) {
      log('[extract] STEP 4 FAIL (standalone): .update-components-text not found');
      return { author: null, body: null, extractionError: 'step4' };
    }
    const clone = bodyEl.cloneNode(true);
    // Remove expand buttons
    clone.querySelectorAll('button').forEach(b => b.remove());
    bodyText = (clone.textContent || '').replace(/(?:\s*#[^\s#]+)+\s*$/, '').trim();
    log('[extract] STEP 4 OK (standalone): body length =', bodyText.length);
  }

  // Trim hashtags + cap
  bodyText = bodyText.replace(/(?:\s*#[^\s#]+)+\s*$/, '').trim();
  if (bodyText.length > 4000) bodyText = bodyText.slice(0, 4000) + '...';

  return { author: authorName, body: bodyText, extractionError: null };
}

/**
 * Creates the Draftly icon button element and attaches the click handler.
 * @param {HTMLElement} commentBox - Reference to the comment box this icon belongs to.
 * @returns {HTMLElement} wrapper div containing the button.
 */
function createDraftlyIcon(commentBox) {
  const wrapper = document.createElement('div');
  wrapper.className = 'draftly-wrapper';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'draftly-btn';
  btn.title = 'Generate comment with Quill';

  btn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
      <circle cx="12" cy="12" r="10" fill="currentColor"/>
      <g transform="translate(5.9, 5.5) scale(0.09375)" fill="#FFFFFF">
        <path d="M 36 100 L 44 92 C 46 88, 48 84, 51 79 C 55 69, 61 58, 70 49 C 79 40, 88 33, 97 28 C 99 27, 101 28, 100 31 C 95 45, 88 57, 79 66 C 83 65, 87 63, 91 60 C 84 69, 76 76, 67 81 C 60 85, 54 87, 49 90 L 41 97 Z"/>
        <path d="M 36 100 L 29 107 L 33 110 L 39 104 Z"/>
      </g>
    </svg>
  `;

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    log("icon clicked", commentBox);

    const postContext = await extractPostContext(commentBox);
    if (postContext.extractionError) {
      log("extraction failed at", postContext.extractionError, "— opening panel with blocked state");
    } else {
      log("extracted:", { author: postContext.author, bodyLen: postContext.body?.length });
    }

    // Open the panel. openPanel is defined in the panel section below.
    openPanel(commentBox, btn, postContext);
  });

  wrapper.appendChild(btn);
  return wrapper;
}

/**
 * Resolves the target button-row container for a given comment box.
 * Walks up the DOM from the comment box (up to 6 levels) looking for
 * LinkedIn's native emoji/photo/GIF buttons. Returns their parentElement
 * (the button row), or null if not found.
 * Only returns containers that are currently attached to the live page.
 * @param {HTMLElement} commentBox
 * @returns {HTMLElement|null}
 */
function findButtonRow(commentBox, type) {
  let node = commentBox.parentElement;
  for (let i = 0; i < 6 && node; i++) {
    if (!node.isConnected) return null;
    
    if (type === 'standalone') {
      // Standalone layout uses comments-comment-box__emoji-picker-trigger
      const emojiBtn = node.querySelector('button.comments-comment-box__emoji-picker-trigger');
      if (emojiBtn && emojiBtn.isConnected) {
        return emojiBtn.parentElement;
      }
    } else {
      // Feed layout uses aria-label mapping
      const nativeBtn = node.querySelector(
        'button[aria-label*="emoji" i], button[aria-label*="photo" i], button[aria-label*="gif" i]'
      );
      if (nativeBtn && nativeBtn.isConnected) {
        return nativeBtn.parentElement;
      }
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Idempotent cleanup: removes duplicate .draftly-wrapper elements within any
 * single container that has accumulated more than one.
 *
 * SAFETY INVARIANT: grouping is done by parentElement. Each distinct button row
 * (or editor wrapper) is its own group. Icons that belong to DIFFERENT button rows
 * are in different groups and are NEVER touched by this function. Only extras
 * within the SAME parent are removed, so a valid icon in a distinct comment box
 * is never accidentally deleted.
 */
function deduplicateIcons() {
  const allWrappers = document.querySelectorAll('.draftly-wrapper');
  // Group wrappers by their direct parent (the button row or editor wrapper)
  const byParent = new Map();
  allWrappers.forEach(w => {
    const p = w.parentElement;
    if (!p) return;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(w);
  });
  // Within each group, keep the first wrapper and remove any extras
  byParent.forEach((wrappers, parent) => {
    if (wrappers.length > 1) {
      log(`dedup: ${wrappers.length - 1} extra icon(s) removed from`, parent);
      for (let i = 1; i < wrappers.length; i++) {
        wrappers[i].remove();
      }
    }
  });
}

/**
 * Scans the DOM and injects the Draftly icon into comment box button rows.
 * Injection is idempotent: if the live target container already has a
 * .draftly-wrapper, nothing is added.
 */
/**
 * Queries all potential comment box elements on the page, distinguishing between
 * feed comment inputs and standalone post main comment inputs.
 * Excludes reply textboxes on both layouts.
 * @returns {Array<{ element: HTMLElement, type: 'feed'|'standalone' }>}
 */
function getPotentialCommentBoxes() {
  const list = [];
  
  // 1. Feed comment boxes
  const feedBoxes = document.querySelectorAll('div[contenteditable="true"][role="textbox"]');
  feedBoxes.forEach(box => {
    const ariaLabel = box.getAttribute('aria-label') || '';
    if (ariaLabel.includes('Text editor for creating comment')) {
      list.push({ element: box, type: 'feed' });
    }
  });

  // 2. Standalone page main comment boxes
  const standaloneBoxes = document.querySelectorAll('div.ql-editor[contenteditable="true"][role="textbox"]');
  standaloneBoxes.forEach(box => {
    const ariaLabel = box.getAttribute('aria-label') || '';
    if (ariaLabel.includes('Text editor for creating content')) {
      const isReply = box.closest('.comments-comment-box--reply');
      const isMain = box.closest('.comments-comment-box--cr');
      if (isMain && !isReply) {
        list.push({ element: box, type: 'standalone' });
      }
    }
  });

  return list;
}

/**
 * Scans the DOM and injects the Draftly icon into comment box button rows.
 * Injection is idempotent: if the live target container already has a
 * .draftly-wrapper, nothing is added.
 */
function injectIcons() {
  // Safety pass first: remove any duplicates that may have accumulated
  deduplicateIcons();

  const boxes = getPotentialCommentBoxes();

  boxes.forEach(({ element: commentBox, type }) => {
    // Guard: comment box must be live in the page
    if (!commentBox.isConnected) return;

    const editorWrapper = commentBox.parentElement;
    if (!editorWrapper || !editorWrapper.isConnected) return;

    // Resolve the live button row (or fall back to the editor wrapper)
    const buttonRow = findButtonRow(commentBox, type);
    const targetContainer = buttonRow || editorWrapper;

    // Shared-row guard
    if (buttonRow) {
      const commentBoxesUnderRow = buttonRow.querySelectorAll(
        type === 'standalone'
          ? 'div.ql-editor[contenteditable="true"][role="textbox"]'
          : 'div[contenteditable="true"][role="textbox"]'
      );
      if (commentBoxesUnderRow.length > 1) {
        log("shared button row detected — relying on existence guard", buttonRow);
      }
    }

    // Primary guard: check the LIVE target container for an existing icon RIGHT NOW
    const existingIcons = targetContainer.querySelectorAll('.draftly-wrapper');
    if (existingIcons.length === 1) {
      return;
    }
    if (existingIcons.length > 1) {
      for (let i = 1; i < existingIcons.length; i++) existingIcons[i].remove();
      return;
    }

    // Zero icons in the live container — safe to inject exactly one
    const wrapper = createDraftlyIcon(commentBox);

    if (buttonRow) {
      // Primary: prepend to the native button row (sits left of emoji/photo/GIF)
      buttonRow.insertBefore(wrapper, buttonRow.firstChild);
    } else {
      // Fallback: absolute top-right of the editor wrapper
      wrapper.classList.add('fallback');
      if (window.getComputedStyle(editorWrapper).position === 'static') {
        editorWrapper.style.position = 'relative';
      }
      editorWrapper.appendChild(wrapper);
    }

    log("icon injected", commentBox);
  });
}

// --- MutationObserver (rAF-debounced to avoid layout thrash on scroll) ---
let rafPending = false;
function handleMutations() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    injectIcons();
    rafPending = false;
  });
}

// Initial injection on load
injectIcons();

// Watch for LinkedIn's virtualized feed rendering new nodes
const observer = new MutationObserver(handleMutations);
observer.observe(document.body, { childList: true, subtree: true });

// ============================================================
// PANEL — Phase 3: Popup panel UI
// All panel logic is isolated in this section.
// ============================================================

/** Reference to the currently open panel element, if any. */
let activePanel = null;

/** Removes the active panel from the DOM and cleans up listeners. */
function closePanel() {
  if (!activePanel) return;
  activePanel.remove();
  activePanel = null;
  document.removeEventListener('click', handleOutsideClick, true);
  document.removeEventListener('keydown', handleEscapeKey, true);
}

/** Closes the panel when Escape is pressed. */
function handleEscapeKey(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closePanel();
  }
}

/** Closes the panel when the user clicks outside it. */
function handleOutsideClick(e) {
  if (activePanel && !activePanel.contains(e.target)) {
    closePanel();
  }
}

/**
 * Sends a generateComments request to the service worker, which calls Gemini.
 * Returns { ok, variations?, error? }.
 * Includes a 25-second timeout race to prevent infinite loading.
 *
 * @param {{ author: string|null, body: string|null }} postContext
 * @param {'short'|'medium'|'long'} length
 * @param {string} guideline
 * @returns {Promise<{ ok: boolean, variations?: string[], error?: string }>}
 */
function requestVariations(postContext, length, guideline, emoji, endWithQuestion, tone) {
  return new Promise((resolve) => {
    let timer = setTimeout(() => {
      timer = null;
      log('request timed out after 25s');
      resolve({ ok: false, error: 'timeout' });
    }, 25000);

    try {
      chrome.runtime.sendMessage(
        {
          action: 'generateComments',
          payload: {
            author: postContext.author,
            body: postContext.body,
            length,
            guideline: guideline || '',
            emoji,
            endWithQuestion,
            tone,
          },
        },
        (response) => {
          if (!timer) return; // already timed out
          clearTimeout(timer);

          log('content: received response', response, chrome.runtime.lastError ? chrome.runtime.lastError.message : null);
          if (chrome.runtime.lastError) {
            log('message error:', chrome.runtime.lastError.message);
            resolve({ ok: false, error: 'extension-error' });
            return;
          }
          resolve(response || { ok: false, error: 'empty-response' });
        }
      );
      log('content: sent generate request');
    } catch (err) {
      if (!timer) return;
      clearTimeout(timer);
      log('sendMessage exception:', err.message);
      resolve({ ok: false, error: 'extension-error' });
    }
  });
}

/**
 * Maps service-worker error codes to short user-facing inline messages.
 */
function errorMessage(code) {
  const messages = {
    'no-key':          'No API key set. Add your free Gemini key in Quill settings to start generating.',
    'auth-error':      "Your API key was rejected. Check that it's correct and active in Quill settings.",
    'rate-limit':      "Rate limit reached. Gemini's free tier has a per-minute limit — wait a moment and try again.",
    'api-error':       'Gemini had a problem on its end. Try again in a moment.',
    'network-error':   "Couldn't reach Gemini. Check your internet connection and try again.",
    'empty-response':  'Gemini returned an empty response. Try Regenerate.',
    'parse-failure':   "Couldn't read the AI's response. Try Regenerate — if it keeps happening, try a shorter length.",
    'timeout':         'This is taking too long. Try again.',
    'extension-error': 'Quill was updated. Please refresh this LinkedIn tab to continue.',
  };
  return messages[code] || 'Something went wrong — try Regenerate.';
}

/**
 * Inserts text into a ProseMirror/tiptap contenteditable comment box.
 *
 * Strategy: focus the element, select all existing content, then use
 * document.execCommand('insertText') which fires a synthetic beforeinput
 * event that ProseMirror\u2019s event handler recognises \u2014 making the inserted
 * text part of the editor\u2019s internal state and preventing it from being
 * overwritten on the next render. Does NOT submit the form.
 *
 * @param {HTMLElement} commentBox
 * @param {string} text
 */
function pasteIntoCommentBox(commentBox, text) {
  commentBox.focus();

  // Select all existing content so paste replaces it cleanly
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(commentBox);
  sel.removeAllRanges();
  sel.addRange(range);

  // execCommand('insertText') triggers ProseMirror\u2019s beforeinput handler,
  // which updates the editor state \u2014 text persists and survives blur.
  const ok = document.execCommand('insertText', false, text);

  if (!ok) {
    // Fallback for environments where execCommand is fully deprecated:
    // dispatch a beforeinput InputEvent directly.
    const evt = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    });
    commentBox.dispatchEvent(evt);
    log('paste: execCommand unavailable, fell back to InputEvent dispatch');
  }
}

/**
 * Builds a single variation card DOM element.
 * @param {string} text - The variation content.
 * @param {number} index - 1-based card number.
 * @param {HTMLElement} commentBox - The associated comment box.
 * @returns {HTMLElement}
 */
function buildVariationCard(text, index, commentBox) {
  const card = document.createElement('div');
  card.className = 'draftly-variation-card';

  const num = document.createElement('div');
  num.className = 'draftly-variation-num';
  num.textContent = `Variation ${index}`;
  card.appendChild(num);

  const p = document.createElement('p');
  p.className = 'draftly-variation-text';
  p.textContent = text;
  card.appendChild(p);

  const actions = document.createElement('div');
  actions.className = 'draftly-variation-actions';

  // Paste button
  const pasteBtn = document.createElement('button');
  pasteBtn.className = 'draftly-paste-btn';
  pasteBtn.textContent = 'Paste';
  pasteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pasteIntoCommentBox(commentBox, text);
    closePanel();
    log('variation pasted into comment box');
  });

  // Copy button
  const copyBtn = document.createElement('button');
  copyBtn.className = 'draftly-copy-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = '\u2713 Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800);
    }).catch(() => {
      log('clipboard write failed');
    });
  });

  actions.appendChild(pasteBtn);
  actions.appendChild(copyBtn);
  card.appendChild(actions);
  return card;
}

/**
 * Shows a loading indicator in the results area.
 */
function showLoading(resultsEl) {
  resultsEl.innerHTML = '';
  const loader = document.createElement('div');
  loader.className = 'draftly-loading';
  loader.textContent = 'Generating\u2026';
  resultsEl.appendChild(loader);
}

/**
 * Shows an inline error message in the results area with actionable buttons.
 */
function showInlineError(resultsEl, message, actions = []) {
  resultsEl.innerHTML = '';
  const errEl = document.createElement('div');
  errEl.className = 'draftly-inline-error';
  errEl.textContent = message;
  resultsEl.appendChild(errEl);

  if (actions.length > 0) {
    const btnContainer = document.createElement('div');
    btnContainer.className = 'draftly-error-actions';
    btnContainer.style.display = 'flex';
    btnContainer.style.gap = '8px';
    btnContainer.style.marginTop = '10px';

    actions.forEach(action => {
      const btn = document.createElement('button');
      btn.className = action.className || 'draftly-regenerate-btn';
      btn.textContent = action.label;
      btn.style.flex = '1';
      btn.style.margin = '0';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        action.onClick();
      });
      btnContainer.appendChild(btn);
    });
    resultsEl.appendChild(btnContainer);
  }
}

/**
 * Renders 3 real variation cards from the Gemini response, plus Regenerate.
 * @param {string[]} variations
 */
function renderVariationCards(resultsEl, variations, commentBox, regenerateFn) {
  resultsEl.innerHTML = '';
  variations.forEach((text, i) => {
    resultsEl.appendChild(buildVariationCard(text, i + 1, commentBox));
  });

  // Regenerate button
  const regenBtn = document.createElement('button');
  regenBtn.className = 'draftly-regenerate-btn';
  regenBtn.textContent = '\u21bb Regenerate';
  regenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    regenerateFn();
  });
  resultsEl.appendChild(regenBtn);
}

/**
 * Runs the full generate flow: loading → API call → render cards or error.
 * Called by both Generate and Regenerate.
 */
async function doGenerate(resultsEl, postContext, length, guideline, emoji, endWithQuestion, tone, commentBox, panel, iconRect, generateBtn, triggerGenerate) {
  const openSettings = () => chrome.runtime.sendMessage({ action: 'openOptions' });
  const reloadPage = () => location.reload();

  // STEP 5 HARD GUARD: block generation if extraction failed
  if (postContext.extractionError || !postContext.body) {
    log('[guard] STEP 5 FAIL: generation blocked due to extraction error:', postContext.extractionError || 'no body');
    if (generateBtn) {
      generateBtn.disabled = true;
      generateBtn.innerHTML = '<span class="draftly-generate-icon">✨</span> Generate';
    }
    showInlineError(resultsEl, "Couldn't read this post. LinkedIn may have changed something — try refreshing.", [
      { label: 'Reload Page', onClick: reloadPage }
    ]);
    requestAnimationFrame(() => positionPanel(panel, iconRect));
    return;
  }

  // 1. Fail fast: check if key is set before loading spinner
  let hasKey = false;
  try {
    const settings = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(response);
        }
      });
    });
    if (settings && settings.hasApiKey) {
      hasKey = true;
    }
  } catch (err) {
    log('Failed checking settings before generate:', err);
  }

  if (!hasKey) {
    log('generate failed: no-key check failed before loading');
    const msg = errorMessage('no-key');
    showInlineError(resultsEl, msg, [
      { label: 'Open Settings', onClick: openSettings }
    ]);
    if (generateBtn) {
      generateBtn.disabled = false;
      generateBtn.innerHTML = '<span class="draftly-generate-icon">✨</span> Try Again';
    }
    requestAnimationFrame(() => positionPanel(panel, iconRect));
    return;
  }

  // 2. Show loading state
  showLoading(resultsEl);
  if (generateBtn) {
    generateBtn.disabled = true;
    generateBtn.innerHTML = '<span class="draftly-generate-icon">✨</span> Generating…';
  }

  // Re-position panel now that content changed
  requestAnimationFrame(() => positionPanel(panel, iconRect));

  const result = await requestVariations(postContext, length, guideline, emoji, endWithQuestion, tone);

  if (result.ok && result.variations) {
    if (generateBtn) {
      generateBtn.disabled = false;
      generateBtn.innerHTML = '<span class="draftly-generate-icon">✨</span> Generate';
    }
    renderVariationCards(resultsEl, result.variations, commentBox, triggerGenerate);
  } else {
    if (generateBtn) {
      generateBtn.disabled = false;
      generateBtn.innerHTML = '<span class="draftly-generate-icon">✨</span> Try Again';
    }

    const code = result.error;
    const msg = errorMessage(code);
    log('generate failed:', code);

    // Map each code to its specific button configuration (excluding redundant "Try Again")
    let actions = [];
    if (code === 'no-key') {
      actions = [
        { label: 'Open Settings', onClick: openSettings }
      ];
    } else if (code === 'auth-error') {
      actions = [
        { label: 'Open Settings', onClick: openSettings }
      ];
    } else if (code === 'extension-error') {
      actions = [
        { label: 'Reload Page', onClick: reloadPage }
      ];
    }

    showInlineError(resultsEl, msg, actions);
  }

  // Re-position after final content renders
  requestAnimationFrame(() => positionPanel(panel, iconRect));
}

/**
 * Positions the panel near the icon, flipping vertically if near viewport edges.
 * @param {HTMLElement} panel
 * @param {DOMRect} iconRect
 */
function positionPanel(panel, iconRect) {
  if (panel.dataset.dragged === 'true') {
    return;
  }
  const margin = 10;
  const panelW = 340;
  const panelH = panel.offsetHeight || 280;

  // Default: open below the icon
  let top = iconRect.bottom + margin;
  let left = iconRect.left;

  // Flip above if not enough space below the icon
  if (top + panelH > window.innerHeight - margin) {
    const aboveTop = iconRect.top - panelH - margin;
    // Only flip if there\u2019s actually more room above
    if (aboveTop > margin) {
      top = aboveTop;
    }
  }

  // Clamp horizontally: don\u2019t let the panel spill past the right or left edges
  if (left + panelW > window.innerWidth - margin) {
    left = window.innerWidth - panelW - margin;
  }
  if (left < margin) left = margin;

  panel.style.top = `${Math.round(top)}px`;
  panel.style.left = `${Math.round(left)}px`;
}

/**
 * Opens the Draftly popup panel near the clicked icon.
 * Closes any previously open panel first (enforces one panel at a time).
 *
 * @param {HTMLElement} commentBox - The comment input box this panel belongs to.
 * @param {HTMLElement} iconEl    - The clicked D button (used for positioning).
 * @param {{ author: string|null, body: string|null }} postContext
 */
async function openPanel(commentBox, iconEl, postContext) {
  // Enforce one panel at a time
  closePanel();

  const iconRect = iconEl.getBoundingClientRect();

  // Fetch settings to read defaults
  let selectedLength = 'medium';
  let selectedTone = 'professional';
  let emojiDefault = false;
  let questionDefault = false;
  let hasKey = false;
  let settings = null;
  try {
    settings = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
        if (chrome.runtime.lastError) {
          // Service worker inactive or connection error — resolve with null gracefully
          resolve(null);
        } else {
          resolve(response);
        }
      });
    });
    if (settings) {
      if (settings.defaultLength) selectedLength = settings.defaultLength;
      if (settings.tone) selectedTone = settings.tone;
      emojiDefault = !!settings.emoji;
      questionDefault = !!settings.endWithQuestion;
      hasKey = !!settings.hasApiKey;
      if (settings.themeColor) {
        applyDynamicAccent(settings.themeColor);
      }
    }
  } catch (err) {
    log('Failed to fetch settings:', err);
  }

  // Local toggle states (per-comment overrides)
  let emojiOn = emojiDefault;
  let questionOn = questionDefault;

  // ---- Build panel DOM ----
  const panel = document.createElement('div');
  panel.className = 'draftly-panel';
  if (settings && settings.themeMode === 'dark') {
    panel.classList.add('theme-dark');
  }

  // Stop click/keydown events from leaking through the panel into LinkedIn
  panel.addEventListener('click', e => e.stopPropagation());
  panel.addEventListener('keydown', e => e.stopPropagation());

  // ======== Header ========
  const header = document.createElement('div');
  header.className = 'draftly-panel-header';

  // Left side: icon + title + status
  const titleWrap = document.createElement('span');
  titleWrap.className = 'draftly-panel-title';

  const headerIcon = document.createElement('span');
  headerIcon.className = 'draftly-header-icon';
  headerIcon.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="#FFFFFF" width="14" height="14">
      <path d="M 36 100 L 44 92 C 46 88, 48 84, 51 79 C 55 69, 61 58, 70 49 C 79 40, 88 33, 97 28 C 99 27, 101 28, 100 31 C 95 45, 88 57, 79 66 C 83 65, 87 63, 91 60 C 84 69, 76 76, 67 81 C 60 85, 54 87, 49 90 L 41 97 Z"/>
      <path d="M 36 100 L 29 107 L 33 110 L 39 104 Z"/>
    </svg>
  `;
  titleWrap.appendChild(headerIcon);

  const titleText = document.createTextNode('Quill');
  titleWrap.appendChild(titleText);

  // Status badge
  if (hasKey) {
    const status = document.createElement('span');
    status.className = 'draftly-header-status';
    const dot = document.createElement('span');
    dot.className = 'draftly-header-status-dot';
    status.appendChild(dot);
    status.appendChild(document.createTextNode('Ready'));
    titleWrap.appendChild(status);
  }

  // Right side: gear + close
  const headerActions = document.createElement('div');
  headerActions.className = 'draftly-header-actions';

  const gearBtn = document.createElement('button');
  gearBtn.className = 'draftly-panel-gear';
  gearBtn.title = 'Settings';
  gearBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
  gearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ action: 'openOptions' });
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'draftly-panel-close';
  closeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closePanel();
  });

  headerActions.appendChild(gearBtn);
  headerActions.appendChild(closeBtn);

  header.appendChild(titleWrap);
  header.appendChild(headerActions);
  panel.appendChild(header);

  // ======== Make Panel Draggable by Header ========
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  header.addEventListener('mousedown', (e) => {
    // Exclude gearBtn and closeBtn
    if (e.target.closest('.draftly-panel-gear') || e.target.closest('.draftly-panel-close')) {
      return;
    }

    isDragging = true;
    panel.classList.add('draftly-dragging');

    // Get current fixed coordinates of the panel
    const rect = panel.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;

    startX = e.clientX;
    startY = e.clientY;

    e.preventDefault(); // Prevent text selection/drag behaviors

    const handleMouseMove = (moveEvent) => {
      if (!isDragging) return;
      panel.dataset.dragged = 'true';
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Clamping coordinates so the header and panel remain visible in the viewport
      const panelWidth = panel.offsetWidth || 340;
      const headerHeight = header.offsetHeight || 40;

      newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - panelWidth));
      newTop = Math.max(0, Math.min(newTop, window.innerHeight - headerHeight));

      panel.style.left = `${newLeft}px`;
      panel.style.top = `${newTop}px`;
    };

    const handleMouseUp = () => {
      isDragging = false;
      panel.classList.remove('draftly-dragging');
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  });

  // ======== Body ========
  const body = document.createElement('div');
  body.className = 'draftly-panel-body';

  // -- Tone selector --
  const toneSection = document.createElement('div');
  const toneLabel = document.createElement('div');
  toneLabel.className = 'draftly-section-label';
  toneLabel.textContent = 'TONE';

  const toneGroup = document.createElement('div');
  toneGroup.className = 'draftly-chip-group';

  const toneOptions = [
    { value: 'professional', label: 'Professional', icon: '💼' },
    { value: 'casual', label: 'Casual', icon: '💬' },
    { value: 'insightful', label: 'Insightful', icon: '💡' },
  ];
  const toneChips = [];

  toneOptions.forEach(opt => {
    const chip = document.createElement('button');
    chip.className = 'draftly-chip' + (opt.value === selectedTone ? ' active' : '');
    chip.innerHTML = `<span class="draftly-chip-icon">${opt.icon}</span>${opt.label}`;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedTone = opt.value;
      toneChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
    toneChips.push(chip);
    toneGroup.appendChild(chip);
  });

  toneSection.appendChild(toneLabel);
  toneSection.appendChild(toneGroup);
  body.appendChild(toneSection);

  // -- Length selector --
  const lengthSection = document.createElement('div');
  const lengthLabel = document.createElement('div');
  lengthLabel.className = 'draftly-section-label';
  lengthLabel.textContent = 'LENGTH';

  const lengthGroup = document.createElement('div');
  lengthGroup.className = 'draftly-chip-group';

  const lengthOptions = [
    { value: 'short', label: 'Short', icon: '⚡' },
    { value: 'medium', label: 'Medium', icon: '✏️' },
    { value: 'long', label: 'Long', icon: '📝' },
  ];
  const lengthChips = [];

  lengthOptions.forEach(opt => {
    const chip = document.createElement('button');
    chip.className = 'draftly-chip' + (opt.value === selectedLength ? ' active' : '');
    chip.innerHTML = `<span class="draftly-chip-icon">${opt.icon}</span>${opt.label}`;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedLength = opt.value;
      lengthChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
    lengthChips.push(chip);
    lengthGroup.appendChild(chip);
  });

  lengthSection.appendChild(lengthLabel);
  lengthSection.appendChild(lengthGroup);
  body.appendChild(lengthSection);

  // -- Emoji & Question pill toggles --
  const togglesRow = document.createElement('div');
  togglesRow.className = 'draftly-toggles-row';

  function createPillToggle(icon, label, initialState, onChange) {
    const pill = document.createElement('div');
    pill.className = 'draftly-pill-toggle' + (initialState ? ' on' : '');

    pill.innerHTML = `<span class="draftly-pill-icon">${icon}</span><span class="draftly-pill-label">${label}</span><span class="draftly-mini-switch"></span>`;

    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOn = pill.classList.toggle('on');
      onChange(isOn);
    });

    return pill;
  }

  const emojiPill = createPillToggle('😊', 'Emoji', emojiOn, (val) => { emojiOn = val; });
  const questionPill = createPillToggle('❓', 'Question', questionOn, (val) => { questionOn = val; });

  togglesRow.appendChild(emojiPill);
  togglesRow.appendChild(questionPill);
  body.appendChild(togglesRow);

  // -- Guideline input --
  const guidelineWrap = document.createElement('div');
  guidelineWrap.className = 'draftly-guideline-wrap';

  const guidelineInput = document.createElement('input');
  guidelineInput.type = 'text';
  guidelineInput.className = 'draftly-guideline-input';
  guidelineInput.placeholder = 'Write a quick reply guideline\u2026';
  guidelineInput.maxLength = 400;
  // Prevent LinkedIn from intercepting keystrokes in our input
  guidelineInput.addEventListener('keydown', e => e.stopPropagation());
  guidelineInput.addEventListener('keyup', e => e.stopPropagation());
  guidelineInput.addEventListener('click', e => e.stopPropagation());

  const charCount = document.createElement('span');
  charCount.className = 'draftly-char-count';
  charCount.textContent = '0/400';
  guidelineInput.addEventListener('input', () => {
    charCount.textContent = `${guidelineInput.value.length}/400`;
  });

  guidelineWrap.appendChild(guidelineInput);
  guidelineWrap.appendChild(charCount);
  body.appendChild(guidelineWrap);

  // -- Tip box --
  const tip = document.createElement('div');
  tip.className = 'draftly-tip';
  tip.innerHTML = `<span class="draftly-tip-icon">\u2728</span><span>Tip: Add a guideline like "agree and add a stat" for more specific results.</span>`;
  body.appendChild(tip);

  // -- Generate button --
  const generateBtn = document.createElement('button');
  generateBtn.className = 'draftly-generate-btn';
  generateBtn.innerHTML = '<span class="draftly-generate-icon">\u2728</span> Generate';

  // -- Results area --
  const resultsEl = document.createElement('div');
  resultsEl.className = 'draftly-variations';

  const triggerGenerate = () => {
    // Attach results area the first time
    if (!body.contains(resultsEl)) {
      body.appendChild(resultsEl);
    }
    doGenerate(resultsEl, postContext, selectedLength, guidelineInput.value, emojiOn, questionOn, selectedTone, commentBox, panel, iconRect, generateBtn, triggerGenerate);
  };

  generateBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    triggerGenerate();
  });

  body.appendChild(generateBtn);
  panel.appendChild(body);

  // Attach to document.body so it is never clipped by LinkedIn\u2019s scroll containers
  document.body.appendChild(panel);

  // Position after layout (so offsetHeight is available)
  requestAnimationFrame(() => positionPanel(panel, iconRect));

  activePanel = panel;

  // Register outside-click and escape listeners.
  // Deferred 50ms so the icon\u2019s own click event doesn\u2019t immediately trigger them.
  setTimeout(() => {
    document.addEventListener('click', handleOutsideClick, true);
    document.addEventListener('keydown', handleEscapeKey, true);
  }, 50);

  log('panel opened for comment box', commentBox);
}
