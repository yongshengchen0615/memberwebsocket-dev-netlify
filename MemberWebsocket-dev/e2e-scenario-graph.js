(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MemberE2EScenarioGraph = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  function hashText(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  // A stalled UI action must settle its node. Callers stop the current runner on
  // timeout because racing a promise does not cancel its underlying DOM mutation.
  function runWithDeadline(task, timeoutMs, nodeKey, onTimeout) {
    const duration = Number(timeoutMs);
    if (typeof task !== 'function' || !Number.isFinite(duration) || duration <= 0) {
      throw new TypeError('E2E node deadline requires a task and a positive timeout.');
    }
    let timer;
    const action = Promise.resolve().then(task);
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { onTimeout?.(action); } catch (_) {}
        const error = new Error('E2E 節點 ' + String(nodeKey || 'unknown') + ' 逾時（' + Math.round(duration / 1000) + ' 秒）。');
        error.code = 'E2E_NODE_TIMEOUT';
        error.nodeKey = String(nodeKey || 'unknown');
        reject(error);
      }, duration);
    });
    return Promise.race([action, deadline]).finally(() => clearTimeout(timer));
  }

  function shuffled(items, randomUnit) {
    const copy = Array.isArray(items) ? items.slice() : [];
    const next = typeof randomUnit === 'function' ? randomUnit : Math.random;
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const unit = Math.max(0, Math.min(0.999999999, Number(next()) || 0));
      const swap = Math.floor(unit * (index + 1));
      [copy[index], copy[swap]] = [copy[swap], copy[index]];
    }
    return copy;
  }

  function normalizeNode(node, index, metaByKey) {
    const key = String(node?.key || ('NODE_' + String(index + 1))).trim();
    if (!key) throw new Error('E2E scenario node key is required.');
    const meta = metaByKey && typeof metaByKey === 'object' && metaByKey[key] && typeof metaByKey[key] === 'object'
      ? metaByKey[key]
      : {};
    const dependencies = Array.isArray(meta.dependencies)
      ? [...new Set(meta.dependencies.map((item) => String(item || '').trim()).filter(Boolean))]
      : [];
    return {
      definition: node,
      key,
      name: String(node?.name || key),
      domain: String(node?.domain || 'E2E'),
      module: String(meta.module || 'shared'),
      phase: Math.max(0, Math.trunc(Number(meta.phase) || 0)),
      risk: String(meta.risk || 'normal'),
      required: meta.required === true,
      dependencies
    };
  }

  function planScenario(options) {
    const source = Array.isArray(options?.nodes) ? options.nodes : [];
    if (!source.length) {
      return { version: 1, seed: String(options?.seed || ''), complexityLevel: 1, fingerprint: 'SG1-empty', keys: [], path: [] };
    }
    const nodes = source.map((node, index) => normalizeNode(node, index, options?.metaByKey || {}));
    const rawPriority = options?.priorityByKey && typeof options.priorityByKey === 'object' ? options.priorityByKey : {};
    const priorityByKey = new Map(nodes.map((node) => [
      node.key,
      clamp(rawPriority[node.key], 0, 1)
    ]));
    const byKey = new Map();
    for (const node of nodes) {
      if (byKey.has(node.key)) throw new Error('Duplicate E2E scenario node: ' + node.key);
      byKey.set(node.key, node);
    }
    for (const node of nodes) {
      for (const dependency of node.dependencies) {
        if (!byKey.has(dependency)) throw new Error('Unknown E2E dependency ' + dependency + ' for ' + node.key);
      }
    }

    const selected = new Set();
    const visiting = new Set();
    function include(key) {
      if (selected.has(key)) return;
      if (visiting.has(key)) throw new Error('Cyclic E2E scenario dependency at ' + key);
      const node = byKey.get(key);
      if (!node) return;
      visiting.add(key);
      node.dependencies.forEach(include);
      visiting.delete(key);
      selected.add(key);
    }

    nodes.filter((node) => node.required).forEach((node) => include(node.key));
    const explicitRequired = Array.isArray(options?.requiredKeys) ? options.requiredKeys : [];
    // Full coverage is independent of seed/complexity. Randomness changes order,
    // never whether a registered feature is tested.
    if (options?.coverageMode === 'full') nodes.forEach((node) => include(node.key));
    explicitRequired.forEach((key) => include(String(key || '')));

    const level = clamp(options?.complexityLevel || 1, 1, 8);
    const requestedMin = Math.max(1, Math.trunc(Number(options?.minNodes) || 1));
    const requestedMax = Math.max(requestedMin, Math.trunc(Number(options?.maxNodes) || nodes.length));
    const target = Math.min(
      nodes.length,
      Math.max(
        selected.size,
        Math.min(requestedMax, requestedMin + Math.min(4, Math.floor(level / 2)))
      )
    );
    const optional = shuffled(nodes.filter((node) => !selected.has(node.key)), options?.randomUnit);
    for (const node of optional) {
      if (selected.size >= target) break;
      include(node.key);
    }

    const pending = new Map(nodes.filter((node) => selected.has(node.key)).map((node) => [node.key, node]));
    const emitted = new Set();
    const ordered = [];
    const next = typeof options?.randomUnit === 'function' ? options.randomUnit : Math.random;
    while (pending.size) {
      const ready = [...pending.values()].filter((node) =>
        node.dependencies.every((dependency) => !selected.has(dependency) || emitted.has(dependency))
      );
      if (!ready.length) throw new Error('E2E scenario graph has no executable node; dependency cycle suspected.');
      ready.sort((left, right) => left.phase - right.phase || left.key.localeCompare(right.key));
      const minPhase = ready[0].phase;
      const pool = ready.filter((node) => node.phase <= minPhase + 1);
      const unit = Math.max(0, Math.min(0.999999999, Number(next()) || 0));
      const hasHistoricalPriority = pool.some((node) => Number(priorityByKey.get(node.key) || 0) > 0);
      let chosen;
      if (hasHistoricalPriority) {
        const weighted = pool.map((node) => ({
          node,
          weight: 1 + 4 * Number(priorityByKey.get(node.key) || 0)
        }));
        const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
        let threshold = unit * totalWeight;
        chosen = weighted[weighted.length - 1]?.node || pool[0];
        for (const item of weighted) {
          threshold -= item.weight;
          if (threshold <= 0) {
            chosen = item.node;
            break;
          }
        }
      } else {
        chosen = pool[Math.floor(unit * pool.length)] || pool[0];
      }
      ordered.push(chosen);
      emitted.add(chosen.key);
      pending.delete(chosen.key);
    }

    const seed = String(options?.seed || '');
    const keys = ordered.map((node) => node.key);
    const fingerprint = 'SG1-' + hashText(seed + '|' + keys.join('>'));
    return {
      version: 1,
      seed,
      complexityLevel: level,
      coverageMode: options?.coverageMode === 'full' ? 'full' : 'sampled',
      fingerprint,
      keys,
      path: ordered.map((node, index) => ({
        order: index + 1,
        key: node.key,
        name: node.name,
        domain: node.domain,
        module: node.module,
        phase: node.phase,
        risk: node.risk,
        priority: Number(priorityByKey.get(node.key) || 0),
        required: node.required
      }))
    };
  }

  function replayScenario(options) {
    const source = Array.isArray(options?.nodes) ? options.nodes : [];
    if (!source.length) throw new Error('E2E replay requires a non-empty scenario catalog.');
    const nodes = source.map((node, index) => normalizeNode(node, index, options?.metaByKey || {}));
    const byKey = new Map();
    for (const node of nodes) {
      if (byKey.has(node.key)) throw new Error('Duplicate E2E scenario node: ' + node.key);
      byKey.set(node.key, node);
    }
    for (const node of nodes) {
      for (const dependency of node.dependencies) {
        if (!byKey.has(dependency)) throw new Error('Unknown E2E dependency ' + dependency + ' for ' + node.key);
      }
    }
    const keys = Array.isArray(options?.keys) ? options.keys.map((key) => String(key || '').trim()).filter(Boolean) : [];
    if (!keys.length) throw new Error('E2E replay path is empty.');
    if (new Set(keys).size !== keys.length) throw new Error('E2E replay path contains duplicate nodes.');
    for (const key of keys) if (!byKey.has(key)) throw new Error('E2E replay node is unavailable in the current build: ' + key);

    const selected = new Set(keys);
    const requiredKeys = new Set(
      nodes.filter((node) => node.required).map((node) => node.key)
        .concat(Array.isArray(options?.requiredKeys) ? options.requiredKeys.map((key) => String(key || '')) : [])
        .filter(Boolean)
    );
    for (const key of requiredKeys) if (!selected.has(key)) throw new Error('E2E replay path is missing required node: ' + key);

    const position = new Map(keys.map((key, index) => [key, index]));
    for (const key of keys) {
      const node = byKey.get(key);
      for (const dependency of node.dependencies) {
        if (!selected.has(dependency)) throw new Error('E2E replay path is missing dependency ' + dependency + ' for ' + key);
        if (position.get(dependency) >= position.get(key)) {
          throw new Error('E2E replay dependency order is invalid: ' + dependency + ' must precede ' + key);
        }
      }
    }

    const seed = String(options?.seed || '');
    const fingerprint = 'SG1-' + hashText(seed + '|' + keys.join('>'));
    const expectedFingerprint = String(options?.expectedFingerprint || '');
    if (expectedFingerprint && fingerprint !== expectedFingerprint) {
      throw new Error('E2E replay fingerprint mismatch: expected ' + expectedFingerprint + ', got ' + fingerprint);
    }
    const level = clamp(options?.complexityLevel || 1, 1, 8);
    return {
      version: 1,
      replay: true,
      seed,
      complexityLevel: level,
      fingerprint,
      keys,
      path: keys.map((key, index) => {
        const node = byKey.get(key);
        return {
          order: index + 1, key: node.key, name: node.name, domain: node.domain,
          module: node.module, phase: node.phase, risk: node.risk, required: node.required
        };
      })
    };
  }

  return { planScenario, replayScenario, hashText, runWithDeadline };
});
