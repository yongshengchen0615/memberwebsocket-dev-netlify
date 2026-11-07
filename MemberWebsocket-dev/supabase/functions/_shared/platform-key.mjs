import { PlatformError } from './platform-policy.mjs';

export async function resolvePlatformEncryptionKey({ configuredKey, db }) {
  // Preserve an existing key: changing the effective key would strand ciphertext.
  if (typeof configuredKey === 'string' && configuredKey.trim()) return configuredKey.trim();
  let result;
  try { result = await db.rpc('platform_credential_key'); } catch { result = null; }
  if (result?.error || typeof result?.data !== 'string' || !result.data) {
    throw new PlatformError(503, 'PLATFORM_KEY_UNAVAILABLE', '目前無法取得商家憑證加密金鑰，請稍後再試。');
  }
  return result.data;
}
