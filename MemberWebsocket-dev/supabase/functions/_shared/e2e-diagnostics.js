const DIAGNOSTIC_VERSION = 3;

function asText(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function safeStringify(value, max = 12000) {
  try {
    return JSON.stringify(value ?? {}).slice(0, max);
  } catch {
    return "";
  }
}

function findField(value, keys, depth = 0) {
  const pending = [{ value, depth }];
  const seen = new WeakSet();
  let visited = 0;
  // Depth alone does not bound work in a wide trace. Share one traversal
  // budget across all branches and tolerate cyclic browser diagnostics.
  while (pending.length && visited < 256) {
    const current = pending.pop();
    const node = current.value;
    if (current.depth > 5 || node == null || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    visited += 1;
    const entries = Array.isArray(node)
      ? node.slice(0, 24).map((item, index) => [String(index), item])
      : Object.entries(node).slice(0, 80);
    if (!Array.isArray(node)) {
      for (const [key, item] of entries) {
        if (keys.has(key.toLowerCase()) && item != null) return item;
      }
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      pending.push({ value: entries[index][1], depth: current.depth + 1 });
    }
  }
  return null;
}

function firstHttpStatus(actual, trace) {
  const keys = new Set(["httpstatus", "http_status", "statuscode", "status_code"]);
  for (const source of [actual, trace?.error]) {
    const raw = findField(source, keys);
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  const failedRequest = requestEntries(trace).filter((item) => requestStatus(item) >= 400).at(-1);
  if (failedRequest) return requestStatus(failedRequest);
  const generic = findField(actual, new Set(["status"]));
  const value = Number(generic);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function firstSourceCode(actual, trace) {
  const keys = new Set(["errorcode", "error_code", "downstreamcode", "downstream_code", "code"]);
  // Keep the explicit error reachable even when the surrounding trace is wide.
  const raw = findField(actual, keys) ?? findField(trace?.error, keys) ?? findField(trace, keys);
  return asText(raw, 120).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120);
}

function requestEntries(trace) {
  const timings = Array.isArray(trace?.apiTimings) ? trace.apiTimings : [];
  const requests = Array.isArray(trace?.networkRequests) ? trace.networkRequests : [];
  return [...timings, ...requests].filter((item) => item && typeof item === "object" && item.path);
}

function requestStatus(item) {
  const status = Number(item?.httpStatus ?? item?.responseStatus ?? item?.statusCode ?? item?.status);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function firstPath(trace, httpStatus) {
  const entries = requestEntries(trace);
  const candidate = (httpStatus == null ? null : entries.filter((item) => requestStatus(item) === httpStatus).at(-1))
    || entries.filter((item) => requestStatus(item) >= 400).at(-1)
    || entries.at(-1);
  const path = asText(candidate?.path, 240).split(/[?#]/, 1)[0];
  return path.startsWith("/") && !path.startsWith("//") ? path : "";
}

function fnv1a(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

function includesAny(haystack, patterns) {
  return patterns.some((pattern) => haystack.includes(pattern));
}

function unmetBooleanAssertions(expected, actual) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return [];
  return Object.entries(expected).filter(([key, value]) =>
    typeof value === "boolean" && actual?.[key] !== value
  ).map(([key]) => key).slice(0, 20);
}

export function diagnoseE2EFailure(input = {}) {
  const caseKey = asText(input.caseKey, 100) || "UNKNOWN_CASE";
  const domain = asText(input.domain, 120);
  const message = asText(input.message, 1600);
  const expected = input.expected && typeof input.expected === "object" ? input.expected : {};
  const actual = input.actual && typeof input.actual === "object" ? input.actual : {};
  const trace = input.trace && typeof input.trace === "object" ? input.trace : {};
  const unmetFields = unmetBooleanAssertions(expected, actual);
  const sourceCode = firstSourceCode(actual, trace);
  const statusKeys = new Set(["httpstatus", "http_status", "statuscode", "status_code"]);
  const explicitStatus = findField(actual, statusKeys) ?? findField(trace?.error, statusKeys);
  const observedStatus = firstHttpStatus(actual, trace);
  // A successful negative test can leave an intentional 4xx in apiTimings.
  // For a boolean assertion mismatch, classify the failing fields instead of
  // attributing that unrelated request or the generic case title as the cause.
  const assertionOnly = unmetFields.length > 0 && !sourceCode && explicitStatus == null
    && !trace?.error && observedStatus !== 429 && !(observedStatus >= 500);
  const httpStatus = assertionOnly ? null : observedStatus;
  const probeEndpoint = asText(actual?.userDateWindowProbe?.endpoint, 80);
  const path = assertionOnly && /^[a-z0-9-]+$/.test(probeEndpoint)
    ? "/functions/v1/" + probeEndpoint : assertionOnly ? "" : firstPath(trace, httpStatus);
  const signal = assertionOnly ? unmetFields.join(" ").toLowerCase() : [
    message, sourceCode, safeStringify(actual), safeStringify(trace?.error), safeStringify(trace?.events),
  ].join(" ").toLowerCase();

  let category = "assertion";
  let code = "E2E_ASSERTION";
  let layer = "test-assertion";
  let retryable = false;

  const popupBlocked = new Set(["E2E_BACKGROUND_POPUP_BLOCKED", "E2E_POPUP_BLOCKED"]).has(sourceCode);
  const runnerLifecycle = sourceCode === "E2E_BACKGROUND_INTERRUPTED"
    || sourceCode.startsWith("E2E_BACKGROUND_RUNNER_")
    || includesAny(signal, ["背景 runner 視窗已關閉", "背景 runner 中斷", "background runner closed", "background runner stalled"]);

  if (popupBlocked) {
    category = "browser-policy";
    code = "E2E_BROWSER_POLICY";
    layer = "browser";
  } else if (runnerLifecycle) {
    category = "runner-lifecycle";
    code = "E2E_RUNNER_LIFECYCLE";
    layer = "orchestration";
    retryable = true;
  } else if (httpStatus === 401) {
    category = "authentication";
    code = "E2E_AUTHENTICATION";
    layer = "authentication";
  } else if (httpStatus === 403) {
    category = "authorization";
    code = "E2E_AUTHORIZATION";
    layer = "authorization";
  } else if (httpStatus === 429) {
    category = "rate-limit";
    code = "E2E_RATE_LIMIT";
    layer = "edge-function";
    retryable = true;
  } else if (httpStatus === 404 && /^\/functions\/v1\/[a-z0-9-]+$/.test(path)
    && ["NOT_FOUND", "FUNCTION_NOT_FOUND"].includes(sourceCode)) {
    category = "deployment-route";
    code = "E2E_DEPLOYMENT_ROUTE";
    layer = "edge-gateway";
  } else if (httpStatus != null && httpStatus >= 500) {
    category = "backend";
    code = "E2E_BACKEND";
    layer = "backend";
    retryable = true;
  } else if (assertionOnly && includesAny(signal, ["datewindow", "bookingdatewindow"])) {
    category = "api-contract";
    code = "E2E_API_CONTRACT";
    layer = "edge-function";
  } else if (
    httpStatus === 429
    || includesAny(signal, ["rate_limit", "rate-limited", "rate limited", "too many requests", "429", "過於密集", "稍後再試"])
  ) {
    category = "rate-limit";
    code = "E2E_RATE_LIMIT";
    layer = "edge-function";
    retryable = true;
  } else if (
    includesAny(signal, ["realtime", "websocket", "channel error", "subscribe", "subscription", "即時同步", "同步逾時"])
  ) {
    category = "realtime";
    code = "E2E_REALTIME";
    layer = "realtime";
    retryable = true;
  } else if (
    includesAny(signal, ["timeout", "timed out", "time out", "逾時", "超時", "允許時間", "deadline exceeded"])
  ) {
    category = "timeout";
    code = "E2E_TIMEOUT";
    layer = "orchestration";
    retryable = true;
  } else if (
    httpStatus === 403
    || includesAny(signal, ["forbidden", "permission denied", "authorization", "權限不足", "無權限", "不允許"])
  ) {
    category = "authorization";
    code = "E2E_AUTHORIZATION";
    layer = "authorization";
  } else if (
    httpStatus === 401
    || includesAny(signal, [
      "unauthenticated", "authentication", "invalid token", "expired token", "session expired",
      "登入資訊", "登入失效", "重新登入", "session 尚未", "session required",
    ])
  ) {
    category = "authentication";
    code = "E2E_AUTHENTICATION";
    layer = "authentication";
  } else if (
    includesAny(signal, ["failed to fetch", "networkerror", "network error", "offline", "connection reset", "connection refused", "網路"])
  ) {
    category = "network";
    code = "E2E_NETWORK";
    layer = "browser-network";
    retryable = true;
  } else if (
    (httpStatus != null && httpStatus >= 500)
    || includesAny(signal, ["service unavailable", "database", "資料庫暫時", "服務暫時", "internal server error"])
  ) {
    category = "backend";
    code = "E2E_BACKEND";
    layer = "backend";
    retryable = true;
  } else if (
    includesAny(signal, ["window.error", "unhandledrejection", "typeerror", "referenceerror", "syntaxerror"])
  ) {
    category = "client-error";
    code = "E2E_CLIENT_ERROR";
    layer = "browser";
  }

  const fingerprintBasis = [
    category,
    caseKey,
    domain,
    sourceCode || "-",
    httpStatus == null ? "-" : String(httpStatus),
    path || "-",
  ].join("|");

  const runnerNextCheck = {
    E2E_BACKGROUND_RUNNER_CONTROL_LOAD_FAILED: "檢查 Runner 的 loader 狀態、控制器腳本 HTTP 狀態與失敗快照；修正載入後再啟動。",
    E2E_BACKGROUND_RUNNER_VERSION_MISMATCH: "比對主管理頁與 Runner 的 controllerVersion，重新整理管理端以載入同一版本。",
    E2E_BACKGROUND_RUNNER_NOT_READY: "比對 Runner 快照的 adminReady、loader.phase、controllerReady 及資源耗時，定位未完成的啟動階段。",
    E2E_BACKGROUND_RUNNER_BOOT_FAILED: "檢查 Runner 的登入／初始化錯誤畫面、adminReady 與 API 耗時；先修復啟動失敗。",
  }[sourceCode];
  const nextCheck = runnerNextCheck || {
    "rate-limit": "檢查失敗 API 的 429 紀錄及同帳號並行請求數。",
    realtime: "比對訂閱狀態、資料更新時間與用戶端畫面更新事件。",
    timeout: "檢查最後一筆 API 耗時及 Runner 頁面可見性，定位等待的步驟。",
    authorization: "檢查管理員權限、測試帳號所有權及受保護 API 的拒絕紀錄。",
    authentication: "檢查測試 Session 是否有效，以及登入或續期是否完成。",
    network: "檢查瀏覽器網路狀態及最後一筆 API 請求。",
    backend: "對照 API 狀態碼與 Edge Function／資料庫錯誤紀錄。",
    "client-error": "檢查瀏覽器錯誤事件與對應操作前後的畫面狀態。",
    "api-contract": "比對失敗案例的日期範圍探測值、後端時段回應與預約共用設定。",
    "deployment-route": "核對 Edge Function slug、部署狀態、前端端點與版本；勿將缺少函式路由當成會員資料不存在。",
    "browser-policy": "確認管理端網站已允許彈出式視窗，再由使用者操作重新啟動 E2E。",
    "runner-lifecycle": "檢查 Runner 是否被關閉、最後心跳時間與最後完成案例，再重播相同 seed。",
    assertion: "比對 Expected／Actual，確認資料寫入、回讀及畫面呈現的第一個差異。",
  }[category];

  return {
    version: DIAGNOSTIC_VERSION,
    code,
    category,
    layer,
    retryable,
    nextCheck,
    fingerprint: "E2E-" + fnv1a(fingerprintBasis),
    signal: {
      caseKey,
      sourceCode: sourceCode || null,
      httpStatus,
      path: path || null,
    },
  };
}

export function attachE2EDiagnosis(trace, diagnosis) {
  const base = trace && typeof trace === "object" && !Array.isArray(trace) ? trace : {};
  return {
    ...base,
    artifactVersion: Math.max(DIAGNOSTIC_VERSION, Number(base.artifactVersion || 0)),
    diagnosis,
  };
}

export function summarizeE2EFailureDiagnoses(items = []) {
  const byCategory = {};
  const byCode = {};
  const fingerprints = {};
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    const category = asText(item.category, 60) || "unknown";
    const code = asText(item.code, 80) || "E2E_UNKNOWN";
    const fingerprint = asText(item.fingerprint, 80);
    byCategory[category] = Number(byCategory[category] || 0) + 1;
    byCode[code] = Number(byCode[code] || 0) + 1;
    if (fingerprint) fingerprints[fingerprint] = Number(fingerprints[fingerprint] || 0) + 1;
  }
  return {
    version: DIAGNOSTIC_VERSION,
    total: Object.values(byCategory).reduce((sum, value) => sum + Number(value || 0), 0),
    byCategory,
    byCode,
    fingerprints,
  };
}
