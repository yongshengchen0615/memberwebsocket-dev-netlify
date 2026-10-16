const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const offersModule = import(pathToFileURL(path.join(root, 'supabase/functions/_shared/latest-available-offers.ts')));

test('booking ticket rules belong to reward nodes and use concrete booking service ids', () => {
  const rewardMigration = read('supabase/migrations/20261002152109_move_point_ticket_service_rules_to_reward_nodes.sql');
  const serviceItemMigration = read('supabase/migrations/20261003130000_ticket_booking_service_items.sql');
  const serviceMatchMigration = read('supabase/migrations/20261003143500_ticket_booking_service_match_mode.sql');
  const adminHtml = read('admin/index.html');
  const adminApp = read('admin/app.js');
  const api = read('supabase/functions/api/index.ts');
  const benefits = read('supabase/functions/_shared/booking-benefits.ts');
  const bookingBenefitsUi = read('booking/booking-benefits.js');
  const bookingApp = read('booking/app.js');

  assert.match(rewardMigration, /alter table public\.point_card_rewards[\s\S]*required_service_types/);
  assert.match(rewardMigration, /join public\.point_card_rewards r on r\.id = pt\.reward_id/);
  assert.match(rewardMigration, /alter table public\.ticket_templates[\s\S]*drop column if exists required_service_types/);

  assert.match(serviceItemMigration, /alter table public\.point_card_rewards[\s\S]*required_service_ids uuid\[\]/);
  assert.match(serviceItemMigration, /alter table public\.event_tickets[\s\S]*required_service_ids uuid\[\]/);
  assert.match(serviceItemMigration, /booking_has_required_service_id[\s\S]*bi\.service_id = any\(p_required_service_ids\)/);
  assert.match(serviceItemMigration, /booking_participant_items bpi[\s\S]*bpi\.service_id = any\(p_required_service_ids\)/);
  assert.match(serviceItemMigration, /save_point_card_service_items/);
  assert.doesNotMatch(serviceItemMigration, /booking_has_required_service_type\(new\.booking_id/);
  assert.match(serviceMatchMigration, /required_service_match_mode text not null default 'any'/);
  assert.match(serviceMatchMigration, /booking_meets_required_services/);
  assert.match(serviceMatchMigration, /p_match_mode[\s\S]*= 'all'/);
  assert.match(serviceMatchMigration, /required_service_match_mode = v_required_service_match_mode/);

  assert.doesNotMatch(adminHtml, /id="ticketRequiredServiceTypes"/);
  assert.match(adminHtml, /id="eventTicketRequiredServiceIds"/);
  assert.match(adminHtml, /id="eventTicketRequiredServiceMatchMode"/);
  assert.match(adminApp, /此節點的預約項目限制/);
  assert.match(adminApp, /dataset\.rewardRequiredServiceIds = 'true'/);
  assert.match(adminApp, /requiredServiceIds: collectRequiredServiceIds\(row\.querySelector\('\[data-reward-required-service-ids\]'\)\)/);
  assert.match(adminApp, /requiredServiceMatchMode/);
  assert.match(adminApp, /勾選的所有項目都需預約/);
  assert.match(adminApp, /strong\.textContent = service\.title/);
  assert.match(adminApp, /bookingServiceRequirementLabel/);
  assert.match(adminApp, /需預約「\$\{fullTypes\[0\]\}」項目類型/);

  assert.match(api, /requiredServiceIds: Array\.isArray\(reward\.required_service_ids\)/);
  assert.match(api, /normalizeRequiredServiceIds\(supabase,reward\.requiredServiceIds\)/);
  assert.match(api, /save_point_card_service_items/);
  assert.match(api, /requiredServiceMatchMode/);
  assert.match(api, /required_service_match_mode/);
  assert.match(api, /bookingServiceOptions\(supabase\)/);

  assert.match(benefits, /offer\.requiredServiceIds/);
  assert.match(benefits, /requiredServiceTitles/);
  assert.match(benefits, /requiredServiceMatchMode/);
  assert.match(benefits, /項目類型的所有項目/);
  assert.doesNotMatch(benefits, /pointRequiredByTemplate/);
  assert.match(bookingBenefitsUi, /currentServiceIds/);
  assert.match(bookingBenefitsUi, /matchMode === 'all'/);
  assert.match(bookingBenefitsUi, /required\.every\(\(serviceId\) => currentServiceIds\.has\(serviceIdKey\(serviceId\)\)\)/);
  assert.match(bookingBenefitsUi, /required\.some\(\(serviceId\) => currentServiceIds\.has\(serviceIdKey\(serviceId\)\)\)/);
  assert.match(bookingApp, /item\.service\?\.serviceId/);
});

test('the same ticket template can require different concrete booking items at different point nodes', async () => {
  const { selectLatestPointOffers } = await offersModule;
  const rewards = [
    {
      id: 'reward-body',
      point_card_id: 'card-1',
      threshold_stamps: 5,
      ticket_template_id: 'template-1',
      required_service_ids: ['service-body-60'],
    },
    {
      id: 'reward-foot',
      point_card_id: 'card-1',
      threshold_stamps: 10,
      ticket_template_id: 'template-1',
      required_service_ids: ['service-foot-60'],
    },
  ];
  const cards = [{
    id: 'card-1',
    card_id: 'CARD',
    title: '身體集點卡',
    status: 'active',
    expiry_mode: 'unlimited',
    sort_order: 0,
  }];
  const templates = [{
    id: 'template-1',
    title: '共用優惠券',
    status: 'active',
  }];
  const tickets = [
    {
      ticket_id: 'PT-BODY',
      reward_id: 'reward-body',
      point_card_id: 'card-1',
      ticket_template_id: 'template-1',
      threshold_stamps: 5,
    },
    {
      ticket_id: 'PT-FOOT',
      reward_id: 'reward-foot',
      point_card_id: 'card-1',
      ticket_template_id: 'template-1',
      threshold_stamps: 10,
    },
  ];

  const offers = selectLatestPointOffers(rewards, cards, templates, tickets, '2026-10-03');
  assert.equal(offers.length, 2);
  assert.deepEqual(offers[0].requiredServiceIds, ['service-body-60']);
  assert.deepEqual(offers[1].requiredServiceIds, ['service-foot-60']);
  assert.equal(offers[0].ticketTemplateId, offers[1].ticketTemplateId);
});
