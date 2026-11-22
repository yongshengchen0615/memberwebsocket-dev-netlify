import { businessFetch as fetch } from '../_shared/business-scope.ts';
import { bookingDetailUri } from "./booking-actions.ts";
import { groupReminderNoticeFields, reminderNoticeCard } from "./reminder-notice.mjs";
export type BookingBenefits = {
  pointTickets: string[];
  eventTickets: string[];
  tierActivities: string[];
  tierLabel: string;
};

export type Job = {
  id: string;
  recipient: string;
  message_text: string;
  channel: string;
  attempt_count: number;
  booking_id?: string;
  event_key?: string;
  benefits?: BookingBenefits;
  copyText?: string;
  bookingStatus?: string;
  frontdeskCanReview?: boolean;
  frontdeskUri?: string;
};
export type Delivery = { accepted: boolean; retryable: boolean; status: number | null; lineRequestId: string };

type ParsedBookingParticipant = {
  label: string;
  items: string[];
  duration: string;
  amount: string;
  technician: string;
  note: string;
};

type ParsedBookingMessage = {
  title: string;
  fields: Array<{ label: string; value: string }>;
  services: string[];
  participants: ParsedBookingParticipant[];
  fallbackText: string;
  rejectionNotice: string;
};

type FlexText = Record<string, unknown>;
type LineFlexMessage = {
  type: 'flex';
  altText: string;
  contents: Record<string, unknown>;
};

const TITLE_STYLES: Record<string, { color: string; eyebrow: string }> = {
  '預約': { color: '#DF6B4D', eyebrow: 'NEW BOOKING' },
  '預約申請': { color: '#397AA3', eyebrow: 'PENDING CONFIRMATION' },
  '修改預約': { color: '#C56E32', eyebrow: 'BOOKING UPDATED' },
  '取消預約申請': { color: '#9A711F', eyebrow: 'CANCELLATION REQUEST' },
  '預約確認': { color: '#2F8F61', eyebrow: 'BOOKING CONFIRMED' },
  '預約提醒': { color: '#397AA3', eyebrow: 'BOOKING REMINDER' },
  '完成服務': { color: '#286553', eyebrow: 'SERVICE COMPLETED' },
  '預約未通過': { color: '#B35A50', eyebrow: 'BOOKING DECLINED' },
  '櫃檯拒絕預約': { color: '#A85543', eyebrow: 'FRONTDESK REVIEW' },
  '預約取消': { color: '#68756F', eyebrow: 'BOOKING CANCELLED' },
  '取消申請未通過': { color: '#A85C50', eyebrow: 'CANCELLATION DECLINED' },
};

const MAX_COMPONENT_TEXT = 1900;
const MAX_ALT_TEXT = 500;
const TEXT_COLOR = '#17352E';
const MUTED_COLOR = '#728079';
const SURFACE_COLOR = '#F6F8F7';

