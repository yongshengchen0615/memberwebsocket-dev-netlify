// Only use images from LINE's server-verified ID token on the LINE image CDN.
// Missing claims preserve any previously verified image rather than clearing it.
export function normalizeLinePictureUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    if (!/(^|\.)line-scdn\.net$/i.test(url.hostname)) return '';
    return url.href;
  } catch {
    return '';
  }
}
