import {
  ANNOTATION_MESSAGES,
  ANNOTATION_DEFAULT_USERNAME,
  ANNOTATION_REFRESH_EVENT,
} from '../../utils/constants.js';
import { COMMENT_STATUSES } from './store.js';
import createAnnotationServiceClient from './service.js';
import requestParentCollabRefresh from './collab-sync.js';
import { hideGlobalSnackbar, showGlobalSnackbar } from '../../utils/snackbar.js';

export default function createCommentsPanelController({
  annotationState,
  annotationUI,
  store,
}) {
  const annotationService = createAnnotationServiceClient();
  const isInlineEditingAllowed = () => window.streamConfig?.inlineEditingAllowed !== false;

  function isCollabComplete(snackbarMessage) {
    if (!annotationState.isCollabComplete) return false;
    if (snackbarMessage) showGlobalSnackbar(snackbarMessage);
    return true;
  }

  function syncEditLabelAccessState() {
    if (!annotationUI.panelEl) return;
    const editLabel = annotationUI.panelEl.querySelector('label[for="annotation-inline-mode-edit"]');
    if (editLabel instanceof HTMLElement) {
      if (annotationState.isCollabComplete) {
        editLabel.title = ANNOTATION_MESSAGES.collabCompleteEditRestricted;
        editLabel.setAttribute('aria-label', ANNOTATION_MESSAGES.collabCompleteEditRestricted);
        return;
      }
      if (!isInlineEditingAllowed()) {
        editLabel.title = ANNOTATION_MESSAGES.inlineEditRestrictedDescription;
        editLabel.setAttribute('aria-label', ANNOTATION_MESSAGES.inlineEditRestrictedDescription);
        return;
      }
      editLabel.removeAttribute('title');
      editLabel.removeAttribute('aria-label');
    }
  }

  function enforceCollabCompleteUiState() {
    closeCommentEditor();
    closePopupAndSelection();
    annotationUI.annotationMode = 'comments';
    if (annotationUI.inlineCommentsToggleEl) {
      annotationUI.inlineCommentsToggleEl.checked = true;
    }
    if (annotationUI.inlineToggleEl) annotationUI.inlineToggleEl.checked = false;
    if (annotationUI.inlineAssetsToggleEl) annotationUI.inlineAssetsToggleEl.checked = false;
    syncEditLabelAccessState();
  }

  let enableInlineEditMode = async () => {};
  let disableInlineEditMode = () => {};
  let flushPendingCommentsPanelRefresh = () => {};
  let renderCommentsPanel = () => {};
  let popupSubmitPending = false;
  let activeCommentEditor = null;
  let popupDraft = '';
  let popupDraftKey = '';
  let pendingCommentsPanelRefresh = false;
  const panelReplyDrafts = new Map();
  const pendingReplyComposerKeys = new Set();
  const pendingCommentEditIds = new Set();

  function setInlineModeHandlers(handlers) {
    enableInlineEditMode = handlers.enableInlineEditMode;
    disableInlineEditMode = handlers.disableInlineEditMode;
  }

  function setSelectedElement(element) {
    store.clearSelectedElement();
    annotationState.selectedElement = element;
    annotationState.selectedElement.classList.add('annotation-selected-element');
    annotationState.selectedElementRef = '';
    annotationState.selectedElementPath = store.buildCommentElementPath(
      annotationState.selectedElement,
      annotationUI.mainEl,
    );
  }

  function ensureFloatingLayer() {
    const existing = document.querySelector('.annotation-floating-layer');
    if (existing) existing.remove();

    const layer = document.createElement('div');
    layer.className = 'annotation-floating-layer';
    document.body.appendChild(layer);
    annotationUI.layerEl = layer;
  }

  function ensureCommentsPanel() {
    const existing = document.querySelector('.annotation-comments-panel');
    if (existing) existing.remove();

    const panel = document.createElement('aside');
    panel.className = 'annotation-comments-panel';
    panel.innerHTML = `
      <div class="annotation-comments-panel-header">
        <div class="annotation-comments-panel-heading">
          <h3>Comments</h3>
        </div>
        <div class="annotation-inline-edit-switcher">
          <div class="annotation-inline-radio-group" role="radiogroup" aria-label="Annotation mode">
            <input type="radio" id="annotation-inline-mode-comments" name="annotation-inline-mode" class="annotation-inline-mode-radio" value="comments" checked />
            <label for="annotation-inline-mode-comments">Comments</label>
            <input type="radio" id="annotation-inline-mode-edit" name="annotation-inline-mode" class="annotation-inline-mode-radio" value="edit" />
            <label for="annotation-inline-mode-edit">Edit</label>
            <input type="radio" id="annotation-inline-mode-assets" name="annotation-inline-mode" class="annotation-inline-mode-radio" value="assets" />
            <label for="annotation-inline-mode-assets">Assets</label>
          </div>
        </div>
      </div>
      <div class="annotation-comments-content">
        <div class="annotation-comments-list"></div>
        <div class="annotation-comments-disabled-overlay">Edit mode is on. Switch it off to add comments.</div>
      </div>
    `;
    document.body.appendChild(panel);
    annotationUI.panelEl = panel;
    annotationUI.panelListEl = panel.querySelector('.annotation-comments-list');
    annotationUI.inlineToggleEl = panel.querySelector('#annotation-inline-mode-edit');
    annotationUI.inlineCommentsToggleEl = panel.querySelector('#annotation-inline-mode-comments');
    annotationUI.inlineAssetsToggleEl = panel.querySelector('#annotation-inline-mode-assets');

    if (annotationUI.annotationMode === 'assets') {
      if (annotationUI.inlineAssetsToggleEl) annotationUI.inlineAssetsToggleEl.checked = true;
      if (annotationUI.inlineToggleEl) annotationUI.inlineToggleEl.checked = false;
      if (annotationUI.inlineCommentsToggleEl) annotationUI.inlineCommentsToggleEl.checked = false;
    } else if (annotationUI.annotationMode === 'edit' || annotationUI.inlineMode) {
      if (annotationUI.inlineToggleEl) annotationUI.inlineToggleEl.checked = true;
      if (annotationUI.inlineCommentsToggleEl) annotationUI.inlineCommentsToggleEl.checked = false;
      if (annotationUI.inlineAssetsToggleEl) annotationUI.inlineAssetsToggleEl.checked = false;
    } else {
      if (annotationUI.inlineCommentsToggleEl) annotationUI.inlineCommentsToggleEl.checked = true;
      if (annotationUI.inlineToggleEl) annotationUI.inlineToggleEl.checked = false;
      if (annotationUI.inlineAssetsToggleEl) annotationUI.inlineAssetsToggleEl.checked = false;
    }

    syncEditLabelAccessState();
  }

  function ensureCanvasRefreshBar() {
    const existing = document.querySelector('.annotation-canvas-refresh-bar');
    if (existing) existing.remove();

    const refreshBar = document.createElement('div');
    refreshBar.className = 'annotation-canvas-refresh-bar';
    refreshBar.setAttribute('aria-hidden', 'true');
    refreshBar.setAttribute('role', 'status');
    refreshBar.setAttribute('aria-live', 'polite');
    refreshBar.innerHTML = `
      <div class="annotation-canvas-refresh-copy">
        <span class="annotation-canvas-refresh-icon" aria-hidden="true">i</span>
        <div class="annotation-canvas-refresh-text">
          <strong>${ANNOTATION_MESSAGES.refreshEditsTitle}</strong>
          <span>${ANNOTATION_MESSAGES.refreshEditsInlineMessage}</span>
        </div>
      </div>
      <button type="button" class="annotation-canvas-refresh-btn">${ANNOTATION_MESSAGES.refreshEditsAction}</button>
    `;
    document.body.appendChild(refreshBar);
    annotationUI.canvasRefreshBarEl = refreshBar;

    const refreshButton = refreshBar.querySelector('.annotation-canvas-refresh-btn');
    if (refreshButton instanceof HTMLButtonElement) {
      annotationState.canvasRefreshBarClickHandler = (event) => {
        event.preventDefault();
        event.stopPropagation();
        hideGlobalSnackbar();
        window.dispatchEvent(new CustomEvent(ANNOTATION_REFRESH_EVENT));
      };
      refreshButton.addEventListener('click', annotationState.canvasRefreshBarClickHandler);
    }
  }

  function buildCommentGroups(thread) {
    const groups = [];
    const byCommentId = new Map();
    let currentGroup = null;

    (thread.messages || []).forEach((message) => {
      const isComment = message.kind === 'comment' || !currentGroup;
      if (isComment) {
        const group = {
          comment: message,
          replies: [],
        };
        groups.push(group);
        byCommentId.set(message.id, group);
        currentGroup = group;
        return;
      }

      const parentGroup = message.replyToCommentId
        ? byCommentId.get(message.replyToCommentId)
        : currentGroup;
      if (parentGroup) parentGroup.replies.push(message);
    });

    return groups;
  }

  function getRootComment(thread) {
    return buildCommentGroups(thread)[0]?.comment || thread?.messages?.[0] || null;
  }

  function getCurrentUserIdentity() {
    return annotationService.getCurrentUserIdentity();
  }

  function isCurrentUserCollabOwner() {
    const normalizedRole = `${window.streamConfig?.collabRole || ''}`
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, ' ');
    if (!normalizedRole) {
      return window.streamConfig?.inlineEditingAllowed === true;
    }
    return normalizedRole === 'owner'
      || normalizedRole === 'collab owner';
  }

  function isThreadClosed(thread) {
    return Boolean(thread) && store.normalizeCommentStatus(thread.status) === 'Closed';
  }

  function isCommentEditableByCurrentUser(thread, message) {
    if (!message || annotationUI.inlineMode || annotationUI.annotationMode !== 'comments') return false;
    const currentUser = getCurrentUserIdentity();
    const currentProfileId = `${currentUser?.profileId || ''}`.trim();
    const authorProfileId = `${message.authorProfileId ?? ''}`.trim();
    return Boolean(currentProfileId && authorProfileId && currentProfileId === authorProfileId);
  }

  function isThreadStatusEditableByCurrentUser(thread) {
    if (!thread) return false;
    if (annotationUI.inlineMode || annotationUI.annotationMode !== 'comments') return false;
    return isCurrentUserCollabOwner();
  }

  function getCommentEditorKey(threadId, commentId) {
    return `${threadId || ''}::${commentId || ''}`;
  }

  function getDraftScopeKey(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }

  function syncPopupDraftScope(elementPath) {
    const nextKey = getDraftScopeKey(elementPath);
    if (popupDraftKey && popupDraftKey !== nextKey) {
      popupDraft = '';
    }
    popupDraftKey = nextKey;
  }

  function updatePopupDraft(value) {
    popupDraft = value || '';
  }

  function clearPopupDraft() {
    popupDraft = '';
    popupDraftKey = '';
  }

  function getReplyComposerKey(threadId, commentId = '') {
    return `${threadId || ''}::${commentId || ''}`;
  }

  function getPanelReplyDraft(threadId, commentId = '') {
    return panelReplyDrafts.get(getReplyComposerKey(threadId, commentId)) || '';
  }

  function updatePanelReplyDraft(threadId, commentId = '', value = '') {
    const key = getReplyComposerKey(threadId, commentId);
    if (!value) {
      panelReplyDrafts.delete(key);
      return;
    }
    panelReplyDrafts.set(key, value);
  }

  function clearPanelReplyDraft(threadId, commentId = '') {
    panelReplyDrafts.delete(getReplyComposerKey(threadId, commentId));
  }

  function resetPanelReplyComposer(threadId, commentId = '') {
    clearPanelReplyDraft(threadId, commentId);
    const input = annotationUI.panelEl?.querySelector(
      `.annotation-panel-reply-input[data-thread-id="${threadId}"][data-comment-id="${commentId}"]`,
    );
    if (input instanceof HTMLInputElement) {
      input.value = '';
    }
  }

  function isEditingComment(threadId, commentId) {
    return activeCommentEditor?.threadId === threadId
      && activeCommentEditor?.commentId === commentId;
  }

  function openCommentEditor(threadId, commentId, text) {
    if (pendingCommentEditIds.size) return false;
    activeCommentEditor = {
      threadId,
      commentId,
      draft: text || '',
    };
    return true;
  }

  function focusCommentEditor(threadId, commentId) {
    window.requestAnimationFrame(() => {
      const input = annotationUI.panelEl?.querySelector(
        `.annotation-panel-edit-input[data-thread-id="${threadId}"][data-comment-id="${commentId}"]`,
      );
      if (!(input instanceof HTMLTextAreaElement)) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  function closeCommentEditor() {
    activeCommentEditor = null;
  }

  function updateCommentEditorDraft(value) {
    if (!activeCommentEditor) return;
    activeCommentEditor = {
      ...activeCommentEditor,
      draft: value,
    };
  }

  function isCommentsViewActive() {
    return annotationUI.annotationMode === 'comments' && !annotationUI.inlineMode;
  }

  function getVisibleThreadType() {
    if (annotationUI.annotationMode === 'assets') return '';
    return annotationUI.inlineMode || annotationUI.annotationMode === 'edit'
      ? 'edit'
      : 'comment';
  }

  function schedulePendingCommentsPanelRefreshFlush() {
    window.requestAnimationFrame(() => {
      flushPendingCommentsPanelRefresh();
    });
  }

  function shouldDeferCommentsPanelRefresh() {
    return pendingReplyComposerKeys.size > 0
      || pendingCommentEditIds.size > 0;
  }

  flushPendingCommentsPanelRefresh = function flushPendingCommentsPanelRefreshImpl() {
    if (!pendingCommentsPanelRefresh) return;
    if (shouldDeferCommentsPanelRefresh()) return;
    renderCommentsPanel();
  };

  function setCommentEditPending(threadId, commentId, isPending) {
    const key = getCommentEditorKey(threadId, commentId);
    if (isPending) {
      pendingCommentEditIds.add(key);
    } else {
      pendingCommentEditIds.delete(key);
    }

    const textArea = annotationUI.panelEl?.querySelector(
      `.annotation-panel-edit-input[data-thread-id="${threadId}"][data-comment-id="${commentId}"]`,
    );
    const saveBtn = annotationUI.panelEl?.querySelector(
      `.annotation-panel-edit-save-btn[data-thread-id="${threadId}"][data-comment-id="${commentId}"]`,
    );
    const cancelBtn = annotationUI.panelEl?.querySelector(
      `.annotation-panel-edit-cancel-btn[data-thread-id="${threadId}"][data-comment-id="${commentId}"]`,
    );
    const form = textArea?.closest('.annotation-panel-edit-form')
      || saveBtn?.closest('.annotation-panel-edit-form')
      || cancelBtn?.closest('.annotation-panel-edit-form');

    if (form instanceof HTMLElement) {
      form.classList.toggle('is-submitting', isPending);
      form.setAttribute('aria-busy', `${isPending}`);
    }
    if (textArea instanceof HTMLTextAreaElement) {
      textArea.readOnly = isPending;
    }
    if (saveBtn instanceof HTMLButtonElement) {
      saveBtn.disabled = isPending;
    }
    if (cancelBtn instanceof HTMLButtonElement) {
      cancelBtn.disabled = isPending;
    }
    if (!isPending) {
      schedulePendingCommentsPanelRefreshFlush();
    }
  }

  function setPanelReplyPending(threadId, commentId, isPending) {
    const key = getReplyComposerKey(threadId, commentId);
    if (isPending) {
      pendingReplyComposerKeys.add(key);
    } else {
      pendingReplyComposerKeys.delete(key);
    }

    const input = annotationUI.panelEl?.querySelector(
      `.annotation-panel-reply-input[data-thread-id="${threadId}"][data-comment-id="${commentId || ''}"]`,
    );
    const button = annotationUI.panelEl?.querySelector(
      `.annotation-panel-reply-btn[data-thread-id="${threadId}"][data-comment-id="${commentId || ''}"]`,
    );
    const composer = input?.closest('.annotation-panel-reply-composer')
      || button?.closest('.annotation-panel-reply-composer');

    if (composer instanceof HTMLElement) {
      composer.classList.toggle('is-submitting', isPending);
      composer.setAttribute('aria-busy', `${isPending}`);
    }
    if (input instanceof HTMLInputElement) {
      input.readOnly = isPending;
    }
    if (button instanceof HTMLButtonElement) {
      button.disabled = isPending;
    }
    if (!isPending) {
      schedulePendingCommentsPanelRefreshFlush();
    }
  }

  function createCommentEditForm(threadId, commentId, draft, isReply = false) {
    const editorFieldId = `annotation-panel-edit-input-${threadId}-${commentId}`;
    const editForm = document.createElement('div');
    editForm.className = isReply
      ? 'annotation-panel-edit-form annotation-panel-edit-form-reply'
      : 'annotation-panel-edit-form';

    const input = document.createElement('textarea');
    input.className = 'annotation-panel-edit-input';
    input.id = editorFieldId;
    input.name = editorFieldId;
    input.dataset.threadId = threadId;
    input.dataset.commentId = commentId;
    input.placeholder = ANNOTATION_MESSAGES.editCommentPlaceholder;
    input.value = draft || '';

    const actions = document.createElement('div');
    actions.className = 'annotation-panel-edit-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'annotation-panel-edit-cancel-btn';
    cancelBtn.dataset.threadId = threadId;
    cancelBtn.dataset.commentId = commentId;
    cancelBtn.setAttribute('aria-label', ANNOTATION_MESSAGES.cancelCommentAction);
    cancelBtn.setAttribute('title', ANNOTATION_MESSAGES.cancelCommentAction);
    cancelBtn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6L18 18M18 6L6 18"></path>
      </svg>
    `;

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'annotation-panel-edit-save-btn';
    saveBtn.dataset.threadId = threadId;
    saveBtn.dataset.commentId = commentId;
    saveBtn.setAttribute('aria-label', ANNOTATION_MESSAGES.saveCommentAction);
    saveBtn.setAttribute('title', ANNOTATION_MESSAGES.saveCommentAction);
    saveBtn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12.5L9.5 17L19 7.5"></path>
      </svg>
    `;

    actions.append(cancelBtn, saveBtn);
    editForm.append(input, actions);
    return editForm;
  }

  function isCommentsServiceAvailable() {
    return annotationService.isAvailable();
  }

  function captureTransientDraftsFromDom() {
    const popupInput = annotationUI.popupEl?.querySelector('.annotation-reply-input');
    if (popupInput instanceof HTMLTextAreaElement) {
      updatePopupDraft(popupInput.value);
    }

    annotationUI.panelEl?.querySelectorAll('.annotation-panel-reply-input').forEach((input) => {
      if (!(input instanceof HTMLInputElement)) return;
      updatePanelReplyDraft(input.dataset.threadId, input.dataset.commentId, input.value);
    });
  }

  function getThreadRenderSnapshot(thread) {
    return {
      id: thread?.id || '',
      threadType: store.getThreadType(thread),
      status: thread?.status || '',
      username: thread?.username || '',
      elementPath: getDraftScopeKey(thread?.elementPath),
      messages: (thread?.messages || []).map((message) => ({
        id: message?.id || '',
        authorProfileId: `${message?.authorProfileId ?? ''}`,
        username: message?.username || '',
        text: message?.text || '',
        kind: message?.kind || '',
        replyToCommentId: message?.replyToCommentId || '',
      })),
    };
  }

  function getThreadsRenderSignature(threads = []) {
    return JSON.stringify(threads.map(getThreadRenderSnapshot));
  }

  function createFnv1aHash() {
    let hash = 0x811c9dc5;
    return {
      update(value = '') {
        const input = `${value}`;
        for (let index = 0; index < input.length; index += 1) {
          // eslint-disable-next-line no-bitwise
          hash ^= input.charCodeAt(index);
          // eslint-disable-next-line no-bitwise
          hash = Math.imul(hash, 0x01000193) >>> 0;
        }
      },
      digest() {
        return hash.toString(16).padStart(8, '0');
      },
    };
  }

  function getStableStringValue(input) {
    if (Array.isArray(input)) {
      return input.map((item) => getStableStringValue(item));
    }
    if (input && typeof input === 'object') {
      return Object.keys(input)
        .sort()
        .reduce((result, key) => {
          result[key] = getStableStringValue(input[key]);
          return result;
        }, {});
    }
    return input;
  }

  function stringifyStableValue(value) {
    try {
      return JSON.stringify(getStableStringValue(value));
    } catch {
      return '';
    }
  }

  function getEasyEditComparisonSnapshot(edit) {
    return {
      editType: edit?.editType || '',
      attrName: edit?.attrName || '',
      elementPath: edit?.elementPath || '',
      elementProps: stringifyStableValue(edit?.elementProps || {}),
      from: edit?.from || '',
      to: edit?.to || '',
      fromHtml: edit?.fromHtml || '',
      toHtml: edit?.toHtml || '',
      changedFrom: edit?.changedFrom || '',
      changedTo: edit?.changedTo || '',
    };
  }

  function getEasyEditsComparisonHash(edits = []) {
    const normalizedEdits = [...edits]
      .map((edit) => {
        const snapshot = getEasyEditComparisonSnapshot(edit);
        const stableKey = `${snapshot.elementPath}::${snapshot.attrName}::${snapshot.editType}`;
        return `${stableKey}|${stringifyStableValue(snapshot)}`;
      })
      .sort();

    const hash = createFnv1aHash();
    normalizedEdits.forEach((normalizedEdit) => {
      hash.update(normalizedEdit);
      hash.update('\u001f');
    });

    return hash.digest();
  }

  function getEasyEditsComparisonSize(edits = []) {
    return Array.isArray(edits) ? edits.length : 0;
  }

  function getSelfSavedEditsFingerprint(edits = []) {
    return {
      count: getEasyEditsComparisonSize(edits),
      hash: getEasyEditsComparisonHash(edits),
    };
  }

  function setSelfSavedEditsFingerprint(edits = []) {
    const fingerprint = getSelfSavedEditsFingerprint(edits);
    annotationState.latestSelfSavedEditsHash = fingerprint.hash;
    annotationState.latestSelfSavedEditsCount = fingerprint.count;
  }

  function clearSelfSavedEditsFingerprint() {
    annotationState.latestSelfSavedEditsHash = '';
    annotationState.latestSelfSavedEditsCount = 0;
  }

  function markSelfSavedEditsSnapshot(editRecord = []) {
    setSelfSavedEditsFingerprint(editRecord);
  }

  function shouldSuppressSelfSaveRefresh(remoteEditRecord = []) {
    if (!annotationState.latestSelfSavedEditsHash) return false;
    if (
      getEasyEditsComparisonSize(remoteEditRecord) !== annotationState.latestSelfSavedEditsCount
    ) {
      return false;
    }
    return (
      getEasyEditsComparisonHash(remoteEditRecord)
      === annotationState.latestSelfSavedEditsHash
    );
  }

  function syncPendingPanelStates() {
    pendingReplyComposerKeys.forEach((key) => {
      const [threadId = '', commentId = ''] = key.split('::');
      setPanelReplyPending(threadId, commentId, true);
    });
    pendingCommentEditIds.forEach((key) => {
      const [threadId = '', commentId = ''] = key.split('::');
      setCommentEditPending(threadId, commentId, true);
    });
  }

  function isEditViewActive() {
    return annotationUI.annotationMode === 'edit';
  }

  function getTimestampValue(value) {
    const timestamp = new Date(value || 0).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function hasPendingRemoteEdits() {
    return Boolean(
      annotationState.pendingRemoteEditsSnapshot?.updatedAt
      || annotationState.pendingRemoteEditsSnapshot?.createdAt,
    );
  }

  function renderRefreshAction() {
    if (!(annotationUI.canvasRefreshBarEl instanceof HTMLElement)) return;
    const isVisible = hasPendingRemoteEdits();
    annotationUI.canvasRefreshBarEl.classList.toggle('is-visible', isVisible);
    annotationUI.canvasRefreshBarEl.setAttribute('aria-hidden', `${!isVisible}`);
  }

  function applyNormalizedCommentThreads(nextCommentThreads = []) {
    const visibleThreadType = getVisibleThreadType();
    const currentCommentThreads = annotationState.store.threads.filter(
      (thread) => store.getThreadType(thread) === 'comment',
    );
    const didCommentsChange = getThreadsRenderSignature(currentCommentThreads)
      !== getThreadsRenderSignature(nextCommentThreads);

    if (!didCommentsChange) {
      if (
        pendingCommentsPanelRefresh
        && visibleThreadType === 'comment'
        && !shouldDeferCommentsPanelRefresh()
      ) {
        renderCommentsPanel();
      }
      return false;
    }

    store.replaceThreadsByType('comment', nextCommentThreads);
    if (visibleThreadType !== 'comment') {
      return true;
    }

    // eslint-disable-next-line no-use-before-define
    clearThreadTargetCache();
    // eslint-disable-next-line no-use-before-define
    renderThreadMarkers({ resolveTargets: true });
    if (shouldDeferCommentsPanelRefresh()) {
      pendingCommentsPanelRefresh = true;
      return true;
    }

    renderCommentsPanel();
    return true;
  }

  function applySavedEditsSnapshot(snapshot) {
    store.replaceEasyEdits(snapshot?.editRecord || []);
    annotationState.latestSavedEditsUpdatedAt = snapshot?.updatedAt || snapshot?.createdAt || null;
    annotationState.pendingRemoteEditsSnapshot = null;
    annotationState.hasLoadedInitialEditsSnapshot = true;
    store.rebindEasyEditsToCurrentDom();
    store.applyEasyEditsToDom();
    store.saveAnnotationStore();
    // eslint-disable-next-line no-use-before-define
    clearThreadTargetCache();
    // eslint-disable-next-line no-use-before-define
    renderThreadMarkers({ resolveTargets: true });
    renderCommentsPanel();
  }

  function applyRemoteEditsSnapshot(remoteEditSnapshot, options = {}) {
    const {
      forceApply = false,
    } = options;

    const safeSnapshot = remoteEditSnapshot || {
      createdAt: null,
      updatedAt: null,
      authorUsername: '',
      editRecord: [],
    };
    const remoteUpdatedAtValue = getTimestampValue(
      safeSnapshot.updatedAt || safeSnapshot.createdAt,
    );
    const currentUpdatedAtValue = getTimestampValue(annotationState.latestSavedEditsUpdatedAt);
    const pendingUpdatedAtValue = getTimestampValue(
      annotationState.pendingRemoteEditsSnapshot?.updatedAt
      || annotationState.pendingRemoteEditsSnapshot?.createdAt,
    );

    if (!annotationState.hasLoadedInitialEditsSnapshot || forceApply) {
      applySavedEditsSnapshot(safeSnapshot);
      return true;
    }

    if (!remoteUpdatedAtValue) {
      return false;
    }

    if (remoteUpdatedAtValue <= currentUpdatedAtValue) {
      return false;
    }

    if (remoteUpdatedAtValue <= pendingUpdatedAtValue) {
      return false;
    }

    if (annotationState.latestSelfSavedEditsHash) {
      const shouldSuppress = shouldSuppressSelfSaveRefresh(safeSnapshot.editRecord);
      clearSelfSavedEditsFingerprint();
      if (shouldSuppress) {
        applySavedEditsSnapshot(safeSnapshot);
        return false;
      }
    }

    annotationState.pendingRemoteEditsSnapshot = safeSnapshot;
    renderCommentsPanel();
    showGlobalSnackbar(ANNOTATION_MESSAGES.refreshEditsSnackbar, {
      variant: 'warning',
    });
    return true;
  }

  function applyRemoteCollabSnapshot(snapshot = {}, options = {}) {
    const {
      includeEdits = true,
    } = options;
    const wasCollabComplete = annotationState.isCollabComplete;

    annotationState.latestRemoteCollabSnapshot = snapshot;

    if (snapshot?.collab && snapshot.collab.status != null) {
      annotationState.isCollabComplete = (
        `${snapshot.collab.status}`.trim().toLowerCase() === 'end'
      );
    }

    if (snapshot?.collab) {
      try {
        const nextThreads = annotationService.normalizeThreadsPayload(snapshot.collab);
        if (Array.isArray(nextThreads)) {
          applyNormalizedCommentThreads(
            nextThreads.filter((thread) => store.getThreadType(thread) === 'comment'),
          );
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('Could not apply remote comment snapshot', error);
      }
    }

    if (includeEdits && snapshot && Object.prototype.hasOwnProperty.call(snapshot, 'edits')) {
      try {
        const nextEditSnapshot = annotationService.normalizeEditsSnapshot(snapshot.edits);
        applyRemoteEditsSnapshot(nextEditSnapshot);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('Could not apply remote edits snapshot', error);
      }
    }

    if (!wasCollabComplete && annotationState.isCollabComplete) {
      enforceCollabCompleteUiState();
      if (annotationUI.inlineMode) {
        void disableInlineEditMode().then(() => {
          renderThreadMarkers({ resolveTargets: true });
          renderCommentsPanel();
        });
      } else {
        renderThreadMarkers({ resolveTargets: true });
        renderCommentsPanel();
      }
    }
  }

  function applyPendingRemoteEditsSnapshot() {
    if (!annotationState.pendingRemoteEditsSnapshot) return false;
    applyRemoteEditsSnapshot(annotationState.pendingRemoteEditsSnapshot, {
      forceApply: true,
    });
    return true;
  }

  renderCommentsPanel = function renderCommentsPanelImpl() {
    if (!annotationUI.panelListEl) return;
    pendingCommentsPanelRefresh = false;
    captureTransientDraftsFromDom();
    renderRefreshAction();
    syncEditLabelAccessState();

    const collabComplete = isCollabComplete();

    const activePopupThreadId = `${annotationUI.popupEl?.dataset.threadId || ''}`.trim();
    if (activePopupThreadId) {
      const popupThread = store.getThreadById(activePopupThreadId);
      if (isThreadClosed(popupThread)) {
        closePopupAndSelection();
        showGlobalSnackbar(ANNOTATION_MESSAGES.closedThreadRestricted);
      }
    }

    if (collabComplete && annotationUI.popupEl) {
      closePopupAndSelection();
    }

    let preservedComposer = null;
    let preservedComposerKey = '';
    let preservedEditForm = null;
    let preservedEditKey = '';
    let preservedSelStart = 0;
    let preservedSelEnd = 0;
    let preservedIsReply = false;

    const { activeElement } = document;
    if (activeElement && annotationUI.panelListEl.contains(activeElement)) {
      if (
        activeElement instanceof HTMLInputElement
        && activeElement.classList.contains('annotation-panel-reply-input')
      ) {
        const tid = activeElement.dataset.threadId || '';
        const cid = activeElement.dataset.commentId || '';
        preservedComposerKey = `${tid}::${cid}`;
        preservedSelStart = activeElement.selectionStart ?? activeElement.value.length;
        preservedSelEnd = activeElement.selectionEnd ?? activeElement.value.length;
        preservedComposer = activeElement.closest('.annotation-panel-reply-composer');
        if (preservedComposer) preservedComposer.remove();
      } else if (
        activeElement instanceof HTMLTextAreaElement
        && activeElement.classList.contains('annotation-panel-edit-input')
      ) {
        const tid = activeElement.dataset.threadId || '';
        const cid = activeElement.dataset.commentId || '';
        preservedEditKey = `${tid}::${cid}`;
        preservedSelStart = activeElement.selectionStart ?? activeElement.value.length;
        preservedSelEnd = activeElement.selectionEnd ?? activeElement.value.length;
        preservedEditForm = activeElement.closest('.annotation-panel-edit-form');
        preservedIsReply = !!activeElement.closest('.annotation-panel-reply-row');
        if (preservedEditForm) preservedEditForm.remove();
      }
    }

    const scrollContainer = annotationUI.panelEl?.querySelector('.annotation-comments-content');
    const savedScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;

    annotationUI.panelListEl.innerHTML = '';
    const panelTitle = annotationUI.panelEl?.querySelector('.annotation-comments-panel-header h3');
    if (panelTitle instanceof HTMLElement) {
      const mode = annotationUI.annotationMode || (annotationUI.inlineMode ? 'edit' : 'comments');
      let title = 'Comments';
      if (mode === 'edit') title = 'Edits';
      if (mode === 'assets') title = 'Assets';
      panelTitle.textContent = title;
    }

    if (annotationUI.annotationMode === 'assets') {
      const empty = document.createElement('p');
      empty.className = 'annotation-comments-empty';
      empty.textContent = ANNOTATION_MESSAGES.noAssets;
      annotationUI.panelListEl.appendChild(empty);
      return;
    }

    if (!isCommentsServiceAvailable()) {
      const empty = document.createElement('div');
      empty.className = 'annotation-comments-empty annotation-comments-empty-warning';
      empty.innerHTML = `
        <strong>${ANNOTATION_MESSAGES.collabUnavailableTitle}</strong>
        <span>${ANNOTATION_MESSAGES.collabUnavailableDescription}</span>
      `;
      annotationUI.panelListEl.appendChild(empty);
      return;
    }

    const visibleThreadType = getVisibleThreadType();
    const visibleThreads = annotationState.store.threads
      .filter((thread) => store.getThreadType(thread) === visibleThreadType);
    const showComments = isCommentsViewActive();

    if (!visibleThreads.length) {
      const empty = document.createElement('p');
      empty.className = 'annotation-comments-empty';
      empty.textContent = showComments
        ? ANNOTATION_MESSAGES.noComments
        : ANNOTATION_MESSAGES.noEdits;
      annotationUI.panelListEl.appendChild(empty);
      return;
    }

    let didReuseComposer = false;
    let didReuseEditForm = false;

    visibleThreads.forEach((thread) => {
      const groups = buildCommentGroups(thread);
      groups.forEach((group, idx) => {
        const isLatestInThread = idx === groups.length - 1;
        const isClosedThread = isThreadClosed(thread);
        const canEditRootComment = !isClosedThread
          && !collabComplete
          && isCommentEditableByCurrentUser(thread, group.comment);
        const card = document.createElement('article');
        card.className = 'annotation-panel-comment';
        card.dataset.threadId = thread.id;
        card.dataset.messageId = group.comment.id || '';
        const isActiveMessage = Boolean(annotationState.activeMessageId)
          && group.comment.id === annotationState.activeMessageId;
        if (isActiveMessage
          || (!annotationState.activeMessageId
            && thread.id === annotationState.activeThreadId
            && isLatestInThread)) {
          card.classList.add('is-active');
        }

        let statusControls;
        if (showComments) {
          statusControls = document.createElement('div');
          statusControls.className = 'annotation-panel-status-controls';
          const statusSelect = document.createElement('select');
          const canEditThreadStatus = isThreadStatusEditableByCurrentUser(thread);
          statusSelect.className = 'annotation-panel-status-select';
          statusSelect.dataset.threadId = thread.id;
          statusSelect.dataset.messageId = group.comment.id || '';
          statusSelect.disabled = !canEditThreadStatus || collabComplete;
          if (!canEditThreadStatus || collabComplete) {
            let restrictionMessage = ANNOTATION_MESSAGES.updateStatusRestricted;
            if (collabComplete) {
              restrictionMessage = ANNOTATION_MESSAGES.collabCompleteCommentRestricted;
            } else if (isClosedThread) {
              restrictionMessage = ANNOTATION_MESSAGES.closedThreadRestricted;
            }
            statusSelect.title = restrictionMessage;
            statusSelect.setAttribute('aria-label', restrictionMessage);
          }
          COMMENT_STATUSES.forEach((status) => {
            const option = document.createElement('option');
            option.value = status;
            option.textContent = status;
            option.selected = thread.status === status;
            statusSelect.appendChild(option);
          });
          statusControls.append(statusSelect);
          if (canEditRootComment) {
            const editThreadBtn = document.createElement('button');
            editThreadBtn.type = 'button';
            editThreadBtn.className = 'annotation-panel-edit-btn';
            editThreadBtn.dataset.action = 'edit-comment';
            editThreadBtn.dataset.threadId = thread.id;
            editThreadBtn.dataset.commentId = group.comment.id || '';
            editThreadBtn.setAttribute('aria-label', ANNOTATION_MESSAGES.editCommentAriaLabel);
            editThreadBtn.innerHTML = `
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 17.25V21h3.75L19.81 7.94l-3.75-3.75z"></path>
            </svg>
          `;
            statusControls.append(editThreadBtn);
          }
        }

        const username = document.createElement('p');
        username.className = 'annotation-panel-comment-user';
        username.textContent = group.comment.username
          || thread.username
          || ANNOTATION_DEFAULT_USERNAME;

        const rootCommentKey = `${thread.id}::${group.comment.id || ''}`;
        const isEditingRootComment = canEditRootComment && isEditingComment(thread.id, group.comment.id || '');
        if (isEditingRootComment) {
          if (preservedEditForm && !preservedIsReply && preservedEditKey === rootCommentKey) {
            card.append(username, preservedEditForm);
            preservedEditForm = null;
            didReuseEditForm = true;
          } else {
            const editForm = createCommentEditForm(
              thread.id,
              group.comment.id || '',
              activeCommentEditor?.draft || '',
            );
            card.append(username, editForm);
          }
        } else {
          const text = document.createElement('p');
          text.className = 'annotation-panel-comment-text';
          text.textContent = group.comment.text || '';
          card.append(username, text);
        }
        if (statusControls) card.append(statusControls);

        const repliesWrap = document.createElement('div');
        repliesWrap.className = 'annotation-panel-replies-list';
        group.replies.forEach((reply) => {
          const replyRow = document.createElement('div');
          replyRow.className = 'annotation-panel-reply-row';

          const replyKey = `${thread.id}::${reply.id || ''}`;
          const canEditReply = !isClosedThread
            && !collabComplete
            && isCommentEditableByCurrentUser(thread, reply);
          const isEditingReply = canEditReply && isEditingComment(thread.id, reply.id || '');
          if (isEditingReply) {
            if (preservedEditForm && preservedIsReply && preservedEditKey === replyKey) {
              replyRow.append(preservedEditForm);
              preservedEditForm = null;
              didReuseEditForm = true;
            } else {
              const editForm = createCommentEditForm(
                thread.id,
                reply.id || '',
                activeCommentEditor?.draft || '',
                true,
              );
              replyRow.append(editForm);
            }
          } else {
            const replyContent = document.createElement('div');
            replyContent.className = 'annotation-panel-reply-content';
            const replyUsername = document.createElement('p');
            replyUsername.className = 'annotation-panel-reply-user';
            replyUsername.textContent = reply.username || ANNOTATION_DEFAULT_USERNAME;
            const replyText = document.createElement('p');
            replyText.className = 'annotation-panel-reply-text';
            replyText.textContent = reply.text || '';
            replyContent.append(replyUsername, replyText);
            replyRow.append(replyContent);
          }

          if (showComments && canEditReply && !isEditingReply) {
            const replyEditBtn = document.createElement('button');
            replyEditBtn.type = 'button';
            replyEditBtn.className = 'annotation-panel-edit-btn annotation-panel-edit-btn-reply';
            replyEditBtn.dataset.action = 'edit-comment';
            replyEditBtn.dataset.threadId = thread.id;
            replyEditBtn.dataset.commentId = reply.id || '';
            replyEditBtn.setAttribute('aria-label', ANNOTATION_MESSAGES.editCommentAriaLabel);
            replyEditBtn.innerHTML = `
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 17.25V21h3.75L19.81 7.94l-3.75-3.75z"></path>
              </svg>
            `;
            replyRow.append(replyEditBtn);
          }
          repliesWrap.appendChild(replyRow);
        });

        card.append(repliesWrap);

        if (showComments && !isClosedThread && !collabComplete) {
          const composerKey = `${thread.id}::${group.comment.id || ''}`;
          if (preservedComposer && preservedComposerKey === composerKey) {
            card.append(preservedComposer);
            preservedComposer = null;
            didReuseComposer = true;
          } else {
            const replyFieldId = `annotation-panel-reply-input-${thread.id}-${group.comment.id || 'root'}`;
            const replyComposer = document.createElement('div');
            replyComposer.className = 'annotation-panel-reply-composer';
            replyComposer.innerHTML = `
              <input type="text" id="${replyFieldId}" name="${replyFieldId}" class="annotation-panel-reply-input" data-thread-id="${thread.id}" data-comment-id="${group.comment.id || ''}" placeholder="Reply..." />
              <button type="button" class="annotation-panel-reply-btn" data-thread-id="${thread.id}" data-comment-id="${group.comment.id || ''}" aria-label="Send reply">
                <span aria-hidden="true">➤</span>
              </button>
            `;
            const replyInput = replyComposer.querySelector('.annotation-panel-reply-input');
            if (replyInput instanceof HTMLInputElement) {
              replyInput.value = getPanelReplyDraft(thread.id, group.comment.id || '');
            }
            card.append(replyComposer);
          }
        }

        annotationUI.panelListEl.appendChild(card);
      });
    });

    if (scrollContainer) scrollContainer.scrollTop = savedScrollTop;
    syncPendingPanelStates();

    if (didReuseComposer && preservedComposerKey) {
      const [tid, cid] = preservedComposerKey.split('::');
      const input = annotationUI.panelListEl.querySelector(
        `.annotation-panel-reply-input[data-thread-id="${tid}"][data-comment-id="${cid}"]`,
      );
      if (input instanceof HTMLInputElement) {
        window.requestAnimationFrame(() => {
          input.focus();
          input.setSelectionRange(preservedSelStart, preservedSelEnd);
        });
      }
    }

    if (didReuseEditForm && preservedEditKey) {
      const [tid, cid] = preservedEditKey.split('::');
      const textarea = annotationUI.panelListEl.querySelector(
        `.annotation-panel-edit-input[data-thread-id="${tid}"][data-comment-id="${cid}"]`,
      );
      if (textarea instanceof HTMLTextAreaElement) {
        window.requestAnimationFrame(() => {
          textarea.focus();
          textarea.setSelectionRange(preservedSelStart, preservedSelEnd);
        });
      }
    }
  };

  function getCommentsScrollContainer() {
    if (!annotationUI.panelEl) return null;
    return annotationUI.panelEl.querySelector('.annotation-comments-content');
  }

  function scrollThreadInPanel(threadId, messageId = '', commentIndex = 0) {
    if (!annotationUI.panelEl || !annotationUI.panelListEl || !threadId) return;
    const thread = store.getThreadById(threadId);
    if (!thread) return;

    const firstCommentId = buildCommentGroups(thread)[0]?.comment?.id || '';
    annotationState.activeThreadId = threadId;
    annotationState.activeMessageId = messageId || firstCommentId;
    annotationState.activeEditId = '';
    renderCommentsPanel();

    const runScroll = () => {
      const scrollContainer = getCommentsScrollContainer();
      let target = null;
      if (annotationState.activeMessageId) {
        target = annotationUI.panelListEl.querySelector(`[data-message-id="${annotationState.activeMessageId}"]`);
      }
      if (!(target instanceof HTMLElement)) {
        const sameThreadCards = annotationUI.panelListEl.querySelectorAll(`[data-thread-id="${threadId}"]`);
        target = sameThreadCards[commentIndex] || sameThreadCards[0] || null;
      }
      if (!(target instanceof HTMLElement) || !scrollContainer) return;

      const targetTop = target.offsetTop + annotationUI.panelListEl.offsetTop - 16;
      scrollContainer.scrollTo({
        top: Math.max(0, targetTop),
        behavior: 'smooth',
      });

      annotationUI.panelListEl.querySelectorAll('.annotation-panel-comment-focus')
        .forEach((el) => el.classList.remove('annotation-panel-comment-focus'));
      target.classList.add('annotation-panel-comment-focus');
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      window.setTimeout(() => {
        target.classList.remove('annotation-panel-comment-focus');
      }, 1200);
    };

    window.requestAnimationFrame(runScroll);
    window.setTimeout(runScroll, 60);
  }

  function clearMarkers() {
    if (!annotationUI.layerEl) return;
    annotationUI.layerEl.querySelectorAll('.annotation-thread-marker, .annotation-edit-marker')
      .forEach((marker) => marker.remove());
  }

  function clearThreadTargetCache() {
    if (!(annotationState.threadTargetCache instanceof Map)) {
      annotationState.threadTargetCache = new Map();
      return;
    }
    annotationState.threadTargetCache.clear();
  }

  function resolveThreadTargets() {
    clearThreadTargetCache();
    annotationState.store.threads.forEach((thread) => {
      if (!thread?.id) return;
      annotationState.threadTargetCache.set(thread.id, store.getElementForThread(thread));
    });
  }

  function getCachedThreadTarget(thread) {
    if (!thread?.id) return null;
    if (!(annotationState.threadTargetCache instanceof Map)) {
      annotationState.threadTargetCache = new Map();
    }

    const cachedTarget = annotationState.threadTargetCache.get(thread.id);
    if (
      cachedTarget instanceof HTMLElement
      && annotationUI.mainEl?.contains(cachedTarget)
    ) {
      return cachedTarget;
    }

    if (annotationState.threadTargetCache.has(thread.id) && cachedTarget === null) {
      return null;
    }

    const resolvedTarget = store.getElementForThread(thread);
    annotationState.threadTargetCache.set(thread.id, resolvedTarget);
    return resolvedTarget;
  }

  function scrollCommentsPanelToBottom() {
    const scrollContainer = getCommentsScrollContainer();
    if (!scrollContainer) return;
    window.requestAnimationFrame(() => {
      scrollContainer.scrollTo({
        top: scrollContainer.scrollHeight,
        behavior: 'smooth',
      });
    });
  }

  function renderThreadMarkers({ resolveTargets = false } = {}) {
    if (!annotationUI.layerEl || !annotationUI.mainEl) return;
    if (resolveTargets) resolveThreadTargets();
    const occupiedMarkerSlots = new Set();
    const MARKER_STEP = 28;
    const MIN_MARKER_LEFT = 8;

    annotationUI.mainEl.querySelectorAll('[data-annotation-count]').forEach((el) => {
      el.classList.remove('annotation-has-comments');
      el.removeAttribute('data-annotation-count');
    });
    clearMarkers();
    if (annotationUI.annotationMode === 'assets') return;

    const markerThreadType = isEditViewActive() ? 'edit' : 'comment';

    const resolveMarkerPosition = (baseTop, baseLeft) => {
      const row = Math.max(0, Math.round(baseTop));
      let nextLeft = Math.max(MIN_MARKER_LEFT, Math.round(baseLeft));
      let slotKey = `${row}:${nextLeft}`;
      while (occupiedMarkerSlots.has(slotKey) && nextLeft > MIN_MARKER_LEFT) {
        nextLeft = Math.max(MIN_MARKER_LEFT, nextLeft - MARKER_STEP);
        slotKey = `${row}:${nextLeft}`;
      }
      occupiedMarkerSlots.add(slotKey);
      return {
        top: row,
        left: nextLeft,
      };
    };

    annotationState.store.threads
      .filter((thread) => store.getThreadType(thread) === markerThreadType)
      .forEach((thread) => {
        const targetEl = getCachedThreadTarget(thread);
        if (!targetEl) return;

        if (isCommentsViewActive()) {
          targetEl.classList.add('annotation-has-comments');
          targetEl.setAttribute('data-annotation-count', String((thread.messages || []).length || 1));
        }

        const rect = targetEl.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > window.innerHeight) return;

        const groups = buildCommentGroups(thread);
        groups.forEach((group, idx) => {
          const marker = document.createElement('button');
          marker.type = 'button';
          marker.className = isEditViewActive() ? 'annotation-edit-marker' : 'annotation-thread-marker';
          marker.dataset.threadId = thread.id;
          marker.dataset.messageId = group.comment.id || '';
          marker.dataset.commentIndex = String(idx);
          marker.title = isEditViewActive() ? `Edit ${idx + 1}` : `Comment ${idx + 1}`;
          marker.setAttribute(
            'aria-label',
            isEditViewActive() ? `Open edit ${idx + 1}` : `Open comment ${idx + 1}`,
          );
          marker.innerHTML = isEditViewActive()
            ? `
          <svg class="annotation-edit-marker-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 17.25V21h3.75L19.81 7.94l-3.75-3.75z"></path>
          </svg>
        `
            : `
          <svg class="annotation-thread-marker-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 4h16v11H7l-3 3z"></path>
          </svg>
        `;

          const position = resolveMarkerPosition(
            rect.top - 8,
            rect.right - 8 - (idx * MARKER_STEP),
          );
          marker.style.top = `${position.top}px`;
          marker.style.left = `${position.left}px`;
          annotationUI.layerEl.appendChild(marker);
        });
      });
  }

  function setPopupSubmitPending(isPending) {
    popupSubmitPending = isPending;

    if (!(annotationUI.popupEl instanceof HTMLElement)) return;

    annotationUI.popupEl.classList.toggle('is-submitting', isPending);
    annotationUI.popupEl.setAttribute('aria-busy', `${isPending}`);

    const input = annotationUI.popupEl.querySelector('.annotation-reply-input');
    const sendBtn = annotationUI.popupEl.querySelector('.annotation-reply-btn');
    const closeBtn = annotationUI.popupEl.querySelector('.annotation-popup-close');

    if (input instanceof HTMLTextAreaElement) {
      input.readOnly = isPending;
    }
    if (sendBtn instanceof HTMLButtonElement) {
      sendBtn.disabled = isPending;
    }
    if (closeBtn instanceof HTMLButtonElement) {
      closeBtn.disabled = isPending;
    }
  }

  async function submitPanelReply(threadId, commentId, rawValue) {
    if (!isCommentsServiceAvailable()) {
      showGlobalSnackbar(ANNOTATION_MESSAGES.commentsUnavailableSnackbar);
      return;
    }
    if (isCollabComplete(ANNOTATION_MESSAGES.collabCompleteCommentRestricted)) return;
    const composerKey = getReplyComposerKey(threadId, commentId);
    if (pendingReplyComposerKeys.has(composerKey)) return;

    const value = (rawValue || '').trim();
    if (!value) return;
    const thread = store.getThreadById(threadId);
    if (!thread) return;
    if (isThreadClosed(thread)) {
      showGlobalSnackbar(ANNOTATION_MESSAGES.closedThreadRestricted);
      return;
    }
    let activeThread = thread;
    let didPersistToService = false;
    let didHydrateThread = false;

    setPanelReplyPending(threadId, commentId, true);
    try {
      const result = await annotationService.createReply(threadId, value);
      if (result?.persisted) {
        didPersistToService = true;
      }
      if (result?.thread) {
        store.upsertThread(result.thread);
        activeThread = store.getThreadById(result.thread.id) || thread;
        didHydrateThread = true;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('Could not save reply to service', error);
    }

    if (!didPersistToService) {
      showGlobalSnackbar(ANNOTATION_MESSAGES.sendReplyError);
      setPanelReplyPending(threadId, commentId, false);
      return;
    }

    if (!didHydrateThread) {
      store.pushThreadMessage(activeThread, value, 'reply');
    }

    hideGlobalSnackbar();
    annotationState.activeThreadId = activeThread.id;
    annotationState.activeMessageId = commentId || getRootComment(activeThread)?.id || '';
    resetPanelReplyComposer(threadId, commentId);
    setPanelReplyPending(threadId, commentId, false);
    if (didHydrateThread) {
      store.saveAnnotationStore();
      renderThreadMarkers({ resolveTargets: true });
      renderCommentsPanel();
      scrollCommentsPanelToBottom();
    } else {
      store.saveAnnotationStore();
      renderCommentsPanel();
    }
    requestParentCollabRefresh('reply-created');
  }

  function removePopup() {
    popupSubmitPending = false;
    if (!annotationUI.popupEl) return;
    annotationUI.popupEl.remove();
    annotationUI.popupEl = null;
  }

  function closePopupAndSelection() {
    clearPopupDraft();
    store.clearSelectedElement();
    removePopup();
  }

  async function submitCommentEdit(threadId, commentId, rawValue) {
    if (!isCommentsServiceAvailable()) {
      showGlobalSnackbar(ANNOTATION_MESSAGES.commentsUnavailableSnackbar);
      return;
    }
    if (isCollabComplete(ANNOTATION_MESSAGES.collabCompleteCommentRestricted)) return;
    const editKey = getCommentEditorKey(threadId, commentId);
    if (pendingCommentEditIds.has(editKey)) return;

    const thread = store.getThreadById(threadId);
    if (!thread) return;
    const message = thread.messages?.find((item) => item.id === commentId);
    if (isThreadClosed(thread)) {
      showGlobalSnackbar(ANNOTATION_MESSAGES.closedThreadRestricted);
      return;
    }
    if (!message || !isCommentEditableByCurrentUser(thread, message)) return;

    const nextValue = `${rawValue || ''}`.trim();
    const previousValue = `${message.text || ''}`.trim();
    if (!nextValue || nextValue === previousValue) {
      closeCommentEditor();
      renderCommentsPanel();
      return;
    }

    setCommentEditPending(threadId, commentId, true);
    try {
      const result = await annotationService.updateComment(commentId, nextValue, threadId);
      if (!result?.persisted) throw new Error('Comment update failed');
      if (result.thread) {
        store.upsertThread(result.thread);
      } else {
        message.text = nextValue;
      }
      hideGlobalSnackbar();
      closeCommentEditor();
      annotationState.activeThreadId = threadId;
      annotationState.activeMessageId = commentId;
      store.saveAnnotationStore();
      renderThreadMarkers({ resolveTargets: true });
      renderCommentsPanel();
      scrollThreadInPanel(threadId, commentId);
      requestParentCollabRefresh('comment-updated');
    } catch (error) {
      showGlobalSnackbar(ANNOTATION_MESSAGES.saveCommentError);
      // eslint-disable-next-line no-console
      console.warn('Could not update comment in service', error);
      setCommentEditPending(threadId, commentId, false);
      return;
    }

    setCommentEditPending(threadId, commentId, false);
  }

  async function submitPopupMessage() {
    if (!isCommentsServiceAvailable()) {
      showGlobalSnackbar(ANNOTATION_MESSAGES.commentsUnavailableSnackbar);
      return;
    }
    if (isCollabComplete(ANNOTATION_MESSAGES.collabCompleteCommentRestricted)) return;
    if (popupSubmitPending) return;
    if (
      !annotationUI.popupEl
      || !annotationState.selectedElement
      || !annotationState.selectedElementPath
    ) return;
    const input = annotationUI.popupEl.querySelector('.annotation-reply-input');
    if (!(input instanceof HTMLTextAreaElement)) return;

    const value = input.value.trim();
    if (!value) return;

    let thread = store.getCommentThreadByElement(annotationState.selectedElement);
    const isReply = Boolean(thread);
    if (isReply && isThreadClosed(thread)) {
      showGlobalSnackbar(ANNOTATION_MESSAGES.closedThreadRestricted);
      return;
    }
    let didPersistToService = false;
    let didHydrateThread = false;
    setPopupSubmitPending(true);
    try {
      if (!thread) {
        const remoteThread = await annotationService.createThread({
          elementPath: annotationState.selectedElementPath,
          body: value,
          quotedText: annotationState.selectedElement.textContent?.trim() || null,
        });
        if (remoteThread) {
          store.upsertThread(remoteThread);
          thread = store.getThreadById(remoteThread.id);
          didPersistToService = true;
        }
      } else {
        const result = await annotationService.createReply(thread.id, value);
        if (result?.persisted) {
          didPersistToService = true;
        }
        if (result?.thread) {
          store.upsertThread(result.thread);
          thread = store.getThreadById(result.thread.id);
          didHydrateThread = true;
        }
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('Could not save comment thread to service', error);
    }

    if (!didPersistToService || !thread) {
      showGlobalSnackbar(
        isReply
          ? ANNOTATION_MESSAGES.sendReplyError
          : ANNOTATION_MESSAGES.postCommentError,
      );
      setPopupSubmitPending(false);
      return;
    }

    hideGlobalSnackbar();
    const latest = thread.messages[thread.messages.length - 1];
    annotationState.activeMessageId = getRootComment(thread)?.id || latest?.id || '';
    annotationState.activeThreadId = thread.id;
    setPopupSubmitPending(false);
    closePopupAndSelection();
    if (didHydrateThread || !isReply) {
      store.saveAnnotationStore();
      renderThreadMarkers({ resolveTargets: true });
      renderCommentsPanel();
      scrollCommentsPanelToBottom();
    } else {
      store.pushThreadMessage(thread, value, 'reply');
      store.saveAnnotationStore();
      renderCommentsPanel();
    }
    requestParentCollabRefresh(isReply ? 'reply-created' : 'comment-created');
  }

  function attachPopupEvents() {
    if (!annotationUI.popupEl) return;
    const input = annotationUI.popupEl.querySelector('.annotation-reply-input');
    const sendBtn = annotationUI.popupEl.querySelector('.annotation-reply-btn');

    if (sendBtn) {
      sendBtn.addEventListener('click', (event) => {
        event.preventDefault();
        submitPopupMessage();
      });
    }

    if (input) {
      input.addEventListener('input', (event) => {
        const { target } = event;
        if (!(target instanceof HTMLTextAreaElement)) return;
        updatePopupDraft(target.value);
      });
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        submitPopupMessage();
      });
    }
  }

  function positionPopup(anchorElement) {
    if (!annotationUI.popupEl) return;
    const panelRect = annotationUI.panelEl?.getBoundingClientRect();
    const maxPopupRight = panelRect ? Math.max(24, panelRect.left - 12) : window.innerWidth - 12;
    const maxPopupWidth = Math.max(220, maxPopupRight - 24);
    annotationUI.popupEl.style.maxWidth = `${maxPopupWidth}px`;

    const rect = anchorElement.getBoundingClientRect();
    const popupWidth = Math.min(annotationUI.popupEl.offsetWidth || 320, maxPopupWidth);
    const popupHeight = annotationUI.popupEl.offsetHeight || 260;

    let left = rect.right + 12;
    if (left + popupWidth > maxPopupRight) {
      left = rect.left - popupWidth - 12;
    }
    left = Math.max(12, Math.min(left, maxPopupRight - popupWidth));

    let { top } = rect;
    top = Math.max(12, Math.min(top, window.innerHeight - popupHeight - 12));

    annotationUI.popupEl.style.left = `${left}px`;
    annotationUI.popupEl.style.top = `${top}px`;
  }

  function preparePopupDraftForElement(element) {
    if (annotationState.selectedElement && annotationState.selectedElement !== element) {
      const popupInput = annotationUI.popupEl?.querySelector('.annotation-reply-input');
      if (popupInput instanceof HTMLTextAreaElement) {
        popupInput.value = '';
      }
      clearPopupDraft();
    }
    return store.buildCommentElementPath(element, annotationUI.mainEl);
  }

  function openPopupForElement(element, shouldScroll = false) {
    if (popupSubmitPending) return;
    if (!annotationUI.layerEl) return;
    if (isCollabComplete()) return;
    const nextElementPath = preparePopupDraftForElement(element);
    setSelectedElement(element);
    syncPopupDraftScope(nextElementPath);
    const thread = store.getCommentThreadByElement(annotationState.selectedElement);
    if (thread && isThreadClosed(thread)) {
      store.clearSelectedElement();
      removePopup();
      showGlobalSnackbar(ANNOTATION_MESSAGES.closedThreadRestricted);
      return;
    }
    annotationState.activeThreadId = thread?.id || '';
    annotationState.activeMessageId = '';
    renderCommentsPanel();
    if (shouldScroll) {
      element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    removePopup();
    const popup = document.createElement('section');
    popup.className = 'annotation-floating-popup';
    popup.dataset.threadId = thread?.id || '';

    const header = document.createElement('div');
    header.className = 'annotation-popup-header';

    const title = document.createElement('h3');
    title.className = 'annotation-popup-title';
    title.textContent = thread ? 'Reply' : 'Comment';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'annotation-popup-close';
    closeBtn.setAttribute('aria-label', 'Close comment');
    closeBtn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6L18 18M18 6L6 18"></path>
      </svg>
    `;

    const rightControls = document.createElement('div');
    rightControls.className = 'annotation-popup-header-controls';
    rightControls.append(closeBtn);
    header.append(title, rightControls);

    const composer = document.createElement('div');
    composer.className = 'annotation-reply-composer';
    const popupFieldId = `annotation-popup-input-${thread?.id || 'new'}`;
    composer.innerHTML = `
      <textarea id="${popupFieldId}" name="${popupFieldId}" class="annotation-reply-input" placeholder="${thread ? 'Write a reply...' : 'Write a comment...'}"></textarea>
      <button type="button" class="annotation-reply-btn" aria-label="${thread ? 'Send reply' : 'Send comment'}">
        <span aria-hidden="true">➤</span>
      </button>
    `;

    popup.append(header, composer);
    annotationUI.layerEl.appendChild(popup);
    annotationUI.popupEl = popup;
    positionPopup(element);
    attachPopupEvents();

    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      closePopupAndSelection();
    });

    const input = popup.querySelector('.annotation-reply-input');
    if (input instanceof HTMLTextAreaElement) {
      input.value = popupDraft;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function syncFloatingUI() {
    if (!annotationUI.mainEl) return;
    renderThreadMarkers();
    if (annotationUI.popupEl && annotationState.selectedElement) {
      positionPopup(annotationState.selectedElement);
    }
  }

  function scheduleFloatingUISync() {
    if (annotationState.floatingUiFrameId) return;
    annotationState.floatingUiFrameId = window.requestAnimationFrame(() => {
      annotationState.floatingUiFrameId = null;
      syncFloatingUI();
    });
  }

  function teardownGlobalListeners(options = {}) {
    const {
      preserveRemoteEditState = false,
    } = options;
    hideGlobalSnackbar();
    closeCommentEditor();
    pendingCommentsPanelRefresh = false;
    if (!preserveRemoteEditState) {
      clearSelfSavedEditsFingerprint();
      annotationState.pendingRemoteEditsSnapshot = null;
      annotationState.hasLoadedInitialEditsSnapshot = false;
    }
    panelReplyDrafts.clear();
    popupDraft = '';
    popupDraftKey = '';
    if (annotationState.floatingUiFrameId) {
      window.cancelAnimationFrame(annotationState.floatingUiFrameId);
      annotationState.floatingUiFrameId = null;
    }
    if (annotationUI.mainEl && annotationState.mainScrollHandler) {
      annotationUI.mainEl.removeEventListener('scroll', annotationState.mainScrollHandler);
      annotationState.mainScrollHandler = null;
    }
    if (annotationUI.mainEl && annotationState.mainClickHandler) {
      annotationUI.mainEl.removeEventListener('click', annotationState.mainClickHandler, true);
      annotationState.mainClickHandler = null;
    }
    if (annotationUI.layerEl && annotationState.layerClickHandler) {
      annotationUI.layerEl.removeEventListener('click', annotationState.layerClickHandler);
      annotationState.layerClickHandler = null;
    }
    if (annotationUI.panelEl && annotationState.panelClickHandler) {
      annotationUI.panelEl.removeEventListener('click', annotationState.panelClickHandler);
      annotationState.panelClickHandler = null;
    }
    if (annotationUI.canvasRefreshBarEl && annotationState.canvasRefreshBarClickHandler) {
      const refreshButton = annotationUI.canvasRefreshBarEl.querySelector('.annotation-canvas-refresh-btn');
      if (refreshButton instanceof HTMLButtonElement) {
        refreshButton.removeEventListener('click', annotationState.canvasRefreshBarClickHandler);
      }
      annotationState.canvasRefreshBarClickHandler = null;
    }
    if (annotationUI.canvasRefreshBarEl) {
      annotationUI.canvasRefreshBarEl.remove();
      annotationUI.canvasRefreshBarEl = null;
    }
    if (annotationUI.panelEl && annotationState.panelInputHandler) {
      annotationUI.panelEl.removeEventListener('input', annotationState.panelInputHandler);
      annotationState.panelInputHandler = null;
    }
    if (annotationUI.panelEl && annotationState.panelKeydownHandler) {
      annotationUI.panelEl.removeEventListener('keydown', annotationState.panelKeydownHandler);
      annotationState.panelKeydownHandler = null;
    }
    if (annotationUI.panelEl && annotationState.panelFocusoutHandler) {
      annotationUI.panelEl.removeEventListener('focusout', annotationState.panelFocusoutHandler);
      annotationState.panelFocusoutHandler = null;
    }
    if (annotationUI.panelEl && annotationState.panelChangeHandler) {
      annotationUI.panelEl.removeEventListener('change', annotationState.panelChangeHandler);
      annotationState.panelChangeHandler = null;
    }
    if (annotationUI.inlineToggleEl && annotationState.inlineToggleChangeHandler) {
      annotationUI.inlineToggleEl.removeEventListener('change', annotationState.inlineToggleChangeHandler);
      annotationState.inlineToggleChangeHandler = null;
    }
    if (annotationUI.inlineCommentsToggleEl && annotationState.inlineCommentsToggleChangeHandler) {
      annotationUI.inlineCommentsToggleEl.removeEventListener(
        'change',
        annotationState.inlineCommentsToggleChangeHandler,
      );
      annotationState.inlineCommentsToggleChangeHandler = null;
    }
    if (annotationUI.inlineAssetsToggleEl && annotationState.inlineAssetsToggleChangeHandler) {
      annotationUI.inlineAssetsToggleEl.removeEventListener(
        'change',
        annotationState.inlineAssetsToggleChangeHandler,
      );
      annotationState.inlineAssetsToggleChangeHandler = null;
    }
    if (annotationState.documentClickHandler) {
      document.removeEventListener('click', annotationState.documentClickHandler);
      annotationState.documentClickHandler = null;
    }
    if (annotationState.windowResizeHandler) {
      window.removeEventListener('resize', annotationState.windowResizeHandler);
      annotationState.windowResizeHandler = null;
    }
  }

  async function setupAnnotationUI(mainEl, options = {}) {
    const {
      preserveRemoteEditState = false,
    } = options;
    teardownGlobalListeners({ preserveRemoteEditState });
    annotationState.isCollabComplete = window.streamConfig?.collabComplete === true;
    annotationUI.mainEl = mainEl;
    ensureFloatingLayer();
    ensureCommentsPanel();
    ensureCanvasRefreshBar();
    store.loadAnnotationStore();
    store.rebindThreadsToCurrentDom();
    store.saveAnnotationStore();
    renderThreadMarkers({ resolveTargets: true });
    renderCommentsPanel();

    annotationState.mainClickHandler = (event) => {
      if (!isCommentsViewActive()) return;
      if (!isCommentsServiceAvailable()) return;
      if (isCollabComplete()) return;
      if (popupSubmitPending) return;
      const { target } = event;
      if (!(target instanceof HTMLElement)) return;
      if (target === mainEl) return;
      if (target.closest('a')) event.preventDefault();
      event.stopPropagation();
      openPopupForElement(target);
    };
    mainEl.addEventListener('click', annotationState.mainClickHandler, true);

    annotationState.layerClickHandler = (event) => {
      const { target } = event;
      if (!(target instanceof Element)) return;
      const editMarker = target.closest('.annotation-edit-marker');
      if (editMarker instanceof HTMLButtonElement) {
        scrollThreadInPanel(
          editMarker.dataset.threadId,
          editMarker.dataset.messageId,
          Number.parseInt(editMarker.dataset.commentIndex || '0', 10),
        );
        return;
      }
      const marker = target.closest('.annotation-thread-marker');
      if (!(marker instanceof HTMLButtonElement)) return;
      scrollThreadInPanel(
        marker.dataset.threadId,
        marker.dataset.messageId,
        Number.parseInt(marker.dataset.commentIndex || '0', 10),
      );
    };
    annotationUI.layerEl.addEventListener('click', annotationState.layerClickHandler);

    annotationState.panelClickHandler = async (event) => {
      const { target } = event;
      if (!(target instanceof Element)) return;
      if (target.closest('.annotation-inline-edit-switcher')) return;
      if (!isCommentsServiceAvailable()) return;
      const card = target.closest('.annotation-panel-comment');

      if (getVisibleThreadType() === 'edit') {
        if (!(card instanceof HTMLElement)) return;
        const thread = store.getThreadById(card.dataset.threadId);
        if (!thread) return;
        const targetEl = store.getElementForThread(thread);
        if (targetEl) targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        annotationState.activeThreadId = thread.id;
        annotationState.activeMessageId = card.dataset.messageId || '';
        renderCommentsPanel();
        return;
      }

      if (target.closest('.annotation-panel-reply-btn')) {
        if (isCollabComplete(ANNOTATION_MESSAGES.collabCompleteCommentRestricted)) return;
        const replyBtn = target.closest('.annotation-panel-reply-btn');
        if (!(replyBtn instanceof HTMLButtonElement)) return;
        const { threadId, commentId } = replyBtn.dataset;
        if (!threadId) return;
        const thread = store.getThreadById(threadId);
        if (isThreadClosed(thread)) {
          showGlobalSnackbar(ANNOTATION_MESSAGES.closedThreadRestricted);
          return;
        }
        const input = annotationUI.panelEl.querySelector(
          `.annotation-panel-reply-input[data-thread-id="${threadId}"][data-comment-id="${commentId}"]`,
        );
        if (!(input instanceof HTMLInputElement)) return;
        submitPanelReply(threadId, commentId, input.value);
        return;
      }

      if (target.closest('.annotation-panel-edit-save-btn')) {
        const saveBtn = target.closest('.annotation-panel-edit-save-btn');
        if (!(saveBtn instanceof HTMLButtonElement)) return;
        const { threadId, commentId } = saveBtn.dataset;
        if (!threadId || !commentId) return;
        const input = annotationUI.panelEl.querySelector(
          `.annotation-panel-edit-input[data-thread-id="${threadId}"][data-comment-id="${commentId}"]`,
        );
        if (!(input instanceof HTMLTextAreaElement)) return;
        submitCommentEdit(threadId, commentId, input.value);
        return;
      }

      if (target.closest('.annotation-panel-edit-cancel-btn')) {
        closeCommentEditor();
        renderCommentsPanel();
        return;
      }

      if (target.closest('.annotation-panel-edit-btn')) {
        if (isCollabComplete(ANNOTATION_MESSAGES.collabCompleteCommentRestricted)) return;
        const editBtn = target.closest('.annotation-panel-edit-btn');
        if (!(editBtn instanceof HTMLButtonElement)) return;
        const { threadId, commentId } = editBtn.dataset;
        if (!threadId || !commentId) return;
        const thread = store.getThreadById(threadId);
        const message = thread?.messages?.find((item) => item.id === commentId);
        if (isThreadClosed(thread)) {
          showGlobalSnackbar(ANNOTATION_MESSAGES.closedThreadRestricted);
          return;
        }
        if (!message || !isCommentEditableByCurrentUser(thread, message)) return;
        if (!openCommentEditor(threadId, commentId, message.text || '')) return;
        renderCommentsPanel();
        focusCommentEditor(threadId, commentId);
        return;
      }

      if (target.closest('.annotation-panel-reply-input')) return;
      if (target.closest('.annotation-panel-edit-form')) return;
      if (target.closest('.annotation-panel-status-select')) return;
      if (!(card instanceof HTMLElement)) return;

      const thread = store.getThreadById(card.dataset.threadId);
      if (!thread) return;
      annotationState.activeEditId = '';
      annotationState.activeMessageId = card.dataset.messageId || '';
      const targetEl = store.getElementForThread(thread);
      if (!targetEl) return;
      if (isThreadClosed(thread)) {
        annotationState.activeThreadId = thread.id;
        renderCommentsPanel();
        targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      if (isCollabComplete()) {
        annotationState.activeThreadId = thread.id;
        renderCommentsPanel();
        targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      openPopupForElement(targetEl, true);
    };
    annotationUI.panelEl.addEventListener('click', annotationState.panelClickHandler);

    annotationState.panelInputHandler = (event) => {
      const { target } = event;
      if (target instanceof HTMLInputElement && target.classList.contains('annotation-panel-reply-input')) {
        updatePanelReplyDraft(target.dataset.threadId, target.dataset.commentId, target.value);
        return;
      }
      if (!(target instanceof HTMLTextAreaElement)) return;
      if (!target.classList.contains('annotation-panel-edit-input')) return;
      updateCommentEditorDraft(target.value);
    };
    annotationUI.panelEl.addEventListener('input', annotationState.panelInputHandler);

    annotationState.panelKeydownHandler = (event) => {
      if (annotationUI.inlineMode) return;
      if (!isCommentsServiceAvailable()) return;
      const { target } = event;
      if (target instanceof HTMLInputElement && target.classList.contains('annotation-panel-reply-input')) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        submitPanelReply(target.dataset.threadId, target.dataset.commentId, target.value);
        return;
      }
      if (!(target instanceof HTMLTextAreaElement)) return;
      if (!target.classList.contains('annotation-panel-edit-input')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCommentEditor();
        renderCommentsPanel();
        return;
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submitCommentEdit(target.dataset.threadId, target.dataset.commentId, target.value);
      }
    };
    annotationUI.panelEl.addEventListener('keydown', annotationState.panelKeydownHandler);

    annotationState.panelFocusoutHandler = () => {
      schedulePendingCommentsPanelRefreshFlush();
    };
    annotationUI.panelEl.addEventListener('focusout', annotationState.panelFocusoutHandler);

    annotationState.panelChangeHandler = async (event) => {
      const { target } = event;
      if (target instanceof HTMLInputElement && target.classList.contains('annotation-inline-mode-radio')) return;
      if (annotationUI.inlineMode) return;
      if (!isCommentsServiceAvailable()) return;
      if (!(target instanceof HTMLSelectElement)) return;
      if (!target.classList.contains('annotation-panel-status-select')) return;
      if (isCollabComplete(ANNOTATION_MESSAGES.collabCompleteCommentRestricted)) return;
      const { threadId } = target.dataset;
      if (!threadId) return;
      const thread = store.getThreadById(threadId);
      if (!thread) return;
      if (!isThreadStatusEditableByCurrentUser(thread)) {
        target.value = thread.status;
        target.disabled = true;
        showGlobalSnackbar(ANNOTATION_MESSAGES.updateStatusRestricted);
        window.setTimeout(() => {
          target.disabled = false;
        }, 0);
        return;
      }
      const previousStatus = thread.status;
      const nextStatus = target.value;
      target.value = previousStatus;
      target.disabled = true;
      annotationState.activeThreadId = thread.id;
      annotationState.activeMessageId = '';
      try {
        const remoteThread = await annotationService.updateThreadStatus(threadId, nextStatus);
        if (!remoteThread) return;
        store.upsertThread(remoteThread);
        hideGlobalSnackbar();
        store.saveAnnotationStore();
        renderThreadMarkers({ resolveTargets: true });
        renderCommentsPanel();
        requestParentCollabRefresh('thread-status-updated');
      } catch (error) {
        showGlobalSnackbar(ANNOTATION_MESSAGES.updateStatusError);
        target.value = previousStatus;
        renderCommentsPanel();
        // eslint-disable-next-line no-console
        console.warn('Could not update thread status in service', error);
      } finally {
        target.disabled = false;
      }
    };
    annotationUI.panelEl.addEventListener('change', annotationState.panelChangeHandler);

    annotationState.documentClickHandler = (event) => {
      if (annotationUI.inlineMode) return;
      if (popupSubmitPending) return;
      const { target } = event;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('.annotation-floating-popup')) return;
      if (target.closest('.annotation-thread-marker')) return;
      if (target.closest('.annotation-comments-panel')) return;
      if (target.closest('main')) return;
      closePopupAndSelection();
    };
    document.addEventListener('click', annotationState.documentClickHandler);

    annotationState.mainScrollHandler = scheduleFloatingUISync;
    annotationState.windowResizeHandler = scheduleFloatingUISync;
    mainEl.addEventListener('scroll', annotationState.mainScrollHandler);
    window.addEventListener('resize', annotationState.windowResizeHandler);

    if (annotationUI.inlineToggleEl) {
      annotationState.inlineToggleChangeHandler = async (event) => {
        const { target } = event;
        if (!(target instanceof HTMLInputElement) || !target.checked) return;
        if (isCollabComplete()) {
          closeCommentEditor();
          closePopupAndSelection();
          annotationUI.annotationMode = 'comments';
          await disableInlineEditMode();
          if (annotationUI.inlineCommentsToggleEl) {
            annotationUI.inlineCommentsToggleEl.checked = true;
          }
          if (annotationUI.inlineToggleEl) annotationUI.inlineToggleEl.checked = false;
          if (annotationUI.inlineAssetsToggleEl) annotationUI.inlineAssetsToggleEl.checked = false;
          showGlobalSnackbar(ANNOTATION_MESSAGES.collabCompleteEditRestricted);
          renderThreadMarkers({ resolveTargets: true });
          renderCommentsPanel();
          return;
        }
        if (!isInlineEditingAllowed()) {
          closeCommentEditor();
          closePopupAndSelection();
          annotationUI.annotationMode = 'edit';
          await disableInlineEditMode();
          if (annotationUI.inlineCommentsToggleEl) {
            annotationUI.inlineCommentsToggleEl.checked = false;
          }
          if (annotationUI.inlineAssetsToggleEl) annotationUI.inlineAssetsToggleEl.checked = false;
          renderThreadMarkers({ resolveTargets: true });
          renderCommentsPanel();
          return;
        }
        if (!isCommentsServiceAvailable()) {
          target.checked = false;
          if (annotationUI.inlineCommentsToggleEl) {
            annotationUI.inlineCommentsToggleEl.checked = true;
          }
          annotationUI.annotationMode = 'comments';
          showGlobalSnackbar(ANNOTATION_MESSAGES.collabUnavailableSnackbar);
          return;
        }
        target.disabled = true;
        try {
          closeCommentEditor();
          closePopupAndSelection();
          annotationUI.annotationMode = 'edit';
          if (annotationUI.inlineAssetsToggleEl) annotationUI.inlineAssetsToggleEl.checked = false;
          const didEnable = await enableInlineEditMode();
          if (!didEnable) {
            throw new Error('Inline edit mode unavailable');
          }
        } catch {
          target.checked = false;
          if (annotationUI.inlineCommentsToggleEl) {
            annotationUI.inlineCommentsToggleEl.checked = true;
          }
          annotationUI.annotationMode = 'comments';
        } finally {
          target.disabled = false;
        }
        renderThreadMarkers({ resolveTargets: true });
        renderCommentsPanel();
      };
      annotationUI.inlineToggleEl.addEventListener('change', annotationState.inlineToggleChangeHandler);
    }

    if (annotationUI.inlineCommentsToggleEl) {
      annotationState.inlineCommentsToggleChangeHandler = async (event) => {
        const { target } = event;
        if (!(target instanceof HTMLInputElement) || !target.checked) return;
        closeCommentEditor();
        annotationUI.annotationMode = 'comments';
        await disableInlineEditMode();
        if (annotationUI.inlineToggleEl) annotationUI.inlineToggleEl.checked = false;
        if (annotationUI.inlineAssetsToggleEl) annotationUI.inlineAssetsToggleEl.checked = false;
        renderThreadMarkers({ resolveTargets: true });
        renderCommentsPanel();
      };
      annotationUI.inlineCommentsToggleEl.addEventListener(
        'change',
        annotationState.inlineCommentsToggleChangeHandler,
      );
    }

    if (annotationUI.inlineAssetsToggleEl) {
      annotationState.inlineAssetsToggleChangeHandler = async (event) => {
        const { target } = event;
        if (!(target instanceof HTMLInputElement) || !target.checked) return;
        closeCommentEditor();
        annotationUI.annotationMode = 'assets';
        await disableInlineEditMode();
        if (annotationUI.inlineToggleEl) annotationUI.inlineToggleEl.checked = false;
        if (annotationUI.inlineCommentsToggleEl) {
          annotationUI.inlineCommentsToggleEl.checked = false;
        }
        renderThreadMarkers({ resolveTargets: true });
        renderCommentsPanel();
      };
      annotationUI.inlineAssetsToggleEl.addEventListener(
        'change',
        annotationState.inlineAssetsToggleChangeHandler,
      );
    }
  }

  return {
    applyPendingRemoteEditsSnapshot,
    applyRemoteCollabSnapshot,
    markSelfSavedEditsSnapshot,
    removePopup,
    renderCommentsPanel,
    renderThreadMarkers,
    setInlineModeHandlers,
    setupAnnotationUI,
  };
}
