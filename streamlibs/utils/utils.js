export const [setLibs, getLibs] = (() => {
  let libs;
  return [
    (prodLibs, location) => {
      libs = (() => {
        const { hostname, search } = location || window.location;
        if (!(hostname.includes('.aem.') || hostname.includes('local'))) return prodLibs;
        const branch = new URLSearchParams(search).get('milolibs') || 'main';
        if (branch === 'local') return 'http://localhost:6456/libs';
        return branch.includes('--') ? `https://${branch}.aem.live/libs` : `https://${branch}--milo--adobecom.aem.live/libs`;
      })();
      return libs;
    }, () => libs,
  ];
})();

export function getQueryParam(param) {
  const url = new URL(window.location);
  return url.searchParams.get(param);
}

export function fixRelativeLinks(html) {
  return html.replaceAll('./media', 'https://main--milo--adobecom.aem.page/media');
}

export async function getConfig() {
  const { getConfig: miloGetConfig } = await import(`${getLibs()}/utils/utils.js`);
  return miloGetConfig();
}

export async function initializeTokens(token) {
  const config = await getConfig();
  config.streamMapper.figmaAuthToken = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  config.streamMapper.daToken = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
}

export function extractByPattern(tag, pattern) {
  if (!tag || !pattern) {
    return {};
  }
  const parts = tag.split('-');
  const match = parts.find((p) => (pattern instanceof RegExp
    ? pattern.test(p) : p.includes(pattern)));
  if (!match) return null;
  const cleaned = match.replace(/\s+/g, '');
  const numMatch = cleaned.match(/^([a-zA-Z]+)?(\d+)?([a-zA-Z]+)?$/);
  if (numMatch) {
    const [, prefix, number, suffix] = numMatch;
    return {
      raw: match,
      prefix: prefix || null,
      number: number ? parseInt(number, 10) : null,
      suffix: suffix || null,
    };
  }
  return { raw: match };
}

export function divSwap(blockContent, divSelector, divSelector2) {
  const div1 = blockContent.querySelector(divSelector);
  const div2 = blockContent.querySelector(divSelector2);

  if (!div1 || !div2) return;

  const placeholder = document.createElement('div');
  div1.replaceWith(placeholder);
  div2.replaceWith(div1);
  placeholder.replaceWith(div2);
}

export const compose = (...fns) => (initialArg) => fns.reduce((acc, fn) => fn(acc), initialArg);

export const getFirstType = (text) => {
  if (!text) {
    return 'neither';
  }

  const cleaned = text
    .toLowerCase()
    .replace(/->|-/g, ' ')
    .replace(/_/g, ' ')
    .trim();

  const words = cleaned.split(/\s+/);

  const copyIndex = words.indexOf('copy');
  const imageIndex = words.indexOf('image');

  if (copyIndex === -1 && imageIndex === -1) {
    return 'neither';
  } if (copyIndex === -1) {
    return 'image';
  } if (imageIndex === -1) {
    return 'copy';
  }

  return copyIndex < imageIndex ? 'copy' : 'image';
};

export function getIconSize(value) {
  const sizeValue = value?.toLowerCase();
  let size = 'm';
  if (sizeValue.includes('s')) size = 's';
  if (sizeValue.includes('m')) size = 'm';
  if (sizeValue.includes('l')) size = 'l';
  if (sizeValue.includes('xl')) size = 'xl';
  if (sizeValue.includes('xxl')) size = 'xxl';
  return size;
}

export function ackCodeGeneration() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let ackCode = '';
  for (let i = 0; i < 8; i += 1) {
    ackCode += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return ackCode;
}

async function fetchImageAsBase64(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function persistOriginalImageUrl(img, url) {
  if (!url) return;
  img.setAttribute('data-stream-original-src', url);
  const picture = img.closest('picture');
  if (!picture) return;
  picture.setAttribute('data-stream-original-src', url);
  picture.querySelectorAll('source').forEach((source) => {
    source.setAttribute('data-stream-original-src', url);
  });
}

export async function transformImages() {
  const imgs = document.querySelectorAll('img[src^="https://content.da.live"]');
  if (imgs.length === 0) return;
  const config = await getConfig();
  if (!config?.streamMapper?.daToken) return;
  await Promise.all(
    Array.from(imgs).map(async (img) => {
      const url = img.getAttribute('src');
      if (!url) return;
      try {
        const dataUrl = await fetchImageAsBase64(url, config.streamMapper.daToken);
        persistOriginalImageUrl(img, url);
        img.src = dataUrl;
        const picture = img.closest('picture');
        if (picture) {
          picture.querySelectorAll('source').forEach((source) => {
            source.srcset = dataUrl;
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('Could not auth-fetch image', url, err);
      }
    }),
  );
}

export async function miloLoadArea() {
  await transformImages();
  window['page-load-ok-milo']?.remove();
  const { loadArea } = await import(`${getLibs()}/utils/utils.js`);
  await loadArea();
}
