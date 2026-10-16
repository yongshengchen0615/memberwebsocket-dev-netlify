// RETIRED COMPATIBILITY ENDPOINT.
// CalendarSystem moved to its dedicated Supabase project.
const REPLACEMENT_ENDPOINT = "https://zrdpsobxaehqukacjjss.supabase.co/functions/v1/calendar-system-api";

Deno.serve((request: Request) => {
  const origin = request.headers.get("Origin");
  const allowOrigin = origin === "https://yongshengchen0615.github.io" ? origin : "";
  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "content-type, apikey",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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
      code: "CALENDAR_SYSTEM_MOVED",
      message: "CalendarSystem 已移至獨立 Supabase 專案。",
      details: { endpoint: REPLACEMENT_ENDPOINT },
    },
  }), { status: 410, headers });
});
