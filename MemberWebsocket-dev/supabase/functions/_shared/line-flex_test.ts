import { buildLineFlexNotice } from "./line-flex.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function collectComponents(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const collected: Array<Record<string, unknown>> = [record];
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) collected.push(...collectComponents(item));
    } else if (child && typeof child === "object") {
      collected.push(...collectComponents(child));
    }
  }
  return collected;
}

Deno.test("buildLineFlexNotice creates a structured card layout with useful alt text", () => {
  const message = buildLineFlexNotice(
    "王小明，您好：\n\n【本次點數】\n・集點卡 +3 點\n\n【目前會員狀態】\n・累積服務時間：320 分鐘\n・會員等級：銀級會員",
    { title: "會員權益通知", eyebrow: "MEMBER BENEFITS" },
  );

  assert(message.type === "flex", "message type should be flex");
  assert(message.altText.includes("王小明"), "altText should preserve recipient context");
  assert(message.altText.includes("本次點數"), "altText should summarize the notice");
  assert(message.altText.length <= 500, "altText should stay within the conservative limit");
  assert(message.contents.type === "bubble", "contents should be a Flex bubble");

  const body = message.contents.body as Record<string, unknown>;
  const contents = body.contents as Array<Record<string, unknown>>;
  assert(Array.isArray(contents) && contents.length === 3, "intro and sections should render as separate cards");
  assert(contents.every((item) => item.type === "box"), "top-level body items should be mobile-friendly cards");
  assert(contents.every((item) => item.cornerRadius === "12px"), "cards should use consistent rounded corners");

  const components = collectComponents(body);
  assert(components.some((item) => item.text === "本次點數"), "section heading should be preserved");
  assert(components.some((item) => item.text === "目前會員狀態"), "multiple sections should be preserved");
  assert(components.some((item) => item.text === "會員等級"), "key/value lines should expose the label separately");
  assert(components.some((item) => item.text === "銀級會員"), "key/value lines should preserve the value");
});

Deno.test("buildLineFlexNotice renders available offers with direct LIFF actions", () => {
  const message = buildLineFlexNotice(
    [
      "王小明，您好：",
      "",
      "【目前可用優惠】",
      "集點卡優惠（依節點排序）",
      "・腳底按摩集點卡｜免費加時 10 分鐘｜消耗 8 點",
      "・全身按摩集點卡｜折抵 NT$200｜消耗 12 點",
      "",
      "活動票券",
      "・九月會員回饋（已領取）",
      "・生日月優惠（可領取）",
      "請至會員系統查看與使用。",
    ].join("\n"),
    { title: "會員權益通知", eyebrow: "MEMBER BENEFITS" },
  );

  const body = message.contents.body as Record<string, unknown>;
  const components = collectComponents(body);

  assert(components.some((item) => item.text === "目前可用優惠"), "available offers section heading should be preserved");
  assert(components.some((item) => item.text === "集點卡優惠（依節點排序）" && item.weight === "bold"), "point-card subgroup should be emphasized");
  assert(components.some((item) => item.text === "活動票券" && item.weight === "bold"), "event-ticket subgroup should be emphasized");
  assert(components.some((item) => item.text === "免費加時 10 分鐘" && item.weight === "bold"), "offer title should be the primary text");
  assert(components.some((item) => item.text === "腳底按摩集點卡"), "point-card source should remain visible");
  assert(components.some((item) => item.text === "消耗 8 點"), "redemption cost should remain visible");
  assert(components.some((item) => item.text === "九月會員回饋" && item.weight === "bold"), "event ticket title should be primary text");
  assert(components.some((item) => item.text === "狀態：已領取"), "claimed event ticket status should be explicit");
  assert(components.some((item) => item.text === "狀態：可領取"), "claimable event ticket status should be explicit");
  assert(!message.altText.includes("請至會員系統查看與使用。"), "legacy generic CTA should be removed from alt text");
  assert(!components.some((item) => item.text === "請至會員系統查看與使用。"), "legacy generic CTA should be removed from the Flex body");

  const offerCards = components.filter((item) => item.type === "box" && item.cornerRadius === "10px" && item.backgroundColor === "#FFFFFF");
  assert(offerCards.length === 4, "each available offer should render as an individual inner card");

  const buttons = components.filter((item) => item.type === "button");
  const pointButton = buttons.find((item) => (item.action as Record<string, unknown> | undefined)?.label === "開啟集點卡");
  const eventButton = buttons.find((item) => (item.action as Record<string, unknown> | undefined)?.label === "開啟活動票券");
  assert(pointButton, "point-card offers should include an open point-card button");
  assert(eventButton, "event-ticket offers should include an open event-ticket button");
  assert((pointButton.action as Record<string, unknown>).uri === "https://liff.line.me/2010787602-eIzRN9l6", "point-card button should open the point-card LIFF app");
  assert((eventButton.action as Record<string, unknown>).uri === "https://liff.line.me/2010787602-tuapstY3", "event-ticket button should open the event-ticket LIFF app");
});

Deno.test("buildLineFlexNotice falls back safely and chunks long text", () => {
  const fallback = buildLineFlexNotice("");
  assert(fallback.type === "flex", "empty input should still produce a flex message");
  assert(fallback.altText.length > 0, "empty input should receive fallback altText");

  const longMessage = buildLineFlexNotice("A".repeat(5000), { accent: "not-a-color" });
  const body = longMessage.contents.body as Record<string, unknown>;
  const textComponents = collectComponents(body).filter((item) => item.type === "text");
  assert(textComponents.length >= 3, "long text should be split into safe component sizes");
  assert(textComponents.every((item) => String(item.text || "").length <= 1900), "component text should stay under the configured limit");

  const header = longMessage.contents.header as Record<string, unknown>;
  assert(header.backgroundColor === "#315D50", "invalid accent should fall back to the default color");
});
