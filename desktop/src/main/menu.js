'use strict'

/**
 * Application menu. The harness Web UI owns everything about a session, so the
 * shell's own entries stay limited to what only the shell can do: pick the
 * workspace folder, restart the harness, and reach the logs.
 */

const { Menu, app, shell } = require('electron')

const REPOSITORY = 'https://github.com/usherwong/deepseek-harness'

function buildMenu(actions) {
  const isMac = process.platform === 'darwin'

  const template = [
    ...(isMac
      ? [{
          label: app.getName(),
          submenu: [
            { label: 'About DSH Desktop', click: actions.onAbout },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Change Workspace Folder…', accelerator: 'CmdOrCtrl+O', click: actions.onChangeWorkspace },
        { label: 'Restart Harness', accelerator: 'CmdOrCtrl+Shift+R', click: actions.onRestart },
        { type: 'separator' },
        { label: 'Open Logs Folder', click: actions.onOpenLogs },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
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
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'zoom' }],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Repository', click: () => void shell.openExternal(REPOSITORY) },
        { label: 'Harness Documentation', click: () => void shell.openExternal('https://github.com/deepseek-ai/deepseek-harness/tree/master/docs') },
        ...(isMac ? [] : [{ type: 'separator' }, { label: 'About DSH Desktop', click: actions.onAbout }]),
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

module.exports = { buildMenu }
