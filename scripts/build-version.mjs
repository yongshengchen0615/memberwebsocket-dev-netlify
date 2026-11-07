// Every deploy keeps its own badge. A verifier may reproduce that same artifact.
export function buildDate(env, now = new Date()) {
  const epoch = env.VERIFIED_PREVIEW_SOURCE_EPOCH;
  if (epoch === undefined) return now;
  if (!/^\d{10}$/.test(epoch) || !/^[a-f0-9]{40}$/.test(env.COMMIT_REF || '')
    || !/^[a-f0-9]{24}$/.test(env.DEPLOY_ID || '')) {
    throw new TypeError('Verified preview needs a source timestamp, full commit and deploy identity');
  }
  return new Date(Number(epoch) * 1000);
}

export function formatBuildVersion(date, deployId) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('A valid build timestamp is required');
  }
  const suffix = String(deployId ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(-6);
  if (suffix.length !== 6) {
    throw new TypeError('A deployment identifier with at least six characters is required');
  }
  const stamp = date.toISOString().slice(2, 19).replace(/[-T:]/g, '');
  return `v${stamp.slice(0, 6)}.${stamp.slice(6)}-${suffix}`;
}
