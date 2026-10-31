// Deployment-only tombstone for retired test-user / QA endpoints.
// Stored outside functions/ so automatic function discovery cannot publish
// the historical test implementation as a new active endpoint.
Deno.serve(() =>
  new Response(
    JSON.stringify({
      ok: false,
      status: 410,
      error: {
        code: "TEST_FEATURE_RETIRED",
        message: "測試會員與測試相關功能已移除。",
      },
    }),
    {
      status: 410,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    },
  )
);
