(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MemberE2EProfessionalTester = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 2;
  const PRIMARY_TYPES = new Set(['click', 'input', 'change', 'submit']);
  const CAPTURE_TYPES = Object.freeze(['click', 'input', 'change', 'submit', 'keydown', 'focusin', 'focusout', 'pointerdown']);
  const PROFILES = Object.freeze(['deliberate', 'impatient', 'exploratory', 'skeptical']);

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  function hashText(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function unique(items) {
    return [...new Set((Array.isArray(items) ? items : []).filter(Boolean))];
  }

  function normalizeLearning(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const preferredTesterProfile = PROFILES.includes(String(source.preferredTesterProfile || ''))
      ? String(source.preferredTesterProfile)
      : '';
    return Object.freeze({
      executions: Math.max(0, Math.trunc(Number(source.executions) || 0)),
      passCount: Math.max(0, Math.trunc(Number(source.passCount) || 0)),
      failCount: Math.max(0, Math.trunc(Number(source.failCount) || 0)),
      skipCount: Math.max(0, Math.trunc(Number(source.skipCount) || 0)),
      failureRate: clamp(source.failureRate, 0, 1),
      failureEwma: clamp(source.failureEwma, 0, 1),
      flakyScore: clamp(source.flakyScore, 0, 1),
      riskScore: clamp(source.riskScore, 0, 1),
      avgDurationMs: Math.max(0, Math.trunc(Number(source.avgDurationMs) || 0)),
      p95DurationMs: Math.max(0, Math.trunc(Number(source.p95DurationMs) || 0)),
      preferredTesterProfile,
      lastFailureCode: String(source.lastFailureCode || '').slice(0, 120),
      lastFailureFingerprint: String(source.lastFailureFingerprint || '').slice(0, 80)
    });
  }

  function inferRisk(options = {}) {
    const explicit = String(options.risk || '').trim().toLowerCase();
    if (explicit && explicit !== 'normal') return explicit;
    const text = [options.caseKey, options.domain, options.module].map((item) => String(item || '').toLowerCase()).join(' ');
    if (/security|auth|session|permission|boundary|invalid|forbidden|tamper/.test(text)) return 'security';
    if (/mutation|create|update|delete|redeem|transfer|booking|lifecycle|grant|save/.test(text)) return 'mutation';
    if (/realtime|notification|line|sync|websocket/.test(text)) return 'eventual-consistency';
    return explicit || 'normal';
  }

  function planTesterBehavior(options = {}) {
    const caseKey = String(options.caseKey || 'UNKNOWN_CASE').trim() || 'UNKNOWN_CASE';
    const side = String(options.side || 'shared').trim() || 'shared';
    const surface = String(options.surface || options.module || 'shared').trim() || 'shared';
    const baseComplexityLevel = Math.max(1, Math.min(8, Math.trunc(Number(options.complexityLevel) || 1)));
    const learning = normalizeLearning(options.learning);
    const complexityBoost = learning.riskScore >= 0.75 || learning.flakyScore >= 0.55
      ? 2
      : learning.riskScore >= 0.45 || learning.flakyScore >= 0.25
        ? 1
        : 0;
    const complexityLevel = Math.max(1, Math.min(8, baseComplexityLevel + complexityBoost));
    const risk = inferRisk(options);
    const seed = String(options.seed || 'professional-tester');
    const unit = hashText(seed + '|' + side + '|' + surface + '|' + caseKey + '|' + risk + '|' + complexityLevel);
    const baselineProfile = PROFILES[unit % PROFILES.length];
    const preferenceChance = learning.executions >= 4 ? 75 : learning.executions >= 2 ? 65 : 55;
    const usePreferred = Boolean(
      learning.preferredTesterProfile
      && learning.executions > 0
      && ((unit >>> 16) % 100) < preferenceChance
    );
    const profile = usePreferred ? learning.preferredTesterProfile : baselineProfile;
    const strategies = ['precondition-scan', 'timing-variance', 'postcondition-scan', 'structural-regression-guard'];
    if (learning.failCount > 0) strategies.push('historical-failure-replay');
    if (learning.riskScore >= 0.65) strategies.push('risk-weighted-postcondition');
    if (learning.flakyScore >= 0.25) strategies.push('repeat-and-recovery-evidence');
    if (learning.flakyScore >= 0.5) strategies.push('refresh-persistence-evidence');
    if (risk === 'security' || risk === 'auth') strategies.push('negative-boundary-observation');
    if (risk === 'mutation') strategies.push('correction-observation', 'repeat-action-guard', 'post-mutation-consistency');
    if (risk === 'eventual-consistency' || risk === 'notification') strategies.push('eventual-consistency-observation');
    if (complexityLevel >= 3) strategies.push('focus-traversal-probe');
    if (complexityLevel >= 4) strategies.push('keyboard-evidence');
    if (complexityLevel >= 6) strategies.push('repeat-and-recovery-evidence');
    if (complexityLevel >= 7) strategies.push('refresh-persistence-evidence');

    const profileDelay = {
      deliberate: [150, 330],
      impatient: [35, 120],
      exploratory: [90, 260],
      skeptical: [120, 300]
    }[profile];
    const spread = Math.min(220, complexityLevel * 22);
    const beforeDelayMs = profileDelay[0] + (unit % Math.max(1, profileDelay[1] - profileDelay[0] + 1));
    const afterDelayMs = 60 + ((unit >>> 8) % (150 + spread));

    return Object.freeze({
      version: VERSION,
      profile,
      risk,
      side,
      surface,
      caseKey,
      complexityLevel,
      baseComplexityLevel,
      learning,
      profileSource: usePreferred ? 'historical-preference' : 'deterministic-exploration',
      strategies: Object.freeze(unique(strategies)),
      beforeDelayMs,
      afterDelayMs,
      focusProbe: complexityLevel >= 3,
      evidenceTarget: complexityLevel >= 6 ? 'deep' : complexityLevel >= 3 ? 'professional' : 'basic'
    });
  }

  function fallbackTargetLabel(node) {
    if (!node || node.nodeType !== 1) return 'unknown';
    const id = String(node.id || '').trim();
    if (id) return '#' + id;
    const action = String(node.getAttribute?.('data-action') || node.getAttribute?.('data-booking-admin-action') || '').trim();
    if (action) return '[action=' + action + ']';
    const tag = String(node.tagName || 'element').toLowerCase();
    const classes = String(node.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    return classes ? tag + '.' + classes : tag;
  }

  function visibleElement(node) {
    if (!node || node.nodeType !== 1 || node.disabled === true || node.hidden === true) return false;
    if (node.getAttribute?.('aria-hidden') === 'true') return false;
    try {
      const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      if (typeof node.getClientRects === 'function' && node.getClientRects().length === 0 && style?.position !== 'fixed') return false;
    } catch (_) {}
    return true;
  }

  function documentSnapshot(documentRef, labelTarget = fallbackTargetLabel) {
    if (!documentRef || typeof documentRef.querySelectorAll !== 'function') {
      return { available: false, fingerprint: 'snapshot-unavailable' };
    }
    const ids = new Map();
    for (const node of documentRef.querySelectorAll('[id]')) {
      const id = String(node.id || '').trim();
      if (!id) continue;
      ids.set(id, Number(ids.get(id) || 0) + 1);
    }
    let duplicateIdCount = 0;
    for (const count of ids.values()) if (count > 1) duplicateIdCount += count - 1;
    const visibleDialogs = [...documentRef.querySelectorAll('[role="dialog"], dialog')].filter(visibleElement).length;
    const busyCount = [...documentRef.querySelectorAll('[aria-busy="true"]')].filter(visibleElement).length;
    const invalidCount = [...documentRef.querySelectorAll('[aria-invalid="true"]')].filter(visibleElement).length;
    const root = documentRef.documentElement;
    const horizontalOverflow = Boolean(root && Number(root.scrollWidth || 0) > Number(root.clientWidth || 0) + 2);
    const focusTarget = labelTarget(documentRef.activeElement);
    const snapshot = {
      available: true,
      duplicateIdCount,
      visibleDialogs,
      busyCount,
      invalidCount,
      horizontalOverflow,
      focusTarget
    };
    snapshot.fingerprint = 'PT1-' + hashText(JSON.stringify(snapshot)).toString(16).padStart(8, '0');
    return snapshot;
  }

  function summarizeProfessionalEvidence(events, before, after, plan) {
    const source = Array.isArray(events) ? events : [];
    const primary = source.filter((item) => PRIMARY_TYPES.has(String(item?.type || '')));
    const primaryTargets = primary.map((item) => String(item?.target || '')).filter(Boolean);
    const allTargets = source.map((item) => String(item?.target || '')).filter(Boolean);
    const typeCounts = {};
    const targetTypeCounts = new Map();
    for (const item of source) {
      const type = String(item?.type || 'unknown');
      const target = String(item?.target || 'unknown');
      typeCounts[type] = Number(typeCounts[type] || 0) + 1;
      const key = target + '|' + type;
      targetTypeCounts.set(key, Number(targetTypeCounts.get(key) || 0) + 1);
    }
    const repeatedClick = [...targetTypeCounts.entries()].some(([key, count]) => key.endsWith('|click') && count >= 2);
    const correctedInput = [...targetTypeCounts.entries()].some(([key, count]) => key.endsWith('|input') && count >= 2);
    const distinctPrimaryTargets = new Set(primaryTargets).size;
    const stateTransition = Boolean(before?.available && after?.available && before.fingerprint !== after.fingerprint);
    const duplicateIdIncrease = before?.available && after?.available
      ? Math.max(0, Number(after.duplicateIdCount || 0) - Number(before.duplicateIdCount || 0)) : 0;
    const horizontalOverflowIntroduced = Boolean(before?.available && after?.available && !before.horizontalOverflow && after.horizontalOverflow);
    const signals = {
      primaryInteraction: primary.length > 0,
      multiStep: primary.length >= 3 || distinctPrimaryTargets >= 2,
      dataEntry: primary.some((item) => item.type === 'input' || item.type === 'change'),
      correctedInput,
      repeatedAction: repeatedClick,
      keyboard: source.some((item) => item.type === 'keydown'),
      focusTraversal: source.some((item) => item.type === 'focusin' || item.type === 'focusout'),
      stateTransition,
      postconditionObserved: Boolean(after?.available)
    };
    const anomalies = {
      duplicateIdIncrease,
      horizontalOverflowIntroduced,
      busyDelta: before?.available && after?.available ? Number(after.busyCount || 0) - Number(before.busyCount || 0) : 0,
      invalidDelta: before?.available && after?.available ? Number(after.invalidCount || 0) - Number(before.invalidCount || 0) : 0
    };
    let score = 0;
    if (signals.primaryInteraction) score += 25;
    if (signals.multiStep) score += 15;
    if (signals.dataEntry) score += 10;
    if (signals.correctedInput) score += 10;
    if (signals.repeatedAction) score += 10;
    if (signals.keyboard) score += 10;
    if (signals.focusTraversal) score += 5;
    if (signals.stateTransition) score += 10;
    if (!anomalies.duplicateIdIncrease && !anomalies.horizontalOverflowIntroduced) score += 5;
    score = Math.min(100, score);
    const grade = score >= 80 ? 'deep' : score >= 55 ? 'professional' : 'basic';
    const ok = signals.primaryInteraction && anomalies.duplicateIdIncrease === 0 && !anomalies.horizontalOverflowIntroduced;
    return {
      eventCount: primary.length,
      allEventCount: source.length,
      eventTypes: unique(source.map((item) => String(item?.type || ''))),
      targets: unique(primaryTargets).slice(0, 24),
      allTargets: unique(allTargets).slice(0, 32),
      trustedEventCount: source.filter((item) => item?.trusted === true).length,
      professionalTester: {
        version: VERSION,
        profile: plan?.profile || 'unknown',
        risk: plan?.risk || 'normal',
        evidenceTarget: plan?.evidenceTarget || 'basic',
        strategies: Array.isArray(plan?.strategies) ? plan.strategies.slice(0, 16) : [],
        learning: plan?.learning || null,
        profileSource: plan?.profileSource || 'deterministic-exploration',
        score,
        grade,
        ok,
        signals,
        anomalies,
        before,
        after
      }
    };
  }

  function safeFocusProbe(documentRef, options = {}) {
    if (!documentRef || typeof documentRef.querySelectorAll !== 'function') return false;
    const excludeTarget = typeof options.excludeTarget === 'function' ? options.excludeTarget : () => false;
    const selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const candidates = [...documentRef.querySelectorAll(selector)].filter((node) => visibleElement(node) && !excludeTarget(node));
    const target = candidates.find((node) => String(node.getAttribute?.('type') || '').toLowerCase() !== 'submit') || candidates[0];
    if (!target || typeof target.focus !== 'function') return false;
    const previous = documentRef.activeElement;
    try {
      target.focus({ preventScroll: true });
      if (previous && previous !== target && typeof previous.focus === 'function' && previous !== documentRef.body) {
        previous.focus({ preventScroll: true });
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  async function capture(options = {}, run) {
    if (typeof run !== 'function') throw new TypeError('Professional tester capture requires a run function.');
    const documentRef = options.document;
    const labelTarget = typeof options.labelTarget === 'function' ? options.labelTarget : fallbackTargetLabel;
    const excludeTarget = typeof options.excludeTarget === 'function' ? options.excludeTarget : () => false;
    const delay = typeof options.delay === 'function'
      ? options.delay
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const plan = planTesterBehavior(options);
    const events = [];
    const maxEvents = Math.max(40, Math.min(200, Number(options.maxEvents) || 120));
    const handler = (event) => {
      const target = event?.target;
      if (!target || excludeTarget(target)) return;
      events.push({
        type: String(event.type || ''),
        target: labelTarget(target),
        trusted: event.isTrusted === true
      });
      if (events.length > maxEvents) events.shift();
    };
    if (documentRef?.addEventListener) CAPTURE_TYPES.forEach((type) => documentRef.addEventListener(type, handler, true));
    const cleanup = () => {
      if (documentRef?.removeEventListener) CAPTURE_TYPES.forEach((type) => documentRef.removeEventListener(type, handler, true));
    };
    const registerCleanup = typeof options.registerCleanup === 'function' ? options.registerCleanup : () => {};
    registerCleanup(cleanup);
    const before = documentSnapshot(documentRef, labelTarget);
    try {
      if (plan.focusProbe) safeFocusProbe(documentRef, { excludeTarget });
      await delay(plan.beforeDelayMs);
      const outcome = await run();
      await delay(plan.afterDelayMs);
      const after = documentSnapshot(documentRef, labelTarget);
      return { outcome, evidence: summarizeProfessionalEvidence(events, before, after, plan), plan };
    } finally {
      cleanup();
      registerCleanup(null);
    }
  }

  return {
    VERSION,
    CAPTURE_TYPES,
    planTesterBehavior,
    documentSnapshot,
    summarizeProfessionalEvidence,
    safeFocusProbe,
    capture
  };
});
