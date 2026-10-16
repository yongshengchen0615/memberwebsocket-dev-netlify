(() => {
  'use strict';

  const STEP_DEFINITIONS = Object.freeze([
    ['日期', '選擇日期'],
    ['項目', '選擇服務'],
    ['時間', '選擇時段'],
    ['確認', '確認送出'],
  ]);

  function visible(element) {
    return Boolean(element && !element.classList.contains('hidden'));
  }

  function boot() {
    const bookingCard = document.querySelector('#bookingView .booking-card[aria-labelledby="bookingTitle"]');
    if (!bookingCard || bookingCard.querySelector('[data-booking-flow]')) return;

    const heading = bookingCard.querySelector('.section-heading');
    const appointmentPanel = document.getElementById('appointmentPanel');
    const selectedServiceList = document.getElementById('selectedServiceList');
    const selectedServiceEmpty = document.getElementById('selectedServiceEmpty');
    const slotGrid = document.getElementById('slotGrid');
    const confirmModal = document.getElementById('bookingConfirmModal');

    const flow = document.createElement('ol');
    flow.className = 'booking-flow';
    flow.dataset.bookingFlow = '';
    flow.setAttribute('aria-label', '預約流程');

    STEP_DEFINITIONS.forEach(([label, description], index) => {
      const item = document.createElement('li');
      item.className = 'booking-flow-step';
      item.dataset.bookingFlowStep = String(index + 1);
      item.title = description;

      const number = document.createElement('span');
      number.className = 'booking-flow-index';
      number.textContent = String(index + 1);
      number.setAttribute('aria-hidden', 'true');

      const copy = document.createElement('span');
      copy.className = 'booking-flow-label';
      copy.textContent = label;

      item.append(number, copy);
      flow.appendChild(item);
    });

    if (heading) heading.insertAdjacentElement('afterend', flow);
    else bookingCard.prepend(flow);

    function selectedServicesExist() {
      return Boolean(
        selectedServiceList?.children.length ||
        (selectedServiceEmpty && selectedServiceEmpty.classList.contains('hidden'))
      );
    }

    function selectedSlotExists() {
      return Boolean(slotGrid?.querySelector('.slot-button.selected, .slot-button[aria-pressed="true"]'));
    }

    function currentStep() {
      if (visible(confirmModal)) return 4;
      if (visible(appointmentPanel)) {
        if (selectedSlotExists()) return 4;
        if (selectedServicesExist()) return 3;
        return 2;
      }
      return 1;
    }

    function render() {
      const current = currentStep();
      flow.dataset.currentStep = String(current);
      flow.querySelectorAll('[data-booking-flow-step]').forEach((item, index) => {
        const step = index + 1;
        item.classList.toggle('is-current', step === current);
        item.classList.toggle('is-reached', step < current);
        if (step === current) item.setAttribute('aria-current', 'step');
        else item.removeAttribute('aria-current');
      });
    }

    render();
    window.addEventListener('booking:selection-changed', render);

    if (typeof MutationObserver === 'function') {
      const observer = new MutationObserver(render);
      [appointmentPanel, selectedServiceList, selectedServiceEmpty, slotGrid, confirmModal]
        .filter(Boolean)
        .forEach((element) => observer.observe(element, {
          attributes: true,
          attributeFilter: ['class', 'aria-pressed'],
          childList: true,
          subtree: element === slotGrid,
        }));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
