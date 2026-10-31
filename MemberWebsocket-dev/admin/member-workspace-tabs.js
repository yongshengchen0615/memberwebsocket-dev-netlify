(() => {
  'use strict';

  const WORKSPACES = Object.freeze([
    { key: 'directory', tabId: 'memberDirectoryTab', panelId: 'memberDirectoryPanel' },
    { key: 'usage', tabId: 'memberUsageTab', panelId: 'memberUsagePanel' },
    { key: 'tiers', tabId: 'memberTierSettingsTab', panelId: 'memberTierSettingsPanel' },
    { key: 'terms', tabId: 'memberTermsTab', panelId: 'memberTermsPanel' },
  ]);

  function initMemberWorkspaceTabs() {
    const items = WORKSPACES.map((workspace) => ({
      ...workspace,
      tab: document.getElementById(workspace.tabId),
      panel: document.getElementById(workspace.panelId),
    }));

    if (items.some((item) => !item.tab || !item.panel)) return;

    const selectWorkspace = (key, focusTab = false) => {
      const available = items.filter((item) => !item.tab.disabled && item.tab.dataset.businessAllowed !== 'false');
      const next = available.some((item) => item.key === key) ? key : available[0]?.key;

      items.forEach((item) => {
        const selected = item.key === next;
        item.tab.setAttribute('aria-selected', String(selected));
        item.tab.tabIndex = selected ? 0 : -1;
        item.panel.classList.toggle('hidden', !selected);
        if (selected && focusTab) item.tab.focus();
      });
      window.dispatchEvent(new CustomEvent('member-workspace-selected', { detail: { workspace: next } }));
    };
    window.MemberWorkspaceTabs = Object.freeze({ select: (key) => selectWorkspace(key) });

    items.forEach((item, index) => {
      item.tab.addEventListener('click', () => selectWorkspace(item.key));
      item.tab.addEventListener('keydown', (event) => {
        const available = items.filter((entry) => !entry.tab.disabled && entry.tab.dataset.businessAllowed !== 'false');
        const currentIndex = available.indexOf(item);
        let targetIndex = -1;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') targetIndex = (currentIndex + 1) % available.length;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') targetIndex = (currentIndex - 1 + available.length) % available.length;
        if (event.key === 'Home') targetIndex = 0;
        if (event.key === 'End') targetIndex = available.length - 1;
        if (targetIndex < 0) return;
        event.preventDefault();
        if (available[targetIndex]) selectWorkspace(available[targetIndex].key, true);
      });
    });

    const initiallySelected = items.find((item) => item.tab.getAttribute('aria-selected') === 'true');
    selectWorkspace(initiallySelected ? initiallySelected.key : 'directory');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMemberWorkspaceTabs, { once: true });
  } else {
    initMemberWorkspaceTabs();
  }
})();
