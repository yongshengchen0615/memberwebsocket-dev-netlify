(() => {
  'use strict';

  const MAX_LOCATIONS = 20;
  const MIN_RADIUS_METERS = 50;
  const MAX_RADIUS_METERS = 2000;
  const DEFAULT_RADIUS_METERS = 100;
  const DEFAULT_CENTER = [23.69781, 120.960515];
  const DEFAULT_ZOOM = 7;
  const DETAIL_ZOOM = 16;
  const SEARCH_MIN_INTERVAL_MS = 1000;

  function normalizeRadius(value) {
    const radius = Number(value);
    return Number.isInteger(radius) && radius >= MIN_RADIUS_METERS && radius <= MAX_RADIUS_METERS
      ? radius
      : DEFAULT_RADIUS_METERS;
  }

  function normalizeLocation(raw, fallbackName = '') {
    const latitude = Number(raw?.latitude);
    const longitude = Number(raw?.longitude);
    return {
      name: String(raw?.name || fallbackName || '').trim().slice(0, 100),
      latitude: Number.isFinite(latitude) ? latitude : 0,
      longitude: Number.isFinite(longitude) ? longitude : 0,
      radiusMeters: normalizeRadius(raw?.radiusMeters),
    };
  }

  function createEditor(config) {
    let locations = [];
    let map = null;
    let markers = [];
    let circles = [];
    let draft = null;
    let draftMarker = null;
    let draftCircle = null;
    let editingIndex = null;
    let initialized = false;
    let searchBusy = false;
    let lastSearchAt = 0;
    let lastGeocoderRequestAt = 0;
    let searchController = null;
    let gpsTracker = null;
    let gpsPlaceName = '';
    let gpsNameFix = null;
    let gpsGeneration = 0;
    let gpsFallbackPending = false;
    const geocodeCache = new Map();

    const byId = (id) => document.getElementById(id);
    const checkbox = () => byId(config.checkboxId);
    const controls = () => byId(config.controlsId);
    const rows = () => byId(config.rowsId);
    const count = () => byId(config.countId);
    const status = () => byId(config.statusId);
    const mapElement = () => byId(config.mapId);
    const searchInput = () => byId(config.searchInputId);
    const searchButton = () => byId(config.searchButtonId);
    const searchResults = () => byId(config.searchResultsId);
    const draftPanel = () => byId(config.draftPanelId);
    const draftName = () => byId(config.draftNameId);
    const draftRadius = () => byId(config.draftRadiusId);
    const confirmButton = () => byId(config.addButtonId);

    function setStatus(message, isError = false) {
      const element = status();
      if (!element) return;
      element.textContent = message;
      element.classList.toggle('warning', Boolean(isError));
    }

    function validCoordinate(latitude, longitude) {
      return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
        && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
    }

    function validRadius(radiusMeters) {
      return Number.isInteger(radiusMeters)
        && radiusMeters >= MIN_RADIUS_METERS
        && radiusMeters <= MAX_RADIUS_METERS;
    }

    function removeLayer(layer) {
      try { layer?.remove?.(); } catch {}
    }

    function clearDraftOverlay() {
      removeLayer(draftMarker);
      removeLayer(draftCircle);
      draftMarker = null;
      draftCircle = null;
    }

    function renderDraftOverlay() {
      clearDraftOverlay();
      if (!map || !draft || !validCoordinate(draft.latitude, draft.longitude) || typeof window.L === 'undefined') return;

      if (typeof window.L.circle === 'function' && validRadius(draft.radiusMeters)) {
        draftCircle = window.L.circle([draft.latitude, draft.longitude], {
          radius: draft.radiusMeters,
          weight: 2,
          fillOpacity: 0.12,
        }).addTo(map);
      }

      if (typeof window.L.marker === 'function') {
        draftMarker = window.L.marker([draft.latitude, draft.longitude], { draggable: true }).addTo(map);
        draftMarker.bindTooltip(editingIndex == null ? '待新增位置' : '待套用位置');
        draftMarker.on('dragend', (event) => {
          const latlng = event?.target?.getLatLng?.();
          if (!latlng || !draft) return;
          draft.latitude = Number(latlng.lat);
          draft.longitude = Number(latlng.lng);
          draftCircle?.setLatLng?.([draft.latitude, draft.longitude]);
          setStatus('位置已調整；確認半徑範圍後再套用。');
        });
      }
    }

    function renderMapLayers() {
      if (!map || typeof window.L === 'undefined') return;
      markers.forEach(removeLayer);
      circles.forEach(removeLayer);
      markers = [];
      circles = [];

      locations.forEach((location, index) => {
        if (!validCoordinate(location.latitude, location.longitude)) return;
        if (typeof window.L.circle === 'function' && validRadius(location.radiusMeters)) {
          const circle = window.L.circle([location.latitude, location.longitude], {
            radius: location.radiusMeters,
            weight: 2,
            fillOpacity: 0.08,
          }).addTo(map);
          circles.push(circle);
        }
        if (typeof window.L.marker === 'function') {
          const marker = window.L.marker([location.latitude, location.longitude]).addTo(map);
          marker.bindTooltip(`${location.name || `地點 ${index + 1}`} · ${location.radiusMeters} 公尺`);
          marker.on('click', () => {
            map.setView([location.latitude, location.longitude], DETAIL_ZOOM);
            rows()?.children[index]?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
          });
          markers.push(marker);
        }
      });
      renderDraftOverlay();
    }

    function createMap() {
      if (map || !mapElement() || typeof window.L === 'undefined') return;
      map = window.L.map(mapElement(), { scrollWheelZoom: true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map);
      map.on('click', (event) => {
        if (locations.length >= MAX_LOCATIONS && editingIndex == null) {
          return setStatus(`最多只能設定 ${MAX_LOCATIONS} 個使用地點。`, true);
        }
        setDraft(event.latlng.lat, event.latlng.lng, `使用地點 ${locations.length + 1}`);
      });
      renderMapLayers();
    }

    function field(labelText, type, value, options = {}) {
      const label = document.createElement('label');
      const span = document.createElement('span');
      span.textContent = labelText;
      const input = document.createElement('input');
      input.type = type;
      input.value = String(value ?? '');
      if (options.min != null) input.min = String(options.min);
      if (options.max != null) input.max = String(options.max);
      if (options.step != null) input.step = String(options.step);
      if (options.maxLength != null) input.maxLength = Number(options.maxLength);
      label.append(span, input);
      return { label, input };
    }

    function render() {
      const container = rows();
      if (!container) return;
      container.replaceChildren(...locations.map((location, index) => {
        const row = document.createElement('article');
        row.className = 'coupon-location-row';

        const title = document.createElement('strong');
        title.textContent = `地點 ${index + 1}`;
        const name = field('地點名稱', 'text', location.name, { maxLength: 100 });
        const radius = field('核銷半徑（公尺）', 'number', location.radiusMeters, {
          min: MIN_RADIUS_METERS,
          max: MAX_RADIUS_METERS,
          step: 10,
        });

        name.input.addEventListener('input', () => {
          locations[index].name = name.input.value.trim().slice(0, 100);
          renderMapLayers();
        });
        radius.input.addEventListener('input', () => {
          locations[index].radiusMeters = Number(radius.input.value);
          scope.textContent = `地圖圓圈顯示目前 ${locations[index].radiusMeters} 公尺的核銷範圍。`;
          renderMapLayers();
        });

        const scope = document.createElement('small');
        scope.className = 'coupon-location-scope';
        scope.textContent = `地圖圓圈顯示目前 ${location.radiusMeters} 公尺的核銷範圍。`;

        const actions = document.createElement('div');
        actions.className = 'coupon-location-actions';

        const focus = document.createElement('button');
        focus.type = 'button';
        focus.className = 'text-button';
        focus.textContent = '查看範圍';
        focus.addEventListener('click', () => {
          if (!validCoordinate(locations[index].latitude, locations[index].longitude)) return;
          createMap();
          map?.setView([locations[index].latitude, locations[index].longitude], DETAIL_ZOOM);
        });

        const adjust = document.createElement('button');
        adjust.type = 'button';
        adjust.className = 'text-button';
        adjust.textContent = '調整位置／範圍';
        adjust.addEventListener('click', () => {
          const current = locations[index];
          setDraft(current.latitude, current.longitude, current.name, {
            radiusMeters: current.radiusMeters,
            editingIndex: index,
          });
        });

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'text-button';
        remove.textContent = '刪除';
        remove.addEventListener('click', () => {
          locations.splice(index, 1);
          if (editingIndex === index) clearDraft(false);
          else if (Number.isInteger(editingIndex) && editingIndex > index) editingIndex -= 1;
          render();
          setStatus('已移除使用地點。');
        });

        actions.append(focus, adjust, remove);
        row.append(title, name.label, radius.label, scope, actions);
        return row;
      }));
      if (count()) count().textContent = `${locations.length} / ${MAX_LOCATIONS} 個使用地點`;
      renderMapLayers();
    }

    function renderDraftEditor() {
      const panel = draftPanel();
      if (!panel) return;
      panel.classList.toggle('hidden', !draft);
      if (!draft) return;

      const nameInput = draftName();
      const radiusInput = draftRadius();
      if (nameInput && nameInput.value !== draft.name) nameInput.value = draft.name;
      if (radiusInput && radiusInput.value !== String(draft.radiusMeters)) radiusInput.value = String(draft.radiusMeters);

      const button = confirmButton();
      if (button) button.textContent = editingIndex == null ? '＋ 新增地點' : '套用位置與範圍';
    }

    function setDraft(latitude, longitude, name = '', options = {}) {
      if (!options.fromGps) stopGPS();
      if (locations.length >= MAX_LOCATIONS && options.editingIndex == null) {
        setStatus(`最多只能設定 ${MAX_LOCATIONS} 個使用地點。`, true);
        return false;
      }
      const lat = Number(latitude);
      const lng = Number(longitude);
      if (!validCoordinate(lat, lng)) {
        setStatus('選取的位置無效，請重新選擇。', true);
        return false;
      }

      editingIndex = Number.isInteger(options.editingIndex) ? options.editingIndex : null;
      draft = normalizeLocation({
        name: name || `使用地點 ${locations.length + 1}`,
        latitude: lat,
        longitude: lng,
        radiusMeters: options.radiusMeters ?? DEFAULT_RADIUS_METERS,
      });
      createMap();
      renderDraftEditor();
      renderDraftOverlay();
      map?.setView([lat, lng], DETAIL_ZOOM);
      setStatus(editingIndex == null
        ? '已選擇候選位置。請確認地點名稱與半徑範圍，再按「新增地點」。'
        : '正在調整既有地點。確認位置與半徑範圍後，再按「套用位置與範圍」。');
      return true;
    }

    function clearDraft(updateStatus = true) {
      stopGPS();
      draft = null;
      editingIndex = null;
      clearDraftOverlay();
      renderDraftEditor();
      if (updateStatus) setStatus('已取消候選位置，尚未變更可使用地點。');
    }

    function commitDraft() {
      if (!draft) {
        setStatus('請先使用地址搜尋、目前 GPS，或直接在地圖上選擇位置。', true);
        return false;
      }

      const name = String(draftName()?.value || draft.name || '').trim().slice(0, 100);
      const radiusMeters = Number(draftRadius()?.value ?? draft.radiusMeters);
      if (!name) {
        setStatus('請輸入地點名稱。', true);
        return false;
      }
      if (!validRadius(radiusMeters)) {
        setStatus(`核銷半徑需為 ${MIN_RADIUS_METERS}～${MAX_RADIUS_METERS} 公尺的整數。`, true);
        return false;
      }

      stopGPS();
      const confirmed = normalizeLocation({ ...draft, name, radiusMeters });
      const wasEditing = Number.isInteger(editingIndex);
      if (wasEditing) locations[editingIndex] = confirmed;
      else locations.push(confirmed);

      draft = null;
      editingIndex = null;
      clearDraftOverlay();
      renderDraftEditor();
      render();
      map?.setView([confirmed.latitude, confirmed.longitude], DETAIL_ZOOM);
      setStatus(wasEditing ? `已套用「${confirmed.name}」的位置與範圍。` : `已新增「${confirmed.name}」。`);
      return true;
    }

    function addLocation(latitude, longitude, name = '', radiusMeters = DEFAULT_RADIUS_METERS) {
      if (!setDraft(latitude, longitude, name, { radiusMeters })) return false;
      return commitDraft();
    }

    function refresh() {
      const enabled = Boolean(checkbox()?.checked);
      controls()?.classList.toggle('hidden', !enabled);
      if (!enabled) stopGPS();
      if (enabled) {
        createMap();
        window.setTimeout(() => {
          map?.invalidateSize();
          renderMapLayers();
        }, 0);
      }
    }

    function stopGPS() {
      gpsGeneration += 1;
      gpsTracker?.stop();
      gpsTracker = null;
      gpsFallbackPending = false;
      gpsPlaceName = '';
      gpsNameFix = null;
      const button = byId(config.currentButtonId);
      if (button) button.textContent = '使用即時 GPS 選點';
    }

    function gpsAlternativeHelp(reason) {
      return (reason || '瀏覽器目前無法取得 GPS 位置。') +
        ' 可確認裝置定位服務與瀏覽器的位置權限，或直接使用「地址搜尋」／點選地圖設定地點。';
    }

    function trySingleGpsFix(generation) {
      // Some desktop browsers cannot supply an ongoing position watch but can
      // return a genuine one-shot fix. Try a different accuracy mode on
      // CoreLocation-unavailable; never synthesize coordinates.
      const previousTracker = gpsTracker;
      gpsTracker = null;
      gpsFallbackPending = true;
      previousTracker?.stop();
      const button = byId(config.currentButtonId);
      if (button) button.textContent = '取消單次 GPS 定位';
      setStatus('即時 GPS 暫時無法取得位置，正在嘗試瀏覽器單次定位…');
      try {
        navigator.geolocation.getCurrentPosition((position) => {
          if (generation !== gpsGeneration || !gpsFallbackPending || !checkbox()?.checked) return;
          const latitude = Number(position?.coords?.latitude);
          const longitude = Number(position?.coords?.longitude);
          const accuracy = Number(position?.coords?.accuracy);
          const timestamp = Number(position?.timestamp);
          stopGPS();
          if (!validCoordinate(latitude, longitude) || !Number.isFinite(accuracy) ||
              accuracy <= 0 || accuracy > 100 || !Number.isFinite(timestamp) ||
              timestamp < Date.now() - 20000 || timestamp > Date.now() + 30000) {
            setStatus(gpsAlternativeHelp('GPS 定位精度不足或位置已過期，無法作為目前位置。'), true);
            return;
          }
          if (setDraft(latitude, longitude, '目前 GPS 位置', { fromGps: true })) {
            setStatus(`已取得瀏覽器單次 GPS 位置（精度約 ±${Math.round(accuracy)} 公尺）。請確認名稱與範圍，再新增地點。`);
          }
        }, (error) => {
          if (generation !== gpsGeneration || !gpsFallbackPending) return;
          stopGPS();
          const reason = error?.code === 1 ? '瀏覽器拒絕位置權限。'
            : error?.code === 3 ? '瀏覽器 GPS 定位逾時。'
            : '瀏覽器無法判定目前位置。';
          setStatus(gpsAlternativeHelp(reason), true);
        }, { enableHighAccuracy: false, maximumAge: 0, timeout: 12000 });
      } catch (_) {
        if (generation !== gpsGeneration) return;
        stopGPS();
        setStatus(gpsAlternativeHelp('瀏覽器無法啟動單次 GPS 定位。'), true);
      }
    }

    function useCurrentLocation() {
      if (gpsTracker || gpsFallbackPending) {
        stopGPS();
        return setStatus('已停止即時 GPS，現有候選地點保留；請確認後儲存。');
      }
      if (!navigator.geolocation) return setStatus(gpsAlternativeHelp('此瀏覽器不支援 GPS 定位。'), true);
      const generation = gpsGeneration;
      const button = byId(config.currentButtonId);
      if (!window.TicketLiveLocation) {
        // Compatibility fallback for deployments where the shared watch helper is unavailable.
        navigator.geolocation.getCurrentPosition((position) => {
          if (generation !== gpsGeneration || !checkbox()?.checked) return;
          setDraft(position.coords.latitude, position.coords.longitude, '目前 GPS 位置');
          setStatus('已定位一次，請確認地點名稱。');
        }, () => {
          if (generation === gpsGeneration) setStatus(gpsAlternativeHelp('GPS 暫時無法定位。'), true);
        }, { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 });
        return;
      }
      setStatus('正在啟動即時 GPS，請允許位置權限…');
      let firstGPSFix = true;
      gpsTracker = window.TicketLiveLocation.create({
        onUpdate(fix, fresh) {
          if (generation !== gpsGeneration || !checkbox()?.checked || !gpsTracker) return;
          if (firstGPSFix && draft) {
            draft.name = '目前 GPS 位置';
            if (draftName()) draftName().value = draft.name;
          }
          firstGPSFix = false;
          if (gpsNameFix && window.TicketLiveLocation.distanceMeters(gpsNameFix, fix) > 120) {
            gpsPlaceName = '';
            gpsNameFix = null;
            if (draft) {
              draft.name = '目前 GPS 位置';
              if (draftName()) draftName().value = draft.name;
            }
          }
          if (!draft) {
            if (!setDraft(fix.latitude, fix.longitude, '目前 GPS 位置', { fromGps: true })) return;
          } else {
            draft.latitude = fix.latitude;
            draft.longitude = fix.longitude;
            if (gpsPlaceName && !draft.name) draft.name = gpsPlaceName;
            draftName().value = draft.name;
            renderDraftOverlay();
            map?.setView([fix.latitude, fix.longitude], DETAIL_ZOOM, { animate: false });
          }
          setStatus(`${fresh ? '即時 GPS 已同步' : 'GPS 精度不足或座標已過期'}（精度約 ±${Math.round(fix.accuracy)} 公尺）。${gpsPlaceName ? '附近「' + gpsPlaceName + '」' : '地點名稱待確認'}；停止定位後可調整並儲存。`);
        },
        onError(message, error) {
          if (generation !== gpsGeneration) return;
          if (error?.code === 2 && !gpsFallbackPending &&
              typeof navigator.geolocation?.getCurrentPosition === 'function') {
            trySingleGpsFix(generation);
            return;
          }
          stopGPS();
          setStatus(gpsAlternativeHelp(message), true);
        }
      });
      try {
        const tracker = gpsTracker;
        tracker.start();
        if (tracker !== gpsTracker || generation !== gpsGeneration) return;
        if (button) button.textContent = '停止即時 GPS 更新';
        tracker.read().then(async (fix) => {
          try {
            const name = await window.TicketLiveLocation.placeName(fix);
            if (generation !== gpsGeneration || tracker !== gpsTracker) return;
            if (window.TicketLiveLocation.distanceMeters(fix, tracker.latest()) > 120) return;
            gpsPlaceName = name;
            gpsNameFix = fix;
            if (draft) {
              draft.name = name.slice(0, 100);
              if (draftName()) draftName().value = draft.name;
            }
            setStatus(`GPS 約定位於「${name}」，精度約 ±${Math.round(fix.accuracy)} 公尺。請確認名稱與半徑，選好後停止即時更新並儲存。`);
          } catch (_) {
            if (generation === gpsGeneration && tracker === gpsTracker)
              setStatus('GPS 持續更新中；無法取得地點名稱，請手動輸入後儲存。', true);
          }
        }).catch((error) => {
          if (generation === gpsGeneration && tracker === gpsTracker)
            setStatus(gpsAlternativeHelp(error.message || 'GPS 定位失敗。'), true);
        });
      } catch (error) {
        stopGPS();
        setStatus(gpsAlternativeHelp(error.message || 'GPS 啟動失敗。'), true);
      }
    }

    function clearSearchResults() {
      searchResults()?.replaceChildren();
    }

    function geocoderCandidates(result) {
      return Array.isArray(result)
        ? result.filter((item) => validCoordinate(Number(item?.lat), Number(item?.lon))).slice(0, 5)
        : [];
    }

    function relaxedAddressQuery(query) {
      const normalized = String(query || '')
        .replace(/[，、]/g, ',')
        .replace(/臺/g, '台')
        .replace(/\s+/g, ' ')
        .trim();

      const roadMatch = normalized.match(/^(.+?[縣市].+?[區鄉鎮市].+?(?:路|街|大道))/u);
      if (roadMatch?.[1]?.length >= 4) return roadMatch[1].trim();

      return normalized
        .replace(/\d+\s*樓(?:之\s*\d+)?(?:\s*\d+\s*室)?.*$/u, '')
        .replace(/\d+(?:[-之]\d+)?\s*號.*$/u, '')
        .replace(/[\s,]+$/g, '')
        .trim();
    }

    function mapViewbox() {
      const bounds = map?.getBounds?.();
      if (!bounds) return '';
      const west = Number(bounds.getWest?.());
      const north = Number(bounds.getNorth?.());
      const east = Number(bounds.getEast?.());
      const south = Number(bounds.getSouth?.());
      if (![west, north, east, south].every(Number.isFinite)) return '';
      return `${west},${north},${east},${south}`;
    }

    function sortCandidatesByMapDistance(candidates) {
      const center = map?.getCenter?.();
      const centerLat = Number(center?.lat);
      const centerLng = Number(center?.lng);
      if (!validCoordinate(centerLat, centerLng)) return candidates;

      const latitudeScale = Math.cos(centerLat * Math.PI / 180);
      return [...candidates].sort((left, right) => {
        const leftLat = Number(left?.lat);
        const leftLng = Number(left?.lon);
        const rightLat = Number(right?.lat);
        const rightLng = Number(right?.lon);
        const leftDistance = ((leftLat - centerLat) ** 2) + (((leftLng - centerLng) * latitudeScale) ** 2);
        const rightDistance = ((rightLat - centerLat) ** 2) + (((rightLng - centerLng) * latitudeScale) ** 2);
        return leftDistance - rightDistance;
      });
    }

    async function waitForGeocoderSlot() {
      const waitMs = Math.max(0, SEARCH_MIN_INTERVAL_MS - (Date.now() - lastGeocoderRequestAt));
      if (waitMs > 0) await new Promise((resolve) => window.setTimeout(resolve, waitMs));
      if (searchController?.signal?.aborted) {
        const error = new Error('ABORTED');
        error.name = 'AbortError';
        throw error;
      }
    }

    async function fetchGeocoder(query, options = {}) {
      const params = new URLSearchParams({
        q: query,
        format: 'jsonv2',
        limit: '5',
        addressdetails: '1',
        countrycodes: 'tw',
        'accept-language': 'zh-TW',
      });
      if (options.preferMapArea) {
        const viewbox = mapViewbox();
        if (viewbox) {
          params.set('viewbox', viewbox);
          params.set('bounded', '0');
        }
      }

      const cacheKey = params.toString();
      if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);

      await waitForGeocoderSlot();
      lastGeocoderRequestAt = Date.now();
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
        headers: { Accept: 'application/json' },
        signal: searchController?.signal,
        referrerPolicy: 'strict-origin-when-cross-origin',
      });
      if (!response.ok) throw new Error('GEOCODER_HTTP_ERROR');

      const result = await response.json();
      const candidates = geocoderCandidates(result);
      geocodeCache.set(cacheKey, candidates);
      if (geocodeCache.size > 30) geocodeCache.delete(geocodeCache.keys().next().value);
      return candidates;
    }

    function renderAddressCandidates(candidates, query, isNearbyFallback = false) {
      const container = searchResults();
      if (!container) return;
      container.replaceChildren(...candidates.map((candidate) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button button-outline';
        const label = String(candidate.display_name || query).trim();
        button.textContent = isNearbyFallback ? `附近候選：${label.slice(0, 220)}` : label.slice(0, 240);
        button.addEventListener('click', () => {
          setDraft(Number(candidate.lat), Number(candidate.lon), label.slice(0, 100));
          if (searchInput()) searchInput().value = label;
          clearSearchResults();
        });
        return button;
      }));
    }

    async function searchAddress() {
      const query = String(searchInput()?.value || '').trim();
      if (query.length < 2) return setStatus('請輸入至少 2 個字的地址或地標。', true);
      if (searchBusy) return;
      const elapsed = Date.now() - lastSearchAt;
      if (elapsed < SEARCH_MIN_INTERVAL_MS) {
        setStatus('地址搜尋請稍候 1 秒再試。', true);
        return;
      }

      searchBusy = true;
      lastSearchAt = Date.now();
      if (searchButton()) searchButton().disabled = true;
      searchController?.abort();
      searchController = typeof AbortController === 'function' ? new AbortController() : null;
      const timeout = window.setTimeout(() => searchController?.abort(), 12000);
      setStatus('正在搜尋地址…');
      clearSearchResults();

      try {
        let candidates = await fetchGeocoder(query);
        let isNearbyFallback = false;

        if (!candidates.length) {
          const relaxedQuery = relaxedAddressQuery(query);
          setStatus('找不到精確地址，正在搜尋最接近的地址／地標…');
          candidates = sortCandidatesByMapDistance(
            await fetchGeocoder(relaxedQuery || query, { preferMapArea: true })
          );
          isNearbyFallback = true;
        }

        if (!candidates.length) {
          setStatus('仍找不到接近的地址。可先把地圖移到附近區域，再點選地圖位置。', true);
          return;
        }

        renderAddressCandidates(candidates, query, isNearbyFallback);
        setStatus(isNearbyFallback
          ? `找不到精確地址，已顯示 ${candidates.length} 個最接近的候選位置；請確認後再新增。`
          : `找到 ${candidates.length} 個結果。選擇其中一個後，再確認半徑並新增。`);
      } catch (error) {
        if (error?.name !== 'AbortError') setStatus('地址搜尋暫時無法使用，請稍後再試或直接使用 GPS／地圖選點。', true);
        else setStatus('地址搜尋逾時，請重試。', true);
      } finally {
        window.clearTimeout(timeout);
        searchBusy = false;
        if (searchButton()) searchButton().disabled = false;
      }
    }

    function init() {
      if (initialized) return;
      if (!checkbox() || !controls() || !rows()) return;
      initialized = true;

      checkbox().addEventListener('change', refresh);
      confirmButton()?.addEventListener('click', commitDraft);
      byId(config.clearDraftButtonId)?.addEventListener('click', () => clearDraft(true));
      byId(config.currentButtonId)?.addEventListener('click', useCurrentLocation);

      draftName()?.addEventListener('input', () => {
        if (!draft) return;
        draft.name = draftName().value.trim().slice(0, 100);
        draftMarker?.bindTooltip?.(draft.name || '待新增位置');
      });
      draftRadius()?.addEventListener('input', () => {
        if (!draft) return;
        draft.radiusMeters = Number(draftRadius().value);
        if (validRadius(draft.radiusMeters)) {
          draftCircle?.setRadius?.(draft.radiusMeters);
          if (!draftCircle) renderDraftOverlay();
          setStatus(`目前候選核銷範圍：${draft.radiusMeters} 公尺。確認後再新增。`);
        }
      });

      searchButton()?.addEventListener('click', searchAddress);
      searchInput()?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        searchAddress();
      });

      createMap();
      render();
      renderDraftEditor();
      refresh();
      window.addEventListener('pagehide', stopGPS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') stopGPS();
      });
    }

    return {
      init,
      refresh,
      set(value) {
        locations = Array.isArray(value)
          ? value.slice(0, MAX_LOCATIONS).map((item, index) => normalizeLocation(item, `使用地點 ${index + 1}`))
          : [];
        clearDraft(false);
        render();
        refresh();
      },
      get() {
        return locations.map((location) => ({ ...location }));
      },
      addLocation,
      setDraft,
      commitDraft,
      clearDraft,
      stopGPS,
      searchAddress,
    };
  }

  const eventEditor = createEditor({
    checkboxId: 'eventTicketRequiresLocation',
    controlsId: 'eventTicketLocationControls',
    rowsId: 'eventTicketLocationRows',
    countId: 'eventTicketLocationCount',
    statusId: 'eventTicketMapStatus',
    mapId: 'eventTicketLocationMap',
    draftPanelId: 'eventTicketLocationDraft',
    draftNameId: 'eventTicketLocationDraftName',
    draftRadiusId: 'eventTicketLocationDraftRadius',
    addButtonId: 'addEventTicketLocationButton',
    clearDraftButtonId: 'clearEventTicketLocationDraftButton',
    currentButtonId: 'eventTicketUseCurrentLocationButton',
    searchInputId: 'eventTicketAddressSearch',
    searchButtonId: 'eventTicketAddressSearchButton',
    searchResultsId: 'eventTicketAddressResults',
  });

  const templateEditor = createEditor({
    checkboxId: 'ticketRequiresLocation',
    controlsId: 'ticketLocationControls',
    rowsId: 'ticketLocationRows',
    countId: 'ticketLocationCount',
    statusId: 'ticketMapStatus',
    mapId: 'ticketLocationMap',
    draftPanelId: 'ticketLocationDraft',
    draftNameId: 'ticketLocationDraftName',
    draftRadiusId: 'ticketLocationDraftRadius',
    addButtonId: 'addTicketLocationButton',
    clearDraftButtonId: 'clearTicketLocationDraftButton',
    currentButtonId: 'ticketUseCurrentLocationButton',
    searchInputId: 'ticketAddressSearch',
    searchButtonId: 'ticketAddressSearchButton',
    searchResultsId: 'ticketAddressResults',
  });

  const snapshotEditor = createEditor({
    checkboxId: 'bookingAdminSnapshotLocationRequired',
    controlsId: 'bookingAdminSnapshotLocationControls',
    rowsId: 'bookingAdminSnapshotLocationRows',
    countId: 'bookingAdminSnapshotLocationCount',
    statusId: 'bookingAdminSnapshotMapStatus',
    mapId: 'bookingAdminSnapshotLocationMap',
    draftPanelId: 'bookingAdminSnapshotLocationDraft',
    draftNameId: 'bookingAdminSnapshotLocationDraftName',
    draftRadiusId: 'bookingAdminSnapshotLocationDraftRadius',
    addButtonId: 'addBookingAdminSnapshotLocationButton',
    clearDraftButtonId: 'clearBookingAdminSnapshotLocationDraftButton',
    currentButtonId: 'bookingAdminSnapshotUseCurrentLocationButton',
    searchInputId: 'bookingAdminSnapshotAddressSearch',
    searchButtonId: 'bookingAdminSnapshotAddressSearchButton',
    searchResultsId: 'bookingAdminSnapshotAddressResults',
  });

  window.TicketLocationEditors = {
    event: eventEditor,
    template: templateEditor,
    snapshot: snapshotEditor,
    init() { eventEditor.init(); templateEditor.init(); snapshotEditor.init(); },
  };
  window.CouponLocationEditor = eventEditor;
})();
