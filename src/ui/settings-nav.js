// Settings section bar, shared by the four section documents. <body data-tab="..."> names the
// current one. Sections are real addresses (olive://settings/<section>): plain links, so
// back/forward, reload, cmd+click and split work like on any site.
(() => {
  const TABS = [['general', 'General'], ['shortcuts', 'Keyboard Shortcuts'], ['activities', 'Activities'], ['extensions', 'Extensions']];
  const current = document.body.dataset.tab;
  const href = id => `olive://settings/${id}`;
  const nav = document.createElement('nav');
  nav.id = 'settings-tabs'; nav.setAttribute('aria-label', 'Settings');
  const title = document.createElement('h1'); title.className = 'settings-title'; title.textContent = 'Settings';
  const list = document.createElement('div'); list.className = 'settings-tablist'; list.setAttribute('role', 'tablist');
  for (const [id, label] of TABS) {
    const a = document.createElement('a');
    a.href = href(id); a.textContent = label; a.dataset.tab = id; a.setAttribute('role', 'tab');
    a.setAttribute('aria-selected', String(id === current)); a.tabIndex = id === current ? 0 : -1;
    if (id === current) a.setAttribute('aria-current', 'page');
    list.append(a);
  }
  list.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.findIndex(([id]) => id === current), n = TABS.length;
    location.href = href(TABS[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n][0]);
  });
  nav.append(title, list);
  document.body.prepend(nav);
})();
