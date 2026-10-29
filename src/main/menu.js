// native app menu; every action goes to the focused olive window
const { Menu, shell } = require('electron');
const path = require('path');

function buildMenu(mgr) {
  const w = (type, args) => () => {
    const win = mgr.focusedWindow();
    if (win) win.cmd(type, args);
    else if (type === 'newTab' || type === 'newWindow') mgr.newWindow({});
    else if (type === 'newPrivateWindow') mgr.newWindow({ private: true });
  };
  const shortcut = (id) => mgr.shortcuts ? mgr.shortcuts.accelerator(id) : require('./shortcuts').COMMANDS.find(c => c.id === id)?.accelerator;
  const hidden = (accelerator, type, args) => ({ label: type, accelerator, click: w(type, args), visible: false, acceleratorWorksWhenHidden: true });

  const template = [
    {
      label: 'Olive',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Profiles…', click: () => mgr.profileControls?.show() },
        { label: 'Activities — Site Time…', click: w('activities') },
        { label: 'Activity Event Log…', click: w('ledger') },
        { label: 'Set Up Olive…', click: () => mgr.onboarding?.show() },
        { label: 'Keyboard Shortcuts…', accelerator: shortcut('settings'), click: () => mgr.shortcuts?.showSettings(mgr.focusedWindow()) },
        { type: 'separator' },
        { label: 'Set as Default Browser…', click: () => mgr.makeDefault() },
        { label: 'Import from Browser…', click: () => mgr.onboarding?.showImport() },
        { label: 'Import from Arc…', click: () => require('./arc-import').showImport(mgr) },
        { label: 'Reset Permissions for This Site', click: () => mgr.permissions.reset(mgr.focusedWindow()) },
        { label: 'Copy Agent Endpoints', click: w('copyAgentInfo') },
        { label: 'Clear Browsing History', click: () => mgr.history.clear() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: shortcut('newTab'), click: w('newTab') },
        { label: 'New Window', accelerator: shortcut('newWindow'), click: w('newWindow') },
        { label: 'New Private Window', accelerator: shortcut('newPrivateWindow'), click: w('newPrivateWindow') },
        { label: 'Open Location…', accelerator: shortcut('openLocation'), click: w('openLocation') },
        { label: 'Reopen Closed Tab', accelerator: shortcut('reopenClosed'), click: w('reopenClosed') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: shortcut('closeTab'), click: w('closeTab') },
        { label: 'Close Window', accelerator: shortcut('closeWindow'), click: () => mgr.focusedWindow()?.win.close() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Copy URL', accelerator: shortcut('copyUrl'), click: w('copyUrl') },
        { type: 'separator' },
        { label: 'Find…', accelerator: shortcut('find'), click: w('find') },
        { label: 'Find Next', accelerator: shortcut('findNext'), click: w('findNext') },
        { label: 'Find Previous', accelerator: shortcut('findPrev'), click: w('findPrev') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: shortcut('toggleSidebar'), click: w('toggleSidebar') },
        { type: 'separator' },
        { label: 'Reload', accelerator: shortcut('reload'), click: w('reload') },
        { label: 'Hard Reload', accelerator: shortcut('hardReload'), click: w('hardReload') },
        { label: 'Stop', accelerator: shortcut('stop'), click: w('stop') },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: shortcut('zoomReset'), click: w('zoomReset') },
        { label: 'Zoom In', accelerator: shortcut('zoomIn'), click: w('zoomIn') },
        hidden('Cmd+Plus', 'zoomIn'),
        { label: 'Zoom Out', accelerator: shortcut('zoomOut'), click: w('zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Next Recently Used Tab', accelerator: shortcut('mruNext'), click: w('mruNext') },
        { label: 'Previous Recently Used Tab', accelerator: shortcut('mruPrev'), click: w('mruPrev') },
        { label: 'Next Tab', accelerator: shortcut('nextTab'), click: w('nextTab') },
        { label: 'Previous Tab', accelerator: shortcut('prevTab'), click: w('prevTab') },
        hidden('Cmd+Shift+]', 'nextTab'),
        hidden('Cmd+Shift+[', 'prevTab'),
        { type: 'separator' },
        { label: 'Pin / Unpin Tab', accelerator: shortcut('togglePin'), click: w('togglePin') },
        { label: 'Duplicate Tab', accelerator: shortcut('duplicate'), click: w('duplicate') },
        { type: 'separator' },
        { label: 'New Group with Selection', accelerator: shortcut('newGroup'), click: w('newGroup') },
        { type: 'separator' },
        { label: 'Split View with New Tab', accelerator: shortcut('splitNew'), click: w('splitNew') },
        hidden('Ctrl+Shift+Plus', 'splitNew'),
        { label: 'Separate Split View', accelerator: shortcut('unsplit'), click: w('unsplit') },
        { type: 'separator' },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => hidden(`Cmd+${n}`, 'selectIndex', { index: n })),
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: shortcut('back'), click: w('back') },
        { label: 'Forward', accelerator: shortcut('forward'), click: w('forward') },
      ],
    },
    {
      label: 'Developer',
      submenu: [
        { label: 'Developer Tools', accelerator: shortcut('devtools'), click: w('devtools') },
        { label: 'JavaScript Console', accelerator: shortcut('console'), click: w('console') },
        hidden('F12', 'devtools'),
        { type: 'separator' },
        { label: 'Allow Agent Control over CDP (port 9222)', type: 'checkbox', checked: !!mgr.settings.cdp, click: () => mgr.toggleCdp() },
        { label: 'Copy Agent Endpoints (CDP + API)', click: w('copyAgentInfo') },
        { label: 'Open Agent API Docs', click: () => shell.openPath(path.join(__dirname, '..', '..', 'AGENTS.md')) },
        { type: 'separator' },
        { label: 'Inspect Olive UI', click: () => mgr.focusedWindow()?.ui.webContents.openDevTools({ mode: 'detach' }) },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
