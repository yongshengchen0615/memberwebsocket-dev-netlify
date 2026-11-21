import { buildBookingFlexMessage, deliver } from './delivery.ts';

Deno.test('frontdesk review has only its trusted tenant entry; notify-only has no action',()=>{
 const job={id:'11111111-1111-4111-8111-111111111111',recipient:'U'+'a'.repeat(32),message_text:'【預約】\n預約人：測試\n日期：2026/11/18',channel:'frontdesk',attempt_count:1,booking_id:'22222222-2222-4222-8222-222222222222'};
 const read=JSON.stringify(buildBookingFlexMessage({...job,frontdeskCanReview:false}));
 assert(!read.includes('處理預約'),'notify-only must have no management action');
 const review=JSON.stringify(buildBookingFlexMessage({...job,frontdeskCanReview:true,frontdeskUri:'https://liff.line.me/2010999999-desk?business=shop-a&bookingId='+job.booking_id}));
 assert(review.includes('處理預約')&&review.includes('shop-a'),'review must use its actual tenant LIFF');
});

Deno.test('AC-FD-001: frontdesk LINE card uses exactly the requested booking fields and start time', () => {
  const text = [
    '【預約】',
    '預約編號：00000000-0000-4000-8000-000000000001',
    '預約人：陳先生',
    '營業日：2026/11/20',
    '時段：2026/11/20 09:30–2026/11/20 10:30（台北時間）',
    '電話：+886900000000',
    '預約人數：1 位',
    '會員備註：不該出現在櫃檯通知',
    '管理端說明：僅限管理員閱讀',
    '',
    '第一位預約',
    '預約項目：身體60',
    '個別時間：60 分鐘',
    '個別金額：NT$2,500',
    '預約技師：10技師',
  ].join('\n');
  const notice = buildBookingFlexMessage({
    ...sampleJob, channel: 'frontdesk', message_text: text,
  });
  const body = notice.contents.body as Record<string, unknown>;
  const cards = body.contents as Array<Record<string, unknown>>;
  assert(cards.length === 2, 'frontdesk should show one booking summary and one participant card');
  assert(cards.every((card) => card.cornerRadius === '12px'), 'frontdesk should preserve its Flex card design');
  const visible = collectComponents(body).filter((item) => item.type === 'text')
    .map((item) => String(item.text));
  const expected = [
    '預約日期：2026-11-20', '預約時間：09:30',
    '預約人：陳先生', '電話：+886900000000', '預約人數：1 位',
    '第一位預約', '預約項目：身體60', '預約技師：10技師',
  ];
  assert(JSON.stringify(visible) === JSON.stringify(expected),
    'frontdesk message content and order must exactly match the requested eight lines');
  assert(notice.altText.includes('預約日期：2026-11-20') && notice.altText.includes('預約時間：09:30'),
    'LINE push preview must use the same normalized date and start time as the frontdesk card');
  assert(!notice.altText.includes('10:30') && !notice.altText.includes('2026/11/20'),
    'LINE push preview must not show the original time range or slash-formatted date');
  const serialized = JSON.stringify(notice);
  for (const prohibited of ['個別時間', '個別金額', 'NT$2,500', '會員備註', '管理端說明', '不該出現', '僅限管理員', '預約編號']) {
    assert(!serialized.includes(prohibited), `frontdesk must not include unrelated private field: ${prohibited}`);
  }
});

