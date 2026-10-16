// RETIRED COMPATIBILITY ENDPOINT.
// Member calendar traffic is owned by member-calendar-api.
const REPLACEMENT_FUNCTION = "member-calendar-api";

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
      message: "舊會員日曆 API 已停用，請重新整理頁面使用新版服務。",
      details: { replacement: REPLACEMENT_FUNCTION },
    },
  }), { status: 410, headers });
});