function truncate(value: unknown, max: number): string {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

function parseBookingMessage(message: string): ParsedBookingMessage {
  const fallbackText = truncate(message, MAX_COMPONENT_TEXT) || '預約狀態已更新，請至預約頁查看最新資訊。';
  const lines = String(message || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim());

  let title = '預約通知';
  let index = 0;
  const first = lines[0] || '';
  const titleMatch = first.match(/^【([^】]{1,40})】$/);
  if (titleMatch) {
    title = truncate(titleMatch[1], 40);
    index = 1;
  }

  // Rejection templates are appended after the last structured rejection reason.
  // Their punctuation and newlines are prose, never additional booking field labels.
  const lastReasonAt = title === '預約未通過'
    ? lines.findLastIndex((line) => /^拒絕原因：/.test(line)) : -1;
  const rejectionNotice = lastReasonAt >= index
    ? truncate(lines.slice(lastReasonAt + 1).join('\n'), 500) : '';
  const parseEnd = rejectionNotice ? lastReasonAt + 1 : lines.length;

  const fields: Array<{ label: string; value: string }> = [];
  const services: string[] = [];
  const participants: ParsedBookingParticipant[] = [];
  let currentParticipant: ParsedBookingParticipant | null = null;
  let readingServices = false;

  for (; index < parseEnd; index++) {
    const line = lines[index];
    if (!line) {
      readingServices = false;
      continue;
    }

    if (/^第(?:[一二三四五六七八九十]+|\s*\d+\s*)位預約$/.test(line)) {
      currentParticipant = { label: truncate(line, 40), items: [], duration: '', amount: '', technician: '', note: '' };
      participants.push(currentParticipant);
      readingServices = false;
      continue;
    }

    const separator = line.indexOf('：');
    if (currentParticipant && separator > 0) {
      const label = truncate(line.slice(0, separator), 30);
      const value = truncate(line.slice(separator + 1), 500);
      if (label === '預約項目') {
        currentParticipant.items = value
          ? value.split('、').map((item) => truncate(item, 180)).filter(Boolean)
          : [];
        continue;
      }
      if (label === '個別時間') {
        currentParticipant.duration = value;
        continue;
      }
      if (label === '個別金額') {
        currentParticipant.amount = value;
        continue;
      }
      if (label === '預約技師') {
        currentParticipant.technician = value || '現場安排';
        continue;
      }
      if (label === '個別備註' || label === '個別備注') {
        currentParticipant.note = value;
        continue;
      }
    }

    if (readingServices) {
      services.push(truncate(line, 180));
      continue;
    }

    if (separator > 0) {
      const label = truncate(line.slice(0, separator), 30);
      const value = truncate(line.slice(separator + 1), 500);
      if (label === '預約項目') {
        readingServices = true;
        if (value) services.push(truncate(value, 180));
      } else if (value) {
        fields.push({ label, value });
      }
      continue;
    }

    fields.push({ label: '說明', value: truncate(line, 500) });
  }

  // Both reminders and pending applications have per-line legacy 提醒事項 fields.
  return { title, fields: groupReminderNoticeFields(fields), services, participants, fallbackText, rejectionNotice };
}

function fieldRow(label: string, value: string): Record<string, unknown> {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    alignItems: 'flex-start',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        flex: 0,
        width: '68px',
        contents: [
          {
            type: 'text',
            text: truncate(label, 30),
            size: 'xs',
            color: MUTED_COLOR,
            wrap: true,
          },
        ],
      },
      {
        type: 'text',
        text: truncate(value, 500),
        size: 'sm',
        color: TEXT_COLOR,
        weight: 'bold',
        flex: 1,
        wrap: true,
      },
    ],
  };
}

function scheduleCard(parsed: ParsedBookingMessage, accent: string): Record<string, unknown> | null {
  const date = parsed.fields.find((field) => field.label === '日期')?.value || '';
  const time = parsed.fields.find((field) => field.label === '時段')?.value || '';
  if (!date && !time) return null;

  const contents: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: '預約時間',
      size: 'xs',
      weight: 'bold',
      color: MUTED_COLOR,
    },
  ];
  if (date) {
    contents.push({
      type: 'text',
      text: truncate(date, 80),
      size: 'lg',
      weight: 'bold',
      color: accent,
      wrap: true,
      margin: 'xs',
    });
  }
  if (time) {
    contents.push({
      type: 'text',
      text: truncate(time, 160),
      size: 'sm',
      weight: 'bold',
      color: TEXT_COLOR,
      wrap: true,
      margin: 'xs',
    });
  }

  return {
    type: 'box',
    layout: 'vertical',
    paddingAll: '14px',
    backgroundColor: SURFACE_COLOR,
    cornerRadius: '12px',
    contents,
  };
}

function detailsCard(fields: Array<{ label: string; value: string }>): Record<string, unknown> | null {
  const details = fields.filter((field) => field.label !== '日期' && field.label !== '時段');
  if (!details.length) return null;
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    paddingAll: '14px',
    backgroundColor: SURFACE_COLOR,
    cornerRadius: '12px',
    contents: details.map((field) => fieldRow(field.label, field.value)),
  };
}

function servicesCard(services: string[], accent: string): Record<string, unknown> | null {
  if (!services.length) return null;
  return {
    type: 'box',
    layout: 'vertical',
    paddingAll: '14px',
    backgroundColor: SURFACE_COLOR,
    cornerRadius: '12px',
    contents: [
      {
        type: 'text',
        text: '預約項目',
        size: 'sm',
        weight: 'bold',
        color: accent,
      },
      {
        type: 'separator',
        margin: 'sm',
        color: '#E5EAE7',
      },
      {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        margin: 'sm',
        contents: services.map((service) => ({
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          alignItems: 'flex-start',
          contents: [
            { type: 'text', text: '•', size: 'sm', color: accent, flex: 0 },
            {
              type: 'text',
              text: truncate(service, 180),
              size: 'sm',
              color: TEXT_COLOR,
              flex: 1,
              wrap: true,
            },
          ],
        })),
      },
    ],
  };
}

