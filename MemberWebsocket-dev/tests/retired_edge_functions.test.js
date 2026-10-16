const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('retired Edge Functions are non-privileged 410 compatibility endpoints', () => {
  const cases = [
    ['supabase/functions/calendar-system-api/index.ts', 'calendar-system-api'],
    ['supabase/functions/calendar-member-api/index.ts', 'member-calendar-api'],
    ['supabase/functions/point-ticket-batch-api/index.ts', 'pointcard-extension-api'],
  ];
  for (const [file, replacement] of cases) {
    const source = read(file);
    assert.match(source, /status:\s*410/);
    assert.match(source, new RegExp(replacement.replaceAll('-', '\\-')));
    assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY/);
    assert.doesNotMatch(source, /createClient/);
    assert.doesNotMatch(source, /\.from\(/);
    assert.doesNotMatch(source, /\.rpc\(/);
  }
});
