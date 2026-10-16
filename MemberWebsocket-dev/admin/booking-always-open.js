(() => {
  'use strict';

  const SERVICE_ACTIVE_SELECTOR = '#bookingAdminCrudModalBody input[data-field="isActive"]';
  const TECHNICIAN_ACTIVE_SELECTOR = '#bookingAdminTechnicianActive';

  function replaceVisibleToggle(input) {
    if (!(input instanceof HTMLInputElement)) return;
    input.checked = true;
    const label = input.closest('label');
    if (!label) {
      input.style.setProperty('display', 'none', 'important');
      input.setAttribute('aria-hidden', 'true');
      input.tabIndex = -1;
      return;
    }

    const replacement = document.createElement('input');
    replacement.type = 'checkbox';
    replacement.checked = true;
    replacement.tabIndex = -1;
    replacement.setAttribute('aria-hidden', 'true');
    replacement.style.setProperty('display', 'none', 'important');

    if (input.id) replacement.id = input.id;
    if (input.dataset.field) replacement.dataset.field = input.dataset.field;

    label.insertAdjacentElement('beforebegin', replacement);
    label.remove();
  }

  function removeAvailabilityToggles(root = document) {
    root.querySelectorAll?.(SERVICE_ACTIVE_SELECTOR).forEach(replaceVisibleToggle);
    root.querySelectorAll?.(TECHNICIAN_ACTIVE_SELECTOR).forEach(replaceVisibleToggle);
  }

  function forceEnabled(form) {
    form.querySelectorAll?.('input[data-field="isActive"], #bookingAdminTechnicianActive').forEach((input) => {
      if (input instanceof HTMLInputElement) input.checked = true;
    });
  }

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.closest('#bookingAdminCrudModalBody') || form.id === 'bookingAdminTechnicianForm') {
      forceEnabled(form);
    }
  }, true);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof Element) removeAvailabilityToggles(node);
      });
    }
    removeAvailabilityToggles(document);
  });

  const start = () => {
    removeAvailabilityToggles(document);
    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
