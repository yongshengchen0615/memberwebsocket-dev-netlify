const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const css=fs.readFileSync(path.join(root,'admin/business-line-settings.css'),'utf8');
const html=fs.readFileSync(path.join(root,'admin/index.html'),'utf8');
const rule=selector=>{
 const begin=css.indexOf(selector+'{');
 assert.ok(begin>=0,selector+' selector exists');
 return css.slice(begin,css.indexOf('}',begin));
};
test('AC-001: merchant LINE settings inherit light/dark semantic surfaces',()=>{
 assert.ok(html.includes('business-line-settings.css?v=line-theme-20261103-1'));
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
