const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('MemberWebsocket-dev/calendar/app.js', 'utf8');

class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.textContent = '';
    this.className = '';
    this.dataset = {};
    this._classes = new Set();
    this.style = { setProperty() {} };
    this.classList = {
      add: value => this._classes.add(value),
      remove: value => this._classes.delete(value),
      contains: value => this._classes.has(value),
    };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener() {}
  focus() { this.focused = true; }
}

function runDateDetails(items, date = '2026-12-12') {
  const marker = '  window.MemberClientQaHooks = Object.freeze(';
  assert.ok(source.includes(marker), 'calendar test seam exists');
  const script = source.replace(marker,
    '  window.__dateTest = { state, els, splitCalendarDateItems, openCalendarDateDetails };\n' + marker);
  const window = {
    addEventListener() {},
    location: { href: 'https://testing.example/calendar/' },
    BusinessContext: { slug: 'merchant-a' },
  };
  const document = { createElement: tag => new FakeNode(tag) };
  vm.runInNewContext(script, { window, document, HTMLElement: FakeNode, URL, Date, Intl, console });
  const qa = window.__dateTest;
  qa.state.items = items;
  qa.els.calendarDetailTitle = new FakeNode('h2');
  qa.els.calendarDetailDate = new FakeNode('p');
  qa.els.calendarDetailItems = new FakeNode('div');
  qa.els.calendarDetailModal = new FakeNode('div');
  qa.els.closeCalendarDetailButton = new FakeNode('button');
  return { qa, open: () => qa.openCalendarDateDetails(date, new FakeNode('button')) };
}

const activity = { calendarItemId:'activity-1', itemType:'event', title:'一般會員活動',
  startsOn:'2026-12-12', endsOn:'2026-12-12', tierEligible:true, locked:false, allowedTierLabels:['一般會員'] };
const ticket = { calendarItemId:'ticket-1', itemType:'event', title:'銀級活動票券',
  startsOn:'2026-12-12', endsOn:'2026-12-12', tierEligible:false, locked:true,
  allowedTierLabels:['銀級會員'], lockReason:'需升級至銀級會員。',
  linkLabel:'前往使用', linkUrl:'https://old.example/event/?source=event-ticket-calendar&eventTicketId=EVT-1' };

function sections(qa) { return qa.els.calendarDetailItems.children; }
function heading(section) { return section.children[0].children[0].textContent; }
function cards(section) { return section.children[1].children; }
function flatten(node) { return [node, ...node.children.flatMap(flatten)]; }

test('AC-001: a date separates usable benefits from locked activities and tickets while retaining stable order within a tier', async () => {
  const { qa, open } = runDateDetails([ticket, activity,
    { ...activity, calendarItemId:'activity-2', title:'另一項活動' }]);
  const categorized = qa.splitCalendarDateItems(qa.state.items);
  assert.equal(categorized.available.length, 2);
  assert.equal(categorized.locked.length, 1);
  await open();
  assert.deepEqual(sections(qa).map(heading), ['當日可用的會員活動', '未解鎖的活動票券']);
  assert.deepEqual(cards(sections(qa)[0]).map(card => flatten(card).find(el => el.tagName === 'H4').textContent),
    ['一般會員活動', '另一項活動']);
  assert.match(qa.els.calendarDetailDate.textContent, /2 項可用.*1 項未解鎖/);
});

test('AC-002: locked benefits show unlocking guidance but never receive an action link', async () => {
  const { qa, open } = runDateDetails([ticket, { ...ticket, calendarItemId:'ticket-2', title:'已鎖定票券',
    tierEligible:true, locked:true }]);
  await open();
  assert.deepEqual(sections(qa).map(heading), ['未解鎖的活動票券']);
  for (const card of cards(sections(qa)[0])) {
    const nodes = flatten(card);
    assert.equal(nodes.filter(el => el.tagName === 'A').length, 0);
    assert.ok(nodes.some(el => el.textContent.includes('銀級會員')), 'the unlock requirement is visible');
  }
});

test('AC-003: eligible tickets keep their current merchant link without altering the business scope', async () => {
  const { qa, open } = runDateDetails([{ ...ticket, tierEligible:true, locked:false }]);
  await open();
  const first = cards(sections(qa)[0])[0];
  const link = flatten(first).find(node => node.tagName === 'A');
  assert.ok(link);
  assert.equal(new URL(link.href).searchParams.get('business'), 'merchant-a');
  assert.equal(new URL(link.href).searchParams.get('eventTicketId'), 'EVT-1');
  assert.ok(flatten(first).some(node => node.textContent === '活動票券'));
});

test('AC-004: holiday dates retain their exclusive notice and do not pretend to have usable benefits', async () => {
  const holiday = { calendarItemId:'holiday-1', itemType:'holiday', title:'技師休假',
    status:'active', startsOn:'2026-12-12', endsOn:'2026-12-12' };
  const { qa, open } = runDateDetails([activity, ticket, holiday]);
  await open();
  assert.deepEqual(sections(qa).map(heading), ['休假提醒']);
  assert.equal(cards(sections(qa)[0]).length, 1);
  assert.equal(qa.els.calendarDetailDate.textContent, '1 項相關日期說明');
});

