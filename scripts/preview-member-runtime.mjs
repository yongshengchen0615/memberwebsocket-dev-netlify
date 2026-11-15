// Both projects expose the same canonical API names. Only the build's exact
// branch selects the project; UI feature switches never select a backend.
const projects = {
  'Integrated-Marketing-Platform': {ref:'bmwhojszsnxliekkhrka',key:'sb_publishable_Dk6cKyJ5ssJRxf7GGTlZug_K_J3GbK-'},
  master: {ref:'dbuquirnaskrwcamdxki',key:'sb_publishable_W492suU5Hb7LJIJ2DmHbZw_KVp9vB4S'},
};

// Runtime LIFF IDs are deployment settings, not values inherited from the
// branch's tracked config.json. Keep the known-good IDs here as a safe fallback
// until Netlify site-scoped Build variables are configured. Test and production
// profiles can be changed independently without touching Git branches.
const liffFields = Object.freeze([
  'memberLiffId', 'pointsLiffId', 'adminLiffId', 'platformLiffId',
  'eventLiffId', 'calendarLiffId', 'bookingLiffId',
]);
const knownGoodLiff = Object.freeze({
  memberLiffId: '2010787602-kaiSm2eq',
  pointsLiffId: '2010787602-eIzRN9l6',
  adminLiffId: '2010791619-vhevCvvD',
  platformLiffId: '2012065297-VunxFBj8',
  eventLiffId: '2010787602-tuapstY3',
  calendarLiffId: '2010787602-4UKzslco',
  bookingLiffId: '2010787602-sgiB0ETj',
});

function resolveLiffProfile(profileKey, env) {
  const raw = env[profileKey];
  if (raw === undefined) return knownGoodLiff;
  let profile;
  try { profile = JSON.parse(raw); }
  catch { throw new Error(`Invalid ${profileKey}: expected valid JSON`); }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)
    || Object.keys(profile).length !== liffFields.length
    || Object.keys(profile).some(key => !liffFields.includes(key))
    || liffFields.some(key => !/^\d{10}-[A-Za-z0-9]+$/.test(profile[key] || ''))) {
    throw new Error(`Invalid ${profileKey}: expected exactly seven LIFF IDs`);
  }
  return profile;
}

export function previewMemberRuntime(config, env) {
  // Strip obsolete routing overrides for every build identity, including local
  // and production builds. Feature flags must never choose another backend.
  const { __environmentNotes, previewApiFunctionUrl, memberProfileFunctionUrl, memberGrowthFunctionUrl, bookingPreviewApis, ...canonical } = config;
  const branch = env.BRANCH || env.PREVIEW_SOURCE_BRANCH || env.GITHUB_REF_NAME;
  if (branch?.toLowerCase() === 'integrated-marketing-platform'
    && (branch !== 'Integrated-Marketing-Platform' || env.CONTEXT === 'production')) {
    throw new Error('Invalid Integrated branch deployment identity');
  }
  const isReviewBuild = env.NETLIFY === 'true' && ['branch-deploy','deploy-preview'].includes(env.CONTEXT);
  const project = Object.hasOwn(projects, branch) ? projects[branch]
    : isReviewBuild ? projects['Integrated-Marketing-Platform'] : null;
  if (!project) return canonical;
  const selected = Object.fromEntries(Object.entries(canonical).map(([key,value]) => [key,
    typeof value === 'string' ? value.replace(/^((?:https|wss):\/\/)[a-z0-9-]+\.supabase\.co(?=\/|$)/i,
      `$1${project.ref}.supabase.co`) : value]));
  selected.supabaseUrl = `https://${project.ref}.supabase.co`;
  selected.supabasePublishableKey = project.key;
  // A merge may replace all seven LIFF IDs in source config.json. Never let
  // those tracked values override the active deployment's LIFF settings.
  const profileKey = project === projects.master
    ? 'PUBLIC_LIFF_CONFIG_PRODUCTION' : 'PUBLIC_LIFF_CONFIG_TEST';
  Object.assign(selected, resolveLiffProfile(profileKey, env));
  return branch === 'Integrated-Marketing-Platform' ? {...selected,pricePublishing:true} : selected;
}
