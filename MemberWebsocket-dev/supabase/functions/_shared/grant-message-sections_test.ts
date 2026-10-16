import { replaceCurrentGrantSections } from "./grant-message-sections.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("replaceCurrentGrantSections keeps transaction snapshot and refreshes current sections", () => {
  const original = [
    "王小明，您好：",
    "",
    "【本次點數】",
    "・腳底集點卡 +3 點",
    "",
    "【目前會員狀態】",
    "・累積服務時間：100 分鐘",
    "・會員等級：一般會員",
    "",
    "【目前可用優惠】",
    "集點卡優惠",
    "・舊優惠",
  ].join("\n");

  const result = replaceCurrentGrantSections(
    original,
    "【目前會員狀態】\n・累積服務時間：320 分鐘\n・會員等級：銀級會員",
    "【目前可用優惠】\n集點卡優惠\n・新優惠",
  );

  assert(result.includes("【本次點數】\n・腳底集點卡 +3 點"), "transaction snapshot should be preserved");
  assert(result.includes("320 分鐘"), "current service total should be replaced");
  assert(result.includes("銀級會員"), "current tier should be replaced");
  assert(result.includes("新優惠"), "current offers should be replaced");
  assert(!result.includes("100 分鐘"), "stale member status should be removed");
  assert(!result.includes("舊優惠"), "stale offers should be removed");
});
