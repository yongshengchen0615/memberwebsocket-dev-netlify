const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const path=require('node:path');
test('shared ticket preserves accent, escapes titles and reports remaining inventory',()=>{
 const dom=new JSDOM('',{runScripts:'outside-only'});const w=dom.window;
 w.eval(fs.readFileSync(path.join(__dirname,'../../event-ticket-ui.js'),'utf8'));
 const ticket={title:'<img src=x>',accent:'#123456',quota:10,claimedCount:3,allowedTierKeys:['gold']};
 const page=w.EventTicketUI.create(ticket);const booking=w.EventTicketUI.create(ticket,{stateLabel:'可選用'});
 assert.equal(page.querySelector('h3').textContent,booking.querySelector('h3').textContent);
 assert.equal(booking.querySelector('img'),null);
 assert.equal(booking.style.getPropertyValue('--ticket-accent'),'#123456');
 assert.match(booking.textContent,/剩餘 7 張/);assert.match(booking.textContent,/金級會員/);
 assert.match(w.EventTicketUI.create({quota:0}).textContent,/不限量/);dom.window.close();
});
