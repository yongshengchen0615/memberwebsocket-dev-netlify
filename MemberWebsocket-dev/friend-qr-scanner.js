(() => {
  'use strict';
  // Frames and uploaded images stay in this browser. Decoding never navigates or writes.
  function parseInvitation(raw) {
    let code = String(raw || '').trim();
    if (!code || code.length > 2048) throw new Error('請輸入會員編號或好友分享連結。');
    if (/^https?:\/\//i.test(code)) {
      const url = new URL(code), member = new URL('../member/', location.href);
      if (url.origin !== member.origin || url.username || url.password ||
          ![member.pathname, member.pathname + 'index.html'].includes(url.pathname)) {
        throw new Error('這不是本站的好友邀請 QR Code 或連結。');
      }
      const hash = new URLSearchParams(url.hash.slice(1));
      code = hash.get('friend') || '';
    }
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(code)) throw new Error('無法辨識好友內容，請使用好友 QR Code 或會員編號。');
    return code.toUpperCase();
  }

  function create(video, { onResult, onStatus, parseValue = parseInvitation, label = '好友' }) {
    let generation = 0, stream = null, timer = null, active = false;
    const canvas = document.createElement('canvas');
    const stop = () => {
      generation++; active = false; clearTimeout(timer); timer = null;
      if (stream) stream.getTracks().forEach(track => track.stop());
      stream = null; video.srcObject = null;
    };
    function decode(image, width, height, maximum = 960) {
      const ratio = Math.min(1, maximum / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context || typeof window.FriendQRDecode !== 'function') throw new Error(`掃描元件未載入，請重新整理或直接貼上${label}連結。`);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      return window.FriendQRDecode(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })?.data || '';
    }
    function accept(raw) {
      const value = parseValue(raw);
      stop(); onResult(value);
    }
    function scan(current) {
      if (!active || current !== generation) return;
      try {
        if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
          const value = decode(video, video.videoWidth, video.videoHeight, 640);
          if (value) { accept(value); return; }
        }
      } catch (error) {
        stop(); onStatus(error.message); return;
      }
      timer = setTimeout(() => scan(current), 180);
    }
    async function start() {
      stop(); const current = generation; active = true;
      if (!navigator.mediaDevices?.getUserMedia) {
        stop(); onStatus(`此瀏覽器無法開啟相機，請使用 QR 圖片、貼上${label}連結或輸入會員編號。`); return;
      }
      onStatus(`請允許使用相機，將${label} QR Code 對準鏡頭。`);
      try {
        const granted = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (!active || current !== generation || document.hidden) { granted.getTracks().forEach(track => track.stop()); return; }
        stream = granted; video.srcObject = stream; await video.play();
        if (!active || current !== generation) return;
        onStatus(`正在掃描，請將${label} QR Code 放在畫面中央。`); scan(current);
      } catch (error) {
        if (current !== generation) return;
        stop(); onStatus(error.name === 'NotAllowedError'
          ? `相機權限未開啟，請允許相機或改用 QR 圖片／貼上${label}連結。`
          : '無法啟動相機，請關閉其他相機程式，或改用 QR 圖片／會員編號。');
      }
    }
    async function readFile(file) {
      stop(); const current = generation;
      if (!file) return;
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
        onStatus('請選擇 10 MB 以內的 PNG、JPEG 或 WebP QR 圖片。'); return;
      }
      let bitmap;
      try {
        if (typeof window.createImageBitmap === 'function') bitmap = await window.createImageBitmap(file);
        else bitmap = await new Promise((resolve, reject) => {
          const url = URL.createObjectURL(file), image = new Image();
          image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
          image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('無法讀取 QR 圖片，請重新選擇。')); };
          image.src = url;
        });
        if (current !== generation || document.hidden) return;
        if (bitmap.width * bitmap.height > 40_000_000) throw new Error('圖片尺寸過大，請裁切 QR Code 後再試。');
        const value = decode(bitmap, bitmap.width, bitmap.height, 1280);
        if (!value) throw new Error('圖片中未找到 QR Code，請使用清晰、完整的 QR 圖片。');
        accept(value);
      } catch (error) {
        if (current === generation) onStatus(error.message || '無法讀取 QR 圖片，請重新選擇。');
      } finally { bitmap?.close?.(); }
    }
    return { start, stop, readFile };
  }
  window.FriendQRScanner = { parseInvitation, create };
})();