Deno.test('AC-FD-002: multiple frontdesk participants remain ordered and isolated', () => {
  const text = [
    '【預約】', '預約人：王小姐', '日期：2026-11-21',
    '時段：09:30–11:30（台北時間）', '電話：0912345678', '預約人數：2 位',
    '', '第一位預約', '預約項目：身體60', '個別金額：NT$1,000',
    '預約技師：10技師', '', '第二位預約',
    '預約項目：肩頸30、頭部20', '預約技師：現場安排',
  ].join('\n');
  const card = buildBookingFlexMessage({ ...sampleJob, channel: 'frontdesk', message_text: text });
  const body = card.contents.body as Record<string, unknown>;
  const cards = body.contents as Array<Record<string, unknown>>;
  const groups = (cards[1].contents as Array<Record<string, unknown>>).filter((item) => item.type === 'box');
  assert(groups.length === 2, 'each person should have their own frontdesk group');
  const first = collectComponents(groups[0]).filter((c) => c.type === 'text').map((c) => c.text);
  const second = collectComponents(groups[1]).filter((c) => c.type === 'text').map((c) => c.text);
  assert(JSON.stringify(first) === JSON.stringify(['第一位預約', '預約項目：身體60', '預約技師：10技師']),
    'first participant must only include own service and technician');
  assert(JSON.stringify(second) === JSON.stringify(['第二位預約', '預約項目：肩頸30、頭部20', '預約技師：現場安排']),
    'second participant must only include own service and technician');
  const all = JSON.stringify(card.contents);
  assert(all.includes('預約日期：2026-11-21') && all.includes('預約時間：09:30'),
    'ISO dates and time ranges should normalize to booking date and start time');
  assert(!all.includes('NT$1,000'), 'frontdesk must not expose amount');
});

Deno.test('AC-FD-005: overnight appointment uses actual start date, not previous business day', () => {
  const messageText = [
    '【預約】',
    '預約人：陳先生',
    '營業日：2026/11/20',
    '時段：2026/11/21 00:30–2026/11/21 01:30（台北時間）',
    '電話：+886900000000',
    '預約人數：1 位',
    '',
    '第一位預約',
    '預約項目：身體60',
    '預約技師：10技師',
  ].join('\n');
  const message = buildBookingFlexMessage({ ...sampleJob, channel: 'frontdesk', message_text: messageText });
  const summary = JSON.stringify(message.contents.body);
  assert(summary.includes('預約日期：2026-11-21') && summary.includes('預約時間：00:30'),
    'frontdesk must show the real calendar date and start time for overnight appointments');
  assert(!summary.includes('預約日期：2026-11-20'),
    'the previous business day must never overwrite the appointment date');
  assert(message.altText.includes('預約日期：2026-11-21') && message.altText.includes('預約時間：00:30'),
    'LINE push preview must also use the real appointment start date');
  assert(!message.altText.includes('2026-11-20') && !message.altText.includes('01:30'),
    'LINE push preview must not include prior business day or end time');
});

Deno.test('AC-FD-003: frontdesk legacy services and unknown schedules are safely represented', () => {
  const legacy = buildBookingFlexMessage({
    ...sampleJob, channel: 'frontdesk',
    message_text: ['【修改預約】', '日期：2026/11/20', '預約人：王小姐', '電話：0912345678',
      '預約人數：1 位', '預約項目：', '身體60'].join('\n'),
  });
  const text = JSON.stringify(legacy.contents.body);
  assert(text.includes('預約日期：2026-11-20') && text.includes('預約時間：—'),
    'missing time must remain unknown rather than fabricated');
  assert(text.includes('第一位預約') && text.includes('預約項目：身體60') && text.includes('預約技師：現場安排'),
    'legacy aggregate service must remain visible with honest technician fallback');
  const fallback = buildBookingFlexMessage({ ...sampleJob, channel: 'frontdesk', message_text: '預約資料已更新，請查看最新預約。' });
  assert(JSON.stringify(fallback.contents.body).includes('預約資料已更新'),
    'unrecognized legacy messages must still provide a visible fallback');
});

Deno.test('AC-FD-004: member and admin formats do not inherit the compact frontdesk-only card', () => {
  for (const channel of ['member', 'admin']) {
    const notice = buildBookingFlexMessage({
      ...sampleJob, channel,
      message_text: sampleJob.message_text.replace('【預約確認】', '【預約】'),
    });
    const text = JSON.stringify(notice.contents.body);
    assert(text.includes('會員備註') && text.includes('希望加強肩頸') && text.includes('個別金額'),
      `${channel} should retain its established details outside frontdesk`);
    assert(!text.includes('預約日期：2026-09-15'), `${channel} must not use the frontdesk-only date label`);
  }
});

