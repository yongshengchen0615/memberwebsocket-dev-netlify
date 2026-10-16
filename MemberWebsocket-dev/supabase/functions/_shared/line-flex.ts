export type LineFlexMessage = {
  type: "flex";
  altText: string;
  contents: Record<string, unknown>;
};

export type LineFlexNoticeOptions = {
  title?: string;
  eyebrow?: string;
  accent?: string;
  footer?: string;
};

type ParsedSection = {
  title: string;
  lines: string[];
};

const MAX_ALT_TEXT = 500;
const MAX_COMPONENT_TEXT = 1900;
const MAX_MESSAGE_TEXT = 5000;
const MAX_SECTIONS = 12;
const DEFAULT_ACCENT = "#315D50";
const TEXT_COLOR = "#17352E";
const MUTED_COLOR = "#728079";
const SURFACE_COLOR = "#F6F8F7";
const POINTS_LIFF_URL = "https://liff.line.me/2010787602-eIzRN9l6";
const EVENT_LIFF_URL = "https://liff.line.me/2010787602-tuapstY3";

function truncate(value: unknown, max: number): string {
  const text = String(value ?? "").replace(/\u0000/g, "").trim();
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}

function normalizeMessage(value: unknown): string {
  const text = String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "請至會員系統查看與使用。")
    .join("\n")
    .trim();
  return truncate(text || "會員權益已更新，請至會員系統查看最新資訊。", MAX_MESSAGE_TEXT);
}

function safeAccent(value: unknown): string {
  const color = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_ACCENT;
}

function parseMessage(message: string): { intro: string[]; sections: ParsedSection[] } {
  const intro: string[] = [];
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;

  for (const rawLine of message.split("\n")) {
    const line = rawLine.trimEnd();
    const heading = line.trim().match(/^【([^】]{1,40})】(?:\s*(.*))?$/);
    const sectionCount = sections.length + (current ? 1 : 0);
    if (heading && sectionCount < MAX_SECTIONS) {
      if (current) sections.push(current);
      current = { title: truncate(heading[1], 40), lines: [] };
      if (heading[2]) current.lines.push(truncate(heading[2], MAX_COMPONENT_TEXT));
      continue;
    }
    if (current) current.lines.push(line);
    else intro.push(line);
  }

  if (current) sections.push(current);
  return { intro, sections };
}

function compactLines(lines: string[]): string {
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function splitComponentText(value: string): string[] {
  const text = truncate(value, MAX_MESSAGE_TEXT);
  if (!text) return [];
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < chars.length; index += MAX_COMPONENT_TEXT) {
    chunks.push(chars.slice(index, index + MAX_COMPONENT_TEXT).join(""));
  }
  return chunks;
}

function textComponents(
  value: string,
  color = TEXT_COLOR,
  size = "sm",
): Array<Record<string, unknown>> {
  return splitComponentText(value).map((text, index) => ({
    type: "text",
    text,
    size,
    color,
    wrap: true,
    ...(index > 0 ? { margin: "sm" } : {}),
  }));
}

function detailRow(label: string, value: string): Record<string, unknown> {
  return {
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    alignItems: "flex-start",
    contents: [
      {
        type: "box",
        layout: "vertical",
        flex: 0,
        width: "82px",
        contents: [
          {
            type: "text",
            text: truncate(label, 24),
            size: "xs",
            color: MUTED_COLOR,
            wrap: true,
          },
        ],
      },
      {
        type: "text",
        text: truncate(value, MAX_COMPONENT_TEXT),
        size: "sm",
        color: TEXT_COLOR,
        weight: "bold",
        flex: 1,
        wrap: true,
      },
    ],
  };
}

function bulletRow(value: string, accent: string): Record<string, unknown> {
  return {
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    alignItems: "flex-start",
    contents: [
      {
        type: "text",
        text: "•",
        size: "sm",
        color: accent,
        flex: 0,
      },
      {
        type: "text",
        text: truncate(value, MAX_COMPONENT_TEXT),
        size: "sm",
        color: TEXT_COLOR,
        flex: 1,
        wrap: true,
      },
    ],
  };
}

