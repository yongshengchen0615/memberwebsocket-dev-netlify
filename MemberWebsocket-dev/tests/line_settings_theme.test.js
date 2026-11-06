const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const css=fs.readFileSync(path.join(root,'admin/business-line-settings.css'),'utf8');
const html=fs.readFileSync(path.join(root,'admin/index.html'),'utf8');
const rule=selector=>{
 const prefix=selector+'{';
 const line=css.split('\n').find(line=>line.startsWith(prefix));
 assert.ok(line,selector+' selector exists as a standalone CSS rule');
 return line.slice(prefix.length,line.indexOf('}',prefix.length));
};
test('AC-001: merchant LINE settings inherit light/dark semantic surfaces',()=>{
 assert.ok(html.includes('business-line-settings.css?v=line-theme-20261103-2'));
 assert.ok(html.includes('../theme.js?v='));
 for(const [selector,token] of [
  ['.business-line-settings','--theme-surface-raised'],
  ['.business-line-summary','--theme-positive-soft'],
  ['.business-line-settings details','--theme-surface-muted'],
  ['.business-line-settings small','--theme-text-muted'],
  ['.business-client-links code','--theme-surface-muted'],
  ['.business-line-feature-nav button','--theme-surface-muted'],
  ['.business-line-feature-nav button[aria-selected="true"]','--theme-positive']
 ])assert.ok(rule(selector).includes('var('+token+')'),selector+' must use '+token);
 assert.ok(rule('.business-line-settings').includes('color:var(--theme-text)'));
 assert.ok(!rule('.business-line-settings').includes('background:#fff'));
});
test('AC-002: LINE inputs, selection and focus adapt without modifying LINE branding',()=>{
 assert.ok(rule('.business-line-settings input').includes('background:var(--theme-surface-raised);color:var(--theme-text)'));
 assert.ok(rule('.business-line-settings select').includes('background:var(--theme-surface-raised);color:var(--theme-text)'));
 assert.ok(rule('.business-line-feature-nav button[aria-selected="true"]').includes('color:var(--theme-bg)'));
 assert.ok(css.includes('var(--theme-focus-ring)'));
 assert.ok(rule('.business-line-settings input[type="checkbox"]').includes('accent-color:var(--theme-positive)'));
 assert.ok(rule('.business-client-actions .business-client-line-link').includes('background:#087b46'));
});

test('AC-003: merchant shell uses shared color preference while preserving no-theme fallback tokens',()=>{
 const merchant=fs.readFileSync(path.join(root,'admin/workspace.html'),'utf8');
 assert.ok(merchant.includes('data-workspace="merchant"'));
 assert.ok(merchant.includes('business-line-settings.css?v=line-theme-20261103-2'));
 assert.ok(merchant.includes('../theme.css?v=merchant-workspace-theme-20261105-1'));
 assert.ok(merchant.includes('../theme.js?v=m3-ui-20260929-1'));
 assert.ok(merchant.includes('aria-label="外觀設定"'));
 const platformCss=fs.readFileSync(path.join(root,'platform/platform.css'),'utf8');
 assert.match(platformCss,/html\[data-workspace="merchant"\]\s*\{/);
 assert.match(platformCss,/--platform-surface-raised:var\(--theme-surface-raised\)/);
 const scoped=css.match(/html\[data-workspace="merchant"\]:not\(\[data-theme\]\)\{([\s\S]*?)\}/);
 assert.ok(scoped,'legacy workspace requires a scoped fallback palette');
 for(const name of ['bg','surface-raised','surface-muted','text','text-muted','border','border-strong','positive','positive-soft','positive-text','link','focus-ring','placeholder'])
  assert.ok(scoped[1].includes('--theme-'+name+':'),name+' must not be undefined');
});
