const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const auth = read('supabase/functions/_shared/auth-contract.ts');
const api = read('supabase/functions/api/index.ts');
const profileApi = read('supabase/functions/member-profile-api/index.ts');
const admin = read('admin/app.js');
const css = read('admin/styles.css');
const migration = read('supabase/migrations/20261128200000_member_line_picture_url.sql');

test('verified LINE picture claim is normalized to an HTTPS LINE CDN URL', async () => {
  const moduleUrl = pathToFileURL(path.join(root, 'supabase/functions/_shared/line-profile-picture.mjs')).href;
  const { normalizeLinePictureUrl } = await import(moduleUrl);
  assert.equal(normalizeLinePictureUrl('https://profile.line-scdn.net/abc123'), 'https://profile.line-scdn.net/abc123');
  for (const value of [undefined, null, '', 123, 'javascript:alert(1)',
    'http://profile.line-scdn.net/avatar', 'https://profile.line-scdn.net.evil.test/x',
    'https://evil.example.com/x', 'https://user:pass@profile.line-scdn.net/x',
    'https://profile.line-scdn.net.evil/x', 'data:image/png;base64,AAAA']) {
    assert.equal(normalizeLinePictureUrl(value), '', String(value));
  }
});

test('LINE profile photo is taken from server-verified ID token, not request body', () => {
  assert.match(auth, /if \(!response\.ok \|\| !isVerifiedLineIdClaim\(payload, expectedChannelId\)\)/);
  assert.match(auth, /pictureUrl:\s*normalizeLinePictureUrl\(payload\.picture\)/);
  assert.doesNotMatch(auth, /pictureUrl:\s*args\./);
});

test('both member entry points persist verified LINE picture without overwriting it when absent', () => {
  for (const code of [api, profileApi]) {
    assert.match(code, /line_picture_url:\s*identity\.pictureUrl \|\| null/);
    assert.match(code, /if \(identity\.pictureUrl && identity\.pictureUrl !== member\.line_picture_url\)/);
    assert.match(code, /patch\.line_picture_url = identity\.pictureUrl/);
  }
  assert.match(migration, /alter table public\.members add column if not exists line_picture_url text/i);
  assert.match(api, /linePictureUrl:\s*member\.line_picture_url \|\| ""/);
  const adminAuth = api.indexOf('const admin = await authorizeAdmin(supabase,identity);');
  const roster = api.indexOf('if (action === "admin.members.list")');
  assert.ok(adminAuth > -1 && roster > adminAuth, 'directory remains protected by existing admin authorization');
});

function memberAvatarFactory() {
  const start = admin.indexOf('  function createMemberAvatar(');
  const end = admin.indexOf('\n  function createMemberIdentity(', start);
  assert.ok(start >= 0 && end > start, 'avatar factory must be independently testable');
  const document = {
    createElement(tagName) {
      return {
        tagName: tagName.toUpperCase(),
        children: [],
        textContent: '',
        replaceChildren(...items) { this.children = items; this.textContent = ''; },
      };
    },
  };
  const window = { MemberSystem: { initials: (name) => name.slice(0, 1) } };
  return new Function('document', 'window', admin.slice(start, end) + '\nreturn createMemberAvatar;')(document, window);
}

test('directory displays verified LINE photo; missing and invalid photos retain initials', () => {
  const make = memberAvatarFactory();
  const name = '小美';
  const photo = make({ displayName: name, linePictureUrl: 'https://profile.line-scdn.net/123' }, 'member-avatar');
  assert.equal(photo.className, 'member-avatar');
  assert.equal(photo.children.length, 1);
  assert.equal(photo.children[0].tagName, 'IMG');
  assert.equal(photo.children[0].src, 'https://profile.line-scdn.net/123');
  assert.equal(photo.children[0].alt, '');
  assert.equal(photo.children[0].referrerPolicy, 'no-referrer');
  assert.equal(photo.children[0].loading, 'lazy');
  photo.children[0].onerror();
  assert.equal(photo.textContent, '小');

  for (const invalid of ['', 'https://other.site/image.png', 'javascript:alert(1)']) {
    const avatar = make({ displayName: name, linePictureUrl: invalid }, 'member-avatar');
    assert.equal(avatar.textContent, '小');
    assert.equal(avatar.children.length, 0);
  }
  assert.match(admin, /createMemberAvatar\(member, 'member-avatar'\)/);
  assert.match(admin, /createMemberAvatar\(member, 'member-records-avatar'\)/);
  assert.match(css, /\.member-avatar img, \.member-records-avatar img/);
});