Deno.test('AC-BPN-001: admin, member and frontdesk display only the matching participant notes', () => {
  const raw = [
    '【預約確認】', '預約人：測試會員', '營業日：2026/11/21',
    '時段：2026/11/21 09:30–2026/11/21 11:30（台北時間）',
    '電話：+886900000000', '預約人數：3 位',
    '', '第一位預約', '預約項目：身體60', '預約技師：甲技師',
    '個別備註：第一位需要安靜',
    '', '第二位預約', '預約項目：肩頸30', '預約技師：乙技師',
    '個別備註：第二位力道較輕',
    '', '第三位預約', '預約項目：足底40', '預約技師：現場安排',
  ].join('\n');
  for (const channel of ['admin', 'member', 'frontdesk']) {
    const msg = buildBookingFlexMessage({...sampleJob, channel, message_text: raw});
    const cards = ((msg.contents.body as Record<string, unknown>).contents as Array<Record<string, unknown>>);
    const groups = collectComponents(cards).filter(item =>
      item.type === 'text' && typeof item.text === 'string' && String(item.text).includes('個別備註'));
    assert(groups.length === 2, channel + ': should show only non-empty individual notes');
    const all = JSON.stringify(msg.contents.body);
    for (const note of ['第一位需要安靜', '第二位力道較輕']) {
      assert(all.includes(note), channel + ': note should not be dropped');
    }
    if (channel === 'frontdesk') {
      const sections = cards[1].contents as Array<Record<string, unknown>>;
      const perPerson = sections.filter(section => section.type === 'box');
      assert(perPerson.length === 3, 'frontdesk must retain all participant groups');
      const expected = [
        ['第一位需要安靜', '第二位力道較輕'],
        ['第二位力道較輕', '第一位需要安靜'],
        ['', '第一位需要安靜'],
      ];
      perPerson.forEach((person, index) => {
        const serialized = JSON.stringify(person);
        if (expected[index][0]) assert(serialized.includes(expected[index][0]), 'own note required');
        assert(!serialized.includes(expected[index][1]), 'other participant note must never leak');
        if (index === 2) assert(!serialized.includes('個別備註'), 'empty note must be omitted');
      });
    } else {
      const participant = cards.find(card => JSON.stringify(card).includes('每位預約明細') ||
        JSON.stringify(card).includes('第一位'));
      assert(!!participant, channel + ': person details card must remain visible');
      const sections = (participant!.contents as Array<Record<string, unknown>>).filter(x => x.type === 'box');
      assert(sections.length === 3, channel + ': 3 participant groups required');
      sections.forEach((person, index) => {
        const serialized = JSON.stringify(person);
        assert(index === 0 ? serialized.includes('第一位需要安靜') : !serialized.includes('第一位需要安靜'),
          'first note must stay with first person');
        assert(index === 1 ? serialized.includes('第二位力道較輕') : !serialized.includes('第二位力道較輕'),
          'second note must stay with second person');
        if (index === 2) assert(!serialized.includes('個別備註'), 'third note should be absent');
      });
    }
  }
});

Deno.test('AC-BPN-002: legacy and empty per-person notes must not add placeholders', () => {
  for (const channel of ['admin', 'member', 'frontdesk']) {
    const baseline = buildBookingFlexMessage({ ...sampleJob, channel });
    const content = JSON.stringify(baseline.contents.body);
    assert(!content.includes('個別備註'), 'old job without notes must remain visually identical');
    const empty = buildBookingFlexMessage({
      ...sampleJob, channel,
      message_text: sampleJob.message_text + '\n個別備註：',
    });
    assert(!JSON.stringify(empty.contents.body).includes('個別備註'),
      'blank per-person note must not render');
  }
});

Deno.test('AC-BPN-003: member cancellation request title is 預約取消 in frontdesk only', () => {
  const original = ['【取消預約申請】', '預約人：測試會員', '營業日：2026/11/21',
    '時段：2026/11/21 09:30–2026/11/21 10:30（台北時間）',
    '電話：+886900000000', '預約人數：1 位',
    '', '第一位預約', '預約項目：身體60', '預約技師：甲技師',
    '個別備註：需要安靜'].join('\n');
  const headings = [
    ['frontdesk', '預約取消'], ['admin', '取消預約申請'], ['member', '取消預約申請'],
  ];
  for (const [channel, title] of headings) {
    const card = buildBookingFlexMessage({ ...sampleJob, channel, message_text: original });
    const header = collectComponents(card.contents.header).find(x => x.text === title);
    assert(!!header, channel + ': cancellation heading mismatch');
    assert(channel !== 'frontdesk' || (card.altText.startsWith('預約取消｜')
      && !card.altText.startsWith('取消預約申請')),
      'frontdesk LINE push preview must share the new heading');
    assert(JSON.stringify(card.contents.body).includes('需要安靜'),
      'cancellation request must preserve participant note');
  }
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function collectComponents(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const collected: Array<Record<string, unknown>> = [record];
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) collected.push(...collectComponents(item));
    } else if (child && typeof child === 'object') {
      collected.push(...collectComponents(child));
    }
  }
  return collected;
}

