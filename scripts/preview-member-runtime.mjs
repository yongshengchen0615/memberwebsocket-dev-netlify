// Both projects expose the same canonical API names. Only the build's exact
// branch selects the project; UI feature switches never select a backend.
const projects = {
  'Integrated-Marketing-Platform': {ref:'bmwhojszsnxliekkhrka',key:'sb_publishable_Dk6cKyJ5ssJRxf7GGTlZug_K_J3GbK-'},
  master: {ref:'dbuquirnaskrwcamdxki',key:'sb_publishable_W492suU5Hb7LJIJ2DmHbZw_KVp9vB4S'},
};
export function previewMemberRuntime(config, env) {
  // Strip obsolete routing overrides for every build identity, including local
  // and production builds. Feature flags must never choose another backend.
  const { previewApiFunctionUrl, memberProfileFunctionUrl, memberGrowthFunctionUrl, bookingPreviewApis, ...canonical } = config;
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
  return branch === 'Integrated-Marketing-Platform' ? {...selected,pricePublishing:true} : selected;
}
