// LINE readiness is separate from approved business access. runtimeReady is
// derived by the server from an actually provisioned private namespace.
const featureLiffs = Object.freeze({membership:'memberLiffId',points:'pointsLiffId',events:'eventLiffId',calendar:'calendarLiffId',booking:'bookingLiffId'});
const featureKeys = ['membership','points','events','calendar','integrations','booking','testing','usage'];
const channel = value => typeof value === 'string' && /^\d{5,30}$/.test(value);
const liff = (value, id) => channel(id) && typeof value === 'string'
  && /^\d{5,30}-[A-Za-z0-9_-]+$/.test(value) && value.startsWith(id+'-');
export function merchantOnboarding(tenant = {}) {
  const line = tenant.line || {}, commonMissing = [];
  for (const key of ['adminChannelId','memberChannelId','messagingChannelId'])
    if (!channel(line[key])) commonMissing.push(key);
  if (!liff(line.adminLiffId,line.adminChannelId)) commonMissing.push('adminLiffId');
  if (tenant.credentialsConfigured !== true) commonMissing.push('credentials');
  const features = {};
  for (const key of featureKeys) if (tenant.features?.[key] === true) {
    const field = featureLiffs[key];
    const missing = field && !liff(line[field],line.memberChannelId) ? [field] : [];
    features[key] = {configured:missing.length === 0,missing,userReady:false};
  }
  const count = Object.keys(features).length;
  const configured = Object.values(features).filter(item => item.configured).length;
  const configurationComplete = commonMissing.length === 0 && count > 0 && count === configured;
  const suspended = tenant.status === 'suspended';
  const runtimeReady=tenant.runtimeReady===true&&!suspended;
  for(const [key,value] of Object.entries(features))value.userReady=runtimeReady&&Object.hasOwn(featureLiffs,key);
  return {
    stage:suspended ? 'suspended' : !count ? 'awaiting_grants' : runtimeReady?'ready'
      : configurationComplete ? 'awaiting_platform' : 'configuration_required',
    commonMissing,features,grantedCount:count,configuredCount:configured,configurationComplete,
    nextOwner:suspended || !count || configurationComplete ? 'platform' : 'merchant',
    blockers:suspended ? ['TENANT_SUSPENDED'] : [
      ...(!count ? ['FEATURE_GRANTS_REQUIRED'] : []),
      ...(!configurationComplete ? ['LINE_CONFIGURATION_INCOMPLETE'] : []),
      ...(!runtimeReady?['BUSINESS_RUNTIME_UNAVAILABLE']:[]),
    ],
    adminReady:runtimeReady&&count>0,userReady:runtimeReady&&Object.values(features).some(f=>f.userReady),
  };
}
