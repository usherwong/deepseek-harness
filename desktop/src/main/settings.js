'use strict'

/**
 * User-scoped shell settings: which folder the harness treats as its workspace,
 * where its home directory lives, and the window geometry to restore.
 *
 * Harness state itself stays in `$DSH_HOME` (`~/.dsh` by default) so the desktop
 * app and a terminal `dsh` share one set of profiles, sessions, and credentials.
 */

const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const DEFAULTS = {
  /** Working directory of the harness process; the default workspace root. */
  workspaceRoot: null,
  /** Overrides `$DSH_HOME`. Null keeps the harness default, `~/.dsh`. */
  dshHome: null,
  /** 0 asks the shell to pick a free loopback port for every boot. */
  port: 0,
  windowBounds: { width: 1280, height: 860 },
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadSettings() {
  let stored = {}
  try {
    stored = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch {
    // First run, or a file we cannot parse: fall back to defaults.
  }
  const merged = { ...DEFAULTS, ...stored }
  if (typeof merged.workspaceRoot !== 'string' || !fs.existsSync(merged.workspaceRoot)) {
    merged.workspaceRoot = os.homedir()
  }
  return merged
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch }
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
    fs.writeFileSync(settingsFile(), `${JSON.stringify(next, null, 2)}\n`)
  } catch {
    // A settings write failure must not take the app down; the session simply
    // starts from defaults next time.
  }
  return next
}

module.exports = { loadSettings, saveSettings, settingsFile }
