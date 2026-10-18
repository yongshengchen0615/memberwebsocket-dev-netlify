// AES-GCM is provided by Web Crypto; keys are held in Edge Function secrets.
import { PlatformError } from './platform-policy.mjs';
const encoder = new TextEncoder();
const base64 = bytes => btoa(String.fromCharCode(...bytes));
const bytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
async function keyFor(encoded) {
  try {
    const raw = bytes(encoded);
    if (raw.length !== 32) throw new Error();
    return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt','decrypt']);
  } catch { throw new PlatformError(503, 'CREDENTIAL_STORAGE_UNAVAILABLE', '伺服器尚未設定憑證加密金鑰。'); }
}
export async function sealCredentials(tenantId, credentials, encodedKey) {
  const key = await keyFor(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name:'AES-GCM', iv, additionalData:encoder.encode(`tenant:${tenantId}:line:v1`) }, key, encoder.encode(JSON.stringify(credentials)));
  return { version:1, iv:base64(iv), data:base64(new Uint8Array(data)) };
}
export async function openCredentials(tenantId, envelope, encodedKey) {
  if (envelope?.version !== 1) throw new PlatformError(503, 'CREDENTIAL_STORAGE_UNAVAILABLE', '憑證格式版本不支援。');
  const key = await keyFor(encodedKey);
  try {
    const data = await crypto.subtle.decrypt({ name:'AES-GCM', iv:bytes(envelope.iv), additionalData:encoder.encode(`tenant:${tenantId}:line:v1`) }, key, bytes(envelope.data));
    return JSON.parse(new TextDecoder().decode(data));
  } catch { throw new PlatformError(503, 'CREDENTIAL_STORAGE_UNAVAILABLE', '無法讀取商家憑證。'); }
}
export async function payloadHash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value))))].map(x => x.toString(16).padStart(2,'0')).join('');
}
