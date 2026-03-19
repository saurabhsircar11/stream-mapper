import { ANNOTATION_COMMENT_STATUSES, ANNOTATION_DEFAULT_USERNAME } from '../../utils/constants.js';

const ANNOTATION_STORE_KEY = 'stream-annotation-comments';
export const DEFAULT_USERNAME = ANNOTATION_DEFAULT_USERNAME;
export const COMMENT_STATUSES = ANNOTATION_COMMENT_STATUSES;

export function normalizeCommentStatus(status) {
  const value = `${status || ''}`.trim();
  if (value === 'Complete') return 'Resolved';
  if (COMMENT_STATUSES.includes(value)) return value;
  return COMMENT_STATUSES[0];
}

export function createAnnotationStore({ annotationState, annotationUI }) {
  function generateId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function isInlineAssetUrl(value) {
    const normalized = `${value || ''}`.trim().toLowerCase();
    return normalized.startsWith('data:') || normalized.startsWith('blob:');
  }

  function getPersistedElementSource(element) {
    if (!(element instanceof HTMLElement)) return '';

    const originalSource = element.getAttribute('data-stream-original-src')
      || element.closest('picture')?.getAttribute('data-stream-original-src')
      || '';
    if (originalSource) return originalSource;

    const directSource = element.getAttribute('src')
      || element.getAttribute('srcset')
      || '';
    if (isInlineAssetUrl(directSource)) return '';
    return directSource;
  }

  function getCommentElementDescriptor(element) {
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || '',
      href: element.getAttribute('href') || '',
      src: getPersistedElementSource(element),
      alt: element.getAttribute('alt') || '',
      title: element.getAttribute('title') || '',
      ariaLabel: element.getAttribute('aria-label') || '',
    };
  }

  function parseCommentElementPath(elementPath) {
    if (!elementPath) return null;
    if (typeof elementPath === 'object') {
      const hasStructuredAnchor = Boolean(
        elementPath.sectionDaaLh
        || Number.isInteger(elementPath.sectionIndex)
        || elementPath.blockDaaLh
        || elementPath.blockClass
        || Number.isInteger(elementPath.blockIndex)
        || elementPath.pathWithinBlock,
      );
      if (!hasStructuredAnchor && elementPath.selector) {
        return {
          ...elementPath,
          legacy: true,
        };
      }
      return elementPath;
    }
    try {
      const parsed = JSON.parse(elementPath);
      if (parsed && typeof parsed === 'object') {
        const hasStructuredAnchor = Boolean(
          parsed.sectionDaaLh
          || Number.isInteger(parsed.sectionIndex)
          || parsed.blockDaaLh
          || parsed.blockClass
          || Number.isInteger(parsed.blockIndex)
          || parsed.pathWithinBlock,
        );
        if (!hasStructuredAnchor && parsed.selector) {
          return {
            ...parsed,
            legacy: true,
          };
        }
        return parsed;
      }
    } catch (error) {
      // Ignore legacy plain-selector paths.
    }
    return {
      legacy: true,
      selector: elementPath,
    };
  }

  function getCommentElementPathKey(elementPath) {
    const descriptor = parseCommentElementPath(elementPath);
    if (!descriptor) return '';
    if (descriptor.legacy) return `legacy:${descriptor.selector || ''}`;
    return [
      descriptor.sectionDaaLh || '',
      descriptor.sectionIndex ?? '',
      descriptor.blockDaaLh || '',
      descriptor.blockClass || '',
      descriptor.blockIndex ?? '',
      descriptor.pathWithinBlock || '',
      descriptor.tag || '',
      descriptor.id || '',
      descriptor.href || '',
      descriptor.src || '',
      descriptor.alt || '',
      descriptor.title || '',
      descriptor.ariaLabel || '',
    ].join('|');
  }

  function getReviewId() {
    const streamConfigReviewId = window.streamConfig?.reviewId;
    if (streamConfigReviewId !== null && streamConfigReviewId !== undefined && `${streamConfigReviewId}`.trim()) {
      return `${streamConfigReviewId}`.trim();
    }

    const params = new URLSearchParams(window.location.search);
    const urlReviewId = params.get('reviewId') || params.get('reviewid');
    if (urlReviewId && urlReviewId.trim()) return urlReviewId.trim();

    return 'default-review';
  }

  function parseAnnotationPayload(parsed) {
    const easyEditsPayload = parsed?.easyEdits || parsed?.['easy-edits'];
    const easyEdits = Array.isArray(easyEditsPayload)
      ? easyEditsPayload
        .filter((edit) => edit && typeof edit === 'object')
        .map((edit) => ({
          id: edit.id || generateId('easy-edit'),
          editType: edit.editType || 'text',
          attrName: edit.attrName || '',
          elementPath: edit.elementPath || '',
          elementRef: edit.elementRef || '',
          from: `${edit.from || ''}`,
          to: `${edit.to || ''}`,
          fromHtml: `${edit.fromHtml || ''}`,
          toHtml: `${edit.toHtml || ''}`,
          changedFrom: `${edit.changedFrom || ''}`,
          changedTo: `${edit.changedTo || ''}`,
          updatedAt: edit.updatedAt || new Date().toISOString(),
        }))
      : [];

    return {
      threads: [],
      easyEdits,
    };
  }

  function loadAnnotationStore() {
    try {
      const reviewId = getReviewId();
      const raw = window.localStorage.getItem(ANNOTATION_STORE_KEY);
      if (!raw) {
        annotationState.store = { threads: [], easyEdits: [] };
        return;
      }
      const parsed = JSON.parse(raw) || {};

      if (reviewId && typeof parsed === 'object' && !Array.isArray(parsed) && parsed[reviewId]) {
        annotationState.store = parseAnnotationPayload(parsed[reviewId]);
        return;
      }

      annotationState.store = parseAnnotationPayload(parsed);
    } catch (error) {
      annotationState.store = { threads: [], easyEdits: [] };
    }
  }

  function saveAnnotationStore() {
    const payload = {
      easyEdits: annotationState.store.easyEdits,
      'easy-edits': annotationState.store.easyEdits,
    };
    const reviewId = getReviewId();
    let existingMap = {};
    try {
      existingMap = JSON.parse(window.localStorage.getItem(ANNOTATION_STORE_KEY) || '{}') || {};
      if (Array.isArray(existingMap) || typeof existingMap !== 'object') existingMap = {};
    } catch (error) {
      existingMap = {};
    }

    existingMap[reviewId] = payload;

    const serialized = JSON.stringify(existingMap);
    window.localStorage.setItem(ANNOTATION_STORE_KEY, serialized);
    window.streamAnnotationComments = existingMap;
  }

  function replaceFirstOccurrence(source, fromValue, toValue) {
    const haystack = `${source || ''}`;
    const needle = `${fromValue || ''}`;
    if (!needle) return haystack;
    const index = haystack.indexOf(needle);
    if (index === -1) return haystack;
    return `${haystack.slice(0, index)}${toValue || ''}${haystack.slice(index + needle.length)}`;
  }

  function escapeRegExp(value) {
    return `${value || ''}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function applyEasyEditsToHtmlString(html, easyEdits = []) {
    let updatedHtml = `${html || ''}`;
    easyEdits.forEach((edit) => {
      if (!edit || typeof edit !== 'object') return;

      if (edit.editType === 'image-alt') {
        const fromAlt = `${edit.from || ''}`;
        const toAlt = `${edit.to || ''}`;
        if (!fromAlt) return;
        const escapedFromAlt = escapeRegExp(fromAlt);
        const doubleQuoteAlt = new RegExp(`alt="${escapedFromAlt}"`);
        const singleQuoteAlt = new RegExp(`alt='${escapedFromAlt}'`);
        if (doubleQuoteAlt.test(updatedHtml)) {
          updatedHtml = updatedHtml.replace(doubleQuoteAlt, `alt="${toAlt}"`);
        } else if (singleQuoteAlt.test(updatedHtml)) {
          updatedHtml = updatedHtml.replace(singleQuoteAlt, `alt='${toAlt}'`);
        }
        return;
      }

      const fromHtml = `${edit.fromHtml || ''}`;
      const toHtml = `${edit.toHtml || ''}`;
      const fromText = `${edit.from || ''}`;
      const toText = `${edit.to || ''}`;

      if (fromHtml) {
        updatedHtml = replaceFirstOccurrence(updatedHtml, fromHtml, toHtml || fromHtml);
        return;
      }
      if (fromText) {
        updatedHtml = replaceFirstOccurrence(updatedHtml, fromText, toText);
      }
    });
    return updatedHtml;
  }

  function getStoredAnnotationPayload() {
    try {
      const reviewId = getReviewId();
      const raw = window.localStorage.getItem(ANNOTATION_STORE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) || {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed[reviewId]) {
        return parseAnnotationPayload(parsed[reviewId]);
      }
      return parseAnnotationPayload(parsed);
    } catch {
      return null;
    }
  }

  function getThreadType(thread) {
    return thread?.threadType || 'comment';
  }

  function buildElementPath(element, root = annotationUI.mainEl) {
    const segments = [];
    let current = element;

    while (current && current !== root) {
      if (!current.parentElement) break;
      const tag = current.tagName.toLowerCase();
      const siblings = [];
      const currentTagName = current.tagName;
      const children = Array.from(current.parentElement.children);
      for (let idx = 0; idx < children.length; idx += 1) {
        const child = children[idx];
        if (child.tagName === currentTagName) siblings.push(child);
      }
      const index = siblings.indexOf(current);
      segments.unshift(`${tag}:nth-of-type(${index + 1})`);
      current = current.parentElement;
    }

    return `main > ${segments.join(' > ')}`;
  }

  function buildRelativeElementPath(element, root) {
    if (!element || !root) return '';
    if (element === root) return ':scope';

    const segments = [];
    let current = element;

    while (current && current !== root) {
      if (!current.parentElement) break;
      const tag = current.tagName.toLowerCase();
      const siblings = [];
      const children = Array.from(current.parentElement.children);
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (child.tagName === current.tagName) siblings.push(child);
      }
      const siblingIndex = siblings.indexOf(current);
      segments.unshift(`${tag}:nth-of-type(${siblingIndex + 1})`);
      current = current.parentElement;
    }

    return segments.join(' > ') || ':scope';
  }

  function getDirectSectionChildren(root) {
    if (!(root instanceof HTMLElement)) return [];
    return Array.from(root.children).filter((child) => (
      child instanceof HTMLElement && child.classList.contains('section')
    ));
  }

  function getCommentAnchorContext(element, root = annotationUI.mainEl) {
    if (!(element instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;

    const section = element.closest('.section');
    if (!(section instanceof HTMLElement) || !root.contains(section)) return null;

    let block = element;
    while (
      block
      && block.parentElement
      && block.parentElement !== section
    ) {
      block = block.parentElement;
    }
    if (!(block instanceof HTMLElement)) return null;

    const sections = getDirectSectionChildren(root);
    const sectionIndex = sections.indexOf(section);
    const blockChildren = Array.from(section.children)
      .filter((child) => child instanceof HTMLElement);
    const blockIndex = blockChildren.indexOf(block);
    const blockClass = Array.from(block.classList || []).find(Boolean) || '';

    return {
      section,
      block,
      sectionDaaLh: section.getAttribute('daa-lh') || '',
      sectionIndex: sectionIndex > -1 ? sectionIndex : null,
      blockDaaLh: block.getAttribute('daa-lh') || '',
      blockClass,
      blockIndex: blockIndex > -1 ? blockIndex : null,
    };
  }

  function buildCommentElementPath(element, root = annotationUI.mainEl) {
    const selector = buildElementPath(element, root);
    const context = getCommentAnchorContext(element, root);
    if (!context) {
      return JSON.stringify({
        selector,
        ...getCommentElementDescriptor(element),
      });
    }

    return JSON.stringify({
      selector,
      sectionDaaLh: context.sectionDaaLh,
      sectionIndex: context.sectionIndex,
      blockDaaLh: context.blockDaaLh,
      blockClass: context.blockClass,
      blockIndex: context.blockIndex,
      pathWithinBlock: buildRelativeElementPath(element, context.block),
      ...getCommentElementDescriptor(element),
    });
  }

  function buildThreadElementPath(element, root = annotationUI.mainEl) {
    return buildCommentElementPath(element, root);
  }

  function ensureElementRef(element) {
    if (!element.dataset.annotationRef) {
      element.dataset.annotationRef = generateId('el');
    }
    return element.dataset.annotationRef;
  }

  function getElementByRef(elementRef) {
    if (!annotationUI.mainEl || !elementRef) return null;
    return annotationUI.mainEl.querySelector(`[data-annotation-ref="${elementRef}"]`);
  }

  function getMainRelativeSelector(selector) {
    const value = `${selector || ''}`.trim();
    if (!value) return '';
    if (value === 'main') return '';
    if (value.startsWith('main > ')) return value.slice('main > '.length);
    return value;
  }

  function getRelativeSelector(selector) {
    const value = `${selector || ''}`.trim();
    if (!value || value === ':scope') return '';
    if (value.startsWith(':scope > ')) return value.slice(':scope > '.length);
    if (value.startsWith(':scope')) return value.slice(':scope'.length).trim();
    return value;
  }

  function getCommentBlockFromDescriptor(descriptor) {
    if (!annotationUI.mainEl || !descriptor || descriptor.legacy) return null;

    let section = null;
    if (descriptor.sectionDaaLh) {
      section = getDirectSectionChildren(annotationUI.mainEl).find((child) => (
        child.getAttribute('daa-lh') === descriptor.sectionDaaLh
      )) || null;
    }
    if (!(section instanceof HTMLElement) && Number.isInteger(descriptor.sectionIndex)) {
      const sections = getDirectSectionChildren(annotationUI.mainEl);
      section = sections[descriptor.sectionIndex] || null;
    }
    if (!(section instanceof HTMLElement)) return null;

    let block = null;
    if (descriptor.blockDaaLh) {
      block = Array.from(section.children).find((child) => (
        child instanceof HTMLElement && child.getAttribute('daa-lh') === descriptor.blockDaaLh
      )) || null;
    }
    if (!(block instanceof HTMLElement) && Number.isInteger(descriptor.blockIndex)) {
      const blockChildren = Array.from(section.children)
        .filter((child) => child instanceof HTMLElement);
      const candidate = blockChildren[descriptor.blockIndex] || null;
      if (candidate instanceof HTMLElement) {
        block = candidate;
      }
    }
    if (!(block instanceof HTMLElement) && descriptor.blockClass) {
      block = Array.from(section.children).find((child) => (
        child instanceof HTMLElement && child.classList.contains(descriptor.blockClass)
      )) || null;
    }
    return block instanceof HTMLElement ? block : null;
  }

  function getElementByCommentPath(elementPath) {
    if (!annotationUI.mainEl || !elementPath) return null;
    const descriptor = parseCommentElementPath(elementPath);
    if (!descriptor) return null;

    if (!descriptor.legacy) {
      const block = getCommentBlockFromDescriptor(descriptor);
      if (!block) return null;

      const selector = getRelativeSelector(descriptor.pathWithinBlock);
      const candidates = !selector
        ? [block]
        : Array.from(block.querySelectorAll(selector));

      const exactMatch = candidates.find((candidate) => {
        if (!(candidate instanceof HTMLElement)) return false;
        const candidateDescriptor = getCommentElementDescriptor(candidate);
        if (descriptor.tag && candidateDescriptor.tag !== descriptor.tag) return false;
        if (descriptor.id && candidateDescriptor.id !== descriptor.id) return false;
        if (descriptor.href && candidateDescriptor.href !== descriptor.href) return false;
        if (descriptor.src && candidateDescriptor.src !== descriptor.src) return false;
        if (descriptor.alt && candidateDescriptor.alt !== descriptor.alt) return false;
        if (descriptor.title && candidateDescriptor.title !== descriptor.title) return false;
        if (
          descriptor.ariaLabel
          && candidateDescriptor.ariaLabel !== descriptor.ariaLabel
        ) return false;
        return true;
      });

      if (exactMatch instanceof HTMLElement) return exactMatch;
      if (candidates.length === 1 && descriptor.tag) {
        return candidates[0];
      }
      if (descriptor.selector) {
        return getElementByCommentPath({
          ...descriptor,
          legacy: true,
        });
      }
      return null;
    }

    if (!descriptor.selector) return null;

    const candidates = Array.from(
      annotationUI.mainEl.querySelectorAll(getMainRelativeSelector(descriptor.selector)),
    );
    const exactMatch = candidates.find((candidate) => {
      if (!(candidate instanceof HTMLElement)) return false;
      const candidateDescriptor = getCommentElementDescriptor(candidate);
      if (descriptor.tag && candidateDescriptor.tag !== descriptor.tag) return false;
      if (descriptor.id && candidateDescriptor.id !== descriptor.id) return false;
      if (descriptor.href && candidateDescriptor.href !== descriptor.href) return false;
      if (descriptor.src && candidateDescriptor.src !== descriptor.src) return false;
      if (descriptor.alt && candidateDescriptor.alt !== descriptor.alt) return false;
      if (descriptor.title && candidateDescriptor.title !== descriptor.title) return false;
      if (
        descriptor.ariaLabel
        && candidateDescriptor.ariaLabel !== descriptor.ariaLabel
      ) return false;
      return true;
    });

    if (exactMatch instanceof HTMLElement) return exactMatch;
    if (descriptor.legacy && candidates[0] instanceof HTMLElement) return candidates[0];
    if (candidates.length === 1 && descriptor.tag) {
      return candidates[0];
    }
    return null;
  }

  function getElementByThreadPath(elementPath) {
    return getElementByCommentPath(elementPath);
  }

  function getElementForThread(thread) {
    if (!thread) return null;
    if (thread.elementPath) {
      const byPath = getElementByThreadPath(thread.elementPath);
      if (byPath) return byPath;
    }
    return getElementByRef(thread.elementRef);
  }

  function rebindThreadsToCurrentDom() {
    if (!annotationUI.mainEl) return;

    annotationState.store.threads.forEach((thread) => {
      const target = getElementForThread(thread);
      if (!(target instanceof HTMLElement)) return;
      thread.elementRef = ensureElementRef(target);
    });
  }

  function getThreadByElementRef(elementRef, threadType = null) {
    return annotationState.store.threads.find((thread) => thread.elementRef === elementRef
      && (!threadType || getThreadType(thread) === threadType));
  }

  function getThreadByElementPath(elementPath, threadType = null) {
    return annotationState.store.threads.find((thread) => (
      (!threadType || getThreadType(thread) === threadType)
        && getCommentElementPathKey(thread.elementPath) === getCommentElementPathKey(elementPath)
    ));
  }

  function getCommentThreadByElementPath(elementPath) {
    return getThreadByElementPath(elementPath, 'comment');
  }

  function getEditThreadByElementPath(elementPath) {
    return getThreadByElementPath(elementPath, 'edit');
  }

  function getCommentThreadByElement(element) {
    if (!(element instanceof HTMLElement)) return null;
    const exactPath = buildThreadElementPath(element, annotationUI.mainEl);
    const exactThread = getCommentThreadByElementPath(exactPath);
    if (exactThread) return exactThread;

    return annotationState.store.threads.find((thread) => (
      getThreadType(thread) === 'comment' && getElementByThreadPath(thread.elementPath) === element
    ));
  }

  function getEditThreadByElement(element) {
    if (!(element instanceof HTMLElement)) return null;
    const exactPath = buildThreadElementPath(element, annotationUI.mainEl);
    const exactThread = getEditThreadByElementPath(exactPath);
    if (exactThread) return exactThread;

    return annotationState.store.threads.find((thread) => (
      getThreadType(thread) === 'edit' && getElementByThreadPath(thread.elementPath) === element
    ));
  }

  function getThreadById(threadId) {
    return annotationState.store.threads.find((thread) => thread.id === threadId);
  }

  function replaceThreadsByType(threadType, nextThreads = []) {
    const preservedThreads = annotationState.store.threads.filter(
      (thread) => getThreadType(thread) !== threadType,
    );
    annotationState.store.threads = [
      ...preservedThreads,
      ...nextThreads.map((thread) => ({
        ...thread,
        threadType: thread.threadType || threadType,
        status: normalizeCommentStatus(thread.status),
        messages: Array.isArray(thread.messages) ? thread.messages : [],
      })),
    ];
  }

  function upsertThread(nextThread) {
    if (!nextThread?.id) return;
    const normalizedThread = {
      ...nextThread,
      threadType: nextThread.threadType || getThreadType(nextThread),
      status: normalizeCommentStatus(nextThread.status),
      messages: Array.isArray(nextThread.messages) ? nextThread.messages : [],
    };
    const existingIndex = annotationState.store.threads.findIndex(
      (thread) => thread.id === normalizedThread.id,
    );
    if (existingIndex > -1) {
      annotationState.store.threads[existingIndex] = normalizedThread;
      return;
    }
    annotationState.store.threads.push(normalizedThread);
  }

  function removeThread(threadId) {
    if (!threadId) return;
    annotationState.store.threads = annotationState.store.threads.filter(
      (thread) => thread.id !== threadId,
    );
  }

  function removeThreadMessage(threadId, messageId) {
    if (!threadId || !messageId) return;
    const thread = getThreadById(threadId);
    if (!thread) return;
    thread.messages = (thread.messages || []).filter((message) => message.id !== messageId);
  }

  function clearSelectedElement() {
    if (annotationState.selectedElement) {
      annotationState.selectedElement.classList.remove('annotation-selected-element');
    }
    annotationState.selectedElement = null;
    annotationState.selectedElementPath = '';
    annotationState.selectedElementRef = '';
  }

  function getEasyEditByElement(elementRef, elementPath) {
    return annotationState.store.easyEdits.find((edit) => (
      (elementRef && edit.elementRef === elementRef)
      || (elementPath && edit.elementPath === elementPath)
    ));
  }

  function upsertEasyEdit(editRecord) {
    const index = annotationState.store.easyEdits.findIndex((edit) => (
      edit.elementRef === editRecord.elementRef
        || (edit.elementPath && edit.elementPath === editRecord.elementPath)
    ));
    if (index > -1) {
      annotationState.store.easyEdits[index] = {
        ...annotationState.store.easyEdits[index],
        ...editRecord,
      };
      return;
    }
    annotationState.store.easyEdits.push(editRecord);
  }

  function getChangedSegments(fromText, toText) {
    const fromValue = `${fromText || ''}`;
    const toValue = `${toText || ''}`;
    let prefix = 0;
    while (
      prefix < fromValue.length
      && prefix < toValue.length
      && fromValue[prefix] === toValue[prefix]
    ) {
      prefix += 1;
    }

    let fromSuffixIndex = fromValue.length - 1;
    let toSuffixIndex = toValue.length - 1;
    while (
      fromSuffixIndex >= prefix
      && toSuffixIndex >= prefix
      && fromValue[fromSuffixIndex] === toValue[toSuffixIndex]
    ) {
      fromSuffixIndex -= 1;
      toSuffixIndex -= 1;
    }

    return {
      changedFrom: fromValue.slice(prefix, fromSuffixIndex + 1),
      changedTo: toValue.slice(prefix, toSuffixIndex + 1),
    };
  }

  function removeEasyEditHighlights(root = annotationUI.mainEl) {
    if (!(root instanceof HTMLElement)) return;
    root.querySelectorAll('.annotation-easy-edit-changed').forEach((element) => {
      if (!(element instanceof HTMLElement)) return;
      element.classList.remove('annotation-easy-edit-changed');
    });
  }

  function truncateInlineEditText(text, max = 80) {
    const value = `${text || ''}`.replace(/\s+/g, ' ').trim();
    if (value.length <= max) return value || '""';
    return `${value.slice(0, max)}...`;
  }

  function getEditPanelMessage(edit) {
    if (edit.editType === 'image-alt') {
      return `changed alt "${truncateInlineEditText(edit.from, 40)}" -> "${truncateInlineEditText(edit.to, 40)}"`;
    }
    return `changed "${truncateInlineEditText(edit.from)}" -> "${truncateInlineEditText(edit.to)}"`;
  }

  function pushThreadMessage(thread, text, kind = 'reply') {
    thread.messages = thread.messages || [];
    thread.messages.push({
      id: generateId('message'),
      username: DEFAULT_USERNAME,
      text,
      kind,
    });
  }

  function recordEditMessage(elementRef, elementPath, text) {
    let thread = getEditThreadByElementPath(elementPath);
    if (!thread && elementRef) {
      thread = getThreadByElementRef(elementRef, 'edit');
    }
    if (!thread) {
      thread = {
        id: generateId('thread'),
        threadType: 'edit',
        elementRef,
        elementPath,
        status: COMMENT_STATUSES[0],
        username: DEFAULT_USERNAME,
        messages: [],
      };
      annotationState.store.threads.push(thread);
    }

    const existingMessages = thread.messages || [];
    const kind = existingMessages.length ? 'reply' : 'comment';
    pushThreadMessage(thread, text, kind);
    annotationState.activeThreadId = thread.id;
    annotationState.activeMessageId = '';
    annotationState.activeEditId = '';
  }

  function getElementForEdit(edit) {
    if (!annotationUI.mainEl) return null;
    if (edit.elementRef) {
      const byRef = getElementByRef(edit.elementRef);
      if (byRef) return byRef;
    }
    if (!edit.elementPath) return null;
    const byPath = annotationUI.mainEl.querySelector(edit.elementPath);
    return byPath instanceof HTMLElement ? byPath : null;
  }

  function rebindEasyEditsToCurrentDom() {
    if (!annotationUI.mainEl) return;
    annotationState.store.easyEdits.forEach((edit) => {
      const target = getElementForEdit(edit);
      if (!(target instanceof HTMLElement)) return;
      edit.elementRef = ensureElementRef(target);
      if (!edit.elementPath) {
        edit.elementPath = buildElementPath(target, annotationUI.mainEl);
      }
    });
  }

  function applyEasyEditsToDom() {
    if (!annotationUI.mainEl) return;
    removeEasyEditHighlights(annotationUI.mainEl);

    annotationState.store.easyEdits.forEach((edit) => {
      const target = getElementForEdit(edit);
      if (!(target instanceof HTMLElement)) return;

      if (edit.editType === 'image-alt') {
        target.setAttribute('alt', edit.to || '');
        return;
      }

      if (edit.toHtml) {
        if (target.innerHTML !== edit.toHtml) {
          target.innerHTML = edit.toHtml;
        }
        return;
      }

      const currentText = target.textContent || '';
      if (edit.from && currentText.includes(edit.from)) {
        target.textContent = currentText.replace(edit.from, edit.to);
      } else if (edit.to) {
        target.textContent = edit.to;
      }
    });
  }

  return {
    applyEasyEditsToDom,
    applyEasyEditsToHtmlString,
    buildElementPath,
    buildCommentElementPath,
    buildThreadElementPath,
    clearSelectedElement,
    ensureElementRef,
    generateId,
    getChangedSegments,
    getCommentThreadByElement,
    getCommentThreadByElementPath,
    getEditThreadByElement,
    getEditThreadByElementPath,
    getEditPanelMessage,
    getElementByCommentPath,
    getElementByThreadPath,
    getEasyEditByElement,
    getElementByRef,
    getElementForThread,
    getStoredAnnotationPayload,
    getThreadByElementPath,
    getThreadByElementRef,
    getThreadById,
    getThreadType,
    loadAnnotationStore,
    normalizeCommentStatus,
    pushThreadMessage,
    recordEditMessage,
    rebindEasyEditsToCurrentDom,
    rebindThreadsToCurrentDom,
    removeThread,
    removeThreadMessage,
    replaceThreadsByType,
    removeEasyEditHighlights,
    saveAnnotationStore,
    upsertThread,
    upsertEasyEdit,
  };
}
