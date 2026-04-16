/* eslint-disable no-console */
/* eslint-disable no-use-before-define */
import {
  persistOnTarget,
  targetCompatibleHtml,
} from './target/da.js';
import {
  pushTargetHtmlToStore,
  fetchPreviewHtmlFromStore,
  pushPreviewHtmlToStore,
  fetchTargetHtmlFromStore,
  resetEditChangesInStore,
  resetPreviewHtmlInStore,
  resetTargetHtmlInStore,
} from './store/store.js';
import {
  getQueryParam,
  fixRelativeLinks,
  initializeTokens,
  getConfig,
  miloLoadArea,
} from './utils/utils.js';
import { handleError } from './utils/error-handler.js';
import { showGlobalSnackbar } from './utils/snackbar.js';
import {
  createStreamOperation,
  editStreamOperation,
  applyEditChanges,
  handleBackToEditor,
  preflightOperation,
  annotationOperation,
  refreshAnnotationFloatingUI,
  persistAnnotationChangesToDA,
  saveAnnotationChanges,
  applyRemoteCollabSnapshot,
  preparePendingRemoteEditsRefresh,
} from './utils/operations.js';
import {
  ANNOTATION_REFRESH_EVENT,
  ANNOTATION_READY_EVENT,
  ANNOTATION_MESSAGES,
  LOADER_PROGRESS_STEPS,
  LOADER_STEP_MESSAGES,
} from './utils/constants.js';
import {
  initializeLoader,
  updateLoader,
  hideLoader,
  notifyParentPreviewInteractive,
} from './utils/loader.js';

