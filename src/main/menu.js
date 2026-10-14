// native app menu; every action goes to the focused olive window
const { Menu, app, shell } = require('electron');
const path = require('path');

function buildMenu(mgr) {
  const w = (type, args) => () => {
    const win = mgr.focusedWindow();
    if (win) win.cmd(type, args);
    else if (type === 'newTab' || type === 'newWindow') mgr.newWindow({});
    else if (type === 'newPrivateWindow') mgr.newWindow({ private: true });
  };
  const hidden = (accelerator, type, args) => ({ label: type, accelerator, click: w(type, args), visible: false, acceleratorWorksWhenHidden: true });

  const template = [
    {
      label: 'Olive',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Set as Default Browser…', click: () => mgr.makeDefault() },
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
        { label: 'New Tab', accelerator: 'Cmd+T', click: w('newTab') },
        { label: 'New Window', accelerator: 'Cmd+N', click: w('newWindow') },
        { label: 'New Private Window', accelerator: 'Cmd+Shift+N', click: w('newPrivateWindow') },
        { label: 'Open Location…', accelerator: 'Cmd+L', click: w('openLocation') },
        { label: 'Reopen Closed Tab', accelerator: 'Cmd+Shift+T', click: w('reopenClosed') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'Cmd+W', click: w('closeTab') },
        { label: 'Close Window', accelerator: 'Cmd+Shift+W', click: () => mgr.focusedWindow()?.win.close() },
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
        { label: 'Copy URL', accelerator: 'Cmd+Shift+C', click: w('copyUrl') },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'Cmd+F', click: w('find') },
        { label: 'Find Next', accelerator: 'Cmd+G', click: w('findNext') },
        { label: 'Find Previous', accelerator: 'Cmd+Shift+G', click: w('findPrev') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'Cmd+S', click: w('toggleSidebar') },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'Cmd+R', click: w('reload') },
        { label: 'Hard Reload', accelerator: 'Cmd+Shift+R', click: w('hardReload') },
        { label: 'Stop', accelerator: 'Cmd+.', click: w('stop') },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'Cmd+0', click: w('zoomReset') },
        { label: 'Zoom In', accelerator: 'Cmd+=', click: w('zoomIn') },
        hidden('Cmd+Plus', 'zoomIn'),
        { label: 'Zoom Out', accelerator: 'Cmd+-', click: w('zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: w('nextTab') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: w('prevTab') },
        hidden('Cmd+Shift+]', 'nextTab'),
        hidden('Cmd+Shift+[', 'prevTab'),
        hidden('Cmd+Alt+Down', 'nextTab'),
        hidden('Cmd+Alt+Up', 'prevTab'),
        { type: 'separator' },
        { label: 'Pin / Unpin Tab', accelerator: 'Cmd+D', click: w('togglePin') },
        { label: 'Duplicate Tab', accelerator: 'Cmd+Shift+D', click: w('duplicate') },
        { type: 'separator' },
        { label: 'Split View with New Tab', accelerator: 'Ctrl+Shift+=', click: w('splitNew') },
        hidden('Ctrl+Shift+Plus', 'splitNew'),
        { label: 'Separate Split View', accelerator: 'Ctrl+Shift+-', click: w('unsplit') },
        { type: 'separator' },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => hidden(`Cmd+${n}`, 'selectIndex', { index: n })),
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'Cmd+[', click: w('back') },
        { label: 'Forward', accelerator: 'Cmd+]', click: w('forward') },
      ],
    },
    {
      label: 'Developer',
      submenu: [
        { label: 'Developer Tools', accelerator: 'Cmd+Alt+I', click: w('devtools') },
        { label: 'JavaScript Console', accelerator: 'Cmd+Alt+J', click: w('console') },
        hidden('F12', 'devtools'),
        { type: 'separator' },
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