function nextMeaningfulLine(lines: string[], start: number): string {
  for (let index = start; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line) return line;
  }
  return "";
}

function sectionLineComponents(lines: string[], accent: string): Array<Record<string, unknown>> {
  const components: Array<Record<string, unknown>> = [];
  const normalized = lines.map((line) => line.trim());

  for (let index = 0; index < normalized.length; index++) {
    const line = normalized[index];
    if (!line) continue;

    const bulletMatch = line.match(/^[・•]\s*(.+)$/);
    const content = bulletMatch ? bulletMatch[1].trim() : line;
    const keyValue = content.match(/^([^：]{1,24})：\s*(.+)$/);

    if (keyValue) {
      components.push(detailRow(keyValue[1], keyValue[2]));
      continue;
    }

    if (bulletMatch) {
      components.push(bulletRow(content, accent));
      continue;
    }

    const nextLine = nextMeaningfulLine(normalized, index + 1);
    const introducesList = /^[・•]/.test(nextLine);
    if (introducesList && Array.from(content).length <= 36) {
      components.push({
        type: "text",
        text: truncate(content, 80),
        size: "xs",
        weight: "bold",
        color: MUTED_COLOR,
        wrap: true,
      });
      continue;
    }

    components.push(...textComponents(content, MUTED_COLOR, "xs"));
  }

  return components;
}

function offerItemCard(
  title: string,
  source: string,
  meta: string,
  accent: string,
): Record<string, unknown> {
  const contents: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: truncate(title, 180),
      size: "sm",
      weight: "bold",
      color: TEXT_COLOR,
      wrap: true,
    },
  ];

  if (source) {
    contents.push({
      type: "text",
      text: truncate(source, 180),
      size: "xs",
      color: MUTED_COLOR,
      wrap: true,
      margin: "xs",
    });
  }
  if (meta) {
    contents.push({
      type: "text",
      text: truncate(meta, 180),
      size: "xs",
      weight: "bold",
      color: accent,
      wrap: true,
      margin: "xs",
    });
  }

  return {
    type: "box",
    layout: "vertical",
    paddingAll: "12px",
    backgroundColor: "#FFFFFF",
    cornerRadius: "10px",
    contents,
  };
}

function offerGroupAction(groupHeading: string, accent: string): Record<string, unknown> | null {
  const heading = groupHeading.trim();
  let label = "";
  let uri = "";

  if (heading.startsWith("集點卡優惠")) {
    label = "開啟集點卡";
    uri = POINTS_LIFF_URL;
  } else if (heading.startsWith("活動票券")) {
    label = "開啟活動票券";
    uri = EVENT_LIFF_URL;
  } else {
    return null;
  }

  return {
    type: "button",
    style: "primary",
    height: "sm",
    color: accent,
    margin: "sm",
    action: {
      type: "uri",
      label,
      uri,
    },
  };
}

