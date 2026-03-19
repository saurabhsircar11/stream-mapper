const DA_Y_WRAPPER_MODULE_URL = '../../vendor/da-y-wrapper/dist/index.js';
const DA_ADMIN_ORIGIN = 'https://admin.da.live';
const DA_COLLAB_SERVER_URL = 'wss://collab.da.live';

let collabModulesPromise = null;

function normalizeBearerToken(token) {
  const value = `${token || ''}`.trim();
  if (!value) return '';
  return value.replace(/^Bearer\s+/i, '').trim();
}

function normalizeDaDocumentPath(documentUrl) {
  const rawValue = `${documentUrl || ''}`.trim();
  if (!rawValue) return '';

  if (/^https?:\/\//i.test(rawValue)) {
    try {
      const parsedUrl = new URL(rawValue);
      if (parsedUrl.hostname.includes('da.live') && parsedUrl.hash.startsWith('#/')) {
        const hashPath = decodeURIComponent(parsedUrl.hash.slice(2)).replace(/^\/+/, '');
        return hashPath.replace(/\.html$/i, '');
      }
      return `${parsedUrl.pathname || ''}`.replace(/^\/+/, '').replace(/\.html$/i, '');
    } catch (error) {
      return '';
    }
  }

  return rawValue.replace(/^\/+/, '').replace(/\.html$/i, '');
}