function participantsCard(participants: ParsedBookingParticipant[], accent: string, memberConfirmation = false): Record<string, unknown> | null {
  if (!participants.length) return null;
  const contents: Array<Record<string, unknown>> = memberConfirmation ? [] : [
    {
      type: 'text',
      text: '每位預約明細',
      size: 'sm',
      weight: 'bold',
      color: accent,
    },
  ];

  participants.forEach((participant, index) => {
    if (index > 0) contents.push({ type: 'separator', margin: 'md', color: '#E5EAE7' });
    contents.push({
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      margin: index === 0 ? 'sm' : 'md',
      contents: [
        {
          type: 'text',
          text: truncate(memberConfirmation ? participant.label.replace(/預約$/, '') : participant.label, 40),
          size: 'sm',
          weight: 'bold',
          color: TEXT_COLOR,
          wrap: true,
        },
        fieldRow('預約項目', participant.items.length ? participant.items.join('、') : '—'),
        ...(memberConfirmation ? [] : [
          fieldRow('個別時間', participant.duration || '—'),
          fieldRow('個別金額', participant.amount || '—'),
        ]),
        fieldRow('預約技師', participant.technician || '現場安排'),
        ...(participant.note ? [fieldRow('個別備註', participant.note)] : []),
      ],
    });
  });

  return {
    type: 'box',
    layout: 'vertical',
    paddingAll: '14px',
    backgroundColor: SURFACE_COLOR,
    cornerRadius: '12px',
    contents,
  };
}

// Frontdesk notices intentionally contain only the operational booking facts.
// The other channels retain their richer member/admin cards and private notes.
function frontdeskValue(parsed: ParsedBookingMessage, ...labels: string[]): string {
  for (const label of labels) {
    const value = parsed.fields.find((field) => field.label === label)?.value;
    if (value) return value;
  }
  return '';
}

function frontdeskDate(value: string): string {
  const match = value.match(/(?:^|\D)(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?=\D|$)/);
  if (!match) return '—';
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function frontdeskStartTime(value: string): string {
  const match = value.match(/(?:^|\D)([01]\d|2[0-3]):([0-5]\d)(?=\D|$)/);
  return match ? `${match[1]}:${match[2]}` : '—';
}

function frontdeskSummaryLines(parsed: ParsedBookingMessage): string[] {
  // Overnight shifts can have a business date one day before the appointment.
  // Prefer the actual start timestamp embedded in 時段; use 營業日 only when
  // the source has no full start date (legacy notices with a time-only range).
  const start = frontdeskValue(parsed, '時段', '預約時間', '時間');
  const startDate = frontdeskDate(start);
  const date = startDate !== '—' ? startDate
    : frontdeskDate(frontdeskValue(parsed, '預約日期', '日期', '營業日'));
  const time = frontdeskStartTime(start);
  return [
    `預約日期：${date}`,
    `預約時間：${time}`,
    `預約人：${frontdeskValue(parsed, '預約人', '聯絡人') || '—'}`,
    `電話：${frontdeskValue(parsed, '電話') || '—'}`,
    `預約人數：${frontdeskValue(parsed, '預約人數') || '—'}`,
  ];
}

function frontdeskLine(text: string, emphasized = false): Record<string, unknown> {
  return { type: 'text', text: truncate(text, 600), size: 'sm', color: TEXT_COLOR,
    ...(emphasized ? { weight: 'bold' } : {}), wrap: true };
}

function frontdeskCards(parsed: ParsedBookingMessage): Array<Record<string, unknown>> {
  // A legacy notice may parse free-form text into a generic 說明 field.
  // Only synthesize the compact summary if at least one recognized booking fact exists.
  const known = new Set(['預約日期', '營業日', '日期', '預約時間', '時段', '時間',
    '預約人', '聯絡人', '電話', '預約人數', '預約項目']);
  if (!parsed.fields.some((field) => known.has(field.label))
    && !parsed.participants.length && !parsed.services.length) {
    return [fallbackCard(parsed.fallbackText)];
  }
  const summary: Record<string, unknown> = {
    type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px',
    backgroundColor: SURFACE_COLOR, cornerRadius: '12px',
    contents: frontdeskSummaryLines(parsed).map((line) => frontdeskLine(line)),
  };
  const people = parsed.participants.length ? parsed.participants :
    parsed.services.length ? [{
      label: '第一位預約', items: parsed.services, technician: frontdeskValue(parsed, '預約技師'),
      duration: '', amount: '', note: '',
    }] : [];
  if (!people.length) return [summary];
  const contents: Array<Record<string, unknown>> = [];
  for (const person of people) {
    if (contents.length) contents.push({ type: 'separator', margin: 'md', color: '#E5EAE7' });
    contents.push({
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        frontdeskLine(person.label, true),
        frontdeskLine(`預約項目：${person.items.length ? person.items.join('、') : '—'}`),
        frontdeskLine(`預約技師：${person.technician || '現場安排'}`),
        ...(person.note ? [frontdeskLine(`個別備註：${person.note}`)] : []),
      ],
    });
  }
  return [summary, {
    type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '14px',
    backgroundColor: SURFACE_COLOR, cornerRadius: '12px', contents,
  }];
}

