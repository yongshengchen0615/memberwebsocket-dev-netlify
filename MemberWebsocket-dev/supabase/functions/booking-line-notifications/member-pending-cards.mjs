// Member-facing request notices keep status, booking facts and merchant prose
// in distinct LINE Flex sections. This module is pure for contract tests.
const SURFACE = '#F6F8F7';
const TEXT = '#17352E';
const MUTED = '#728079';

function clip(value, max = 500) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, Math.max(1, max - 1)).join('') + '…';
}

function line(label, value) {
  return {
    type: 'text',
    text: clip(label, 28) + '：' + clip(value, 480),
    size: 'sm',
    color: TEXT,
    wrap: true,
  };
}

function section(contents, backgroundColor = SURFACE) {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    paddingAll: '14px',
    backgroundColor,
    cornerRadius: '12px',
    contents,
  };
}

export function buildMemberPendingCards(parsed, accent) {
  const fields = Array.isArray(parsed?.fields) ? parsed.fields : [];
  const people = Array.isArray(parsed?.participants) ? parsed.participants : [];
  const services = Array.isArray(parsed?.services) ? parsed.services : [];
  const value = (label) => clip(fields.find(field => field.label === label)?.value, 500);
  const contents = [
    { type: 'text', text: '預約資料', size: 'md', weight: 'bold', color: accent, wrap: true },
    { type: 'separator', margin: 'sm', color: '#E5EAE7' },
  ];

  // Only booking facts enter this card. Status and administrator-defined
  // prose must not be mistaken for the customer's selected services.
  for (const [source, title] of [
    ['日期', '預約日期'], ['時段', '預約時間'],
    ['預約人', '預約人'], ['電話', '電話'], ['預約人數', '預約人數'],
  ]) {
    const detail = value(source);
    if (detail) contents.push(line(title, detail));
  }

  for (const person of people) {
    contents.push({ type: 'separator', margin: 'md', color: '#E5EAE7' });
    contents.push({
      type: 'text',
      text: clip(person.label, 40) || '預約明細',
      size: 'sm',
      weight: 'bold',
      color: accent,
      wrap: true,
    });
    contents.push(line('預約項目', Array.isArray(person.items) && person.items.length
      ? person.items.join('、') : '—'));
    contents.push(line('個別時間', person.duration || '—'));
    contents.push(line('個別金額', person.amount || '—'));
    contents.push(line('預約技師', person.technician || '現場安排'));
    if (person.note) contents.push(line('個別備註', person.note));
  }

  if (!people.length && services.length) {
    contents.push({ type: 'separator', margin: 'md', color: '#E5EAE7' });
    contents.push({ type: 'text', text: '第一位預約', size: 'sm',
      weight: 'bold', color: accent });
    contents.push(line('預約項目', services.join('、')));
  }

  const cards = [];
  const status = value('狀態');
  if (status) cards.push(section([{
    type: 'text', text: '預約狀態：' + status, size: 'sm',
    weight: 'bold', color: accent, wrap: true,
  }], '#EEF5FA'));

  cards.push(section(contents));

  // The administrator may enter multiple lines. Keep them as one prose text,
  // never parse line breaks as additional Flex field labels or card headings.
  const notice = clip(fields.filter(field => field.label === '提醒事項')
    .map(field => field.value).filter(Boolean).join('\n'), 1600);
  if (notice) cards.push(section([
    { type: 'text', text: '預約申請說明', size: 'sm', weight: 'bold',
      color: MUTED, wrap: true },
    { type: 'text', text: notice, size: 'sm', color: TEXT, wrap: true },
  ]));

  return cards;
}
