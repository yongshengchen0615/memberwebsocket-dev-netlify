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
    // The shared theme controller first mounts in the legacy account menu.
    // Move its existing, event-bound button into the visible merchant shell;
    // importing HTML alone does not re-run theme.js or register its listener.
    const themeToggle=document.getElementById('themeToggleButton');
    // Only import body nodes from the known same-origin static application page.
    host.replaceChildren(...Array.from(source.children,node=>document.importNode(node,true)));
    const appearance=host.querySelector('.platform-appearance.account-menu');
    if(themeToggle&&appearance)appearance.appendChild(themeToggle);
    const heading=host.querySelector('header.topbar h1');
    if(heading)heading.textContent='管理端｜Lumen Club';
    const subtitle=host.querySelector('header.topbar p:last-child');
    if(subtitle)subtitle.textContent='管理功能與 LINE 設定各自獨立；僅已核准的功能可設定 LINE。';
    const nav=host.querySelector('#merchantFeatureNav');
    nav.setAttribute('aria-label','總管理員已核准功能的 LINE 設定');
    document.documentElement.dataset.workspace='merchant';
    const link=document.createElement('link');
    link.rel='stylesheet';link.href='../platform/platform.css?v=merchant-expiry-readonly-20261101-1';
    document.head.append(link);
    try {
      // /admin/ mounts only workspace body nodes; deferred scripts from workspace.html
      // do NOT execute when imported. Load the period helper before platform/app.js.
      const loadScript=(src)=>new Promise((resolve,reject)=>{
        const script=document.createElement('script');
        script.src=src;script.onload=resolve;
        script.onerror=()=>reject(new Error('管理端功能初始化失敗，請重新整理。'));
        document.head.append(script);
      });
      if(!window.PlatformExpiryTerm)await loadScript('../platform/expiry-term.js?v=expiry-term-20261101-1');
      await loadScript('../platform/app.js?v=merchant-expiry-readonly-20261101-1');
      legacy.hidden=true;
      host.hidden=false;
      document.documentElement.dataset.productizedAdmin='true';
      document.dispatchEvent(new Event('productized-admin-ready'));
    }catch(error){
      // Preserve the same working control if the productized shell falls back.
      const legacyMenu=legacy.querySelector('.account-menu');
      if(themeToggle&&legacyMenu&&!legacyMenu.contains(themeToggle)){
        const logout=legacyMenu.querySelector('#logoutButton');
        if(logout)legacyMenu.insertBefore(themeToggle,logout);
        else legacyMenu.appendChild(themeToggle);
      }
      host.hidden=true;legacy.hidden=false;
      delete document.documentElement.dataset.workspace;
      throw error;
    }
  }
  Object.defineProperty(window,'ProductizedAdminShell',{
    value:Object.freeze({mount}),configurable:false,writable:false
  });
})();
