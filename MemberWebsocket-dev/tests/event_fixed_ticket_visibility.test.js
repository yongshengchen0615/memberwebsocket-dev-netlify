const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('server-issued tickets are visible only after issuance to the member', () => {
  const api = read('supabase/functions/api/index.ts');
  const event = read('event/app.js');
  const html = read('event/index.html');

  assert.match(api, /if \(\(row\.fixed_ticket_template_id \|\| row\.ticket_type === "referral" \|\| row\.ticket_type === "membership_join"\) && !claimRow\) return \[\];/);
  assert.match(api, /const offers = \(eventRows \|\| \[\]\)\.flatMap/);
  assert.match(event, /return offers\.filter\(\(offer\) => !isFixedOffer\(offer\) \|\| Boolean\(offer\?\.claim\)\);/);
  assert.doesNotMatch(event, /isBirthdayFixedOffer|birthdayMonth\(profile\)/);
  assert.match(html, /<script src="\.\/app\.js\?v=[^"<>]+" defer><\/script>/);
  assert.match(api, /if \(claimRow && String\(claimRow\.status \|\| ""\) === "used"\) return \[\];/);
  assert.match(api, /!\["referral","membership_join"\]\.includes\(String\(row\.ticket_type \|\| ""\)\)/);
});