function entitlementCard(title: string, items: string[], accent: string): Record<string, unknown> {
  const visible = items.slice(0, 6);
  const hidden = Math.max(0, items.length - visible.length);
  const rows: Array<Record<string, unknown>> = visible.length
    ? visible.map((item) => ({
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        alignItems: 'flex-start',
        contents: [
          { type: 'text', text: '•', size: 'sm', color: accent, flex: 0 },
          { type: 'text', text: truncate(item, 320), size: 'sm', color: TEXT_COLOR, flex: 1, wrap: true },
        ],
      }))
    : [{
        type: 'text',
        text: '目前無可用項目',
        size: 'sm',
        color: MUTED_COLOR,
        wrap: true,
      }];

  if (hidden > 0) {
    rows.push({
      type: 'text',
      text: `另有 ${hidden} 項，請至會員頁查看完整內容。`,
      size: 'xs',
      color: MUTED_COLOR,
      wrap: true,
    });
  }

  return {
    type: 'box',
    layout: 'vertical',
    paddingAll: '14px',
    backgroundColor: SURFACE_COLOR,
    cornerRadius: '12px',
    contents: [
      { type: 'text', text: truncate(title, 80), size: 'sm', weight: 'bold', color: accent, wrap: true },
      { type: 'separator', margin: 'sm', color: '#E5EAE7' },
      { type: 'box', layout: 'vertical', spacing: 'sm', margin: 'sm', contents: rows },
    ],
  };
}

function fallbackCard(text: string): Record<string, unknown> {
  return {
    type: 'box',
    layout: 'vertical',
    paddingAll: '14px',
    backgroundColor: SURFACE_COLOR,
    cornerRadius: '12px',
    contents: [
      {
        type: 'text',
        text,
        size: 'sm',
        color: TEXT_COLOR,
        wrap: true,
      },
    ],
  };
}

function makeAltText(parsed: ParsedBookingMessage): string {
  const date = parsed.fields.find((field) => field.label === '日期')?.value || '';
  const time = parsed.fields.find((field) => field.label === '時段')?.value || '';
  const service = parsed.participants[0]?.items[0] || parsed.services[0] || '';
  const summary = [parsed.title, date, time, service].filter(Boolean).join('｜');
  return truncate(summary || parsed.fallbackText, MAX_ALT_TEXT);
}

// Dedicated presentation for a single, audited frontdesk rejection/replacement.
// The generic parser treats the two section headers as loose explanation rows
// and merges repeated date/time/service labels. Keep the source text immutable.
// Presentation-only filter for the frontdesk rejection summary. The item is
// still stored in booking records and remains visible to workflows that need it.
// Match complete service names (optionally with a quantity), not substrings.
function visibleFrontdeskRejectionServices(value: string): string {
  return String(value || '').split('、').map((item) => item.trim())
    .filter((item) => item && !/^到店準備(?:\s*[×xX]\s*\d+)?$/.test(item))
    .join('、');
}

