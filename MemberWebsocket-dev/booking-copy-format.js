(() => {
  'use strict';

  // An older cached admin loader can still request this script dynamically.
  if (window.bookingCopyFormatInstalled) return;
  window.bookingCopyFormatInstalled = true;

  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  const participantNames = ['第一', '第二', '第三', '第四', '第五', '第六', '第七', '第八', '第九', '第十'];
  let configPromise = null;

  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('.booking-copy-button');
    if (!button) return;

    const card = button.closest('.booking-admin-booking, #bookingQueue > .booking-card');
    if (!card) return;

    // booking-summary.js also owns this button. Capture the click here so only the
    // participant-aware formatter writes to the clipboard.
    event.preventDefault();
    event.stopImmediatePropagation();
    copyBooking(button, card).catch(() => setTemporaryLabel(button, '複製失敗'));
  }, true);

  async function copyBooking(button, card) {
    if (button.dataset.copyBusy === 'true') return;
    button.dataset.copyBusy = 'true';
    button.disabled = true;
    const originalLabel = button.textContent || '複製預約內容';

    try {
      const bookingId = String(card.dataset.bookingId || '').trim();
      if (!bookingId) throw clientError('BOOKING_NOT_READY', '預約資料尚未載入完成。');
      let group = groupFromCardData(card);
      if (!group) {
        try {
          group = await fetchGroupDetails(bookingId);
        } catch (error) {
          group = groupFromRenderedDetails(card);
          if (!group) throw error;
        }
      }
      if (!group?.participants?.length) group = groupFromRenderedDetails(card);
      await copyText(buildCopyText(card, group));
      button.textContent = '已複製';
    } catch (error) {
      console.warn('booking copy failed', error?.code || error?.message || 'COPY_FAILED');
      button.textContent = '複製失敗';
    } finally {
      window.setTimeout(() => {
        button.dataset.copyBusy = 'false';
        button.disabled = false;
        button.textContent = originalLabel;
      }, 1500);
    }
  }

  async function fetchGroupDetails(bookingId) {
    const system = window.MemberSystem || window.BookingSystem;
    if (!system?.loadConfig) throw clientError('CONFIG_ERROR', '預約管理設定尚未載入。');
    if (!configPromise) configPromise = Promise.resolve(system.loadConfig()).catch((error) => {
      configPromise = null;
      throw error;
    });
    const config = await configPromise;
    const idToken = String(window.MemberAdminSession?.get?.()?.idToken || window.liff?.getIDToken?.() || '');
    if (!idToken) throw clientError('AUTH_REQUIRED', '管理端登入尚未完成。');

    const endpoint = `${String(config?.supabaseUrl || '').replace(/\/$/, '')}/functions/v1/booking-group-details-api`;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          apikey: String(config?.supabasePublishableKey || ''),
        },
        body: JSON.stringify({
          action: 'admin.booking.group.details',
          clientType: 'admin',
          idToken,
          bookingIds: [bookingId],
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok !== true) {
        throw clientError(String(data?.error?.code || 'API_ERROR'), String(data?.error?.message || '無法取得逐位預約資料。'));
      }
      const group = data?.data?.bookingGroups?.[bookingId];
      if (!group || !Array.isArray(group.participants)) throw clientError('BOOKING_NOT_READY', '預約明細尚未載入完成。');
      if (Number(group.partySize || 1) > Math.max(1, group.participants.length)) throw clientError('BOOKING_INCOMPLETE', '逐位預約明細尚未完整。');
      return group;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function buildCopyText(card, group) {
    return window.BookingCopyText.format({
      bookingDate:card.dataset.bookingDate,startAt:card.dataset.bookingStartAt,endAt:card.dataset.bookingEndAt,
      startTime:startTime(card),endTime:card.dataset.bookingEndTime,name:contactName(card),phone:contactPhone(card),
      partySize:group?.partySize,participants:normalizedParticipants(card,group),
    });
  }

  function normalizedParticipants(card, group) {
    if (Array.isArray(group?.participants) && group.participants.length) {
      return group.participants.map((participant) => ({
        technicianName: String(participant?.technicianName || '現場安排'),
        items: Array.isArray(participant?.items) ? participant.items : [],
      }));
    }

    const storedItems = copyItemsFromCard(card);
    if (storedItems.length) {
      return [{ technicianName: '現場安排', items: storedItems }];
    }

    const serviceTitles = [...card.querySelectorAll('.booking-received-services span')]
      .map((node) => String(node.textContent || '').trim())
      .filter(Boolean);
    return [{
      technicianName: '現場安排',
      items: serviceTitles.map((serviceTitle) => ({ serviceTitle, quantity: 1 })),
    }];
  }

  function copyItemsFromCard(card) {
    try {
      const parsed = JSON.parse(String(card.dataset.bookingCopyItems || '[]'));
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item) => ({
        serviceTitle: String(item?.serviceTitle || '').trim(),
        quantity: Math.max(1, Number(item?.quantity || 1)),
      })).filter((item) => item.serviceTitle);
    } catch (_) {
      return [];
    }
  }

  function groupFromCardData(card) {
    try {
      const parsed = JSON.parse(String(card.dataset.bookingCopyGroup || ''));
      if (!parsed || !Array.isArray(parsed.participants) || !parsed.participants.length) return null;
      const participants = parsed.participants.map((participant) => ({
        technicianName: String(participant?.technicianName || '現場安排'),
        items: Array.isArray(participant?.items) ? participant.items.map((item) => ({
          serviceTitle: String(item?.serviceTitle || '').trim(),
          quantity: Math.max(1, Number(item?.quantity || 1)),
        })).filter((item) => item.serviceTitle) : [],
      }));
      if (!participants.length) return null;
      const partySize = Math.max(1, Number(parsed.partySize || participants.length));
      if (partySize > participants.length) return null;
      return { partySize, participants };
    } catch (_) {
      return null;
    }
  }

  function groupFromRenderedDetails(card) {
    const blocks = [...card.querySelectorAll('.booking-group-admin-details .booking-group-admin-participant')];
    if (!blocks.length) return null;
    const participants = blocks.map((block) => {
      const rows = [...block.querySelectorAll('p')].map((node) => String(node.textContent || '').trim());
      const itemText = rows.find((text) => text.startsWith('預約項目：'))?.slice('預約項目：'.length) || '';
      const technicianName = rows.find((text) => text.startsWith('預約技師：'))?.slice('預約技師：'.length) || '現場安排';
      return {
        technicianName: technicianName.replace(/（主要技師）/g, '').trim() || '現場安排',
        items: itemText.split('、').map((text) => ({
          serviceTitle: text.replace(/（\d+分鐘）/g, '').replace(/\s*×\s*\d+\s*$/g, '').trim(),
          quantity: Number(/×\s*(\d+)\s*$/.exec(text)?.[1] || 1),
        })).filter((item) => item.serviceTitle),
      };
    });
    return { partySize: participants.length, participants };
  }

  function participantItems(items) {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) return '—';
    return rows.map((item) => {
      const title = String(item?.serviceTitle || '預約項目').trim();
      const quantity = Math.max(1, Number(item?.quantity || 1));
      return quantity > 1 ? `${title} × ${quantity}` : title;
    }).join('、');
  }

  function participantLabel(index) {
    return `${participantNames[index] || `第 ${index + 1} `}位預約`;
  }

  function contactName(card) {
    const stored = String(card.dataset.bookingCopyContactName || '').trim();
    if (stored) return stored;
    return String(card.querySelector('.booking-received-name')?.textContent || '會員').trim() || '會員';
  }

  function contactPhone(card) {
    const stored = String(card.dataset.bookingCopyPhone || '').trim();
    const text = stored || String(card.querySelector('.booking-received-phone')?.textContent || '').trim().replace(/^電話：/, '').trim();
    if (!text || text === '—') return '—';
    return text.replace(/[\s()－—-]/g, '');
  }

  function startTime(card) {
    const stored = String(card.dataset.bookingStartTime || '').slice(0, 5);
    if (/^\d{2}:\d{2}$/.test(stored)) return stored;
    const text = String(card.querySelector('.booking-received-datetime')?.textContent || '');
    return /(\d{2}:\d{2})/.exec(text)?.[1] || '—';
  }

  function formatShortDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return String(value || '—');
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const weekday = WEEKDAYS[new Date(year, month - 1, day).getDay()] || '';
    return `${month}/${day}（${weekday}）`;
  }

  async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return; } catch (_) { /* Try the browser's copy fallback. */ }
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.className = 'booking-cancellation-copy-buffer';
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } finally { textarea.remove(); }
    if (!copied) throw clientError('COPY_FAILED', '無法複製預約內容。');
  }

  function setTemporaryLabel(button, label) {
    const originalLabel = button.textContent || '複製預約內容';
    button.textContent = label;
    window.setTimeout(() => { button.textContent = originalLabel; }, 1500);
  }

  function clientError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
})();