const sampleJob = {
  id: '11111111-1111-4111-8111-111111111111',
  recipient: `U${'a'.repeat(32)}`,
  message_text: [
    '【預約確認】',
    '預約人：王小姐',
    '日期：2026/09/15',
    '時段：10:00–11:00（台北時間）',
    '電話：0912345678',
    '預約人數：2 位',
    '會員備註：希望加強肩頸',
    '管理端說明：已安排安靜區域',
    '',
    '第一位預約',
    '預約項目：腳底40',
    '預約技師：10',
    '',
    '第二位預約',
    '預約項目：肩頸30、頭部20',
    '預約技師：現場安排',
  ].join('\n'),
  channel: 'member',
  attempt_count: 1,
};

Deno.test('booking notification builds a structured mobile-friendly Flex Message', () => {
  const message = buildBookingFlexMessage({...sampleJob,channel:'admin'});
  assert(message.type === 'flex', 'notification must be a Flex Message');
  assert(message.altText.includes('預約確認'), 'altText must describe the booking event');
  assert(message.altText.includes('2026/09/15'), 'altText must include the booking date');

  const body = message.contents.body as Record<string, unknown>;
  const cards = body.contents as Array<Record<string, unknown>>;
  assert(Array.isArray(cards) && cards.length === 3, 'schedule, details and services should render as separate cards');
  assert(cards.every((item) => item.type === 'box'), 'body sections should render as boxes');
  assert(cards.every((item) => item.cornerRadius === '12px'), 'body cards should use consistent rounded corners');

  const components = collectComponents(message.contents);
  assert(components.some((item) => item.text === '預約時間'), 'Flex body must highlight the booking schedule');
  assert(components.some((item) => item.text === '2026/09/15' && item.size === 'lg'), 'date should receive strong visual emphasis');
  assert(components.some((item) => item.text === '王小姐'), 'Flex body must include the booking contact');
  assert(components.some((item) => item.text === '希望加強肩頸'), 'Flex body must include the member note');
  assert(components.some((item) => item.text === '已安排安靜區域'), 'Flex body must include the admin note');
  assert(components.some((item) => item.text === '10:00–11:00（台北時間）'), 'Flex body must include the booking time');
  assert(components.some((item) => item.text === '第一位預約'), 'Flex body must identify the first participant');
  assert(components.some((item) => item.text === '第二位預約'), 'Flex body must identify the second participant');
  assert(components.some((item) => item.text === '腳底40'), 'Flex body must include the first participant services');
  assert(components.some((item) => item.text === '肩頸30、頭部20'), 'Flex body must keep participant services grouped');
  assert(components.some((item) => item.text === '10'), 'Flex body must include the selected technician');
  assert(components.some((item) => item.text === '現場安排'), 'Flex body must support on-site technician assignment');
  assert(components.some((item) => item.text === 'Lumen Club 預約系統'), 'Flex footer must identify the booking system');
});

Deno.test('confirmed member notification contains the booking summary without a detail button', () => {
  const message = buildBookingFlexMessage({
    ...sampleJob,
    booking_id: '30000000-0000-4000-8000-000000000001',
    benefits: { pointTickets: ['SECRET-OFFER'], eventTickets: [], tierActivities: [], tierLabel: 'SECRET-TIER' },
  });
  const serialized = JSON.stringify(message);
  assert(!serialized.includes('SECRET-OFFER') && !serialized.includes('SECRET-TIER'), 'offers and tier must not be rendered');
  assert(!serialized.includes('查看預約明細'), 'member confirmation must not render a detail button');
  assert(!serialized.includes('2010787602-sgiB0ETj'), 'member confirmation must not render a booking LIFF link');
  const footer = message.contents.footer as Record<string, unknown>;
  const buttons = collectComponents(footer).filter((item) => item.type === 'button');
  assert(buttons.length === 0, 'member confirmation must not have footer action buttons');
  assert(serialized.includes('2026/09/15') && serialized.includes('腳底40'), 'confirmation summary must remain visible');
});

