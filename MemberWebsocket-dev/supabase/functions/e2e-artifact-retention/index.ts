import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const BUCKET = "e2e-failure-artifacts";
const RETENTION_DAYS = 30;
const PAGE_SIZE = 1000;
const MAX_ROUNDS = 100;

function env(name: string): string { return (Deno.env.get(name) || "").trim(); }
function db() {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_CONFIG_MISSING");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
function secureEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}
Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "METHOD_NOT_ALLOWED" }), {
      status: 405, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  const supabase = db();
  const secretResult = await supabase.rpc("get_e2e_artifact_retention_secret");
  const expectedSecret = secretResult.error ? "" : String(secretResult.data || "");
  const suppliedSecret = request.headers.get("x-retention-secret") || "";
  if (!expectedSecret || !secureEqual(expectedSecret, suppliedSecret)) {
    return new Response(JSON.stringify({ ok: false, error: "UNAUTHORIZED" }), {
      status: 401, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  const cutoffMs = Date.now() - RETENTION_DAYS * 86400000;
  let deleted = 0;
  let scanned = 0;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const listed = await supabase.storage.from(BUCKET).list("runs", {
      limit: PAGE_SIZE, offset: 0, sortBy: { column: "created_at", order: "asc" },
    });
    if (listed.error) {
      return new Response(JSON.stringify({ ok: false, error: "LIST_FAILED", detail: listed.error.message }), {
        status: 500, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    const rows = Array.isArray(listed.data) ? listed.data : [];
    scanned += rows.length;
    const expired = rows
      .filter((item: any) => String(item?.name || "").endsWith(".webp"))
      .filter((item: any) => {
        const createdMs = Date.parse(String(item?.created_at || item?.updated_at || ""));
        return Number.isFinite(createdMs) && createdMs < cutoffMs;
      })
      .map((item: any) => "runs/" + String(item.name));
    if (!expired.length) break;
    for (let offset = 0; offset < expired.length; offset += 100) {
      const batch = expired.slice(offset, offset + 100);
      const removed = await supabase.storage.from(BUCKET).remove(batch);
      if (removed.error) {
        return new Response(JSON.stringify({ ok: false, error: "REMOVE_FAILED", detail: removed.error.message, deleted, scanned }), {
          status: 500, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      deleted += batch.length;
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return new Response(JSON.stringify({
    ok: true, bucket: BUCKET, retentionDays: RETENTION_DAYS, deleted, scanned, completedAt: new Date().toISOString(),
  }), {
    status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
});
