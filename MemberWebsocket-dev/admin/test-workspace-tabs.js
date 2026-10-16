(() => {
  'use strict';

  const TABS = [
    {
      key: 'environment',
      label: '環境設定',
      eyebrow: 'Environment',
      description: '維護模式、PC／行動裝置測試登入、重複登入與維護訊息。'
    },
    {
      key: 'accounts',
      label: '測試帳號',
      eyebrow: 'Test members',
      description: '建立、檢視與批次管理虛擬測試會員。'
    },
    {
      key: 'runner',
      label: 'E2E 執行',
      eyebrow: 'Unified E2E',
      description: '啟動完整背景 E2E，查看執行進度、案例與診斷結果。'
    },
    {
      key: 'history',
      label: '測試紀錄',
      eyebrow: 'History',
      description: '查看最近測試結果，快速回到指定執行的詳細案例。'
    }
  ];

  let mounted = false;
  let activeKey = 'environment';
  const refs = {
    buttons: new Map(),
    panels: new Map(),
    description: null
  };

  window.addEventListener('DOMContentLoaded', mount);
  window.addEventListener('member-admin-ready', mount);

  function mount() {
    if (mounted) return;
    const host = document.getElementById('testModePanel');
    const heading = host?.querySelector('.test-mode-panel-heading');
    const environmentGrid = host?.querySelector('.test-mode-panel-grid');
    const settingsCard = environmentGrid?.querySelector('.test-mode-settings-card');
    const accountsCard = environmentGrid?.querySelector('.test-mode-accounts-card');
    const controlCenter = host?.querySelector('.test-control-center');
    const controlLayout = controlCenter?.querySelector('.test-control-layout');
    const historyCard = controlLayout?.querySelector('.test-control-history-card');
    if (!host || !heading || !environmentGrid || !settingsCard || !accountsCard || !controlCenter || !controlLayout || !historyCard) return;

    const navWrap = document.createElement('div');
    navWrap.className = 'test-workspace-nav-shell';

    const nav = document.createElement('nav');
    nav.className = 'test-workspace-tabs';
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', '測試中心工作區');

    for (const [index, item] of TABS.entries()) {
      const button = document.createElement('button');
      button.id = 'testWorkspace' + capitalize(item.key) + 'Tab';
      button.className = 'test-workspace-tab';
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', item.key === activeKey ? 'true' : 'false');
      button.setAttribute('aria-controls', 'testWorkspace' + capitalize(item.key) + 'Panel');
      button.tabIndex = item.key === activeKey ? 0 : -1;
      button.dataset.testWorkspaceTab = item.key;

      const indexMark = document.createElement('span');
      indexMark.className = 'test-workspace-tab-index';
      indexMark.textContent = String(index + 1).padStart(2, '0');

      const copy = document.createElement('span');
      copy.className = 'test-workspace-tab-copy';
      const label = document.createElement('strong');
      label.textContent = item.label;
      const eyebrow = document.createElement('small');
      eyebrow.textContent = item.eyebrow;
      copy.append(label, eyebrow);
      button.append(indexMark, copy);

      button.addEventListener('click', () => activate(item.key));
      button.addEventListener('keydown', onTabKeydown);
      refs.buttons.set(item.key, button);
      nav.appendChild(button);
    }

    const description = document.createElement('p');
    description.className = 'test-workspace-tab-description';
    description.id = 'testWorkspaceActiveDescription';
    refs.description = description;
    navWrap.append(nav, description);

    const environmentPanel = createPanel('environment');
    const accountsPanel = createPanel('accounts');
    const runnerPanel = createPanel('runner');
    const historyPanel = createPanel('history');

    const environmentShell = document.createElement('div');
    environmentShell.className = 'test-workspace-single-column';
    environmentShell.appendChild(settingsCard);

    const accountsShell = document.createElement('div');
    accountsShell.className = 'test-workspace-single-column test-workspace-accounts-shell';
    accountsShell.appendChild(accountsCard);

    const historyShell = document.createElement('section');
    historyShell.className = 'test-workspace-history-shell';
    historyShell.setAttribute('aria-labelledby', 'testWorkspaceHistoryTitle');

    const historyHeading = document.createElement('div');
    historyHeading.className = 'test-workspace-history-heading';
    historyHeading.innerHTML = '<div><span class="test-mode-eyebrow">Automation history</span><h3 id="testWorkspaceHistoryTitle">測試紀錄</h3><p>保留最近的測試執行結果。點選任一紀錄後，會自動切換到 E2E 執行分頁並顯示該次案例、Expected 與 Actual。</p></div>';
    historyShell.append(historyHeading, historyCard);

    environmentGrid.remove();
    controlLayout.classList.add('is-runner-only');
    environmentPanel.appendChild(environmentShell);
    accountsPanel.appendChild(accountsShell);
    runnerPanel.appendChild(controlCenter);
    historyPanel.appendChild(historyShell);

    heading.after(navWrap, environmentPanel, accountsPanel, runnerPanel, historyPanel);

    historyPanel.addEventListener('click', (event) => {
      if (event.target.closest('.test-control-history-item')) {
        activate('runner');
      }
    });

    window.AdminTestWorkspaceTabs = Object.freeze({
      activate: (key) => activate(key),
      current: () => activeKey
    });

    mounted = true;
    activate(activeKey, false);
  }

  function createPanel(key) {
    const panel = document.createElement('section');
    panel.id = 'testWorkspace' + capitalize(key) + 'Panel';
    panel.className = 'test-workspace-panel test-workspace-panel--' + key;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', 'testWorkspace' + capitalize(key) + 'Tab');
    panel.setAttribute('aria-describedby', 'testWorkspaceActiveDescription');
    panel.tabIndex = 0;
    panel.hidden = key !== activeKey;
    refs.panels.set(key, panel);
    return panel;
  }

  function activate(key, focus = false) {
    if (!refs.buttons.has(key) || !refs.panels.has(key)) return;
    activeKey = key;
    for (const item of TABS) {
      const selected = item.key === key;
      const button = refs.buttons.get(item.key);
      const panel = refs.panels.get(item.key);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
      panel.hidden = !selected;
    }
    const current = TABS.find((item) => item.key === key);
    if (refs.description && current) refs.description.textContent = current.description;
    if (focus) refs.buttons.get(key)?.focus();
  }

  function onTabKeydown(event) {
    const index = TABS.findIndex((item) => item.key === event.currentTarget.dataset.testWorkspaceTab);
    if (index < 0) return;

    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = TABS.length - 1;
    else return;

    event.preventDefault();
    activate(TABS[nextIndex].key, true);
  }

  function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
})();
