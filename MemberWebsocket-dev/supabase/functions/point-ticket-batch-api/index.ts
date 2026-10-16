// RETIRED COMPATIBILITY ENDPOINT.
// Point ticket batch operations are owned by pointcard-extension-api.
const REPLACEMENT_FUNCTION = "pointcard-extension-api";

Deno.serve((request: Request) => {
  const origin = request.headers.get("Origin");
  const allowOrigin = origin === "https://yongshengchen0615.github.io" ? origin : "";
  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "content-type, apikey",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  return new Response(JSON.stringify({
    ok: false,
    status: 410,
    error: {
      code: "FUNCTION_RETIRED",
      message: "舊集點票券批次 API 已停用，請重新整理頁面使用新版服務。",
      details: { replacement: REPLACEMENT_FUNCTION },
    },
  }), { status: 410, headers });
});