Deno.test('member confirmation shows each participant with its own services and technician', () => {
  const message = buildBookingFlexMessage({
    ...sampleJob,
    booking_id: '30000000-0000-4000-8000-000000000001',
  });
  const body = message.contents.body as Record<string, unknown>;
  const cards = body.contents as Array<Record<string, unknown>>;
  assert(cards.length === 2, 'confirmation must show schedule and a per-participant card');
  const groups = (cards[1].contents as Array<Record<string, unknown>>)
    .filter((component) => component.type === 'box');
  assert(groups.length === 2, 'two people must render as two distinct groups');
  const first = collectComponents(groups[0]);
  const second = collectComponents(groups[1]);
  assert(first.some((component) => component.text === '第一位'), 'first group label must be 第一位');
  assert(first.some((component) => component.text === '預約項目'), 'first group must label the service');
  assert(first.some((component) => component.text === '腳底40'), 'first group must display the first service');
  assert(first.some((component) => component.text === '預約技師'), 'first group must label the technician');
  assert(first.some((component) => component.text === '10'), 'first group must display the assigned technician');
  assert(!first.some((component) => component.text === '肩頸30、頭部20'), 'first group must not leak second person services');
  assert(second.some((component) => component.text === '第二位'), 'second group label must be 第二位');
  assert(second.some((component) => component.text === '肩頸30、頭部20'), 'second group must display its own services');
  assert(second.some((component) => component.text === '現場安排'), 'second group must display its own technician');
  assert(!second.some((component) => component.text === '腳底40'), 'second group must not include first person services');
  const bodyComponents = collectComponents(body);
  assert(!bodyComponents.some((component) => component.text === '個別時間' || component.text === '個別金額'),
    'member confirmation should only contain service and technician per person');
  const footer = message.contents.footer as Record<string, unknown>;
  assert(!collectComponents(footer).some((component) => component.type === 'button'),
    'member confirmation must not restore the removed booking detail button');
});

Deno.test('member confirmation supports single and additional participants', () => {
  const firstOnly = sampleJob.message_text.split('\n\n第二位預約')[0].replace('預約人數：2 位', '預約人數：1 位');
  const threePeople = sampleJob.message_text + '\n\n第三位預約\n預約項目：精油按摩60\n預約技師：小林';
  for (const [messageText, expectedLabels] of [
    [firstOnly, ['第一位']],
    [threePeople, ['第一位', '第二位', '第三位']],
  ] as const) {
    const message = buildBookingFlexMessage({ ...sampleJob, message_text: messageText });
    const body = message.contents.body as Record<string, unknown>;
    const cards = body.contents as Array<Record<string, unknown>>;
    const groups = (cards[1].contents as Array<Record<string, unknown>>).filter((item) => item.type === 'box');
    const labels = groups.map((group) => ((group.contents as Array<Record<string, unknown>>)[0]).text);
    assert(JSON.stringify(labels) === JSON.stringify(expectedLabels),
      'confirmation group count and ordering must match participants');
    if (expectedLabels.length === 3) {
      const third = collectComponents(groups[2]);
      assert(third.some((item) => item.text === '精油按摩60'), 'third participant must have its own service');
      assert(third.some((item) => item.text === '小林'), 'third participant must have its own technician');
    }
  }
});

Deno.test('member legacy confirmation without participant sections retains service details', () => {
  const message = buildBookingFlexMessage({
    ...sampleJob,
    message_text: ['【預約確認】', '日期：2026/09/15', '時段：10:00–11:00', '預約項目：', '腳底40'].join('\n'),
  });
  assert(JSON.stringify(message.contents).includes('腳底40'), 'legacy confirmation must not lose services');
});