function parseBooleanFlag(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function isCollabOwnerRole(role) {
  const normalizedRole = `${role || ''}`
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  if (!normalizedRole) return false;
  return normalizedRole === 'owner'
    || normalizedRole === 'collab owner'
    || normalizedRole.endsWith(' owner');
}

function resolveInlineEditingAllowed(previewParams = {}) {
  const explicitFlag = parseBooleanFlag(previewParams.inlineEditingAllowed);
  if (explicitFlag !== null) return explicitFlag;
  if (previewParams.collabRole) return isCollabOwnerRole(previewParams.collabRole);
  return false;
}

function hideDOMElements(eles = []) {
  if (!eles.length) return;
  eles.forEach((ele) => {
    if (!ele) return;
    ele.style.display = 'none';
    ele.classList.remove('is-visible');
  });
}

function showDOMElements(eles = []) {
  if (!eles.length) return;
  eles.forEach((ele) => {
    if (!ele) return;
    ele.style.display = 'block';
  });
}

async function postOperationProcessing(rawhtml) {
  let html = fixRelativeLinks(rawhtml);
  pushPreviewHtmlToStore(html);
  updateLoader({
    message: LOADER_STEP_MESSAGES.START_PAINTING,
    percentage: LOADER_PROGRESS_STEPS.START_PAINTING,
  });
  await startHTMLPainting();
  html = targetCompatibleHtml(html);
  pushTargetHtmlToStore(html);
  hideLoader();
}

function notifyAnnotationReady() {
  if (!window.parent || window.parent === window) return;
  window.parent.postMessage({
    type: ANNOTATION_READY_EVENT,
    storeId: getQueryParam('storeId'),
  }, '*');
}

export async function initiatePreviewer(forceOperation = null) {
  let html = '';
  switch (forceOperation || window.streamConfig.operation) {
    case 'create':
      html = await createStreamOperation();
      await postOperationProcessing(html);
      break;
    case 'edit':
      updateLoader({ message: 'Preparing the editor. Please wait' });
      await editStreamOperation();
      hideLoader();
      return;
    case 'preflight':
      updateLoader();
      await preflightOperation();
      hideLoader();
      break;
    case 'annotation':
      updateLoader();
      await annotationOperation();
      hideLoader();
      notifyAnnotationReady();
      break;
    default:
      break;
  }
}

async function startHTMLPainting() {
  paintHtmlOnPage();
  await miloLoadArea();
}

async function paintHtmlOnPage() {
  const headerEle = document.createElement('header');
  const mainEle = document.createElement('main');
  mainEle.innerHTML = fetchPreviewHtmlFromStore();
  document.body.prepend(mainEle);
  document.body.prepend(headerEle);
}

async function requestStreamConfigFromParent() {
  const storeId = getQueryParam('storeId');

  // If there is no parent window or no storeId, fall back to query params (legacy behavior)
  if (!window.parent || window.parent === window || !storeId) {
    return {
      source: getQueryParam('source'),
      contentUrl: getQueryParam('contentUrl'),
      target: getQueryParam('target'),
      targetUrl: getQueryParam('targetUrl'),
      pageUrl: getQueryParam('pageUrl') || getQueryParam('page_url'),
      token: getQueryParam('token'),
      profileId: getQueryParam('profileId') || getQueryParam('profile_id'),
      collabId: getQueryParam('collabId') || getQueryParam('collab_id'),
      operation: getQueryParam('operation') || 'create',
      preflightUrl: getQueryParam('preflightUrl'),
      selectedPageBlocks: getQueryParam('selectedPageBlock') ? getQueryParam('selectedPageBlock').split(',') : [],
      selectedPageBlockIndices: getQueryParam('selectedPageBlockIndex') ? getQueryParam('selectedPageBlockIndex').split(',') : [],
      reviewId: getQueryParam('reviewId') || getQueryParam('reviewid'),
      startReview: getQueryParam('startReview') || getQueryParam('startreview'),
      inlineEditingAllowed: getQueryParam('inlineEditingAllowed'),
      collabRole: getQueryParam('collabRole'),
      collabComplete: getQueryParam('collabComplete'),
    };
  }

  const config = await getConfig();
  const allowedOrigins = config.streamMapper.allowMessagesFromDomains || [];

  // Ask parent for preview parameters using storeId
  return new Promise((resolve) => {
    const handler = (event) => {
      const isOriginAllowed = allowedOrigins.some((pattern) => {
        const regex = new RegExp(`^${pattern.replace('*', '.*')}$`);
        return regex.test(event.origin);
      });
      if (!isOriginAllowed) return;

      const data = event.data || {};
      if (data.type !== 'STREAM_PREVIEW_PARAMS') return;
      if (data.storeId && data.storeId !== storeId) return;

      window.removeEventListener('message', handler);
      resolve(data.params);
    };

    window.addEventListener('message', handler);

    window.parent.postMessage({
      type: 'STREAM_PREVIEW_PARAMS',
      storeId,
    }, '*');
  });
}

async function setupMessageListener() {
  window.addEventListener('message', async (event) => {
    const config = await getConfig();
    const allowedOrigins = config.streamMapper.allowMessagesFromDomains;
    const isOriginAllowed = allowedOrigins.some((pattern) => {
      const regex = new RegExp(`^${pattern.replace('*', '.*')}$`);
      return regex.test(event.origin);
    });
    if (!isOriginAllowed) return;

    if (event.data.type === 'PUSH_TO_DA') {
      await persist();
    }
    if (event.data.type === 'SAVE_ANNOTATION_CHANGES') {
      await saveChanges();
    }
    if (event.data.type === 'RUN_PREFLIGHT') {
      const url = new URL(window.location.href);
      url.searchParams.set('forceOperation', 'preflight');
      window.location.href = url.toString();
    }
    if (event.data.type === 'EDIT_APPLY_CHANGES') {
      await applyEditChanges();
    }
    if (event.data.type === 'BACK_TO_EDIT') {
      await handleBackToEditor();
    }
    if (event.data.type === 'RESET') {
      window.location.reload();
    }
    if (event.data.type === 'STREAM_GET_TARGET_HTML') {
      const bodyHtml = fetchTargetHtmlFromStore() || '';
      event.source?.postMessage({
        type: 'STREAM_TARGET_HTML',
        requestId: event.data.requestId,
        storeId: getQueryParam('storeId'),
        bodyHtml,
      }, event.origin);
    }
    if (event.data.type === 'STREAM_COLLAB_SNAPSHOT') {
      if (window.streamConfig.operation !== 'annotation') return;
      const collabPageUrl = event.data?.payload?.collab?.pageUrl;
      if (collabPageUrl) window.streamConfig.pageUrl = collabPageUrl;
      applyRemoteCollabSnapshot(event.data.payload || {});
    }
  });

  window.addEventListener(ANNOTATION_REFRESH_EVENT, async () => {
    await refreshAnnotationCanvas();
  });
}

export default async function initPreviewer() {
  resetTargetHtmlInStore();
  resetPreviewHtmlInStore();
  resetEditChangesInStore();
  initializeLoader();
  const previewParams = await requestStreamConfigFromParent();
  if (getQueryParam('forceOperation')) previewParams.operation = getQueryParam('forceOperation');
  window.streamConfig = {
    source: previewParams.source,
    contentUrl: previewParams.contentUrl,
    target: previewParams.target,
    targetUrl: previewParams.targetUrl,
    pageUrl: previewParams.pageUrl
      || previewParams.page_url
      || previewParams.collab?.pageUrl
      || null,
    token: previewParams.token,
    profileId: previewParams.profileId || previewParams.profile_id || null,
    collabId: previewParams.collabId || previewParams.collab_id || null,
    operation: previewParams.operation || 'create',
    preflightUrl: previewParams.preflightUrl,
    selectedPageBlocks: previewParams.selectedPageBlocks || [],
    selectedPageBlockIndices: previewParams.selectedPageBlockIndices || [],
    username: previewParams.username || null,
    reviewId: previewParams.reviewId || previewParams.reviewid || null,
    startReview: previewParams.startReview || previewParams.startreview || false,
    inlineEditingAllowed: resolveInlineEditingAllowed(previewParams),
    collabRole: previewParams.collabRole || null,
    collabComplete: parseBooleanFlag(previewParams.collabComplete),
  };
  await initializeTokens(window.streamConfig.token);
  await initiatePreviewer();
  await setupMessageListener();
}

export async function persist() {
  try {
    notifyParentPreviewInteractive(false);
    updateLoader({ message: 'Pushing content to DA' });
    hideDOMElements([document.querySelector('main')]);
    if (window.streamConfig.operation === 'annotation') {
      await persistAnnotationChangesToDA();
    } else {
      await persistOnTarget();
    }
    hideLoader();
    showDOMElements([document.querySelector('main')]);
  } catch (error) {
    hideLoader();
    showDOMElements([document.querySelector('main')]);
    handleError(error, 'persisting content');
    throw error;
  }
}

export async function saveChanges() {
  const isAnnotationOperation = window.streamConfig.operation === 'annotation';
  try {
    updateLoader({
      message: LOADER_STEP_MESSAGES.SAVE_PREPARING,
      percentage: LOADER_PROGRESS_STEPS.SAVE_PREPARING,
    });
    hideDOMElements([document.querySelector('main')]);
    if (isAnnotationOperation) {
      await saveAnnotationChanges((stage) => {
        if (stage === 'htmlSaved') {
          updateLoader({
            message: LOADER_STEP_MESSAGES.SAVE_HTML_DONE,
            percentage: LOADER_PROGRESS_STEPS.SAVE_HTML_DONE,
          });
        }
        if (stage === 'editsSaved') {
          updateLoader({
            message: LOADER_STEP_MESSAGES.SAVE_METADATA_DONE,
            percentage: LOADER_PROGRESS_STEPS.SAVE_METADATA_DONE,
          });
        }
      });
      updateLoader({
        message: LOADER_STEP_MESSAGES.START_PAINTING,
        percentage: LOADER_PROGRESS_STEPS.START_PAINTING,
      });
      await annotationOperation({
        preserveRemoteEditState: true,
      });
    } else {
      await persistOnTarget();
    }
    showDOMElements([document.querySelector('main')]);
    if (isAnnotationOperation) {
      await refreshAnnotationFloatingUI();
    }
    hideLoader();
    if (isAnnotationOperation) {
      notifyAnnotationReady();
    }
  } catch (error) {
    hideLoader();
    showDOMElements([document.querySelector('main')]);
    if (isAnnotationOperation) {
      showGlobalSnackbar(ANNOTATION_MESSAGES.saveEditsError);
    } else {
      handleError(error, 'saving changes');
    }
    throw error;
  }
}

export async function refreshAnnotationCanvas() {
  if (window.streamConfig.operation !== 'annotation') return;

  try {
    updateLoader({
      message: LOADER_STEP_MESSAGES.START_PAINTING,
      percentage: LOADER_PROGRESS_STEPS.START_PAINTING,
    });
    hideDOMElements([document.querySelector('main')]);
    preparePendingRemoteEditsRefresh();
    await annotationOperation({
      preserveRemoteEditState: true,
    });
    showDOMElements([document.querySelector('main')]);
    await refreshAnnotationFloatingUI();
    hideLoader();
    notifyAnnotationReady();
  } catch (error) {
    hideLoader();
    showDOMElements([document.querySelector('main')]);
    showGlobalSnackbar(ANNOTATION_MESSAGES.refreshEditsError);
    throw error;
  }
}
