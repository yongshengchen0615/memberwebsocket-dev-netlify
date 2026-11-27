// Pure eligibility rules shared by member-calendar Edge and Deno acceptance tests.
// Ownership and confirmation state are checked by the caller before passing bookings.
export type UsageRule = {
  requiredServiceIds: string[];
  requiredServiceMatchMode: string;
  requiredServiceGroups: string[][];
  minBookingAmountMode: string;
  minBookingAmount: number;
  minBookingServiceIds: string[];
  minBookingPartySize: number;
  maxBookingPartySize: number;
};

export function activityUsageRules(value: unknown): UsageRule {
  const rule: any = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    requiredServiceIds: Array.isArray(rule.requiredServiceIds) ? rule.requiredServiceIds.map(String) : [],
    requiredServiceMatchMode: String(rule.requiredServiceMatchMode || "any"),
    requiredServiceGroups: Array.isArray(rule.requiredServiceGroups)
      ? rule.requiredServiceGroups.filter((group: unknown) => Array.isArray(group)).map((group: string[]) => group.map(String)) : [],
    minBookingAmountMode: String(rule.minBookingAmountMode || "none"),
    minBookingAmount: Number(rule.minBookingAmount || 0),
    minBookingServiceIds: Array.isArray(rule.minBookingServiceIds) ? rule.minBookingServiceIds.map(String) : [],
    minBookingPartySize: Number(rule.minBookingPartySize || 0),
    maxBookingPartySize: Number(rule.maxBookingPartySize || 0),
  };
}

export function activityRequiresBooking(rule: UsageRule): boolean {
  return rule.requiredServiceIds.length > 0 || rule.requiredServiceGroups.length > 0
    || rule.minBookingAmountMode !== "none" || rule.minBookingPartySize > 0 || rule.maxBookingPartySize > 0;
}

export function usageConditionLabel(rule: UsageRule, serviceNames: Map<string,string>): string {
  if (!activityRequiresBooking(rule)) return "";
  const name = (id: string) => serviceNames.get(id) || "已停用項目";
  const clauses: string[] = [];
  if (rule.requiredServiceGroups.length) {
    clauses.push("預約「" + rule.requiredServiceGroups.map((group) => group.map(name).join("＋")).join("」或「") + "」其中一組");
  } else if (rule.requiredServiceIds.length) {
    clauses.push(rule.requiredServiceMatchMode === "all"
      ? "預約所有項目：「" + rule.requiredServiceIds.map(name).join("、") + "」"
      : "預約其中一項：「" + rule.requiredServiceIds.map(name).join("、") + "」");
  }
  if (rule.minBookingAmountMode !== "none") {
    const money = "NT$" + rule.minBookingAmount.toLocaleString("en-US");
    clauses.push(rule.minBookingAmountMode === "total"
      ? "整筆預約滿 " + money
      : "指定項目「" + rule.minBookingServiceIds.map(name).join("、") + "」合計滿 " + money);
  }
  if (rule.minBookingPartySize && rule.maxBookingPartySize) {
    clauses.push(rule.minBookingPartySize === rule.maxBookingPartySize
      ? "限 " + rule.minBookingPartySize + " 人"
      : "預約 " + rule.minBookingPartySize + "–" + rule.maxBookingPartySize + " 人");
  } else if (rule.minBookingPartySize) clauses.push("至少 " + rule.minBookingPartySize + " 人");
  else if (rule.maxBookingPartySize) clauses.push("最多 " + rule.maxBookingPartySize + " 人");
  return clauses.join(" · ");
}

export function bookingSatisfiesActivity(
  booking: any, bookingItems: any[], rule: UsageRule,
): boolean {
  const party = Number(booking.party_size);
  if (!Number.isSafeInteger(party) || party < 1) return false;
  if (rule.minBookingPartySize > 0 && party < rule.minBookingPartySize) return false;
  if (rule.maxBookingPartySize > 0 && party > rule.maxBookingPartySize) return false;
  const serviceIds = new Set(bookingItems.map((item:any) => String(item.service_id || "")));
  if (rule.requiredServiceGroups.length) {
    if (!rule.requiredServiceGroups.some((group) => group.length > 0 && group.every((id) => serviceIds.has(id)))) return false;
  } else if (rule.requiredServiceIds.length) {
    const matches = rule.requiredServiceMatchMode === "all"
      ? rule.requiredServiceIds.every((id) => serviceIds.has(id))
      : rule.requiredServiceIds.some((id) => serviceIds.has(id));
    if (!matches) return false;
  }
  if (rule.minBookingAmountMode !== "none") {
    const total = bookingItems
      .filter((item:any) => rule.minBookingAmountMode === "total"
        || rule.minBookingServiceIds.includes(String(item.service_id || "")))
      .reduce((sum:number,item:any) => sum + Number(item.unit_price_amount || 0) * Number(item.quantity || 0),0);
    if (!Number.isSafeInteger(total) || total < rule.minBookingAmount) return false;
  }
  return true;
}

