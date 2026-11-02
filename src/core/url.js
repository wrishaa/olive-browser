// turn whatever the user typed into a url
const SEARCH = 'https://www.google.com/search?q=';

const TLDS = /\.(com|org|net|io|dev|app|ai|co|so|me|gg|sh|xyz|edu|gov|info|biz|tv|fm|us|uk|de|fr|jp|in|ca|au|nl|se|ch|it|es|ru|cn|br|eu|tech|site|page|blog|news|cloud|run|link|to|ly|im|is|cc|vc|ws|zone|studio|design|world|today|online|store|shop|art)(\/|:|$|\?|#)/i;

function looksLikeUrl(text) {
  const t = text.trim();
  if (/^data:/i.test(t)) return true;
  if (!t || /\s/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true;
  if (/^(about|data|view-source|mailto|file|chrome|devtools|olive):/i.test(t)) return true;
  if (/^localhost(:\d+)?(\/|$)/i.test(t)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(t)) return true;
  if (/^\[[0-9a-f:]+\](:\d+)?/i.test(t)) return true;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(t) && (TLDS.test(t) || /^[\w-]+(\.[\w-]+)+(:\d+)(\/|$)/.test(t) || t.includes('/'))) return true;
  if (/^[\w-]+(\.[\w-]+)+$/.test(t) && TLDS.test(t + '/')) return true;
  return false;
}

function toUrl(text) {
  const t = text.trim();
  if (!t) return null;
  if (looksLikeUrl(t)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^localhost:/i.test(t) && !/^[\w-]+(\.[\w-]+)+:\d/.test(t)) return t;
    const local = /^(localhost|127\.|\d{1,3}(\.\d{1,3}){3}|\[)/i.test(t);
    return (local ? 'http://' : 'https://') + t;
  }
  return SEARCH + encodeURIComponent(t);
}

function displayHost(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname.replace(/^www\./, '');
    return url;
  } catch {
    return url || '';
  }
}

module.exports = { toUrl, looksLikeUrl, displayHost, SEARCH };
