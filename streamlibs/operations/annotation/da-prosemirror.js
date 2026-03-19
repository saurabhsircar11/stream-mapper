const DA_PARSER_MODULE_URL = '../../vendor/da-parser/dist/index.js';
const DA_Y_WRAPPER_MODULE_URL = '../../vendor/da-y-wrapper/dist/index.js';

let daProsemirrorModulesPromise = null;

async function loadDaProsemirrorModules() {
  if (!daProsemirrorModulesPromise) {
    daProsemirrorModulesPromise = Promise.all([
      import(DA_PARSER_MODULE_URL),
      import(DA_Y_WRAPPER_MODULE_URL),
    ]).then(([parserModules, wrapperModules]) => {
      if (
        typeof parserModules?.aem2doc !== 'function'
        || typeof parserModules?.doc2aem !== 'function'
        || typeof parserModules?.getSchema !== 'function'
        || typeof parserModules?.yDocToProsemirror !== 'function'
        || typeof wrapperModules?.EditorState !== 'function'
        || typeof wrapperModules?.EditorView !== 'function'
        || typeof wrapperModules?.Slice !== 'function'
        || typeof wrapperModules?.ySyncPlugin !== 'function'
        || !wrapperModules?.Y?.Doc
      ) {
        throw new Error('Could not load DA prose conversion helpers');
      }

      return {
        ...parserModules,
        ...wrapperModules,
      };
    });
  }

  return daProsemirrorModulesPromise;
}

export async function serializeDaCollabDocToHtml(doc) {
  if (!doc) return '';
  const { doc2aem } = await loadDaProsemirrorModules();
  return doc2aem(doc);
}

export async function createDaProsemirrorBridge(doc) {
  if (!doc) return null;

  const {
    Y,
    Slice,
    EditorState,
    EditorView,
    ySyncPlugin,
    aem2doc,
    getSchema,
    yDocToProsemirror,
  } = await loadDaProsemirrorModules();

  const schema = getSchema();
  const yXmlFragment = doc.getXmlFragment('prosemirror');
  const mountEl = document.createElement('div');
  mountEl.className = 'annotation-da-prosemirror-bridge';
  mountEl.setAttribute('aria-hidden', 'true');
  mountEl.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
  document.body.appendChild(mountEl);

  const state = EditorState.create({
    schema,
    plugins: [ySyncPlugin(yXmlFragment)],
  });

  const view = new EditorView(mountEl, {
    state,
    editable: () => false,
  });

  function buildDocFromHtml(html) {
    const tempDoc = new Y.Doc();
    aem2doc(html, tempDoc);
    return yDocToProsemirror(schema, tempDoc);
  }

  return {
    replaceDocumentHtml(html) {
      if (!view || typeof html !== 'string' || !html.trim()) return false;

      const nextDoc = buildDocFromHtml(html);
      if (!nextDoc) return false;

      const currentState = view.state;
      const currentHtml = currentState.doc.textContent || '';
      const nextText = nextDoc.textContent || '';
      if (currentHtml === nextText && currentState.doc.eq(nextDoc)) return false;

      const tr = currentState.tr.replace(
        0,
        currentState.doc.content.size,
        new Slice(nextDoc.content, 0, 0),
      );

      if (!tr.docChanged) return false;
      view.dispatch(tr);
      return true;
    },
    destroy() {
      view.destroy();
      mountEl.remove();
    },
  };
}
