// Every build gets a deployment-specific, human-readable version.
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
