// pure tab metadata logic (no electron): which site a url belongs to, whether a pinned
// tab should hand a navigation to a new tab (domain lock), and whether it drifted from
// its pinned url.

// multi-label public suffixes we care about. not the full public suffix list: enough that
// foo.co.uk, foo.github.io or foo.vercel.app are their own site and mail.google.com and
// google.com are one.
const MULTI_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'ac.kr',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'com.tw', 'com.sg', 'com.my', 'com.mx', 'com.ar', 'com.co', 'com.tr', 'com.ua', 'com.pl',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'co.za', 'org.za', 'gov.za', 'ac.za',
  'co.il', 'org.il', 'ac.il', 'co.id', 'or.id', 'ac.id', 'co.th', 'in.th',
  'com.de', 'co.at', 'or.at', 'com.es', 'com.fr', 'co.it', 'com.pt', 'com.ru', 'com.vn', 'com.ph', 'com.pk', 'com.eg', 'com.sa', 'com.ng',
  // private suffixes where every subdomain is somebody else's site
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com',
  'web.app', 'firebaseapp.com', 'appspot.com', 'blogspot.com', 'azurewebsites.net', 'cloudfront.net',
  'fly.dev', 'onrender.com', 'glitch.me', 'repl.co', 'ngrok.io', 'ngrok-free.app', 's3.amazonaws.com',
]);

function parse(url) {
  try { return new URL(url); } catch { return null; }
}

function isIp(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
}

// the registrable domain ("site") of an http(s) url, or null for anything else.
// ips and single-label hosts (localhost) are their own site.
function siteOf(url) {
  const u = parse(url);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  if (isIp(host)) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join('.');
  const last3 = parts.slice(-3).join('.');
  if (MULTI_SUFFIXES.has(last3)) return parts.slice(-4).join('.');
  if (MULTI_SUFFIXES.has(last2)) return last3;
  return last2;
}

function sameSite(a, b) {
  const sa = siteOf(a);
  return !!sa && sa === siteOf(b);
}

// sign-in pages keep working in place even across sites (sign in with google from a
// pinned notion tab): known identity hosts and the usual oauth/sso paths.
const AUTH_HOSTS = /^(accounts|login|signin|sign-in|auth|sso|id|oauth|identity|idp|secure|account)\.|(^|\.)(okta|okta-emea|auth0|onelogin|duosecurity|pingidentity|microsoftonline|appleid\.apple|clerk|stytch|workos)\.(com|net|dev|io)$/i;
const AUTH_PATHS = /\/(oauth2?|openid|o\/oauth2|authorize|auth|signin|sign-in|login|logon|sso|saml2?|session\/new)(\/|$|\?)/i;

function isAuthUrl(url) {
  const u = parse(url);
  if (!u) return false;
  return AUTH_HOSTS.test(u.hostname) || AUTH_PATHS.test(u.pathname);
}

// domain lock: should this renderer-initiated main-frame navigation in a pinned tab open
// in a new tab instead? only `will-navigate` asks (link clicks, location changes, form
// submits); server redirects, back/forward, reload and urls typed into the tab never do.
//   - only http(s) targets on another site than the pinned url
//   - only while the tab still sits on its pinned site: once a redirect took it elsewhere
//     (an sso hop) we let the flow finish where it is
//   - never for sign-in pages (isAuthUrl)
function shouldOpenOutside({ pinnedUrl, currentUrl, targetUrl }) {
  const pinnedSite = siteOf(pinnedUrl);
  if (!pinnedSite) return false;
  const target = siteOf(targetUrl);
  if (!target || target === pinnedSite) return false;
  if (currentUrl && siteOf(currentUrl) !== pinnedSite) return false;
  if (isAuthUrl(targetUrl)) return false;
  return true;
}

// a url for comparison: no fragment, no trailing slash on the path
function normalizeUrl(url) {
  const u = parse(url);
  if (!u) return String(url || '');
  u.hash = '';
  let s = u.toString();
  if (s.endsWith('/') && u.search === '') s = s.slice(0, -1);
  return s;
}

// a pinned tab drifted when it shows something other than its pinned url
function drifted(pinnedUrl, url) {
  if (!pinnedUrl || !url) return false;
  return normalizeUrl(pinnedUrl) !== normalizeUrl(url);
}

module.exports = { siteOf, sameSite, isAuthUrl, shouldOpenOutside, normalizeUrl, drifted };
