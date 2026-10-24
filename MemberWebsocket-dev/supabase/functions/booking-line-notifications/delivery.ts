import { businessFetch as fetch } from '../_shared/business-scope.ts';
import { bookingDetailUri } from "./booking-actions.ts";
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
};
export type Delivery = { accepted: boolean; retryable: boolean; status: number | null; lineRequestId: string };

type ParsedBookingParticipant = {
  label: string;
  items: string[];
  duration: string;
  amount: string;
  technician: string;
};

type ParsedBookingMessage = {
  title: string;
  fields: Array<{ label: string; value: string }>;
  services: string[];
  participants: ParsedBookingParticipant[];
  fallbackText: string;
};

type FlexText = Record<string, unknown>;
type LineFlexMessage = {
  type: 'flex';
  altText: string;
  contents: Record<string, unknown>;
};

const TITLE_STYLES: Record<string, { color: string; eyebrow: string }> = {
  '預約': { color: '#DF6B4D', eyebrow: 'NEW BOOKING' },
  '修改預約': { color: '#C56E32', eyebrow: 'BOOKING UPDATED' },
  '取消預約申請': { color: '#9A711F', eyebrow: 'CANCELLATION REQUEST' },
  '預約確認': { color: '#2F8F61', eyebrow: 'BOOKING CONFIRMED' },
  '完成服務': { color: '#286553', eyebrow: 'SERVICE COMPLETED' },
  '預約未通過': { color: '#B35A50', eyebrow: 'BOOKING DECLINED' },
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

  const fields: Array<{ label: string; value: string }> = [];
  const services: string[] = [];
  const participants: ParsedBookingParticipant[] = [];
  let currentParticipant: ParsedBookingParticipant | null = null;
  let readingServices = false;

  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line) {
      readingServices = false;
      continue;
    }

    if (/^第(?:[一二三四五六七八九十]+|\s*\d+\s*)位預約$/.test(line)) {
      currentParticipant = { label: truncate(line, 40), items: [], duration: '', amount: '', technician: '' };
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

  return { title, fields, services, participants, fallbackText };
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

export function buildBookingFlexMessage(job: Job): LineFlexMessage {
  const parsed = parseBookingMessage(job.message_text);
  const style = TITLE_STYLES[parsed.title] || { color: '#315D50', eyebrow: 'BOOKING NOTICE' };
  const channelLabel = job.channel === 'admin' ? '管理端預約通知' : '會員預約通知';
  const bodyContents: Array<Record<string, unknown>> = [];

  const schedule = scheduleCard(parsed, style.color);
  const details = detailsCard(parsed.fields);
  const memberConfirmation = job.channel === 'member' && parsed.title === '預約確認';
  const participants = participantsCard(parsed.participants, style.color, memberConfirmation);
  const services = parsed.participants.length ? null : servicesCard(parsed.services, style.color);
  if (schedule) bodyContents.push(schedule);
  if (details) bodyContents.push(details);
  if (participants) bodyContents.push(participants);
  else if (services) bodyContents.push(services);
  if (!bodyContents.length) bodyContents.push(fallbackCard(parsed.fallbackText));

  const footerActions: Array<Record<string, unknown>> = [];
  if (memberConfirmation) {
    // Show each participant's services and technician separately, without an external detail button.
    bodyContents.length = 0;
    if (schedule) bodyContents.push(schedule);
    if (participants) bodyContents.push(participants);
    else if (services) bodyContents.push(services); // Legacy notifications without participant sections.
    if (!bodyContents.length) bodyContents.push(fallbackCard('預約已確認。'));
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
      text: parsed.title,
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
    altText: makeAltText(parsed),
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
