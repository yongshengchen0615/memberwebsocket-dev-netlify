const CURRENT_SECTION_TITLES = new Set(["目前會員狀態", "目前可用優惠"]);

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

export function replaceCurrentGrantSections(
  originalMessage: unknown,
  currentStatusSection: string,
  availableOffersSection: string,
): string {
  const source = normalize(originalMessage);
  const intro: string[] = [];
  const sections: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } | null = null;

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trimEnd();
    const match = line.trim().match(/^【([^】]{1,40})】(?:\s*(.*))?$/);
    if (match) {
      if (current) sections.push(current);
      current = { title: match[1].trim(), lines: [] };
      if (match[2]) current.lines.push(match[2].trim());
      continue;
    }
    if (current) current.lines.push(line);
    else intro.push(line);
  }
  if (current) sections.push(current);

  const blocks: string[] = [];
  const introText = intro.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (introText) blocks.push(introText);

  for (const section of sections) {
    if (CURRENT_SECTION_TITLES.has(section.title)) continue;
    const body = section.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    blocks.push(`【${section.title}】${body ? `\n${body}` : ""}`);
  }

  const liveStatus = normalize(currentStatusSection);
  const liveOffers = normalize(availableOffersSection);
  if (liveStatus) blocks.push(liveStatus);
  if (liveOffers) blocks.push(liveOffers);

  return blocks.join("\n\n").slice(0, 5000);
}
