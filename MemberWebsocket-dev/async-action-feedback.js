/* Explicit user actions only: background sync must not open request feedback. */
(() => {
 'use strict';
 const active = new Map();
 const banner = document.createElement('div');
 banner.className = 'async-action-feedback';
 banner.setAttribute('role','status');
 banner.setAttribute('aria-live','polite');
 banner.setAttribute('aria-atomic','true');
 banner.hidden = true;
 const spinner = document.createElement('span');
 spinner.className = 'async-action-feedback-spinner';
 spinner.setAttribute('aria-hidden','true');
 const label = document.createElement('span');
 label.className = 'async-action-feedback-label';
 banner.append(spinner,label);
 document.body.append(banner);
 function render() {
   banner.hidden = active.size === 0;
   label.textContent = active.size ? Array.from(active.values()).at(-1) : '';
 }
 function begin(message = '正在更新資料…') {
   const key = Symbol('async-action');
   active.set(key,String(message));
   render();
   let finished = false;
   return () => {
     if (finished) return;
     finished = true;
     active.delete(key);
     render();
   };
 }
 async function track(message,operation) {
   const finish = begin(message);
   try { return await operation(); }
   finally { finish(); }
 }
 window.AsyncActionFeedback = Object.freeze({begin,track});
})();
