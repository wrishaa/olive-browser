// Settings tab bar, shared by the four tab documents. <body data-tab="..."> names the
// current one; clicking another asks main to load it into the same page.
(() => {
  const TABS = [['general', 'General'], ['shortcuts', 'Keyboard Shortcuts'], ['activities', 'Activities'], ['extensions', 'Extensions']];
  const current = document.body.dataset.tab;
  const nav = document.createElement('nav');
  nav.id = 'settings-tabs'; nav.setAttribute('aria-label', 'Settings');
  const title = document.createElement('h1'); title.className = 'settings-title'; title.textContent = 'Settings';
  const list = document.createElement('div'); list.className = 'settings-tablist'; list.setAttribute('role', 'tablist');
  for (const [id, label] of TABS) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.dataset.tab = id; b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(id === current)); b.tabIndex = id === current ? 0 : -1;
    b.addEventListener('click', () => { if (id !== current) window.oliveSettings.tab(id); });
    list.append(b);
  }
  list.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.findIndex(([id]) => id === current), n = TABS.length;
    window.oliveSettings.tab(TABS[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n][0]);
  });
  const url = document.createElement('span'); url.className = 'settings-url'; url.textContent = current === 'general' ? 'olive://settings' : `olive://settings/${current}`;
  nav.append(title, list, url);
  document.body.prepend(nav);
  document.getElementById('open-ledger')?.addEventListener('click', () => window.oliveSettings.ledger());
})();
