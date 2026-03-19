import createAnnotationServiceClient from './service.js';
import createDaCollabClient from './da-collab.js';
import { createDaProsemirrorBridge } from './da-prosemirror.js';
import { getDACompatibleDocumentHtml } from '../../target/da.js';
import { ANNOTATION_MESSAGES } from '../../utils/constants.js';
import { hideGlobalSnackbar, showGlobalSnackbar } from '../../utils/snackbar.js';
import { fetchDAContent } from '../../sources/da.js';

const MEDIUM_EDITOR_CSS_URL = 'https://cdn.jsdelivr.net/npm/medium-editor@5.23.3/dist/css/medium-editor.min.css';
const MEDIUM_EDITOR_THEME_CSS_URL = 'https://cdn.jsdelivr.net/npm/medium-editor@5.23.3/dist/css/themes/default.min.css';
const MEDIUM_EDITOR_JS_URL = 'https://cdn.jsdelivr.net/npm/medium-editor@5.23.3/dist/js/medium-editor.min.js';

function parseBooleanFlag(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function isRealtimeAnnotationEditingEnabled() {
  const explicitFlag = parseBooleanFlag(window.streamConfig?.realtimeAnnotationEditing);
  return explicitFlag !== false;
}

function getPlainTextFromHtml(html) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `${html || ''}`;
  return wrapper.textContent || '';
}

function isSharedTextLike(value) {
  return Boolean(
    value
    && typeof value.insert === 'function'
    && typeof value.delete === 'function'
    && typeof value.observe === 'function'
    && typeof value.unobserve === 'function'
    && typeof value.toString === 'function',
  );
}

function isSharedMapLike(value) {
  return Boolean(
    value
    && typeof value.get === 'function'
    && typeof value.set === 'function',
  );
}

function normalizeTargetLocator(threadElementPath, fallbackPath = '') {
  if (!threadElementPath) return `${fallbackPath || ''}`;
  if (typeof threadElementPath === 'object') {
    return JSON.stringify({
      selector: threadElementPath.selector || '',
      sectionDaaLh: threadElementPath.sectionDaaLh || '',
      sectionIndex: threadElementPath.sectionIndex ?? null,
      blockDaaLh: threadElementPath.blockDaaLh || '',
      blockClass: threadElementPath.blockClass || '',
      blockIndex: threadElementPath.blockIndex ?? null,
      pathWithinBlock: threadElementPath.pathWithinBlock || '',
      tag: threadElementPath.tag || '',
      id: threadElementPath.id || '',
    });
  }

  try {
    return normalizeTargetLocator(JSON.parse(threadElementPath), fallbackPath);
  } catch (error) {
    return `${threadElementPath || fallbackPath || ''}`;
  }
}

