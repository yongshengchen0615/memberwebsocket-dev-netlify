const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=name=>fs.readFileSync(path.join(root,name),'utf8');
test('AC-FD-CTA-001: OA join link is absent both during login and on approved staff panels',()=>{
 const app=read('frontdesk/app.js');
 assert.doesNotMatch(app,/加入櫃檯官方帳號|https:\/\/line\.me\/R\/ti\/p\//);
 assert.match(app,/frontdesk\.apply/);
 assert.match(app,/frontdesk\.bootstrap/);
 assert.match(app,/frontdesk\.bookings/);
});
test('AC-FD-THEME-002: the standalone toggle uses the existing persisted color theme without weakening review rights',()=>{
 const html=read('frontdesk/index.html'),js=read('frontdesk/theme-toggle.js'),css=read('frontdesk/styles.css'),theme=read('theme.js');
 assert.match(html,/id="themeToggleButton"/);
 assert.match(html,/src="\.\.\/theme\.js"/);
 assert.match(html,/src="\.\/theme-toggle\.js/);
 assert.match(js,/LumenTheme/);
 assert.match(js,/\.set\(theme\.get\(\)==='dark'\?'light':'dark'\)/);
 assert.match(theme,/lumen-color-theme-v1/);
 assert.match(css,/html\[data-theme="dark"\] body\.frontdesk-page/);
 assert.match(css,/html\[data-theme="light"\] body\.frontdesk-page/);
 assert.match(read('frontdesk/app.js'),/permissionMode==='review'/);
});
