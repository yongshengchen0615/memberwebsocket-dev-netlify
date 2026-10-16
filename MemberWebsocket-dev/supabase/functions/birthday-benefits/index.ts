function corsHeaders(origin: string | null): HeadersInit {
  const allowed = new Set((Deno.env.get("ALLOWED_ORIGINS") || "https://yongshengchen0615.github.io")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
  return {
    "Access-Control-Allow-Origin": origin && allowed.has(origin) ? origin : "",
    "Access-Control-Allow-Headers": "content-type, apikey",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

Deno.serve((request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });

  return new Response(JSON.stringify({
    ok: false,
    error: {
      code: "BIRTHDAY_BENEFIT_RETIRED",
      message: "壽星優惠已整合到活動票券的固定票券功能，請改用固定票券設定。",
    },
  }), {
    status: 410,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });
});
