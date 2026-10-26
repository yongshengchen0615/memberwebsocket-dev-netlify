'use strict';

const PREVIEW_ORIGIN = 'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app';

function validatePreviewTarget(base, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit || '')) {
    throw new Error('COMMIT_REF must be a 40-character lowercase Git SHA');
  }
  if (typeof base !== 'string') throw new Error('PREVIEW_BASE_URL is required');
  let url;
  try { url = new URL(base); }
  catch { throw new Error('PREVIEW_BASE_URL is not a valid URL'); }
  if (url.origin !== PREVIEW_ORIGIN || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Refusing browser smoke outside the dedicated Integrated-Marketing-Platform preview origin');
  }
  return url.origin;
}
module.exports = { validatePreviewTarget };
