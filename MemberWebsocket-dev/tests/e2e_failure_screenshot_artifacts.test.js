const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('failed browser cases capture WebP and upload only metadata into failure trace', () => {
  for (const file of ['user-test-control.js', 'admin/e2e-control.js']) {
    const source = read(file);
    assert.match(source, /html2canvas@1\.4\.1/);
    assert.match(source, /image\/webp/);
    assert.match(source, /FAILURE_SCREENSHOT_MAX_BYTES = 1900000/);
    assert.match(source, /e2e-artifact-api/);
    assert.match(source, /artifactVersion: 3/);
    assert.match(source, /screenshotCapture/);
  }
});

test('artifact API stores only private WebP objects and admin view uses short signed URLs', () => {
  const source = read('supabase/functions/e2e-artifact-api/index.ts');
  assert.match(source, /BUCKET = "e2e-failure-artifacts"/);
  assert.match(source, /MAX_FILE_BYTES = 2 \* 1024 \* 1024/);
  assert.match(source, /file\.type !== "image\/webp"/);
  assert.match(source, /storage\.from\(BUCKET\)\.upload/);
  assert.match(source, /admin\.e2e-artifact\.signed-url/);
  assert.match(source, /createSignedUrl\(path, SIGNED_URL_TTL_SECONDS\)/);
  assert.match(source, /SIGNED_URL_TTL_SECONDS = 300/);
  assert.doesNotMatch(source, /getPublicUrl/);
});

test('artifact storage is private and has a scheduled 30 day retention worker', () => {
  const migration = read('supabase/migrations/20260923142815_e2e_failure_artifact_storage_v2.sql');
  const retention = read('supabase/functions/e2e-artifact-retention/index.ts');
  assert.match(migration, /'e2e-failure-artifacts'/);
  assert.match(migration, /false,\s*2097152/);
  assert.match(migration, /array\['image\/webp'\]/);
  assert.match(migration, /prune-e2e-failure-artifacts/);
  assert.match(migration, /e2e-artifact-retention/);
  assert.match(retention, /RETENTION_DAYS = 30/);
  assert.match(retention, /storage\.from\(BUCKET\)\.remove/);
});

test('admin history renders screenshots inline only after requesting an admin signed URL', () => {
  const source = read('admin/test-control.js');
  const html = read('admin/index.html');
  assert.match(source, /requestArtifactSignedUrl/);
  assert.match(source, /admin\.e2e-artifact\.signed-url/);
  assert.match(source, /loadInlinePreview/);
  assert.match(source, /prepareArtifactPreview/);
  assert.match(source, /artifactPreviewCache/);
  assert.match(source, /ARTIFACT_PREFETCH_CONCURRENCY = 2/);
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /rootMargin: '320px 0px'/);
  assert.match(source, /image\.loading = 'eager'/);
  assert.match(source, /image\.fetchPriority = 'high'/);
  assert.doesNotMatch(source, /image\.loading = 'lazy'/);
  assert.match(source, /image\.onload/);
  assert.match(source, /image\.onerror/);
  assert.match(source, /快照已預載，可直接查看/);
  assert.match(source, /快照已直接載入管理端/);
  assert.match(source, /Private · 30 天保留/);
  assert.match(source, /約 5 分鐘後失效/);
  assert.match(html, /img-src[^;]*https:\/\/dbuquirnaskrwcamdxki\.supabase\.co/);
});