Deno.test('admin new booking notification shows only the copy button', () => {
  for (const bookingStatus of ['pending', 'confirmed']) {
    const copyText = '2026/09/15 10:00 王小姐 腳底40';
    const message = buildBookingFlexMessage({
      ...sampleJob,
      channel: 'admin',
      booking_id: '30000000-0000-4000-8000-000000000001',
      message_text: sampleJob.message_text.replace('【預約確認】', '【預約】'),
      copyText,
      bookingStatus,
    });
    const footer = message.contents.footer as Record<string, unknown>;
    const buttons = collectComponents(footer).filter((item) => item.type === 'button');
    assert(buttons.length === 1, 'admin new booking must have exactly one action regardless of booking status');
    const action = buttons[0].action as Record<string, unknown>;
    assert(action.label === '複製預約內容', 'the sole admin action must be the copy button');
    assert(action.type === 'clipboard' && action.clipboardText === copyText, 'copy button must preserve the booking copy text');
    assert(!JSON.stringify(message).includes('確認預約'), 'admin message must not offer inline confirmation');
    assert(!JSON.stringify(message).includes('開啟管理端／複製'), 'admin message must not show an extra admin link');
  }
});

Deno.test('admin copy action keeps the existing LIFF fallback for long text', () => {
  const message = buildBookingFlexMessage({
    ...sampleJob,
    channel: 'admin',
    booking_id: '30000000-0000-4000-8000-000000000001',
    message_text: sampleJob.message_text.replace('【預約確認】', '【預約】'),
    copyText: 'a'.repeat(1001),
  });
  const footer = message.contents.footer as Record<string, unknown>;
  const buttons = collectComponents(footer).filter((item) => item.type === 'button');
  assert(buttons.length === 1, 'long copy text must still show only one button');
  const action = buttons[0].action as Record<string, unknown>;
  assert(action.label === '複製預約內容' && action.type === 'uri', 'long copy text should use the existing authenticated fallback');
  assert(String(action.uri).includes('bookingAction=copy'), 'fallback must trigger the copy flow');
});

Deno.test('legacy aggregate service notification remains compatible', () => {
  const message = buildBookingFlexMessage({
    ...sampleJob,
    message_text: [
      '【預約】',
      '預約人：王小姐',
      '日期：2026/09/15',
      '時段：10:00–11:00（台北時間）',
      '電話：0912345678',
      '預約項目：',
      '腳底40',
    ].join('\n'),
  });
  assert(JSON.stringify(message.contents).includes('腳底40'), 'legacy queued service details must still render');
});

Deno.test('legacy or unexpected booking text still uses a Flex fallback card', () => {
  const message = buildBookingFlexMessage({
    ...sampleJob,
    message_text: '預約狀態已更新，請查看最新資料。',
  });
  assert(message.type === 'flex', 'fallback notification must remain a Flex Message');
  const body = message.contents.body as Record<string, unknown>;
  const cards = body.contents as Array<Record<string, unknown>>;
  assert(cards.length === 1 && cards[0].cornerRadius === '12px', 'fallback should use the same card presentation');
  assert(JSON.stringify(message.contents).includes('預約狀態已更新'), 'fallback must preserve the original information');
});

Deno.test('delivery preserves LINE retry idempotency while sending Flex', async () => {
  let requestBodyText = '';
  let retryKey = '';

  const send = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBodyText = String(init?.body || '{}');
    retryKey = new Headers(init?.headers).get('X-Line-Retry-Key') || '';
    return new Response('', { status: 200, headers: { 'x-line-request-id': 'req-123' } });
  }) as typeof fetch;

  const result = await deliver(sampleJob, 'test-channel-access-token', send);
  const requestBody = JSON.parse(requestBodyText) as { messages?: Array<Record<string, unknown>> };
  const messages = requestBody.messages;

  assert(result.accepted === true, 'successful LINE response must be accepted');
  assert(result.lineRequestId === 'req-123', 'LINE request id must be retained');
  assert(retryKey === sampleJob.id, 'outbox UUID must remain the LINE retry key');
  assert(Array.isArray(messages) && messages[0]?.type === 'flex', 'push payload must contain a Flex Message');
});


