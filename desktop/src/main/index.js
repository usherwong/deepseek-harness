'use strict'

/**
 * Desktop shell entry point.
 *
 * The shell owns a single window and a single `dsh web` child process. The
 * window shows a boot screen until the harness reports its URL, then navigates
 * to it; from that point the window is the harness Web UI and this process only
 * supervises, routes external links, and shuts the harness down cleanly.
 */

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const path = require('node:path')

const runtime = require('./runtime')
const { HarnessProcess } = require('./harness')
const { createLogger, logsDir } = require('./logger')
const { loadSettings, saveSettings } = require('./settings')
const { resolveUserPath } = require('./shell-path')
const { buildMenu } = require('./menu')

const BOOT_PAGE = path.join(__dirname, '..', '..', 'resources', 'loading.html')

const logger = createLogger('desktop')
const harnessLogger = createLogger('harness')

let mainWindow = null
let harness = null
let settings = null
let quitting = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  main()
}

function main() {
  app.on('second-instance', () => {
    if (mainWindow === null) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    settings = loadSettings()
    // The boot screen must be listening before the first status is pushed, or a
    // runtime that fails to start would report into a page that does not exist.
    await createWindow()
    buildMenu({ onChangeWorkspace: chooseWorkspace, onRestart: restartHarness, onOpenLogs: openLogs, onAbout: showAbout })
    await startHarness()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    if (harness !== null && harness.state === 'ready') mainWindow.loadURL(harness.url)
  })

  app.on('window-all-closed', () => {
    // macOS keeps a running agent alive behind a closed window; every other
    // platform treats the last window closing as a quit.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', event => {
    if (quitting || harness === null) return
    // Give the harness its drain window before the process group goes away.
    event.preventDefault()
    quitting = true
    harness.stop().finally(() => app.quit())
  })

  ipcMain.on('shell:retry', () => void restartHarness())
  ipcMain.on('shell:open-logs', openLogs)
  ipcMain.on('shell:choose-workspace', () => void chooseWorkspace())
  ipcMain.handle('shell:info', () => bootInfo())
}

function createWindow() {
  const bounds = settings.windowBounds ?? {}
  mainWindow = new BrowserWindow({
    width: bounds.width ?? 1280,
    height: bounds.height ?? 860,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#111318',
    title: 'DSH Desktop',
    // A standard title bar, because the window hosts the harness's own Web UI:
    // an inset bar would put the traffic lights on top of its sidebar.
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  const loaded = mainWindow.loadFile(BOOT_PAGE)

  mainWindow.on('close', () => {
    if (mainWindow === null) return
    saveSettings({ windowBounds: mainWindow.getNormalBounds() })
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Anything that is not the harness itself belongs in the user's browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isHarnessUrl(url) || url.startsWith('file://')) return
    event.preventDefault()
    openExternal(url)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.write(`renderer gone: ${details.reason}`)
  })

  return loaded
}

function isHarnessUrl(url) {
  if (harness === null || harness.url === null) return false
  try {
    return new URL(url).origin === new URL(harness.url).origin
  } catch {
    return false
  }
}

function openExternal(url) {
  if (!/^https?:\/\//i.test(url)) return
  void shell.openExternal(url)
}

/** Push a boot-screen state update; ignored once the window shows the harness. */
function sendStatus(payload) {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('shell:status', payload)
}

function bootInfo() {
  return {
    ...runtime.describe(),
    workspaceRoot: settings?.workspaceRoot ?? null,
    logsDir: logsDir(),
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
  }
}

async function startHarness() {
  const check = runtime.verify()
  if (!check.ok) {
    logger.write(check.reason)
    sendStatus({ phase: 'failed', message: 'Harness runtime not found', detail: check.reason })
    return
  }

  runtime.ensureExecutableBits()
  const node = runtime.nodeBinary()
  const info = runtime.describe()
  logger.write(`booting harness ${info.harnessVersion} (${info.harnessMode}) via ${node.path}`)

  sendStatus({
    phase: 'starting',
    message: 'Starting DeepSeek Harness…',
    detail: `workspace: ${settings.workspaceRoot}`,
  })

  harness = new HarnessProcess({
    nodeBin: node.path,
    useElectronNode: !node.bundled,
    entry: runtime.dshEntry(),
    cwd: settings.workspaceRoot,
    dshHome: settings.dshHome,
    port: settings.port ?? 0,
    userPath: resolveUserPath(),
    appVersion: app.getVersion(),
    logger: harnessLogger,
  })

  harness.on('output', line => sendStatus({ phase: 'log', line }))
  harness.on('ready', url => {
    if (mainWindow === null || mainWindow.isDestroyed()) return
    mainWindow.loadURL(url)
  })
  harness.on('failed', message => {
    logger.write(`harness failed: ${message}`)
    showFailure(message)
  })

  await harness.start()
}

/**
 * Return the window to the boot screen and report a failure there.
 *
 * The harness UI cannot render its own death, so a window already showing it is
 * navigated back to the local boot page before the message lands.
 */
function showFailure(message) {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  const detail = harness?.tail() ?? ''
  const report = () => sendStatus({ phase: 'failed', message, detail })
  if (mainWindow.webContents.getURL().startsWith('file://')) {
    report()
    return
  }
  mainWindow.webContents.once('did-finish-load', report)
  mainWindow.loadFile(BOOT_PAGE)
}

async function restartHarness() {
  if (mainWindow !== null && !mainWindow.isDestroyed()) await mainWindow.loadFile(BOOT_PAGE)
  if (harness !== null) {
    harness.removeAllListeners()
    await harness.stop()
    harness = null
  }
  settings = loadSettings()
  await startHarness()
}

async function chooseWorkspace() {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: 'Choose the folder the harness works in',
    defaultPath: settings.workspaceRoot,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Use this folder',
  })
  if (result.canceled || result.filePaths.length === 0) return
  settings = saveSettings({ workspaceRoot: result.filePaths[0] })
  logger.write(`workspace changed to ${settings.workspaceRoot}`)
  await restartHarness()
}

function openLogs() {
  void shell.openPath(logsDir())
}

function showAbout() {
  const info = bootInfo()
  void dialog.showMessageBox(mainWindow ?? undefined, {
    type: 'info',
    title: 'About DSH Desktop',
    message: `DSH Desktop ${info.appVersion}`,
    detail: [
      `Harness: ${info.harnessVersion} (${info.harnessMode})`,
      info.harnessCommit === null ? null : `Commit: ${info.harnessCommit}`,
      `Node: ${info.nodeVersion ?? 'bundled with Electron'}`,
      `Electron: ${info.electronVersion}`,
      `Workspace: ${info.workspaceRoot}`,
      `Logs: ${info.logsDir}`,
    ].filter(entry => entry !== null).join('\n'),
  })
}