export default function createInlineEditingController({
  annotationState,
  annotationUI,
  store,
  renderThreadMarkers,
  renderCommentsPanel,
  removePopup,
}) {
  const annotationService = createAnnotationServiceClient();
  const isInlineEditingAllowed = () => window.streamConfig?.inlineEditingAllowed !== false;
  let realtimeSyncRefreshTimeoutId = 0;

  async function ensureDaSourceHtmlBase() {
    if (annotationState.daSourceHtmlBase) return annotationState.daSourceHtmlBase;

    try {
      const mainEl = await fetchDAContent(window.streamConfig?.contentUrl);
      annotationState.daSourceHtmlBase = mainEl?.innerHTML || '';
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('Could not load DA-compatible base HTML for realtime prose sync', error);
      annotationState.daSourceHtmlBase = '';
    }

    return annotationState.daSourceHtmlBase;
  }

  async function ensureDaProsemirrorBridge() {
    if (annotationState.daProsemirrorBridge) return annotationState.daProsemirrorBridge;
    const doc = annotationState.daCollabClient?.getDoc?.();
    if (!doc) return null;

    try {
      annotationState.daProsemirrorBridge = await createDaProsemirrorBridge(doc);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('Could not initialize DA prose bridge', error);
      annotationState.daProsemirrorBridge = null;
    }

    return annotationState.daProsemirrorBridge;
  }

  function scheduleDaLiveMirror() {
    if (!isInlineEditingAllowed()) return;
    if (!annotationState.daCollabClient?.isReady()) return;

    if (annotationState.daMirrorTimeoutId) {
      window.clearTimeout(annotationState.daMirrorTimeoutId);
    }

    annotationState.daMirrorTimeoutId = window.setTimeout(async () => {
      annotationState.daMirrorTimeoutId = 0;

      if (annotationState.daMirrorInFlight) {
        annotationState.daMirrorQueued = true;
        return;
      }

      annotationState.daMirrorInFlight = true;
      try {
        const baseHtml = await ensureDaSourceHtmlBase();
        if (!baseHtml) return;
        const bridge = await ensureDaProsemirrorBridge();
        if (!bridge) return;

        // eslint-disable-next-line no-use-before-define
        const easyEdits = buildRealtimeEasyEdits();
        const nextPreviewCompatibleHtml = store.applyEasyEditsToHtmlString(baseHtml, easyEdits);
        const nextDaDocumentHtml = getDACompatibleDocumentHtml(nextPreviewCompatibleHtml);
        if (
          !nextDaDocumentHtml
          || nextDaDocumentHtml === annotationState.daLastMirroredHtml
        ) return;

        const didApply = bridge.replaceDocumentHtml(nextDaDocumentHtml);
        if (didApply) {
          annotationState.daLastMirroredHtml = nextDaDocumentHtml;
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('Could not mirror realtime edits into DA live doc', error);
      } finally {
        annotationState.daMirrorInFlight = false;
        if (annotationState.daMirrorQueued) {
          annotationState.daMirrorQueued = false;
          scheduleDaLiveMirror();
        }
      }
    }, 400);
  }

  async function loadMediumEditor() {
    if (window.MediumEditor) return window.MediumEditor;
    if (annotationState.mediumEditorLoadPromise) {
      await annotationState.mediumEditorLoadPromise;
      return window.MediumEditor;
    }

    [
      ['css', MEDIUM_EDITOR_CSS_URL],
      ['theme-css', MEDIUM_EDITOR_THEME_CSS_URL],
    ].forEach(([key, href]) => {
      if (document.querySelector(`link[data-medium-editor="${key}"]`)) return;
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = href;
      css.dataset.mediumEditor = key;
      document.head.appendChild(css);
    });

    annotationState.mediumEditorLoadPromise = new Promise((resolve, reject) => {
      const existingScript = document.querySelector('script[data-medium-editor="js"]');
      if (existingScript) {
        existingScript.addEventListener('load', () => resolve(window.MediumEditor), { once: true });
        existingScript.addEventListener('error', () => reject(new Error('Failed to load MediumEditor')), { once: true });
        if (window.MediumEditor) resolve(window.MediumEditor);
        return;
      }

      const script = document.createElement('script');
      script.src = MEDIUM_EDITOR_JS_URL;
      script.dataset.mediumEditor = 'js';
      script.onload = () => resolve(window.MediumEditor);
      script.onerror = () => reject(new Error('Failed to load MediumEditor'));
      document.head.appendChild(script);
    }).catch((error) => {
      annotationState.mediumEditorLoadPromise = null;
      throw error;
    });

    await annotationState.mediumEditorLoadPromise;
    return window.MediumEditor;
  }

  async function ensureOverlayMediumEditor() {
    if (!(annotationUI.inlineEditorSurfaceEl instanceof HTMLElement)) return null;
    if (annotationUI.mediumEditorInstance) return annotationUI.mediumEditorInstance;

    try {
      const MediumEditor = await loadMediumEditor();
      if (!MediumEditor) return null;

      annotationUI.mediumEditorInstance = new MediumEditor(annotationUI.inlineEditorSurfaceEl, {
        toolbar: {
          buttons: ['bold', 'italic', 'underline', 'anchor', 'h2', 'h3', 'quote'],
          static: true,
          sticky: false,
          align: 'left',
        },
        placeholder: {
          text: 'Start editing...',
          hideOnClick: true,
        },
        targetBlank: true,
        autoLink: true,
        paste: {
          cleanPastedHTML: true,
          cleanAttrs: ['style', 'dir'],
          cleanTags: ['label', 'meta', 'script', 'style'],
        },
      });

      return annotationUI.mediumEditorInstance;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('Could not load MediumEditor for realtime annotation editing', error);
      return null;
    }
  }

  function destroyOverlayMediumEditor() {
    if (!annotationUI.mediumEditorInstance) return;
    annotationUI.mediumEditorInstance.destroy();
    annotationUI.mediumEditorInstance = null;
  }

  function updateInlineEditAvailabilityState(isAvailable, description = '') {
    if (!annotationUI.inlineToggleEl) return;
    if (!isInlineEditingAllowed()) return;

    const editLabel = annotationUI.panelEl?.querySelector('label[for="annotation-inline-mode-edit"]');
    annotationUI.inlineToggleEl.disabled = !isAvailable;
    annotationUI.inlineToggleEl.setAttribute('aria-disabled', `${!isAvailable}`);

    if (editLabel instanceof HTMLElement) {
      if (description) {
        editLabel.title = description;
        editLabel.setAttribute('aria-label', description);
      } else {
        editLabel.removeAttribute('title');
        editLabel.removeAttribute('aria-label');
      }
    }
  }

  function getInlineEditableElements() {
    if (!annotationUI.mainEl) return [];
    const selectors = [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'li', 'blockquote', 'figcaption',
      '[class*="heading"]', '[class*="title"]', '[class*="description"]',
    ];
    return Array.from(annotationUI.mainEl.querySelectorAll(selectors.join(', ')))
      .filter((el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (!el.textContent || !el.textContent.trim()) return false;
        if (el.closest('.annotation-comments-panel') || el.closest('.annotation-floating-popup')) return false;
        return true;
      });
  }

  function getInlineEditableImages() {
    if (!annotationUI.mainEl) return [];
    return Array.from(annotationUI.mainEl.querySelectorAll('img'))
      .filter((el) => {
        if (!(el instanceof HTMLImageElement)) return false;
        if (el.closest('.annotation-comments-panel') || el.closest('.annotation-floating-popup')) return false;
        return true;
      });
  }

  function buildTargetKey(targetType, threadElementPath) {
    const serializedPath = normalizeTargetLocator(threadElementPath);
    return `${targetType}:${serializedPath}`;
  }

  function getDescriptorByElement(element, targetType = null) {
    if (!(element instanceof HTMLElement)) return null;
    return Array.from(annotationState.realtimeTargetRegistry.values())
      .find((descriptor) => (
        descriptor.element === element
        && (!targetType || descriptor.targetType === targetType)
      )) || null;
  }

  function getDescriptorCurrentValue(descriptor) {
    if (!(descriptor?.element instanceof HTMLElement)) return '';
    if (descriptor.targetType === 'image-alt') {
      return descriptor.element.getAttribute('alt') || '';
    }
    return descriptor.element.innerHTML;
  }

  function applyValueToDescriptor(descriptor, nextValue) {
    if (!(descriptor?.element instanceof HTMLElement)) return;
    const value = `${nextValue || ''}`;
    if (descriptor.targetType === 'image-alt') {
      descriptor.element.setAttribute('alt', value);
      return;
    }
    if (descriptor.element.innerHTML !== value) {
      descriptor.element.innerHTML = value;
    }
  }

  function syncDescriptorToSharedState(descriptor) {
    if (!descriptor) return;
    if (annotationState.realtimeApplyingTargetKeys.has(descriptor.targetKey)) return;

    const nextValue = getDescriptorCurrentValue(descriptor);
    applyValueToDescriptor(descriptor, nextValue);
    // eslint-disable-next-line no-use-before-define
    updateSharedTargetValue(descriptor, nextValue);
    annotationState.realtimeDirtyTargetKeys.add(descriptor.targetKey);
    // eslint-disable-next-line no-use-before-define
    buildRealtimeEasyEdits();
    store.saveAnnotationStore();
    renderThreadMarkers({ resolveTargets: true });
    renderCommentsPanel();
  }

  function createTargetDescriptor(element, targetType, existingDescriptor = null) {
    const elementRef = store.ensureElementRef(element);
    const elementPath = store.buildElementPath(element, annotationUI.mainEl);
    const threadElementPath = store.buildThreadElementPath(element, annotationUI.mainEl);
    const targetKey = buildTargetKey(targetType, threadElementPath || elementPath);

    const currentHtml = element instanceof HTMLElement ? element.innerHTML : '';
    const currentAlt = element.getAttribute('alt') || '';

    return {
      targetKey,
      targetType,
      element,
      elementRef,
      elementPath,
      threadElementPath,
      originalHtml: existingDescriptor?.originalHtml ?? currentHtml,
      originalText: existingDescriptor?.originalText ?? getPlainTextFromHtml(currentHtml),
      originalAlt: existingDescriptor?.originalAlt ?? currentAlt,
      lastCommittedValue: existingDescriptor?.lastCommittedValue
        ?? (targetType === 'image-alt' ? currentAlt : currentHtml),
    };
  }

  function refreshTargetRegistry() {
    if (!annotationUI.mainEl) return annotationState.realtimeTargetRegistry;

    const previousRegistry = annotationState.realtimeTargetRegistry;
    const nextRegistry = new Map();

    getInlineEditableElements().forEach((element) => {
      const existingDescriptor = Array.from(previousRegistry.values())
        .find((descriptor) => (
          descriptor.element === element
          || descriptor.elementRef === element.dataset.annotationRef
        ));
      const descriptor = createTargetDescriptor(element, 'text', existingDescriptor);
      nextRegistry.set(descriptor.targetKey, descriptor);
    });

    getInlineEditableImages().forEach((imageElement) => {
      const existingDescriptor = Array.from(previousRegistry.values())
        .find((descriptor) => (
          descriptor.element === imageElement
          || descriptor.elementRef === imageElement.dataset.annotationRef
        ));
      const descriptor = createTargetDescriptor(imageElement, 'image-alt', existingDescriptor);
      nextRegistry.set(descriptor.targetKey, descriptor);
    });

    annotationState.realtimeTargetRegistry = nextRegistry;
    annotationUI.editableElements = Array.from(nextRegistry.values())
      .filter((descriptor) => descriptor.targetType === 'text')
      .map((descriptor) => descriptor.element)
      .filter((element) => element instanceof HTMLElement);
    annotationUI.editableImages = Array.from(nextRegistry.values())
      .filter((descriptor) => descriptor.targetType === 'image-alt')
      .map((descriptor) => descriptor.element)
      .filter((element) => element instanceof HTMLImageElement);

    return nextRegistry;
  }

  function getActiveDescriptor() {
    const targetKey = annotationUI.inlineEditorTargetKey;
    if (!targetKey) return null;
    return annotationState.realtimeTargetRegistry.get(targetKey) || null;
  }

  function updateInlineEditorStatus() {
    if (!(annotationUI.inlineEditorMetaEl instanceof HTMLElement)) return;

    const status = annotationState.daCollabStatus || 'idle';
    let label = 'Live editing unavailable';
    if (status === 'connected') label = ANNOTATION_MESSAGES.realtimeEditConnected;
    if (status === 'connecting') label = ANNOTATION_MESSAGES.realtimeEditConnecting;
    if (status === 'disconnected') label = ANNOTATION_MESSAGES.realtimeEditDisconnected;
    annotationUI.inlineEditorMetaEl.textContent = label;
  }

  async function ensureRealtimeClient() {
    if (!isRealtimeAnnotationEditingEnabled()) {
      return null;
    }

    if (!annotationState.daCollabClient) {
      annotationState.daCollabClient = createDaCollabClient({
        token: window.streamConfig?.token,
        contentUrl: window.streamConfig?.contentUrl,
        displayName: window.streamConfig?.displayName,
        profileId: window.streamConfig?.profileId,
        targetUrl: window.streamConfig?.targetUrl,
      });
      annotationState.daCollabStatusUnsubscribe = annotationState.daCollabClient.onStatusChange(
        ({ status }) => {
          annotationState.daCollabStatus = status;
          updateInlineEditorStatus();
          renderCommentsPanel();
        },
      );
    }

    if (annotationState.daCollabClient.isReady()) {
      // eslint-disable-next-line no-use-before-define
      attachTargetsMapObserver();
      annotationState.realtimeEditingAvailable = true;
      return annotationState.daCollabClient;
    }

    try {
      await annotationState.daCollabClient.connect();
      // eslint-disable-next-line no-use-before-define
      attachTargetsMapObserver();
      annotationState.realtimeEditingAvailable = true;
      updateInlineEditAvailabilityState(true);
      hideGlobalSnackbar();
      return annotationState.daCollabClient;
    } catch (error) {
      annotationState.realtimeEditingAvailable = false;
      updateInlineEditAvailabilityState(
        false,
        ANNOTATION_MESSAGES.realtimeEditUnavailableDescription,
      );
      // eslint-disable-next-line no-console
      console.warn('Could not connect realtime annotation editing', error);
      return null;
    }
  }

  function getRecordContent(record) {
    if (!record) return '';
    const content = record.get('content');
    if (!isSharedTextLike(content)) return '';
    return content.toString();
  }

  function ensureSharedTargetRecord(descriptor) {
    const client = annotationState.daCollabClient;
    const doc = client?.getDoc();
    const targetsMap = client?.getTargetsMap();
    const Y = client?.getYjs();
    if (!doc || !targetsMap || !Y?.Map || !Y?.Text) return null;

    let record = targetsMap.get(descriptor.targetKey);
    if (!isSharedMapLike(record)) {
      doc.transact(() => {
        record = new Y.Map();
        const content = new Y.Text();
        const initialValue = descriptor.targetType === 'image-alt'
          ? descriptor.originalAlt
          : descriptor.originalHtml;
        if (initialValue) content.insert(0, initialValue);
        record.set('type', descriptor.targetType);
        record.set('elementPath', JSON.stringify(descriptor.threadElementPath || descriptor.elementPath || ''));
        record.set('content', content);
        targetsMap.set(descriptor.targetKey, record);
      });
    } else if (!isSharedTextLike(record.get('content'))) {
      doc.transact(() => {
        const content = new Y.Text();
        const initialValue = descriptor.targetType === 'image-alt'
          ? descriptor.originalAlt
          : descriptor.originalHtml;
        if (initialValue) content.insert(0, initialValue);
        record.set('content', content);
      });
    }

    if (!record.get('type')) {
      doc.transact(() => {
        record.set('type', descriptor.targetType);
      });
    }

    return record;
  }

  function updateSharedTargetValue(descriptor, nextValue) {
    const client = annotationState.daCollabClient;
    const doc = client?.getDoc();
    const Y = client?.getYjs();
    const record = ensureSharedTargetRecord(descriptor);
    if (!doc || !Y || !record) return;

    const content = record.get('content');
    if (!isSharedTextLike(content)) return;

    const normalizedValue = `${nextValue || ''}`;
    if (content.toString() === normalizedValue) return;

    doc.transact(() => {
      content.delete(0, content.length);
      if (normalizedValue) {
        content.insert(0, normalizedValue);
      }
    });

    scheduleDaLiveMirror();
  }

  function syncOverlayWithDescriptor(descriptor, nextValue) {
    if (!descriptor || annotationUI.inlineEditorTargetKey !== descriptor.targetKey) return;
    const value = `${nextValue || ''}`;

    if (descriptor.targetType === 'image-alt') {
      if (
        annotationUI.inlineEditorTextareaEl
        && annotationUI.inlineEditorTextareaEl.value !== value
      ) {
        annotationUI.inlineEditorTextareaEl.value = value;
      }
      return;
    }

    if (
      annotationUI.inlineEditorSurfaceEl
      && annotationUI.inlineEditorSurfaceEl.innerHTML !== value
    ) {
      annotationUI.inlineEditorSurfaceEl.innerHTML = value;
    }
  }

  function buildRealtimeEasyEdits() {
    const nextEasyEdits = [];

    annotationState.realtimeTargetRegistry.forEach((descriptor) => {
      const currentValue = getDescriptorCurrentValue(descriptor);

      if (descriptor.targetType === 'image-alt') {
        if (descriptor.originalAlt === currentValue) return;
        nextEasyEdits.push({
          id: `easy-edit-${descriptor.targetKey}`,
          editType: 'image-alt',
          attrName: 'alt',
          elementPath: descriptor.elementPath,
          elementRef: descriptor.elementRef,
          from: descriptor.originalAlt,
          to: currentValue,
          fromHtml: '',
          toHtml: '',
          changedFrom: descriptor.originalAlt,
          changedTo: currentValue,
          updatedAt: new Date().toISOString(),
        });
        return;
      }

      const currentText = getPlainTextFromHtml(currentValue);
      if (descriptor.originalHtml === currentValue) return;

      const changedSegments = store.getChangedSegments(descriptor.originalText, currentText);
      nextEasyEdits.push({
        id: `easy-edit-${descriptor.targetKey}`,
        editType: 'text',
        attrName: '',
        elementPath: descriptor.elementPath,
        elementRef: descriptor.elementRef,
        from: descriptor.originalText,
        to: currentText,
        fromHtml: descriptor.originalHtml,
        toHtml: currentValue,
        changedFrom: changedSegments.changedFrom,
        changedTo: changedSegments.changedTo,
        updatedAt: new Date().toISOString(),
      });
    });

    store.replaceEasyEdits(nextEasyEdits);
    return nextEasyEdits;
  }

  function syncSharedTargetToDom(descriptor) {
    const record = ensureSharedTargetRecord(descriptor);
    if (!record) return;
    const sharedValue = getRecordContent(record);
    annotationState.realtimeApplyingTargetKeys.add(descriptor.targetKey);
    try {
      applyValueToDescriptor(descriptor, sharedValue);
      syncOverlayWithDescriptor(descriptor, sharedValue);
    } finally {
      window.setTimeout(() => {
        annotationState.realtimeApplyingTargetKeys.delete(descriptor.targetKey);
      }, 0);
    }
  }

  function detachTargetObserver(targetKey) {
    const unsubscribe = annotationState.realtimeTargetObservers.get(targetKey);
    if (!unsubscribe) return;
    unsubscribe();
    annotationState.realtimeTargetObservers.delete(targetKey);
  }

  function attachTargetObserver(descriptor) {
    const client = annotationState.daCollabClient;
    const Y = client?.getYjs();
    const record = ensureSharedTargetRecord(descriptor);
    if (!record || !Y) return;

    detachTargetObserver(descriptor.targetKey);

    const content = record.get('content');
    if (!isSharedTextLike(content)) return;

    const syncCurrentDescriptor = () => {
      const nextDescriptor = annotationState.realtimeTargetRegistry.get(descriptor.targetKey);
      if (!nextDescriptor) return;
      syncSharedTargetToDom(nextDescriptor);
      buildRealtimeEasyEdits();
      store.saveAnnotationStore();
      renderThreadMarkers({ resolveTargets: true });
      renderCommentsPanel();
    };

    content.observe(syncCurrentDescriptor);
    annotationState.realtimeTargetObservers.set(descriptor.targetKey, () => {
      content.unobserve(syncCurrentDescriptor);
    });
  }

  function refreshRealtimeSync() {
    const targetRegistry = refreshTargetRegistry();
    annotationState.realtimeTargetObservers.forEach((_, targetKey) => {
      if (!targetRegistry.has(targetKey)) {
        detachTargetObserver(targetKey);
      }
    });
    targetRegistry.forEach((descriptor) => {
      attachTargetObserver(descriptor);
      syncSharedTargetToDom(descriptor);
    });
    buildRealtimeEasyEdits();
    store.saveAnnotationStore();
  }

  function scheduleRealtimeSyncRefresh() {
    if (realtimeSyncRefreshTimeoutId) {
      window.clearTimeout(realtimeSyncRefreshTimeoutId);
    }

    realtimeSyncRefreshTimeoutId = window.setTimeout(() => {
      realtimeSyncRefreshTimeoutId = 0;
      refreshRealtimeSync();
    }, 0);
  }

  function attachTargetsMapObserver() {
    const targetsMap = annotationState.daCollabClient?.getTargetsMap();
    if (!targetsMap || annotationState.realtimeTargetsMapUnsubscribe) return;

    const handleTargetsMapChange = () => {
      scheduleRealtimeSyncRefresh();
    };

    targetsMap.observe(handleTargetsMapChange);
    annotationState.realtimeTargetsMapUnsubscribe = () => {
      targetsMap.unobserve(handleTargetsMapChange);
      annotationState.realtimeTargetsMapUnsubscribe = null;
    };
  }

  function getSelectedImageForMediumEditor() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const candidateNodes = [
      selection.anchorNode,
      selection.focusNode,
      range.commonAncestorContainer,
    ];

    for (let idx = 0; idx < candidateNodes.length; idx += 1) {
      const node = candidateNodes[idx];
      if (node instanceof HTMLImageElement) return node;
      if (node instanceof Element || node?.parentElement instanceof HTMLElement) {
        const element = node instanceof HTMLElement ? node : node?.parentElement;
        const img = element?.closest('img');
        if (img instanceof HTMLImageElement) return img;
      }
    }

    return null;
  }

  function closeInlineAltPopup() {
    if (annotationUI.inlineAltOutsideClickHandler) {
      document.removeEventListener('click', annotationUI.inlineAltOutsideClickHandler, true);
      annotationUI.inlineAltOutsideClickHandler = null;
    }
    if (annotationUI.inlineAltPopupEl) {
      annotationUI.inlineAltPopupEl.remove();
      annotationUI.inlineAltPopupEl = null;
    }
  }

  async function persistSingleImageAltChange(imageElement) {
    const descriptor = getDescriptorByElement(imageElement, 'image-alt');
    if (!descriptor) return;

    syncDescriptorToSharedState(descriptor);
    // eslint-disable-next-line no-use-before-define
    await persistDirtyTargets([descriptor.targetKey]);
  }

  function openInlineAltPopup(imageElement) {
    if (!(imageElement instanceof HTMLImageElement)) return;
    closeInlineAltPopup();

    const popup = document.createElement('div');
    popup.className = 'annotation-inline-alt-popup';
    const currentAlt = imageElement.getAttribute('alt') || '';
    popup.innerHTML = `
      <div class="annotation-inline-alt-popup__header">
        <h4>Edit image alt text</h4>
        <button type="button" class="annotation-inline-alt-popup__close" data-action="close" aria-label="Close">x</button>
      </div>
      <textarea class="annotation-inline-alt-popup__input" data-input="alt" placeholder="Describe the image for accessibility...">${currentAlt}</textarea>
      <div class="annotation-inline-alt-popup__actions">
        <button type="button" class="annotation-inline-alt-popup__btn" data-action="cancel">Cancel</button>
        <button type="button" class="annotation-inline-alt-popup__btn annotation-inline-alt-popup__btn--primary" data-action="save">Save</button>
      </div>
    `;
    document.body.appendChild(popup);
    annotationUI.inlineAltPopupEl = popup;

    const rect = imageElement.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    let top = rect.bottom + 10;
    let { left } = rect;
    if (top + popupRect.height > window.innerHeight - 20) {
      top = Math.max(10, rect.top - popupRect.height - 10);
    }
    if (left + popupRect.width > window.innerWidth - 20) {
      left = window.innerWidth - popupRect.width - 20;
    }
    popup.style.top = `${top}px`;
    popup.style.left = `${Math.max(10, left)}px`;

    const input = popup.querySelector('[data-input="alt"]');
    if (input instanceof HTMLTextAreaElement) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.addEventListener('keydown', async (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeInlineAltPopup();
        }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          imageElement.setAttribute('alt', input.value.trim());
          await persistSingleImageAltChange(imageElement);
          closeInlineAltPopup();
        }
      });
    }

    popup.addEventListener('click', async (event) => {
      const action = event.target.closest('[data-action]')?.getAttribute('data-action');
      if (!action) return;
      if (action === 'close' || action === 'cancel') {
        closeInlineAltPopup();
        return;
      }
      if (action === 'save') {
        const textArea = popup.querySelector('[data-input="alt"]');
        if (textArea instanceof HTMLTextAreaElement) {
          imageElement.setAttribute('alt', textArea.value.trim());
          await persistSingleImageAltChange(imageElement);
        }
        closeInlineAltPopup();
      }
    });

    annotationUI.inlineAltOutsideClickHandler = (event) => {
      const { target } = event;
      if (!(target instanceof HTMLElement)) return;
      if (popup.contains(target)) return;
      closeInlineAltPopup();
    };
    window.setTimeout(() => {
      if (annotationUI.inlineAltOutsideClickHandler) {
        document.addEventListener('click', annotationUI.inlineAltOutsideClickHandler, true);
      }
    }, 0);
  }

  function attachInlineImageSelectionHandler() {
    if (!annotationUI.mainEl || annotationUI.inlineImageSelectHandler) return;
    annotationUI.inlineImageSelectHandler = (event) => {
      if (!annotationUI.inlineMode) return;
      const { target } = event;
      if (!(target instanceof HTMLImageElement)) return;
      annotationUI.inlineSelectedImageEl = target;
      openInlineAltPopup(target);
    };
    annotationUI.mainEl.addEventListener('click', annotationUI.inlineImageSelectHandler, true);
  }

  function detachInlineImageSelectionHandler() {
    if (!annotationUI.mainEl || !annotationUI.inlineImageSelectHandler) return;
    annotationUI.mainEl.removeEventListener('click', annotationUI.inlineImageSelectHandler, true);
    annotationUI.inlineImageSelectHandler = null;
    annotationUI.inlineSelectedImageEl = null;
  }

  function createMediumEditorImageAltExtension() {
    if (!window.MediumEditor?.extensions?.button) return null;
    const ButtonExtension = window.MediumEditor.extensions.button.extend({
      name: 'imageAlt',
      action: 'imageAlt',
      aria: 'Edit image alt text',
      contentDefault: 'ALT',
      contentFA: '<i>ALT</i>',
      init() {
        this.button = this.createButton();
        this.on(this.button, 'click', this.handleClick.bind(this));
      },
      getButton() {
        return this.button;
      },
      handleClick(event) {
        event.preventDefault();
        event.stopPropagation();
        const imageElement = getSelectedImageForMediumEditor()
          || annotationUI.inlineSelectedImageEl;
        if (!(imageElement instanceof HTMLImageElement)) return;
        openInlineAltPopup(imageElement);
      },
    });
    return new ButtonExtension();
  }

  function createMediumEditorInstance(elements) {
    if (!window.MediumEditor || !elements.length) return null;
    const imageAltExtension = createMediumEditorImageAltExtension();
    const toolbarButtons = ['bold', 'italic', 'underline', 'anchor', 'h2', 'h3', 'quote'];
    if (imageAltExtension) toolbarButtons.push('imageAlt');
    const instance = new window.MediumEditor(elements, {
      toolbar: {
        buttons: toolbarButtons,
      },
      extensions: imageAltExtension ? { imageAlt: imageAltExtension } : {},
      placeholder: {
        text: 'Click to edit...',
        hideOnClick: true,
      },
      targetBlank: true,
      autoLink: true,
      paste: {
        cleanPastedHTML: true,
        cleanAttrs: ['style', 'dir'],
        cleanTags: ['label', 'meta', 'script', 'style'],
      },
    });

    instance.subscribe('editableInput', (_, editable) => {
      const descriptor = getDescriptorByElement(editable, 'text');
      if (!descriptor) return;
      syncDescriptorToSharedState(descriptor);
    });

    return instance;
  }

  function ensureInlineEditorOverlay() {
    if (annotationUI.inlineEditorOverlayEl) return annotationUI.inlineEditorOverlayEl;

    const overlay = document.createElement('aside');
    overlay.className = 'annotation-inline-editor';
    overlay.innerHTML = `
      <div class="annotation-inline-editor-header">
        <div>
          <h4 class="annotation-inline-editor-title">Live edit</h4>
          <p class="annotation-inline-editor-meta"></p>
        </div>
        <button type="button" class="annotation-inline-editor-close" data-action="close" aria-label="Close">x</button>
      </div>
      <div class="annotation-inline-editor-body">
        <div class="annotation-inline-editor-surface" contenteditable="true"></div>
        <textarea class="annotation-inline-editor-textarea" spellcheck="true"></textarea>
      </div>
      <div class="annotation-inline-editor-actions">
        <button type="button" class="annotation-inline-editor-button" data-action="done">Done</button>
      </div>
    `;
    document.body.appendChild(overlay);

    annotationUI.inlineEditorOverlayEl = overlay;
    annotationUI.inlineEditorTitleEl = overlay.querySelector('.annotation-inline-editor-title');
    annotationUI.inlineEditorMetaEl = overlay.querySelector('.annotation-inline-editor-meta');
    annotationUI.inlineEditorSurfaceEl = overlay.querySelector(
      '.annotation-inline-editor-surface',
    );
    annotationUI.inlineEditorTextareaEl = overlay.querySelector(
      '.annotation-inline-editor-textarea',
    );

    const handleInput = () => {
      const descriptor = getActiveDescriptor();
      if (!descriptor || !annotationState.daCollabClient?.isReady()) return;

      const nextValue = descriptor.targetType === 'image-alt'
        ? annotationUI.inlineEditorTextareaEl?.value || ''
        : annotationUI.inlineEditorSurfaceEl?.innerHTML || '';

      applyValueToDescriptor(descriptor, nextValue);
      updateSharedTargetValue(descriptor, nextValue);
      annotationState.realtimeDirtyTargetKeys.add(descriptor.targetKey);
      buildRealtimeEasyEdits();
      store.saveAnnotationStore();
      renderThreadMarkers({ resolveTargets: true });
      renderCommentsPanel();
    };

    overlay.addEventListener('click', async (event) => {
      const clickTarget = event.target instanceof Element ? event.target : null;
      const action = clickTarget?.closest('[data-action]')?.getAttribute('data-action');
      if (!action) return;
      event.preventDefault();

      if (action === 'close' || action === 'done') {
        const activeDescriptor = getActiveDescriptor();
        if (activeDescriptor) {
          // eslint-disable-next-line no-use-before-define
          await persistDirtyTargets([activeDescriptor.targetKey]);
        }
        // eslint-disable-next-line no-use-before-define
        closeInlineEditorOverlay();
      }
    });

    annotationUI.inlineEditorSurfaceEl?.addEventListener('input', handleInput);
    annotationUI.inlineEditorTextareaEl?.addEventListener('input', handleInput);

    return overlay;
  }

  function closeInlineEditorOverlay() {
    if (annotationUI.inlineEditorOverlayEl) {
      annotationUI.inlineEditorOverlayEl.classList.remove('is-visible');
    }
    destroyOverlayMediumEditor();
    annotationUI.inlineEditorTargetKey = '';
    store.clearSelectedElement();
  }

  async function openInlineEditorForDescriptor(descriptor) {
    const overlay = ensureInlineEditorOverlay();
    annotationUI.inlineEditorTargetKey = descriptor.targetKey;

    if (annotationUI.inlineEditorTitleEl instanceof HTMLElement) {
      annotationUI.inlineEditorTitleEl.textContent = descriptor.targetType === 'image-alt'
        ? 'Edit image alt text'
        : `Edit ${descriptor.element.tagName.toLowerCase()}`;
    }
    updateInlineEditorStatus();

    if (descriptor.targetType === 'image-alt') {
      destroyOverlayMediumEditor();
      overlay.classList.add('is-alt-mode', 'is-visible');
      overlay.classList.remove('is-text-mode');
      if (annotationUI.inlineEditorTextareaEl) {
        annotationUI.inlineEditorTextareaEl.value = descriptor.element.getAttribute('alt') || '';
        annotationUI.inlineEditorTextareaEl.focus();
      }
    } else {
      overlay.classList.add('is-text-mode', 'is-visible');
      overlay.classList.remove('is-alt-mode');
      if (annotationUI.inlineEditorSurfaceEl) {
        annotationUI.inlineEditorSurfaceEl.innerHTML = descriptor.element.innerHTML;
        await ensureOverlayMediumEditor();
        annotationUI.inlineEditorSurfaceEl.focus();
      }
    }

    store.clearSelectedElement();
    annotationState.selectedElement = descriptor.element;
    descriptor.element.classList.add('annotation-selected-element');
  }

  function findEditableTarget(target) {
    if (!(target instanceof HTMLElement)) return null;

    const imageTarget = target instanceof HTMLImageElement
      ? target
      : target.closest('img.annotation-inline-editable-image');
    if (imageTarget instanceof HTMLImageElement) {
      return Array.from(annotationState.realtimeTargetRegistry.values())
        .find((descriptor) => descriptor.element === imageTarget) || null;
    }

    const textTarget = target.closest('.annotation-inline-editable');
    if (!(textTarget instanceof HTMLElement)) return null;
    return Array.from(annotationState.realtimeTargetRegistry.values())
      .find((descriptor) => descriptor.element === textTarget) || null;
  }

  async function persistEditThreadMessage(element, threadElementPath, text) {
    if (!(element instanceof HTMLElement) || !threadElementPath || !text) return false;

    let thread = store.getEditThreadByElement(element);
    let didPersistToService = false;
    let didHydrateThread = false;

    try {
      const result = thread
        ? await annotationService.createReply(thread.id, text, { loadingMessage: 'Saving edit...' })
        : await annotationService.createThread({
          elementPath: threadElementPath,
          body: text,
          quotedText: null,
          threadType: 'edit',
        });

      if (thread) {
        if (result?.persisted) {
          didPersistToService = true;
        }
        if (result?.thread) {
          store.upsertThread(result.thread);
          thread = store.getThreadById(result.thread.id) || result.thread;
          didHydrateThread = true;
        }
      } else if (result) {
        store.upsertThread(result);
        thread = store.getThreadById(result.id) || result;
        didPersistToService = true;
        didHydrateThread = true;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('Could not save edit thread to service', error);
    }

    if (!didPersistToService || !thread) {
      showGlobalSnackbar(ANNOTATION_MESSAGES.syncEditError);
      return false;
    }

    hideGlobalSnackbar();
    annotationState.activeThreadId = thread.id;
    annotationState.activeMessageId = '';
    annotationState.activeEditId = '';
    if (!didHydrateThread) {
      renderThreadMarkers({ resolveTargets: true });
      renderCommentsPanel();
    }
    return true;
  }

  async function persistDirtyTargets(
    targetKeys = Array.from(annotationState.realtimeDirtyTargetKeys),
  ) {
    const keys = Array.isArray(targetKeys) ? targetKeys : [targetKeys];
    const persistTasks = keys.map(async (targetKey) => {
      const descriptor = annotationState.realtimeTargetRegistry.get(targetKey);
      if (!descriptor || !annotationState.realtimeDirtyTargetKeys.has(targetKey)) return;

      const currentValue = getDescriptorCurrentValue(descriptor);
      if (currentValue === descriptor.lastCommittedValue) {
        annotationState.realtimeDirtyTargetKeys.delete(targetKey);
        return;
      }

      const editRecord = descriptor.targetType === 'image-alt'
        ? {
          editType: 'image-alt',
          from: descriptor.lastCommittedValue,
          to: currentValue,
        }
        : {
          editType: 'text',
          from: getPlainTextFromHtml(descriptor.lastCommittedValue),
          to: getPlainTextFromHtml(currentValue),
        };

      const didPersist = await persistEditThreadMessage(
        descriptor.element,
        descriptor.threadElementPath,
        store.getEditPanelMessage(editRecord),
      );

      if (didPersist) {
        descriptor.lastCommittedValue = currentValue;
      }
      annotationState.realtimeDirtyTargetKeys.delete(targetKey);
    });

    await Promise.all(persistTasks);
    buildRealtimeEasyEdits();
    store.saveAnnotationStore();
    renderThreadMarkers({ resolveTargets: true });
    renderCommentsPanel();
  }

  // eslint-disable-next-line no-unused-vars
  function attachInlineTargetSelectionHandler() {
    if (!annotationUI.mainEl || annotationUI.inlineTargetSelectionHandler) return;

    annotationUI.inlineTargetSelectionHandler = async (event) => {
      if (!annotationUI.inlineMode) return;
      const descriptor = findEditableTarget(event.target);
      if (!descriptor) return;

      event.preventDefault();
      event.stopPropagation();

      const previousDescriptor = getActiveDescriptor();
      if (previousDescriptor && previousDescriptor.targetKey !== descriptor.targetKey) {
        await persistDirtyTargets([previousDescriptor.targetKey]);
      }

      await openInlineEditorForDescriptor(descriptor);
    };

    annotationUI.mainEl.addEventListener('click', annotationUI.inlineTargetSelectionHandler, true);
  }

  // eslint-disable-next-line no-unused-vars
  function detachInlineTargetSelectionHandler() {
    if (!annotationUI.mainEl || !annotationUI.inlineTargetSelectionHandler) return;
    annotationUI.mainEl.removeEventListener('click', annotationUI.inlineTargetSelectionHandler, true);
    annotationUI.inlineTargetSelectionHandler = null;
  }

  async function initializeRealtimeEditing() {
    if (!isRealtimeAnnotationEditingEnabled()) {
      annotationState.realtimeEditingInitialized = false;
      annotationState.realtimeEditingAvailable = false;
      updateInlineEditAvailabilityState(
        false,
        ANNOTATION_MESSAGES.realtimeEditDisabledDescription,
      );
      return false;
    }

    const collabClient = await ensureRealtimeClient();
    if (!collabClient?.isReady()) {
      annotationState.realtimeEditingInitialized = false;
      annotationState.realtimeEditingAvailable = false;
      updateInlineEditAvailabilityState(
        false,
        ANNOTATION_MESSAGES.realtimeEditUnavailableDescription,
      );
      return false;
    }

    refreshRealtimeSync();
    annotationState.realtimeEditingInitialized = true;
    annotationState.realtimeEditingAvailable = true;
    updateInlineEditAvailabilityState(true);
    return true;
  }

  async function enableInlineEditMode() {
    if (!annotationUI.mainEl || annotationUI.inlineMode) return false;
    if (!isInlineEditingAllowed()) {
      showGlobalSnackbar(ANNOTATION_MESSAGES.inlineEditRestrictedSnackbar);
      return false;
    }
    if (!annotationService.isAvailable()) {
      showGlobalSnackbar(ANNOTATION_MESSAGES.collabUnavailableSnackbar);
      return false;
    }
    await loadMediumEditor();

    const didInitializeRealtime = annotationState.realtimeEditingInitialized
      || await initializeRealtimeEditing();
    if (!didInitializeRealtime || !annotationState.daCollabClient?.isReady()) {
      showGlobalSnackbar(ANNOTATION_MESSAGES.realtimeEditUnavailableSnackbar);
      return false;
    }

    refreshTargetRegistry();
    if (annotationState.realtimeTargetRegistry.size === 0) {
      showGlobalSnackbar(ANNOTATION_MESSAGES.noEditableTargets);
      return false;
    }

    annotationUI.inlineMode = true;
    document.body.classList.add('annotation-inline-edit-mode');
    removePopup();
    store.clearSelectedElement();
    store.removeEasyEditHighlights(annotationUI.mainEl);

    annotationUI.mediumEditorInstance = createMediumEditorInstance(annotationUI.editableElements);
    attachInlineImageSelectionHandler();

    annotationUI.editableElements.forEach((element) => {
      element.classList.add('annotation-inline-editable');
      const descriptor = getDescriptorByElement(element, 'text');
      const elementRef = store.ensureElementRef(element);
      if (!descriptor) return;
      const blurHandler = async () => {
        await persistDirtyTargets([descriptor.targetKey]);
      };
      annotationUI.inlineBlurHandlers.set(elementRef, blurHandler);
      element.addEventListener('blur', blurHandler, true);
    });
    annotationUI.editableImages.forEach((imageElement) => {
      imageElement.classList.add('annotation-inline-editable-image');
    });

    renderThreadMarkers({ resolveTargets: true });
    renderCommentsPanel();
    return true;
  }

  async function disableInlineEditMode() {
    if (!annotationUI.inlineMode) return;

    await persistDirtyTargets();

    annotationUI.inlineMode = false;
    document.body.classList.remove('annotation-inline-edit-mode');
    if (annotationUI.mediumEditorInstance) {
      annotationUI.mediumEditorInstance.destroy();
      annotationUI.mediumEditorInstance = null;
    }
    detachInlineImageSelectionHandler();
    closeInlineAltPopup();
    closeInlineEditorOverlay();

    annotationUI.editableElements.forEach((element) => {
      const elementRef = element.dataset.annotationRef;
      const handler = elementRef ? annotationUI.inlineBlurHandlers.get(elementRef) : null;
      if (handler) {
        element.removeEventListener('blur', handler, true);
        annotationUI.inlineBlurHandlers.delete(elementRef);
      }
      element.classList.remove('annotation-inline-editable');
    });
    annotationUI.editableElements = [];
    annotationUI.editableImages.forEach((imageElement) => {
      imageElement.classList.remove('annotation-inline-editable-image');
    });
    annotationUI.editableImages = [];

    buildRealtimeEasyEdits();
    store.saveAnnotationStore();
    renderThreadMarkers({ resolveTargets: true });
    renderCommentsPanel();
  }

  async function syncInlineEditsBeforePersist() {
    if (annotationState.realtimeEditingInitialized && annotationState.daCollabClient?.isReady()) {
      await persistDirtyTargets();
      buildRealtimeEasyEdits();
      store.saveAnnotationStore();
    }
  }

  return {
    disableInlineEditMode,
    enableInlineEditMode,
    initializeRealtimeEditing,
    syncInlineEditsBeforePersist,
  };
}
