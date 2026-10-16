const {JSDOM}=require('jsdom');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'../..');
const code=fs.readFileSync(path.join(root,'dialog-accessibility.js'),'utf8');
function fixture(){
  const dom=new JSDOM(`<button id="opener">開啟</button>
    <div id="upper" class="hidden" role="dialog" aria-modal="true" style="z-index:200"><button id="u1">關閉</button><button id="u2">確認</button></div>
    <div id="lower" class="hidden" role="dialog" aria-modal="true" style="z-index:100"><button id="first">關閉</button><fieldset disabled><button>停用</button></fieldset><input id="input"><button id="last">確認</button><button hidden>隱藏</button></div>`, {runScripts:'outside-only'});
  const w=dom.window, d=w.document;
  // JSDOM 沒有排版引擎：只模擬可見性，不能把這些測試當成視覺／裝置驗收。
  w.HTMLElement.prototype.getClientRects=function(){return this.closest('.hidden,[hidden]') ? [] : [{}];};
  w.eval(code);
  return {dom,w,d,el:id=>d.getElementById(id),tick:()=>new Promise(resolve=>w.queueMicrotask(resolve)),tab(shift=false){d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',shiftKey:shift,bubbles:true,cancelable:true}));}};
}
test('opening focuses the dialog without invoking the mobile keyboard; closing restores opener',async()=>{
  const f=fixture();try{
    f.el('opener').focus();f.el('lower').classList.remove('hidden');await f.tick();
    assert.equal(f.d.activeElement.id,'lower');
    f.el('lower').classList.add('hidden');await f.tick();assert.equal(f.d.activeElement.id,'opener');
  }finally{f.w.dispatchEvent(new f.w.Event('pagehide'));f.dom.window.close();}
});
test('Tab and Shift+Tab stay inside the highest dialog and skip disabled/hidden controls',async()=>{
  const f=fixture();try{
    f.el('lower').classList.remove('hidden');await f.tick();
    f.tab();assert.equal(f.d.activeElement.id,'first');
    f.tab(true);assert.equal(f.d.activeElement.id,'last');
    f.tab();assert.equal(f.d.activeElement.id,'first');
    f.el('upper').classList.remove('hidden');await f.tick();
    f.tab(true);assert.equal(f.d.activeElement.id,'u2');
    f.tab();assert.equal(f.d.activeElement.id,'u1');
    f.el('upper').classList.add('hidden');await f.tick();assert.equal(f.d.activeElement.id,'first');
  }finally{f.w.dispatchEvent(new f.w.Event('pagehide'));f.dom.window.close();}
});
test('dialog with no enabled controls keeps focus and Escape remains with the business flow',async()=>{
  const f=fixture();try{
    f.el('upper').querySelectorAll('button').forEach(el=>el.disabled=true);
    f.el('upper').classList.remove('hidden');await f.tick();f.tab();assert.equal(f.d.activeElement.id,'upper');
    const escape=new f.w.KeyboardEvent('keydown',{key:'Escape',cancelable:true});f.d.dispatchEvent(escape);assert.equal(escape.defaultPrevented,false);
  }finally{f.w.dispatchEvent(new f.w.Event('pagehide'));f.dom.window.close();}
});
test('all interactive app pages load the helper and deny object and base URL injection in CSP',()=>{
  for(const surface of ['member','points','event','calendar','admin','booking']){
    const file=path.join(root,surface,'index.html');const dom=new JSDOM(fs.readFileSync(file,'utf8'));try{
      const d=dom.window.document;
      const script=d.querySelector('script[src*="dialog-accessibility.js"]');assert.ok(script,surface);
      assert.ok(fs.existsSync(path.resolve(path.dirname(file),script.src.split('?')[0])));
      const csp=d.querySelector('[http-equiv="Content-Security-Policy"]').content;
      assert.match(csp,/base-uri 'none'/);assert.match(csp,/object-src 'none'/);
      const directives=Object.fromEntries(csp.split(';').map(part=>part.trim()).filter(Boolean).map(part=>{const [name,...values]=part.split(/\s+/);return [name,values.join(' ')];}));
      assert.doesNotMatch(directives['script-src']||'',/unsafe-eval|unsafe-inline/);
      assert.doesNotMatch(directives['style-src']||'',/unsafe-inline/);
      assert.doesNotMatch(directives['style-src-elem']||'',/unsafe-inline/);
      if(surface==='admin'||surface==='booking') assert.match(directives['style-src-attr']||'',/'unsafe-inline'/);
      else assert.doesNotMatch(directives['style-src-attr']||'',/unsafe-inline/);
      assert.ok(d.querySelector('meta[name="viewport"]').content.includes('width=device-width'));
    }finally{dom.window.close();}
  }
});