function frontdeskRejectionCards(source: string): Array<Record<string, unknown>> | null {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim());
  if (lines[0] !== '【櫃檯拒絕預約】') return null;
  const originalAt = lines.indexOf('【原預約資料】');
  if (originalAt < 0) return null;
  const replacementAt = lines.indexOf('【櫃檯新增的預約資料】');
  const section = (start: number, end: number): Map<string, string> => {
    const fields = new Map<string, string>();
    for (const line of lines.slice(start, end)) {
      const i = line.indexOf('：');
      if (i <= 0 || line.startsWith('【')) continue;
      const key = line.slice(0, i), value = line.slice(i + 1).trim();
      if (value && !fields.has(key)) fields.set(key, truncate(value, 500));
    }
    return fields;
  };
  const operation = section(1, originalAt);
  const original = section(originalAt + 1, replacementAt < 0 ? lines.length : replacementAt);
  const replacement = replacementAt < 0 ? null : section(replacementAt + 1, lines.length);
  const card = (heading: string, status: string, fields: Map<string, string>,
    labels: Array<[string, string]>): Record<string, unknown> => {
    const contents: Array<Record<string, unknown>> = [
      { type: 'text', text: heading, size: 'md', color: TEXT_COLOR, weight: 'bold', wrap: true },
      { type: 'text', text: status, size: 'sm', color: heading.startsWith('原') ? '#A85543' : '#286553',
        weight: 'bold', wrap: true },
      { type: 'separator', margin: 'sm', color: '#E5EAE7' },
    ];
    for (const [label, sourceLabel] of labels) {
      const rawValue = fields.get(sourceLabel);
      const value = sourceLabel === '預約項目'
        ? visibleFrontdeskRejectionServices(rawValue || '') : rawValue;
      if (value && value !== '—' && value !== '未提供') contents.push(fieldRow(label, value));
    }
    return { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px',
      backgroundColor: SURFACE_COLOR, cornerRadius: '12px', contents };
  };
  const summary: Array<Record<string, unknown>> = [
    { type: 'text', text: '處理結果', size: 'md', weight: 'bold', color: TEXT_COLOR },
    fieldRow('執行人員', '櫃檯人員'),
  ];
  if (operation.get('拒絕原因')) summary.push(fieldRow('拒絕原因', operation.get('拒絕原因')!));
  if (replacement) summary.push(fieldRow('補登狀態', replacement.get('預約狀態') || '已確認'));
  const cards: Array<Record<string, unknown>> = [
    { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px',
      backgroundColor: '#FFF4EF', cornerRadius: '12px', contents: summary },
    card('原預約資料', '已拒絕', original, [
      ['預約編號', '預約編號'], ['日期', '預約日期'], ['時間', '預約時間'],
      ['原預約會員', '原預約會員'], ['電話', '電話'], ['人數', '預約人數'],
      ['項目', '預約項目'], ['技師', '預約技師'],
      ['會員備註', '會員備註'], ['管理端說明', '管理端說明'],
    ]),
  ];
  if (replacement) cards.push(card('櫃檯新增預約', replacement.get('預約狀態') || '已確認', replacement, [
    ['新增預約編號', '新增預約編號'], ['日期', '預約日期'], ['時間', '預約時間'],
    ['人數', '預約人數'], ['項目', '預約項目'], ['技師', '預約技師'],
  ]));
  return cards;
}

