const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
}

function rule(css, selector) {
  const match = css.match(new RegExp(escapeRegExp(selector) + '\\s*\\{([^}]*)\\}'));
  assert.ok(match, 'missing CSS rule: ' + selector);
  return match[1];
}

const palettes = {
  forest: ['#17352e', '#df6b4d', '#f3c9ab'],
  midnight: ['#1a2340', '#78a8f7', '#dae6ff'],
  ocean: ['#0d3b4c', '#3dc4c5', '#c9f0ea'],
  sunset: ['#54261f', '#ee896d', '#ffd3b9'],
  lavender: ['#33264d', '#b999e8', '#eadbff'],
  rose: ['#501d32', '#e891ab', '#ffd8e3'],
  gold: ['#45320e', '#e6b84f', '#ffe7a7'],
  platinum: ['#38414e', '#b8cadc', '#e9eff5'],
  mint: ['#1e4039', '#6bd0a0', '#d1f4de'],
  cherry: ['#4a1721', '#ec6973', '#ffd0d4'],
};

test('admin membership tier previews match the member card and progress palettes', () => {
  const adminCss = read('admin/styles.css');
  const memberCss = read('member/styles.css');
  const progressCss = read('member/membership-progress.css');

  for (const [styleKey, [background, accent, soft]] of Object.entries(palettes)) {
    const adminRule = rule(adminCss, '.style-preview[data-style="' + styleKey + '"]');
    assert.match(adminRule, new RegExp('--tier-preview-background:\\s*' + escapeRegExp(background)));
    assert.match(adminRule, new RegExp('--tier-preview-accent:\\s*' + escapeRegExp(accent)));
    assert.match(adminRule, new RegExp('--tier-preview-soft:\\s*' + escapeRegExp(soft)));

    const memberRule = rule(memberCss, '.member-pass.tier-style-' + styleKey);
    assert.match(memberRule, new RegExp('--pass-background:\\s*' + escapeRegExp(background)));
    assert.match(memberRule, new RegExp('--pass-accent:\\s*' + escapeRegExp(accent)));
    assert.match(memberRule, new RegExp('--pass-soft:\\s*' + escapeRegExp(soft)));

    const progressRule = rule(progressCss, '.membership-progress[data-membership-tier-style="' + styleKey + '"]');
    assert.match(progressRule, new RegExp('--membership-card-background:\\s*' + escapeRegExp(background)));
    assert.match(progressRule, new RegExp('--membership-card-accent:\\s*' + escapeRegExp(accent)));
    assert.match(progressRule, new RegExp('--membership-card-soft:\\s*' + escapeRegExp(soft)));
  }
});

test('admin uses a cache-busted stylesheet version for the tier style sync', () => {
  const html = read('admin/index.html');
  assert.match(html, /\.\/styles\.css\?v=[A-Za-z0-9._-]+/);
});
