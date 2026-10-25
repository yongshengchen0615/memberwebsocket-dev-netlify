(() => {
  'use strict';
  // Keep the productized merchant workflow on /admin/ instead of navigating to
  // /admin/workspace.html. This is presentation only; platform-api + SQL own grants.
  async function mount() {
    const host=document.getElementById('productizedAdmin');
    const legacy=document.getElementById('app');
    if(!host||!legacy)throw new Error('管理端頁面缺少必要的登入容器。');
    const response=await fetch('./workspace.html',{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('無法載入管理端功能設定，請重新整理。');
    const parsed=new DOMParser().parseFromString(await response.text(),'text/html');
    const source=parsed.querySelector('main.shell');
    if(!source||!source.querySelector('#applicationWorkspace')||!source.querySelector('#merchantFeatureNav')||!source.querySelector('#merchantLineForm'))
      throw new Error('管理端功能設定版本不相容，請重新整理。');
    // Only import body nodes from the known same-origin static application page.
    host.replaceChildren(...Array.from(source.children,node=>document.importNode(node,true)));
    const heading=host.querySelector('header.topbar h1');
    if(heading)heading.textContent='管理端｜Lumen Club';
    const subtitle=host.querySelector('header.topbar p:last-child');
    if(subtitle)subtitle.textContent='管理功能與 LINE 設定各自獨立；僅已核准的功能可設定 LINE。';
    const nav=host.querySelector('#merchantFeatureNav');
    nav.setAttribute('aria-label','總管理員已核准功能的 LINE 設定');
    document.documentElement.dataset.workspace='merchant';
    const link=document.createElement('link');
    link.rel='stylesheet';link.href='../platform/platform.css?v=merchant-v2-20261024-1';
    document.head.append(link);
    try {
      await new Promise((resolve,reject)=>{
        const script=document.createElement('script');
        script.src='../platform/app.js?v=merchant-v2-20261024-1';
        script.onload=resolve;script.onerror=()=>reject(new Error('管理端功能初始化失敗，請重新整理。'));
        document.head.append(script);
      });
      legacy.hidden=true;
      host.hidden=false;
      document.documentElement.dataset.productizedAdmin='true';
      document.dispatchEvent(new Event('productized-admin-ready'));
    }catch(error){
      host.hidden=true;legacy.hidden=false;
      delete document.documentElement.dataset.workspace;
      throw error;
    }
  }
  Object.defineProperty(window,'ProductizedAdminShell',{
    value:Object.freeze({mount}),configurable:false,writable:false
  });
})();