function buildDaDocumentPathCandidates(documentUrl) {
  const normalizedPath = normalizeDaDocumentPath(documentUrl);
  if (!normalizedPath) return [];

  const pathWithoutSource = normalizedPath.replace(/^source\//, '');
  const candidates = [
    `source/${pathWithoutSource}`,
    pathWithoutSource,
  ];

  return Array.from(new Set(candidates.filter(Boolean))).map((candidate) => `/${candidate}.html`);
}

export function buildDaCollabRoomCandidates(documentUrl) {
  return buildDaDocumentPathCandidates(documentUrl)
    .map((path) => `${DA_ADMIN_ORIGIN}${path}`);
}

export function buildDaCollabRoomName(documentUrl) {
  return buildDaCollabRoomCandidates(documentUrl)[0] || '';
}

function generateAwarenessColor(seedValue) {
  const seed = `${seedValue || 'stream-user'}`;
  let hash = 0;
  for (let idx = 0; idx < seed.length; idx += 1) {
    // eslint-disable-next-line no-bitwise
    hash = seed.charCodeAt(idx) + ((hash << 5) - hash);
  }
  hash = Math.abs(hash);

  const hue = hash % 360;
  const saturation = 65 + (hash % 15);
  const lightness = 45 + (hash % 10);

  return `hsl(${hue}deg ${saturation}% ${lightness}%)`;
}

function buildAwarenessUser({
  profileId,
  displayName,
  provider,
}) {
  const resolvedProfileId = `${profileId || ''}`.trim();
  const resolvedDisplayName = `${displayName || ''}`.trim();

  if (resolvedProfileId && resolvedDisplayName) {
    return {
      color: generateAwarenessColor(resolvedProfileId),
      id: resolvedProfileId,
      name: resolvedDisplayName,
    };
  }

  return {
    color: generateAwarenessColor(`${provider?.awareness?.clientID || 'stream-user'}`),
    id: resolvedProfileId || `anonymous-${provider?.awareness?.clientID || 'stream-user'}`,
    name: resolvedDisplayName || 'Anonymous',
  };
}

function resolveGlobalCollabModules() {
  const globalCandidates = [
    {
      Y: window.Y,
      WebsocketProvider: window.WebsocketProvider,
    },
    {
      Y: window.Y,
      WebsocketProvider: window.YWebsocket?.WebsocketProvider,
    },
    {
      Y: window.Yjs,
      WebsocketProvider: window.WebsocketProvider,
    },
    {
      Y: window.Yjs,
      WebsocketProvider: window.YWebsocket?.WebsocketProvider,
    },
    {
      Y: window.daYWrapper?.Y,
      WebsocketProvider: window.daYWrapper?.WebsocketProvider,
    },
  ];

  return globalCandidates.find((candidate) => (
    candidate?.Y?.Doc
    && typeof candidate?.WebsocketProvider === 'function'
  )) || null;
}

async function loadCollabModules() {
  const globalModules = resolveGlobalCollabModules();
  if (globalModules) return globalModules;

  if (!collabModulesPromise) {
    collabModulesPromise = import(DA_Y_WRAPPER_MODULE_URL).then((wrapperModule) => {
      if (!wrapperModule?.Y?.Doc || typeof wrapperModule?.WebsocketProvider !== 'function') {
        throw new Error('Could not resolve Yjs modules for DA collab');
      }

      return {
        Y: wrapperModule.Y,
        WebsocketProvider: wrapperModule.WebsocketProvider,
      };
    });
  }

  return collabModulesPromise;
}

export default function createDaCollabClient({
  token,
  contentUrl,
  displayName,
  profileId,
  targetUrl,
}) {
  const statusHandlers = new Set();
  const normalizedToken = normalizeBearerToken(token);
  const roomCandidates = buildDaCollabRoomCandidates(contentUrl || targetUrl);
  const debugState = {
    serverUrl: DA_COLLAB_SERVER_URL,
    roomName: roomCandidates[0] || '',
    roomCandidates,
    tokenPresent: Boolean(normalizedToken),
    profileId: `${profileId || ''}`.trim() || null,
    displayName: `${displayName || ''}`.trim() || null,
    connectionStrategy: 'idle',
    moduleState: 'idle',
    moduleSource: 'unknown',
    lastError: '',
    status: 'idle',
    ready: false,
  };

  let Y = null;
  let doc = null;
  let provider = null;
  let targetsMap = null;
  let connectionPromise = null;
  let latestStatus = 'idle';

  function setDebugState(updates = {}) {
    Object.assign(debugState, updates);
  }

  function emitStatus(status, detail = null) {
    latestStatus = status;
    setDebugState({
      status,
      ready: Boolean(provider?.wsconnected && doc && targetsMap),
      lastError: detail instanceof Error ? detail.message : debugState.lastError,
    });
    statusHandlers.forEach((handler) => {
      try {
        handler({ status, detail, debug: { ...debugState } });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('Annotation realtime status handler failed', error);
      }
    });
  }

  async function connect(timeoutMs = 5000) {
    if (connectionPromise) return connectionPromise;
    if (!normalizedToken) {
      throw new Error('DA collab token missing');
    }
    if (!roomCandidates.length) {
      throw new Error('DA collab room name missing');
    }

    connectionPromise = (async () => {
      setDebugState({
        moduleState: 'loading',
        lastError: '',
      });
      const hadGlobalModules = Boolean(resolveGlobalCollabModules());
      const modules = await loadCollabModules();
      Y = modules.Y;
      setDebugState({
        moduleState: 'ready',
        moduleSource: hadGlobalModules ? 'global' : 'da-y-wrapper',
      });

      const strategies = ['polyfill', 'protocols'];
      let lastError = null;

      const attemptConnection = (roomName, strategy) => {
        const attemptDoc = new Y.Doc();
        let attemptProvider = null;

        if (strategy === 'polyfill') {
          class AuthenticatedWebSocket extends window.WebSocket {
            constructor(url) {
              super(url, ['yjs', normalizedToken]);
            }
          }

          attemptProvider = new modules.WebsocketProvider(
            DA_COLLAB_SERVER_URL,
            roomName,
            attemptDoc,
            {
              connect: false,
              WebSocketPolyfill: AuthenticatedWebSocket,
            },
          );
        } else {
          attemptProvider = new modules.WebsocketProvider(
            DA_COLLAB_SERVER_URL,
            roomName,
            attemptDoc,
            {
              connect: false,
              protocols: ['yjs', normalizedToken],
            },
          );
        }

        attemptProvider.maxBackoffTime = 30000;
        attemptProvider.awareness?.setLocalStateField('user', buildAwarenessUser({
          profileId,
          displayName,
          provider: attemptProvider,
        }));

        setDebugState({
          roomName,
          connectionStrategy: strategy,
        });
        emitStatus('connecting');

        return new Promise((resolve, reject) => {
          let settled = false;
          let timeoutId = null;

          const settle = (callback, value) => {
            if (settled) return;
            settled = true;
            if (timeoutId) window.clearTimeout(timeoutId);
            callback(value);
          };

          attemptProvider.on('status', ({ status }) => {
            emitStatus(status);
            if (status === 'connected') {
              settle(resolve, {
                attemptDoc,
                attemptProvider,
                attemptTargetsMap: attemptDoc.getMap('stream-annotation-targets'),
              });
            }
          });

          attemptProvider.on('connection-error', (error) => {
            emitStatus('error', error);
            settle(reject, error instanceof Error ? error : new Error('DA collab connection failed'));
          });

          attemptProvider.on('connection-close', (event) => {
            emitStatus('disconnected', event);
            if (!attemptProvider?.wsconnected) {
              settle(reject, new Error(`DA collab closed (${event?.code || 'unknown'})`));
            }
          });

          timeoutId = window.setTimeout(() => {
            settle(reject, new Error('Timed out connecting to DA collab'));
          }, timeoutMs);

          attemptProvider.connect();
        }).catch((error) => {
          attemptProvider?.destroy();
          attemptDoc.destroy();
          throw error;
        });
      };

      const attemptQueue = roomCandidates.flatMap((roomName) => (
        strategies.map((strategy) => ({ roomName, strategy }))
      ));

      const runAttempt = async (attemptIndex = 0) => {
        if (attemptIndex >= attemptQueue.length) {
          throw lastError || new Error('DA collab connection failed');
        }

        const { roomName, strategy } = attemptQueue[attemptIndex];

        try {
          return await attemptConnection(roomName, strategy);
        } catch (error) {
          lastError = error;
          return runAttempt(attemptIndex + 1);
        }
      };

      const connected = await runAttempt();
      doc = connected.attemptDoc;
      provider = connected.attemptProvider;
      targetsMap = connected.attemptTargetsMap;
      return {
        doc,
        targetsMap,
      };
    })().catch((error) => {
      connectionPromise = null;
      setDebugState({
        lastError: error instanceof Error ? error.message : `${error || 'Unknown error'}`,
        ready: false,
      });
      if (provider) {
        provider.destroy();
        provider = null;
      }
      if (doc) {
        doc.destroy();
        doc = null;
      }
      targetsMap = null;
      emitStatus('error', error);
      throw error;
    });

    return connectionPromise;
  }

  function disconnect() {
    if (provider) {
      provider.destroy();
      provider = null;
    }
    if (doc) {
      doc.destroy();
      doc = null;
    }
    targetsMap = null;
    connectionPromise = null;
    setDebugState({ ready: false });
    emitStatus('disconnected');
  }

  function isReady() {
    return Boolean(provider?.wsconnected && doc && targetsMap);
  }

  function onStatusChange(handler) {
    if (typeof handler !== 'function') return () => {};
    statusHandlers.add(handler);
    handler({ status: latestStatus, detail: null, debug: { ...debugState } });
    return () => {
      statusHandlers.delete(handler);
    };
  }

  function getDoc() {
    return doc;
  }

  function getTargetsMap() {
    return targetsMap;
  }

  function getYjs() {
    return Y;
  }

  function getSourceDocumentUrl() {
    return debugState.roomName;
  }

  return {
    connect,
    disconnect,
    getDoc,
    getSourceDocumentUrl,
    getTargetsMap,
    getYjs,
    isReady,
    onStatusChange,
  };
}
