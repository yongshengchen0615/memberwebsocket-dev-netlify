const ALLOWED_ORIGINS = new Set(
  (Deno.env.get("ALLOWED_ORIGINS") || "https://yongshengchen0615.github.io")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

function corsHeaders(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "",
    "Access-Control-Allow-Headers": "content-type, apikey",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

Deno.serve((request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  return new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: "FEATURE_REMOVED",
        message: "技師永久刪除功能已移除；請使用停用或恢復公開。",
      },
    }),
    {
      status: 410,
      headers: {
        ...corsHeaders(origin),
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
});
