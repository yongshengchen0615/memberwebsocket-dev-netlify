// All environments use the canonical Supabase APIs in the development project.
// The Integrated preview keeps its UI feature switch but no longer calls isolated
// *-preview endpoints or switches booking operations to preview functions.
export function previewMemberRuntime(config, env) {
  const branch = env.BRANCH || env.PREVIEW_SOURCE_BRANCH || env.GITHUB_REF_NAME;
  if (branch !== 'Integrated-Marketing-Platform' || env.CONTEXT === 'production') return { ...config };
  const { previewApiFunctionUrl, memberProfileFunctionUrl, memberGrowthFunctionUrl, bookingPreviewApis, ...canonical } = config;
  return { ...canonical, pricePublishing: true };
}
