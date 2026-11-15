import { readFileSync } from 'node:fs';

// Full release profiles are separate Git paths. Editing the testing JSON
// cannot change production builds (and vice versa), even after a Git merge.
const projects = Object.freeze({
  'Integrated-Marketing-Platform': { ref: 'bmwhojszsnxliekkhrka', folder: 'testing' },
  master: { ref: 'dbuquirnaskrwcamdxki', folder: 'production' },
});
const liffFields = Object.freeze([
  'memberLiffId', 'pointsLiffId', 'adminLiffId', 'platformLiffId',
  'eventLiffId', 'calendarLiffId', 'bookingLiffId',
]);
const profileFields = Object.freeze([
  'brandName', 'supabaseUrl', 'supabaseFunctionUrl', 'supabasePublishableKey',
  'realtimeEnabled', ...liffFields, 'productizedAdmin', 'merchantApprovalVersion',
]);

function validateLiffProfile(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== liffFields.length
    || Object.keys(value).some(key => !liffFields.includes(key))
    || liffFields.some(key => typeof value[key] !== 'string'
      || !/^\d{10}-[A-Za-z0-9]+$/.test(value[key]))) {
    throw new Error('Invalid ' + source + ': expected exactly seven LIFF IDs');
  }
  return value;
}

function loadDeploymentProfile(project) {
  // Files are inputs to the build only; the config directory is not a
  // published asset. Do not use MemberWebsocket-dev/config.json for releases.
  const url = new URL('../MemberWebsocket-dev/config/' + project.folder + '/config.json', import.meta.url);
  let data;
  try { data = JSON.parse(readFileSync(url, 'utf8')); }
  catch { throw new Error('Missing or invalid ' + project.folder + ' deployment config.json'); }
  const { __environmentNotes, ...profile } = data;
  if (Object.keys(profile).length !== profileFields.length
    || Object.keys(profile).some(key => !profileFields.includes(key))
    || profileFields.some(key => !Object.hasOwn(profile, key))) {
    throw new Error('Invalid ' + project.folder + ' deployment config: unexpected or missing field');
  }
  const expectedUrl = 'https://' + project.ref + '.supabase.co';
  if (profile.supabaseUrl !== expectedUrl
    || profile.supabaseFunctionUrl !== expectedUrl + '/functions/v1/api') {
    throw new Error('Cross-environment Supabase URL in ' + project.folder + ' deployment config');
  }
  if (typeof profile.supabasePublishableKey !== 'string'
    || !/^sb_publishable_[A-Za-z0-9_-]{12,}$/.test(profile.supabasePublishableKey)) {
    throw new Error('Invalid ' + project.folder + ' publishable key (secret keys are forbidden)');
  }
  validateLiffProfile(Object.fromEntries(liffFields.map(key => [key, profile[key]])), project.folder);
  if (typeof profile.brandName !== 'string' || !profile.brandName.trim()
    || typeof profile.realtimeEnabled !== 'boolean'
    || typeof profile.productizedAdmin !== 'boolean'
    || !Number.isInteger(profile.merchantApprovalVersion)
    || profile.merchantApprovalVersion < 1) {
    throw new Error('Invalid ' + project.folder + ' deployment config settings');
  }
  return profile;
}

// Release builds read only environment-scoped files under config/. The
// legacy MemberWebsocket-dev/config.json is never a build input, including
// local development and CI builds. Native Netlify previews use testing.
export function buildMemberRuntime(env) {
  const branch = env.BRANCH || env.PREVIEW_SOURCE_BRANCH || env.GITHUB_REF_NAME;
  const isReviewBuild = env.NETLIFY === 'true'
    && ['branch-deploy', 'deploy-preview'].includes(env.CONTEXT);
  const profile = branch === 'Integrated-Marketing-Platform' || isReviewBuild && branch !== 'master'
    ? projects['Integrated-Marketing-Platform'] : projects.master;
  return previewMemberRuntime(loadDeploymentProfile(profile), env);
}

export function previewMemberRuntime(config, env) {
  const { __environmentNotes, previewApiFunctionUrl, memberProfileFunctionUrl,
    memberGrowthFunctionUrl, bookingPreviewApis, ...canonical } = config;
  const branch = env.BRANCH || env.PREVIEW_SOURCE_BRANCH || env.GITHUB_REF_NAME;
  if (branch?.toLowerCase() === 'integrated-marketing-platform'
    && (branch !== 'Integrated-Marketing-Platform' || env.CONTEXT === 'production')) {
    throw new Error('Invalid Integrated branch deployment identity');
  }
  const isReviewBuild = env.NETLIFY === 'true' && ['branch-deploy', 'deploy-preview'].includes(env.CONTEXT);
  const project = Object.hasOwn(projects, branch) ? projects[branch]
    : isReviewBuild ? projects['Integrated-Marketing-Platform'] : null;
  // Local/unknown builds keep existing source-config semantics.
  if (!project) return canonical;
  const selected = loadDeploymentProfile(project);
  return branch === 'Integrated-Marketing-Platform'
    ? { ...selected, pricePublishing: true } : selected;
}
