(() => {
 'use strict';
 const button=document.getElementById('themeToggleButton');
 if(!button)return;
 button.addEventListener('click',()=>{
  const theme=window.LumenTheme;
  if(!theme)return;
  theme.set(theme.get()==='dark'?'light':'dark');
 });
})();
