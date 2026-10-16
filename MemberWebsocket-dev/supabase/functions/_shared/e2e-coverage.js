export function summarizeE2EExecution(cases) {
  const rows = Array.isArray(cases) ? cases : [];
  const passed = rows.filter(row => row.status === 'passed').length;
  const failed = rows.filter(row => row.status === 'failed').length;
  const skipped = rows.filter(row => row.status === 'skipped').length;
  const complete = rows.length > 0 && passed === rows.length;
  return { coverageKind:'registered-node-execution', coverageComplete:complete,
    verificationStatus:failed ? 'failed' : complete ? 'passed' : 'incomplete',
    executedCases:passed + failed, skippedCases:skipped };
}

export function normalizeFeatureCoverage(value) {
  const total = Number(value?.total);
  if (!value?.counts || !Number.isInteger(total) || total < 1 || total > 200) return null;
  const counts = {};
  for (const key of ['passed', 'failed', 'blocked', 'not-run', 'unplanned', 'unregistered']) {
    const count = Number(value.counts[key] || 0);
    if (!Number.isInteger(count) || count < 0 || count > total) return null;
    if (count) counts[key] = count;
  }
  if (Object.values(counts).reduce((sum, n) => sum + n, 0) !== total) return null;
  const execution = value.execution;
  const executionComplete = execution == null || (Number.isInteger(execution.total) && execution.total > 0
    && execution.passed === execution.total && execution.complete === true
    && ['unregistered','unplanned','missing','failed','blocked','pending'].every(key =>
      execution[key] === undefined || (Array.isArray(execution[key]) && execution[key].length === 0)));
  return { version: 1, total, counts, complete: counts.passed === total && executionComplete,
    ...(execution ? { execution: {total:Number(execution.total) || 0,passed:Number(execution.passed) || 0,complete:executionComplete} } : {}) };
}

// Independent of aggregate pass counts: every selected page for every member,
// every planned admin node and every cross-domain handoff must have evidence.
export function evaluateSelectedScope({ selectedModules, participantCount, adminKeys, cases, featureCoverage, clientCoverage }) {
  const allowed = ['member','points','event','calendar','integration','booking'];
  const modules = Array.isArray(selectedModules) ? selectedModules : [];
  const validScope = modules.length > 0 && new Set(modules).size === modules.length
    && modules.every(key => allowed.includes(key))
    && Number.isInteger(participantCount) && participantCount >= 1 && participantCount <= 10;
  const rows = Array.isArray(cases) ? cases : [];
  const passed = key => rows.some(row => row.key === key && row.status === 'passed')
    && !rows.some(row => row.key === key && row.status !== 'passed');
  const rawKeys = Array.isArray(adminKeys) ? adminKeys : [];
  const keys = rawKeys.slice(0, 200).filter(key => typeof key === 'string' && /^[A-Z0-9_]{1,100}$/.test(key));
  const missingAdmin = keys.filter(key => !passed(key));
  const requiredPaired = ['UNIFIED_SERVER_FULL_E2E','PAIRED_COMPLEX_FIXTURE_PREPARE','PAIRED_HUMAN_INTERACTION_COVERAGE',
    ...(modules.includes('member') ? ['PAIRED_MEMBER_REFERRAL_REWARD'] : []),
    ...(modules.includes('points') ? ['PAIRED_POINT_TRANSFER_ATOMIC'] : []),
    ...(modules.includes('event') ? ['PAIRED_EVENT_LAST_TICKET_RACE'] : []),
    ...(modules.includes('booking') ? ['PAIRED_SECURITY_BOOKING_IDOR'] : [])];
  const missingPaired = requiredPaired.filter(key => !passed(key));
  const clients = [];
  if (validScope) for (let participant = 1; participant <= participantCount; participant++) {
    for (const surface of modules.filter(key => key !== 'integration')) {
      const key = 'PAIRED_' + participant + '_' + surface.toUpperCase();
      const evidence = (Array.isArray(clientCoverage) ? clientCoverage : [])
        .filter(item => item.participant === participant && item.surface === surface);
      const row = rows.find(item => item.key === key);
      const complete = passed(key) && evidence.length === 1 && evidence[0].coverage?.complete === true
        && row.actual?.coverageComplete === true && row.actual?.sameTestMember === true
        && row.actual?.humanInteractionVerified === true && row.actual?.cancelled !== true;
      clients.push({participant,surface,complete});
    }
    if (modules.some(key => key !== 'integration') && !passed('PAIRED_' + participant + '_ADMIN_RECORD_SYNC'))
      missingPaired.push('PAIRED_' + participant + '_ADMIN_RECORD_SYNC');
  }
  return { version:1, selectedModules:modules.filter(key => allowed.includes(key)), participantCount,
    expectedClientSurfaces:clients.length, clients, missingAdmin, missingPaired,
    complete:validScope && keys.length > 0 && keys.length === rawKeys.length && new Set(keys).size === keys.length
      && featureCoverage?.complete === true && missingAdmin.length === 0 && missingPaired.length === 0
      && clients.every(item => item.complete) };
}

export function normalizeClientFeatureCoverage(items) {
  const surfaces = ['member', 'points', 'event', 'calendar', 'booking'];
  if (!Array.isArray(items) || items.length > 50) return [];
  return items.filter(item => Number.isInteger(item?.participant) && item.participant >= 1 && item.participant <= 10
    && surfaces.includes(item?.surface)).map(item => ({
    participant: item.participant,
    surface: item.surface,
    coverage: normalizeFeatureCoverage(item?.coverage)
  }));
}

export async function prepareE2EServiceRuleFixtures(supabase, fixture) {
  const tag = String(fixture?.runTag || '');
  const createdBy = String(fixture?.createdBy || '');
  if (!/^[A-Z0-9_-]{4,40}$/.test(tag) || createdBy !== 'qa:e2e:' + tag.toLowerCase()) {
    throw new Error('E2E_FIXTURE_PROVENANCE_INVALID');
  }
  const services = await supabase.from('booking_services').select('id').eq('created_by',createdBy)
    .eq('is_active',true).eq('requires_companion_service',false).order('duration_minutes').limit(2);
  if (services.error || services.data?.length !== 2) throw new Error('E2E_RULE_SERVICES_MISSING');
  const ids = services.data.map(row => row.id);
  const inserted = await supabase.from('event_tickets').insert(['any','all'].map(mode => ({
    event_ticket_id:'QA-EVT-' + tag + '-RULE-' + mode.toUpperCase(),
    title:'E2E QA 服務限定 ' + mode + ' ' + tag, ticket_type:'coupon',
    description:'驗證具體服務項目 ' + mode + ' 限制。', usage_method:'僅供測試帳號預約驗證。',
    usage_instructions:'未預約符合的具體服務項目時不得勾選。',prizes:[],status:'active',
    starts_on:fixture.today,ends_on:null,quota:0,accent:'#3D7A69',
    allowed_tier_keys:['general','silver','gold','platinum'],
    required_service_ids:ids,required_service_match_mode:mode,created_by:createdBy,updated_by:createdBy
  })));
  if (inserted.error) throw new Error('E2E_RULE_TICKETS_PREPARE_FAILED');
  return {serviceRuleTickets:2,serviceRuleModes:['any','all']};
}