test('AC-005: empty groups are omitted and malicious titles are presented as text', async () => {
  const { qa, open } = runDateDetails([{ ...activity, title:'<img src=x onerror=alert(1)>' }]);
  await open();
  assert.equal(sections(qa).length, 1);
  assert.equal(flatten(sections(qa)[0]).filter(el => el.tagName === 'IMG').length, 0);
  assert.ok(flatten(sections(qa)[0]).some(el => el.textContent === '<img src=x onerror=alert(1)>'));
});

test('AC-006: unpreviewable offers cannot be invented from calendar UI and no extra API is issued', async () => {
  const { qa, open } = runDateDetails([]);
  await open();
  assert.equal(sections(qa).length, 0);
  assert.match(source, /visibleCalendarItemsOnDate\(state\.items, isoDate\)/);
  assert.doesNotMatch(source, /calendar\.date\.details.*includeHidden/);
});

const tierOffer = (title, key, kind = 'activity', locked = false) => ({
  ...(kind === 'ticket' ? ticket : activity),
  calendarItemId: 'tier-' + title,
  title,
  allowedTierKeys: [key],
  allowedTierLabels: [{general:'一般會員',silver:'銀級會員',gold:'金級會員',platinum:'白金會員'}[key] || '未知'],
  tierEligible: !locked,
  locked,
  ...(kind === 'ticket' ? {eventTicketId:'EVT-' + title} : {linkUrl:'https://other.example/activity/'}),
});
function cardTitles(section) {
  return cards(section).map(card => flatten(card).find(el => el.tagName === 'H4').textContent);
}
test('AC-007: date modal separates available and locked offers by activity and ticket kind', async () => {
  const {qa, open} = runDateDetails([
    tierOffer('已解鎖票券', 'gold', 'ticket'),
    tierOffer('未解鎖活動', 'platinum', 'activity', true),
    tierOffer('可用活動', 'silver'),
    tierOffer('未解鎖票券', 'gold', 'ticket', true)
  ]);
  await open();
  assert.deepEqual(sections(qa).map(heading), [
    '當日可用的會員活動', '當日可用的活動票券',
    '未解鎖的會員活動', '未解鎖的活動票券'
  ]);
  assert.deepEqual(sections(qa).map(s => s.className), [
    'calendar-detail-group available activities', 'calendar-detail-group available tickets',
    'calendar-detail-group locked activities', 'calendar-detail-group locked tickets'
  ]);
  assert.deepEqual(sections(qa).map(s => cards(s).length), [1,1,1,1]);
  assert.match(qa.els.calendarDetailDate.textContent, /2 項可用.*2 項未解鎖/);
});
test('AC-008: highest minimum eligible membership tier comes first in each category with stable ties', async () => {
  const entries = [
    tierOffer('一般', 'general'),tierOffer('銀級甲','silver'),
    tierOffer('白金','platinum'),tierOffer('金級','gold'),
    tierOffer('銀級乙','silver'),
    tierOffer('鎖定一般','general','ticket',true),
    tierOffer('鎖定白金','platinum','ticket',true),
    tierOffer('鎖定銀級','silver','ticket',true)
  ];
  const {qa,open} = runDateDetails(entries);
  await open();
  assert.deepEqual(cardTitles(sections(qa)[0]), ['白金','金級','銀級甲','銀級乙','一般']);
  assert.deepEqual(cardTitles(sections(qa)[1]), ['🔒 鎖定白金','🔒 鎖定銀級','🔒 鎖定一般']);
  assert.deepEqual(sections(qa).map(heading), ['當日可用的會員活動','未解鎖的活動票券']);
  assert.equal(flatten(sections(qa)[1]).filter(n => n.tagName === 'A').length, 0);
});
test('AC-009: multi-tier inheritance sorts by the lowest eligible tier, not the highest advertised tier', async () => {
  const inherited = {...tierOffer('金級起可用','gold'),allowedTierKeys:['gold','platinum'],allowedTierLabels:['金級會員','白金會員']};
  const {qa,open} = runDateDetails([
    tierOffer('白金專屬','platinum'), inherited, tierOffer('銀級起','silver')
  ]);
  await open();
  assert.deepEqual(cardTitles(sections(qa)[0]), ['白金專屬','金級起可用','銀級起']);
});
test('AC-010: old label-only records sort by tier; unknown records keep original order at the end', async () => {
  const oldGold = {...tierOffer('舊金級','gold'), allowedTierKeys:undefined};
  const oldSilver = {...tierOffer('舊銀級','silver'), allowedTierKeys:undefined};
  const unknown = {...tierOffer('未設定','general'),allowedTierKeys:['unexpected'],allowedTierLabels:['未設定']};
  const {qa,open} = runDateDetails([unknown, oldSilver, oldGold, {...unknown,title:'第二筆未設定'}]);
  await open();
  assert.deepEqual(cardTitles(sections(qa)[0]), ['舊金級','舊銀級','未設定','第二筆未設定']);
});
