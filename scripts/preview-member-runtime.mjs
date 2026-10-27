// Preview code shares the existing data project, but must not replace the live
// API functions while the new registration gate is being accepted.
export function previewMemberRuntime(config, env) {
  const branch = env.BRANCH || env.PREVIEW_SOURCE_BRANCH || env.GITHUB_REF_NAME;
  if (branch !== 'Integrated-Marketing-Platform' || env.CONTEXT === 'production') return { ...config };
  const base = new URL(config.supabaseUrl);
  if (base.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(base.hostname)
      || base.username || base.password || base.pathname !== '/') throw new Error('Invalid preview Supabase URL');
  return { ...config,
    previewApiFunctionUrl: new URL('/functions/v1/api-preview', base).href,
    memberProfileFunctionUrl: new URL('/functions/v1/member-profile-api-preview', base).href,
  };
}