Deno.test('delivery marks 500 and 429 as retryable without changing the LINE retry key', async () => {
  const seenRetryKeys: string[] = [];
  const statuses = [500, 429];
  let call = 0;

  const send = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenRetryKeys.push(new Headers(init?.headers).get('X-Line-Retry-Key') || '');
    const status = statuses[call++] ?? 500;
    return new Response('', { status, headers: { 'x-line-request-id': 'req-' + status } });
  }) as typeof fetch;

  const first = await deliver(sampleJob, 'test-channel-access-token', send);
  const second = await deliver(sampleJob, 'test-channel-access-token', send);

  assert(first.accepted === false && first.retryable === true && first.status === 500,
    'HTTP 500 must remain retryable and unaccepted');
  assert(second.accepted === false && second.retryable === true && second.status === 429,
    'HTTP 429 must remain retryable and unaccepted');
  assert(seenRetryKeys.length === 2 && seenRetryKeys.every((value) => value === sampleJob.id),
    'every retry must reuse the same outbox UUID as X-Line-Retry-Key');
});

Deno.test('delivery can retry the same job after a transient failure and succeed exactly once', async () => {
  const seenRetryKeys: string[] = [];
  let attempt = 0;

  const send = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenRetryKeys.push(new Headers(init?.headers).get('X-Line-Retry-Key') || '');
    attempt += 1;
    return attempt === 1
      ? new Response('', { status: 503, headers: { 'x-line-request-id': 'req-failed' } })
      : new Response('', { status: 200, headers: { 'x-line-request-id': 'req-ok' } });
  }) as typeof fetch;

  const failed = await deliver(sampleJob, 'test-channel-access-token', send);
  const retried = await deliver(sampleJob, 'test-channel-access-token', send);

  assert(failed.accepted === false && failed.retryable === true && failed.status === 503,
    'transient failure must be eligible for retry');
  assert(retried.accepted === true && retried.retryable === false && retried.status === 200,
    'retry must be accepted when LINE recovers');
  assert(retried.lineRequestId === 'req-ok', 'successful retry must retain the final LINE request id');
  assert(seenRetryKeys.length === 2 && seenRetryKeys[0] === sampleJob.id && seenRetryKeys[1] === sampleJob.id,
    'failure and retry must use the identical LINE retry key');
});

Deno.test('LINE duplicate retry acknowledgement 409 is treated as accepted only with accepted request id', async () => {
  const accepted409 = (async () =>
    new Response('', {
      status: 409,
      headers: { 'x-line-accepted-request-id': 'accepted-original' },
    })) as typeof fetch;
  const plain409 = (async () =>
    new Response('', {
      status: 409,
      headers: { 'x-line-request-id': 'duplicate-without-acceptance' },
    })) as typeof fetch;

  const deduplicated = await deliver(sampleJob, 'test-channel-access-token', accepted409);
  const rejectedDuplicate = await deliver(sampleJob, 'test-channel-access-token', plain409);

  assert(deduplicated.accepted === true && deduplicated.retryable === false && deduplicated.status === 409,
    'LINE 409 with accepted-request-id must count as the original push having been accepted');
  assert(deduplicated.lineRequestId === 'accepted-original',
    'deduplicated retry must keep the accepted request id for audit');
  assert(rejectedDuplicate.accepted === false && rejectedDuplicate.retryable === false && rejectedDuplicate.status === 409,
    'plain 409 without accepted-request-id must not be reported as delivered');
});