function offerSectionComponents(lines: string[], accent: string): Array<Record<string, unknown>> {
  const components: Array<Record<string, unknown>> = [];
  const normalized = lines.map((line) => line.trim());
  let currentGroupHeading = "";
  let currentGroupHasItems = false;

  const appendGroupAction = () => {
    if (!currentGroupHasItems) return;
    const action = offerGroupAction(currentGroupHeading, accent);
    if (action) components.push(action);
    currentGroupHasItems = false;
  };

  for (let index = 0; index < normalized.length; index++) {
    const line = normalized[index];
    if (!line || line === "請至會員系統查看與使用。") continue;

    const bulletMatch = line.match(/^[・•]\s*(.+)$/);
    if (!bulletMatch) {
      appendGroupAction();
      currentGroupHeading = line;
      const nextLine = nextMeaningfulLine(normalized, index + 1);
      const isGroupHeading = /^[・•]/.test(nextLine);
      components.push({
        type: "text",
        text: truncate(line, 100),
        size: isGroupHeading ? "xs" : "xxs",
        weight: isGroupHeading ? "bold" : "regular",
        color: isGroupHeading ? accent : MUTED_COLOR,
        wrap: true,
        ...(components.length ? { margin: isGroupHeading ? "sm" : "xs" } : {}),
      });
      continue;
    }

    const content = bulletMatch[1].trim();
    const pointOfferParts = content.split("｜").map((part) => part.trim()).filter(Boolean);
    if (pointOfferParts.length >= 3) {
      const [source, title, ...metaParts] = pointOfferParts;
      components.push(offerItemCard(title, source, metaParts.join("｜"), accent));
      currentGroupHasItems = true;
      continue;
    }

    const eventMatch = content.match(/^(.+?)（(已領取|可領取)）$/);
    if (eventMatch) {
      components.push(offerItemCard(eventMatch[1], "活動票券", `狀態：${eventMatch[2]}`, accent));
      currentGroupHasItems = true;
      continue;
    }

    components.push(offerItemCard(content, "", "", accent));
    currentGroupHasItems = true;
  }

  appendGroupAction();
  return components;
}

function introCard(intro: string): Record<string, unknown> {
  return {
    type: "box",
    layout: "vertical",
    spacing: "xs",
    paddingAll: "14px",
    backgroundColor: SURFACE_COLOR,
    cornerRadius: "12px",
    contents: textComponents(intro, TEXT_COLOR),
  };
}

function sectionCard(section: ParsedSection, accent: string): Record<string, unknown> {
  const contents: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: section.title,
      size: "sm",
      weight: "bold",
      color: accent,
      wrap: true,
    },
  ];
  const details = section.title === "目前可用優惠"
    ? offerSectionComponents(section.lines, accent)
    : sectionLineComponents(section.lines, accent);
  if (details.length) {
    contents.push({ type: "separator", margin: "sm", color: "#E5EAE7" });
    contents.push({
      type: "box",
      layout: "vertical",
      spacing: "sm",
      margin: "sm",
      contents: details,
    });
  }
  return {
    type: "box",
    layout: "vertical",
    paddingAll: "14px",
    backgroundColor: SURFACE_COLOR,
    cornerRadius: "12px",
    contents,
  };
}

function makeAltText(message: string, title: string): string {
  const summary = message
    .replace(/[【】]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(summary || title, MAX_ALT_TEXT);
}

export function buildLineFlexNotice(messageText: unknown, options: LineFlexNoticeOptions = {}): LineFlexMessage {
  const message = normalizeMessage(messageText);
  const title = truncate(options.title || "會員通知", 60);
  const eyebrow = truncate(options.eyebrow || "LUMEN CLUB", 40);
  const footer = truncate(options.footer || "Lumen Club 會員系統", 80);
  const accent = safeAccent(options.accent);
  const parsed = parseMessage(message);
  const bodyContents: Array<Record<string, unknown>> = [];
  const intro = compactLines(parsed.intro);

  if (intro) bodyContents.push(introCard(intro));
  for (const section of parsed.sections) bodyContents.push(sectionCard(section, accent));
  if (!bodyContents.length) bodyContents.push(introCard(message));

  return {
    type: "flex",
    altText: makeAltText(message, title),
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        spacing: "xs",
        backgroundColor: accent,
        paddingAll: "18px",
        contents: [
          { type: "text", text: eyebrow, size: "xxs", weight: "bold", color: "#DDE9E5" },
          { type: "text", text: title, size: "xl", weight: "bold", color: "#FFFFFF", wrap: true },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "16px",
        backgroundColor: "#FFFFFF",
        contents: bodyContents,
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "12px",
        backgroundColor: SURFACE_COLOR,
        contents: [
          { type: "text", text: footer, size: "xxs", color: "#87928D", align: "center" },
        ],
      },
    },
  };
}
