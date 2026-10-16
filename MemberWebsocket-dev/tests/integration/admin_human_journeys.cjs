// Execute the Chromium journeys against production DOM handlers as an additional
// integration lane. This is NOT browser evidence; CI still runs the actual
// Playwright spec (layout, native actionability, CSP, screenshots and traces).
const {test:nodeTest}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM,ResourceLoader,VirtualConsole}=require('jsdom');
const {createRequire}=require('node:module');
const spec=path.resolve(__dirname,'../browser/admin-human.spec.cjs');
const pause=()=>new Promise(r=>setTimeout(r,20));
async function eventually(fn){let error;for(let n=0;n<150;n++){try{return await fn();}catch(e){error=e;await pause();}}throw error;}
function visible(el){for(let n=el;n&&n.nodeType===1;n=n.parentElement){if(n.hidden||n.classList.contains('hidden')||n.style.display==='none')return false;}return !!el;}
function disabled(el){return Boolean(el?.matches(':disabled'));}
class Locator {
  constructor(page,query){this.page=page;this.query=query;}
  nodes(){return this.query();}
  one(){const rows=this.nodes();assert.equal(rows.length,1,'Unique locator expected, found '+rows.length);return rows[0];}
  locator(selector){return new Locator(this.page,()=>this.nodes().flatMap(n=>[...n.querySelectorAll(selector)]));}
  first(){return this.nth(0);} nth(i){return new Locator(this.page,()=>this.nodes().slice(i,i+1));}
  filter({hasText}){return new Locator(this.page,()=>this.nodes().filter(n=>typeof hasText==='string'?n.textContent.includes(hasText):hasText.test(n.textContent)));}
  getByRole(role,options={}){return this.locator(role==='button'?'button':role).filter({hasText:options.name||''});}
  async click(){await eventually(()=>{const n=this.one();if(process.env.ADMIN_JOURNEY_DEBUG)console.log('click',n.id,n.textContent.slice(0,60));assert.ok(visible(n),'Control is hidden');assert.ok(!n.disabled,'Control is disabled');n.click();});await pause();}
  async fill(value){await eventually(()=>{const n=this.one();assert.ok(visible(n),'Input is hidden');assert.ok(!n.disabled,'Input is disabled');n.value=value;n.dispatchEvent(new this.page.dom.window.Event('input',{bubbles:true}));n.dispatchEvent(new this.page.dom.window.Event('change',{bubbles:true}));});await pause();}
  async selectOption(value){const n=await eventually(()=>{const n=this.one();assert.ok(!disabled(n));assert.ok([...n.options].some(o=>o.value===value),'Option missing '+value);return n;});n.value=value;n.dispatchEvent(new this.page.dom.window.Event('change',{bubbles:true}));await pause();}
  async check(){if(!await eventually(()=>this.one().checked))await this.click();}async uncheck(){if(await eventually(()=>this.one().checked))await this.click();}
  async dragTo(target){const w=this.page.dom.window,from=this.one(),to=target.one();const prior=w.document.elementFromPoint;w.document.elementFromPoint=()=>to;try{for(const [type,x,y]of [['pointerdown',1,1],['pointermove',20,20],['pointerup',20,20]]){const e=new w.MouseEvent(type,{bubbles:true,clientX:x,clientY:y,button:0,cancelable:true});Object.defineProperties(e,{pointerId:{value:1},pointerType:{value:'mouse'}});from.dispatchEvent(e);}await pause();}finally{w.document.elementFromPoint=prior;}}
  async inputValue(){return eventually(()=>this.one().value);}async textContent(){return eventually(()=>this.one().textContent);}
  async count(){return this.nodes().length;}
  async evaluate(fn,arg){return this.page.dom.window.eval('('+fn.toString()+')')(this.one(),arg);}
  async getAttribute(key){return eventually(()=>this.one().getAttribute(key));}
}
class Page {
  constructor(){this.routes=[];this.listeners={};this.keyboard={press:async key=>{const w=this.dom.window;w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));await pause();}};}
  on(event,fn){this.listeners[event]=fn;}
  removeAllListeners(event){delete this.listeners[event];}
  async route(pattern,fn){this.routes.push([pattern,fn]);}
  locator(selector){return new Locator(this,()=>[...this.dom.window.document.querySelectorAll(selector)]);}
  getByRole(role,options={}){return this.locator(role==='button'?'button':role).filter({hasText:options.name||''});}
  async evaluate(source,arg){return typeof source==='string'?this.dom.window.eval(source):this.dom.window.eval('('+source.toString()+')')(arg);}
  async reload(){return this.goto(this.url);}
  async goto(url){
    await this.close();this.url=url;const page=this;const run=new URL(url).searchParams.get('run');
    const matches=(pattern,url)=>typeof pattern==='string'?url.startsWith(pattern.replace('**','')):pattern.test(url);
    const request=async(url,init={})=>{
      page.pending=(page.pending||0)+1;try {
      url=new URL(url,page.url).href;const route=page.routes.find(([pattern])=>matches(pattern,url));
      if(route){let result;await route[1]({request:()=>({url:()=>url,postDataJSON:()=>JSON.parse(init.body)}),fulfill:async opt=>{result=new Response(opt.json?JSON.stringify(opt.json):opt.body,{status:opt.status||200,headers:{'Content-Type':opt.contentType||'application/json'}});},abort:async()=>{result=new Response('',{status:503});}});return result;}
      return await fetch(url,{...init,headers:{...init.headers,Cookie:'qa='+run}});
      }finally{page.pending--;}
    };
    class LocalLoader extends ResourceLoader {fetch(url){if(!url.startsWith(new URL(page.url).origin))return null;return super.fetch(url);}}
    const html=await (await request(url)).text();const console=new VirtualConsole();
    console.on('jsdomError',e=>{if(!/Not implemented: (navigation|HTMLFormElement.prototype.requestSubmit|HTMLCanvasElement.prototype.getContext|window.alert|window.scrollTo)/.test(e.message))page.listeners.pageerror?.(e);});
    this.dom=new JSDOM(html,{url,runScripts:'dangerously',resources:new LocalLoader(),pretendToBeVisual:true,virtualConsole:console,beforeParse(w){
      w.__observers=[];const Observer=w.MutationObserver;w.MutationObserver=class extends Observer{constructor(callback){super(callback);w.__observers.push(this);}};
      w.fetch=request;w.Request=Request;w.Response=Response;w.AbortController=AbortController;
      w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
      w.HTMLElement.prototype.scrollIntoView=function(){};
      // JSDOM supplies no layout; model visibility only, with Chromium testing real geometry.
      w.HTMLElement.prototype.getClientRects=function(){return visible(this)?[{}]:[];};
      const dialog=(type,message)=>{let value=type==='prompt'?null:false;page.listeners.dialog?.({type:()=>type,message:()=>message,accept:input=>{value=type==='prompt'?(input||''):true;},dismiss:()=>{value=type==='prompt'?null:false;}});return value;};
      w.confirm=message=>dialog('confirm',message);w.prompt=message=>dialog('prompt',message);w.alert=message=>dialog('alert',message);w.isSecureContext=true;let clipboard='';w.navigator.clipboard={writeText:async text=>{clipboard=text;},readText:async()=>clipboard};
      w.CSS={escape:value=>String(value).replace(/[^a-zA-Z0-9_-]/g,c=>'\\'+c)};
      w.addEventListener('error',e=>page.listeners.pageerror?.({message:e.message}));
    }});
    await new Promise(resolve=>this.dom.window.addEventListener('load',resolve,{once:true}));await pause();
  }
  async close(){if(!this.dom)return;for(let n=0;n<20;n++){await pause();if(!this.pending){await pause();if(!this.pending)break;}}for(const observer of this.dom.window.__observers||[])observer.disconnect();this.dom.window.close();this.dom=null;}
}
function expectation(value,negate=false,poll=false,context=""){
  const check=fn=>poll||value instanceof Locator?eventually(async()=>fn(poll?await value():value)):fn(value);
  const truth=(ok,message)=>assert.equal(Boolean(ok),!negate,message+(context?' '+context:''));
  return {get not(){return expectation(value,!negate,poll);},
    toEqual:expected=>check(v=>negate?assert.notDeepEqual(v,expected):assert.deepEqual(v,expected)),
    toBe:expected=>check(v=>truth(v===expected,`${v} expected ${expected}`)),
    toBeGreaterThan:expected=>check(v=>truth(v>expected,`${v} > ${expected}`)),
    toContain:expected=>check(v=>truth(v.includes(expected),'Contains '+expected)),
    toHaveLength:expected=>check(v=>truth(v.length===expected,`${v.length} length ${expected}`)),
    toMatchObject:expected=>check(v=>{for(const [k,x]of Object.entries(expected))assert.deepEqual(v[k],x);}),
    toBeVisible:()=>check(v=>truth(visible(v.nodes()[0]),'Visibility')),
    toBeHidden:()=>check(v=>truth(!visible(v.nodes()[0]),'Hidden')),
    toBeDisabled:()=>check(v=>truth(disabled(v.one()),'Disabled')),
    toBeChecked:()=>check(v=>truth(v.one().checked,'Checked')),
    toBeEnabled:()=>check(v=>truth(!disabled(v.one()),'Enabled')),
    toHaveCount:n=>check(v=>truth(v.nodes().length===n,`Count ${v.nodes().length} expected ${n}`)),
    toHaveText:s=>check(v=>truth(typeof s==='string'?v.one().textContent.trim()===s:s.test(v.one().textContent),`Text ${v.one().textContent} expected ${s}`)),
    toContainText:s=>check(v=>truth(typeof s==='string'?v.one().textContent.includes(s):s.test(v.one().textContent),`Text ${v.one().textContent} expected ${s}`)),
    toHaveValue:s=>check(v=>truth(v.one().value===s,`Value ${v.one().value} expected ${s}`)),
    toHaveAttribute:(k,s)=>check(v=>truth(v.one().getAttribute(k)===s,`Attribute ${k}`)),
  };
}
const expect=(v,message)=>expectation(v,false,false,message);expect.poll=fn=>expectation(fn,false,true);
const cases=[],before=[],after=[],beforeEach=[],afterEach=[];
const test=(title,fn)=>cases.push({title,fn});
Object.assign(test,{beforeAll:fn=>before.push(fn),afterAll:fn=>after.push(fn),beforeEach:fn=>beforeEach.push(fn),afterEach:fn=>afterEach.push(fn)});
const req=createRequire(spec);
const wrapped=vm.runInThisContext('(function(require,module,exports,__dirname){'+fs.readFileSync(spec,'utf8')+'\n})',{filename:spec});
wrapped(name=>name==='playwright/test'?{test,expect}:req(name),{exports:{}},{},path.dirname(spec));
nodeTest('admin human journeys — DOM integration, not Chromium evidence',async t=>{
  for(const fn of before)await fn();
  try {
    for(const [index,row]of cases.entries()){
      if(process.env.ADMIN_JOURNEY_FILTER&&!new RegExp(process.env.ADMIN_JOURNEY_FILTER).test(row.title))continue;
      await t.test(row.title,async()=>{
        const page=new Page();const info={testId:'dom-'+index,attach:async()=>{},setTimeout(){}};
        try{for(const fn of beforeEach)await fn({page},info);await row.fn({page},info);for(const fn of afterEach)await fn({page},info);}
        catch(e){console.error(row.title,e.message,info.browserErrors,info.fixture?.unexpected, page.dom?.window.document.getElementById('errorMessage')?.textContent);throw e;}finally{await page.close();}
      });
    }
  }finally{for(const fn of after)await fn();}
});