Deno.test('transport exception stays retryable and never exposes the channel access token', async () => {
  const send = (async () => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  const result = await deliver(sampleJob, 'test-channel-access-token', send);

  assert(result.accepted === false && result.retryable === true && result.status === null,
    'network failure must be retryable without a fake HTTP status');
  assert(result.lineRequestId === '', 'network failure must not fabricate a LINE request id');
});

Deno.test('AC-004: only admin LINE shows booking IDs, including fallback and alt text', () => {
  const id = '10000000-0000-4000-8000-000000000030';
  const raw = [
    '【預約】', '預約編號：' + id, '原預約編號：' + id,
    '新增預約編號：' + id, '預約人：櫃檯人員',
    '日期：2026/11/21', '時段：2026/11/21 10:00',
  ].join('\n');
  for (const channel of ['member', 'frontdesk']) {
    const message = buildBookingFlexMessage({ ...sampleJob, channel, message_text: raw });
    assert(!JSON.stringify(message).includes(id), channel + ' must hide the booking ID everywhere');
  }
  const admin = buildBookingFlexMessage({ ...sampleJob, channel: 'admin', message_text: raw });
  assert(JSON.stringify(admin).includes(id), 'admin keeps the booking ID for reconciliation');
  const fallback = buildBookingFlexMessage({
    ...sampleJob, channel: 'frontdesk', message_text: '【預約】\n預約編號：' + id,
  });
  assert(!JSON.stringify(fallback).includes(id), 'frontdesk fallback must also hide the ID');
});

Deno.test('AC-001/002: frontdesk rejection is three readable Flex cards, no mixed member details', () => {
  const originalId='10000000-0000-4000-8000-000000000030';
  const addedId='10000000-0000-4000-8000-000000000031';
  const text = [
    '【櫃檯拒絕預約】', '預約人：櫃檯人員',
    '拒絕原因：該時段已被現場人員預約但未登記',
    '', '【原預約資料】', '預約編號：'+originalId,
    '預約日期：2026-11-21', '預約時間：10:00',
    '原預約會員：陳先生', '電話：0900000000', '預約人數：1 位',
    '預約項目：身體60', '預約技師：10技師', '會員備註：不要太大力',
    '', '【櫃檯新增的預約資料】', '新增預約編號：'+addedId,
    '預約日期：2026-11-21', '預約時間：10:30',
    '預約人：櫃檯人員', '預約人數：1 位',
    '預約項目：肩頸30', '預約技師：11技師', '預約狀態：已確認',
  ].join('\n');
  const card = buildBookingFlexMessage({ ...sampleJob, channel: 'admin', message_text: text });
  const groups = (card.contents.body as any).contents as Array<Record<string, any>>;
  assert(groups.length===3,'one summary and two independent sections');
  const textFields = (value: unknown) => collectComponents(value).filter(x=>x.type==='text').map(x=>String(x.text||''));
  const summary=textFields(groups[0]).join('|');
  const before=textFields(groups[1]).join('|');
  const after=textFields(groups[2]).join('|');
  assert(summary.includes('執行人員')&&summary.includes('櫃檯人員')&&summary.includes('補登狀態')&&summary.includes('已確認'),
    'summary must describe who acted and that replacement is confirmed');
  assert(before.includes('原預約資料')&&before.includes('已拒絕')&&before.includes('陳先生')&&before.includes('0900000000')&&before.includes('身體60')&&before.includes(originalId),
    'original card must retain actual customer and all original service details');
  assert(after.includes('櫃檯新增預約')&&after.includes('10:30')&&after.includes('肩頸30')&&after.includes('11技師')&&after.includes(addedId),
    'replacement card must retain correct new service and start time');
  assert(!after.includes('0900000000')&&!after.includes('陳先生')&&!after.includes('電話')&&!after.includes('預約人'),
    'staff slot replacement has no customer contact or phantom placeholders');
  assert(!before.includes('肩頸30')&&!after.includes('身體60'), 'separate sections must not mix original/replacement');
  assert((before.match(/預約日期/g)||[]).length===0 && (after.match(/預約日期/g)||[]).length===0,
    'show compact date labels only once in each card');
  assert(card.altText.includes('櫃檯拒絕預約'), 'LINE preview title must remain clear');
});

Deno.test('AC-FR-013: non-paired frontdesk rejection never fabricates a replacement card',()=>{
  const text=['【櫃檯拒絕預約】','預約人：櫃檯人員','拒絕原因：預約中有休假技師',
    '【原預約資料】','預約日期：2026-11-21','預約時間：11:00',
    '原預約會員：陳先生','預約項目：身體60','預約技師：10技師'].join('\n');
  const card=buildBookingFlexMessage({...sampleJob,channel:'admin',message_text:text});
  const parts=(card.contents.body as any).contents as Array<Record<string,unknown>>;
  assert(parts.length===2,'unpaired rejection has summary and original, no replacement');
  const rendered=JSON.stringify(card);
  assert(rendered.includes('預約中有休假技師'), 'frontdesk rejection reason must be retained');
  assert(!rendered.includes('櫃檯新增預約')&&!rendered.includes('補登狀態'),
    'do not imply any replacement or confirmation if none exists');
});
