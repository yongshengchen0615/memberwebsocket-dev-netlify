(() => {
  'use strict';

  // GPS only runs while an explicit redemption/location-confirmation dialog is active.
  // Raw coordinates remain in memory and are sent only with a redemption request.
  const MAX_ACCURACY_METERS = 100;
  const MAX_FIX_AGE_MS = 20000;
  const GEO_OPTIONS = Object.freeze({ enableHighAccuracy: true, maximumAge: 0, timeout: 12000 });
  const reverseCache = new Map();
  let lastReverseAt = 0;

  function snapshot(position) {
    const latitude = Number(position?.coords?.latitude);
    const longitude = Number(position?.coords?.longitude);
    const accuracy = Number(position?.coords?.accuracy);
    const timestamp = Number(position?.timestamp);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
        !Number.isFinite(accuracy) || accuracy <= 0 || !Number.isFinite(timestamp)) return null;
    return { latitude, longitude, accuracy, observedAt: new Date(timestamp).toISOString() };
  }

  function isFresh(fix) {
    const age = Date.now() - Date.parse(fix?.observedAt || '');
    return Boolean(fix && Number.isFinite(age) && age >= -30000 &&
      age <= MAX_FIX_AGE_MS && fix.accuracy <= MAX_ACCURACY_METERS);
  }

  function errorMessage(error) {
    if (error?.code === 1) return '定位遭拒，請在瀏覽器設定中允許 GPS 位置權限。';
    if (error?.code === 3) return 'GPS 定位逾時，請移到較空曠處再試。';
    return '目前無法取得 GPS 位置，請確認網路與裝置定位設定。';
  }

  function distanceMeters(a, b) {
    if (!a || !b) return Infinity;
    const dLat = (Number(b.latitude) - Number(a.latitude)) * Math.PI / 180;
    const dLng = (Number(b.longitude) - Number(a.longitude)) * Math.PI / 180;
    const lat1 = Number(a.latitude) * Math.PI / 180;
    const lat2 = Number(b.latitude) * Math.PI / 180;
    return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(
      Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
    )));
  }

  // This is only a UI preview; the server repeats the location authorization
  // with the current database rule and the submitted fresh GPS position.
  function evaluate(fix, locations) {
    if (!Array.isArray(locations) || !locations.length ||
        !locations.every((location) => location && String(location.name || '').trim() &&
          Number.isFinite(Number(location.latitude)) && Math.abs(Number(location.latitude)) <= 90 &&
          Number.isFinite(Number(location.longitude)) && Math.abs(Number(location.longitude)) <= 180 &&
          Number.isInteger(Number(location.radiusMeters)) &&
          Number(location.radiusMeters) >= 50 && Number(location.radiusMeters) <= 2000)) {
      return { allowed: false, reason: 'missing', matched: null };
    }
    if (!isFresh(fix)) return { allowed: false, reason: 'waiting', matched: null };
    const matched = locations.find((location) =>
      distanceMeters(fix, location) + fix.accuracy <= Number(location.radiusMeters)
    );
    return { allowed: Boolean(matched), reason: matched ? 'inside' : 'outside', matched: matched || null };
  }

  function allowedLocationLabel(locations) {
    return Array.isArray(locations) && locations.length
      ? locations.map((item) =>
        `「${String(item.name || '未命名地點')}」（${Number(item.radiusMeters)} 公尺內）`).join('、')
      : '尚未取得管理端的可使用地點';
  }

  function create({ onUpdate, onError } = {}) {
    let watchId = null;
    let latest = null;
    const waiters = new Set();

    function notifyError(error) {
      const message = errorMessage(error);
      // Pass the original browser error as an optional second argument so
      // admin location pickers can recover from POSITION_UNAVAILABLE (code 2).
      if (typeof onError === 'function') onError(message, error);
      if (error?.code === 1) {
        // A denied watch does not resume after the user grants permission.
        // Discard it so the next user attempt starts a fresh browser watch.
        if (watchId !== null) {
          navigator.geolocation.clearWatch(watchId);
          watchId = null;
        }
        latest = null;
        for (const waiter of [...waiters]) waiter.reject(new Error(message));
      }
    }

    function start() {
      if (watchId !== null) return;
      if (!window.isSecureContext || !navigator.geolocation?.watchPosition) {
        throw new Error('此頁面或裝置不支援 HTTPS GPS 即時定位。');
      }
      watchId = navigator.geolocation.watchPosition((position) => {
        const fix = snapshot(position);
        if (!fix) return notifyError({ code: 2 });
        latest = fix;
        if (typeof onUpdate === 'function') onUpdate(fix, isFresh(fix));
        if (!isFresh(fix)) return;
        for (const waiter of [...waiters]) waiter.resolve(fix);
      }, notifyError, GEO_OPTIONS);
    }

    function read(timeoutMs = 12000) {
      try { start(); } catch (error) { return Promise.reject(error); }
      if (isFresh(latest)) return Promise.resolve({ ...latest });
      return new Promise((resolve, reject) => {
        const waiter = {
          timer: null,
          resolve(fix) {
            window.clearTimeout(this.timer);
            waiters.delete(this);
            resolve({ ...fix });
          },
          reject(error) {
            window.clearTimeout(this.timer);
            waiters.delete(this);
            reject(error);
          }
        };
        waiter.timer = window.setTimeout(() => waiter.reject(new Error(
          '尚未取得精度 100 公尺內的即時 GPS，請稍後再確認。'
        )), timeoutMs);
        waiters.add(waiter);
      });
    }

    function stop() {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
      latest = null;
      for (const waiter of [...waiters]) waiter.reject(new Error('已停止 GPS 定位。'));
    }

    return Object.freeze({ start, read, stop, latest: () => latest && { ...latest }, active: () => watchId !== null });
  }

  // Reverse geocoding is an optional, one-off USER-initiated confirmation only.
  // Never poll the public Nominatim API on GPS movement.
  async function placeName(fix) {
    if (!isFresh(fix)) throw new Error('請先取得最新 GPS 定位。');
    const key = [fix.latitude.toFixed(4), fix.longitude.toFixed(4)].join(',');
    if (reverseCache.has(key)) return reverseCache.get(key);
    const waitMs = Math.max(0, 1100 - (Date.now() - lastReverseAt));
    if (waitMs) await new Promise((resolve) => window.setTimeout(resolve, waitMs));
    lastReverseAt = Date.now();
    const params = new URLSearchParams({
      format: 'jsonv2', lat: String(fix.latitude), lon: String(fix.longitude),
      zoom: '18', addressdetails: '1', 'accept-language': 'zh-TW'
    });
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch('https://nominatim.openstreetmap.org/reverse?' + params, {
        headers: { Accept: 'application/json' },
        referrerPolicy: 'strict-origin-when-cross-origin',
        signal: controller.signal,
        cache: 'no-store'
      });
      if (!response.ok) throw new Error('地點名稱查詢暫時無法使用。');
      const data = await response.json();
      const label = String(data?.display_name || '').trim().slice(0, 140);
      if (!label) throw new Error('附近尚無可辨識的地點名稱。');
      reverseCache.set(key, label);
      if (reverseCache.size > 15) reverseCache.delete(reverseCache.keys().next().value);
      return label;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  window.TicketLiveLocation = Object.freeze({
    create, placeName, distanceMeters, isFresh, evaluate, allowedLocationLabel, MAX_ACCURACY_METERS
  });
})();