export function buildBookingFlexMessage(job: Job): LineFlexMessage {
  // Booking identifiers are for administrators only. Sanitize the source
  // before parsing so fallback cards, alt text and normal Flex rows agree.
  const visibleText = job.channel === 'admin' ? job.message_text :
    String(job.message_text || '').replace(/^(?:預約編號|原預約編號|新增預約編號|訂單編號)[：:][^\r\n]*(?:\r?\n|$)/gm, '');
  const parsed = parseBookingMessage(visibleText);
  // The frontdesk-only display title does not change cancellation approval state.
  const displayTitle = job.channel === 'frontdesk' && parsed.title === '取消預約申請' ? '預約取消' : parsed.title;
  const style = TITLE_STYLES[parsed.title] || { color: '#315D50', eyebrow: 'BOOKING NOTICE' };
  const channelLabel = job.channel === 'admin' ? '管理端預約通知' : job.channel === 'frontdesk' ? '櫃檯預約通知' : '會員預約通知';
  const bodyContents: Array<Record<string, unknown>> = [];

  const schedule = scheduleCard(parsed, style.color);
  const memberConfirmation = job.channel === 'member' && parsed.title === '預約確認';
  const memberReminder = job.channel === 'member' && parsed.title === '預約提醒';
  const memberPending = job.channel === 'member' && parsed.title === '預約申請';
  const memberCustomNotice = memberReminder || memberPending;
  const notice = memberCustomNotice ? reminderNoticeCard(parsed.fields) : null;
  const details = detailsCard(memberCustomNotice ? parsed.fields.filter(field => field.label !== '提醒事項') : parsed.fields);
  const rejectionProse = job.channel === 'member' && parsed.title === '預約未通過' && parsed.rejectionNotice
    ? fallbackCard(parsed.rejectionNotice) : null;
  const participants = participantsCard(parsed.participants, style.color, memberConfirmation || memberReminder);
  const services = parsed.participants.length ? null : servicesCard(parsed.services, style.color);
  const rejection = job.channel === 'admin' && parsed.title === '櫃檯拒絕預約'
    ? frontdeskRejectionCards(visibleText) : null;
  if (rejection) {
    bodyContents.push(...rejection);
  } else if (job.channel === 'frontdesk') {
    bodyContents.push(...frontdeskCards(parsed));
  } else {
    if (schedule) bodyContents.push(schedule);
    if (details) bodyContents.push(details);
    if (rejectionProse) bodyContents.push(rejectionProse);
    if (participants) bodyContents.push(participants);
    else if (services) bodyContents.push(services);
    if (!bodyContents.length) bodyContents.push(fallbackCard(parsed.fallbackText));
  }

  const footerActions: Array<Record<string, unknown>> = [];
  if (job.channel === 'frontdesk' && job.frontdeskCanReview === true && /^https:\/\/liff\.line\.me\/\d{5,30}-[A-Za-z0-9_-]+\?/.test(job.frontdeskUri || '')) {
    footerActions.push({type:'button',height:'sm',style:'primary',action:{type:'uri',label:'查看／處理預約',uri:job.frontdeskUri}});
  }
  if (memberConfirmation || memberCustomNotice) {
    // Confirmation and reminders share participant cards; reminders also show the merchant's notice and contact details.
    bodyContents.length = 0;
    if (schedule) bodyContents.push(schedule);
    if (memberCustomNotice && notice) bodyContents.push(notice);
    if (memberCustomNotice && details) bodyContents.push(details);
    if (participants) bodyContents.push(participants);
    else if (services) bodyContents.push(services); // Legacy notifications without participant sections.
    if (!bodyContents.length) bodyContents.push(fallbackCard(memberReminder ? '請查看預約詳情。' : '預約已確認。'));
  }
  if (job.booking_id && job.channel === 'admin' && parsed.title === '預約') {
    const copy = String(job.copyText || '');
    footerActions.push({type:'button',height:'sm',action:copy && Array.from(copy).length<=1000
      ? {type:'clipboard',label:'複製預約內容',clipboardText:copy}
      : {type:'uri',label:'複製預約內容',uri:bookingDetailUri(job.booking_id,true,'copy')}});
  }

  const headerContents: FlexText[] = [
    {
      type: 'text',
      text: style.eyebrow,
      size: 'xxs',
      weight: 'bold',
      color: '#F3EAE6',
    },
    {
      type: 'text',
      text: displayTitle,
      size: 'xl',
      weight: 'bold',
      color: '#FFFFFF',
      wrap: true,
    },
    {
      type: 'text',
      text: channelLabel,
      size: 'xs',
      color: '#F5F7F6',
    },
  ];

  return {
    type: 'flex',
    altText: job.channel === 'frontdesk'
      ? truncate([displayTitle, ...frontdeskSummaryLines(parsed).slice(0, 2)].join('｜'), MAX_ALT_TEXT)
      : rejection
        ? truncate(['櫃檯拒絕預約', '原預約已拒絕',
          ...(rejection.length > 2 ? ['含櫃檯補登資料'] : [])].join('｜'), MAX_ALT_TEXT)
        : makeAltText(parsed),
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        backgroundColor: style.color,
        paddingAll: '18px',
        contents: headerContents,
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        backgroundColor: '#FFFFFF',
        contents: bodyContents,
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        backgroundColor: SURFACE_COLOR,
        contents: [
          ...footerActions,
          {
            type: 'text',
            text: 'Lumen Club 預約系統',
            size: 'xxs',
            color: '#87928D',
            align: 'center',
          },
        ],
      },
    },
  };
}

export function secureEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ (b[i] || 0);
  return difference === 0;
}

export async function deliver(job: Job, token: string, send: typeof fetch = fetch): Promise<Delivery> {
  if (!token) return { accepted: false, retryable: true, status: null, lineRequestId: '' };
  try {
    const message = buildBookingFlexMessage(job);
    const response = await send('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Line-Retry-Key': job.id },
      body: JSON.stringify({ to: job.recipient, messages: [message] }),
      signal: AbortSignal.timeout(10000),
    });
    const acceptedId = response.headers.get('x-line-accepted-request-id') || '';
    return {
      accepted: response.ok || (response.status === 409 && !!acceptedId),
      retryable: response.status >= 500 || response.status === 429,
      status: response.status,
      lineRequestId: acceptedId || response.headers.get('x-line-request-id') || '',
    };
  } catch {
    return { accepted: false, retryable: true, status: null, lineRequestId: '' };
  }
}
