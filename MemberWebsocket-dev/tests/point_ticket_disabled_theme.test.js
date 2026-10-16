const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('unavailable point-card tickets keep their configured theme instead of becoming a gray theme', () => {
  const pointStyles = read('points/styles.css');
  const experience = read('experience.css');

  assert.match(
    pointStyles,
    /\.member-ticket\.locked\[data-card-style\][\s\S]*background:\s*var\(--card-style-background,[\s\S]*filter:\s*grayscale\(\.68\) brightness\(\.92\);/
  );

  const availabilityStart = experience.indexOf('/* Availability state:');
  assert.notEqual(availabilityStart, -1);
  const availability = experience.slice(availabilityStart);

  assert.match(availability, /#pointsView \.ui-ticket\.locked/);
  assert.match(availability, /#bookingView \.ui-ticket\.is-unavailable/);
  assert.match(availability, /filter:\s*grayscale\(\.68\) brightness\(\.92\);/);
  assert.doesNotMatch(availability, /filter:\s*grayscale\(1\);/);
});
