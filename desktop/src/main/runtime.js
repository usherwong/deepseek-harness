'use strict'

/**
 * Locates the harness payload that `scripts/prepare-runtime.mjs` staged.
 *
 * Packaged builds carry the payload as an electron-builder `extraResources`
 * entry, so it lives beside the asar rather than inside it: the harness needs
 * real files on disk for its native `.node` bindings and for the `spawn-helper`
 * binary node-pty executes.
 */

const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

/** Root of the staged payload: `runtime/{node,dsh,manifest.json}`. */
function runtimeDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'runtime')
    : path.resolve(__dirname, '..', '..', 'runtime')
}

/** The payload description written by prepare-runtime, or null when unstaged. */
function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(runtimeDir(), 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * The Node.js binary the harness runs under.
 *
 * A bundled runtime is preferred because the harness declares its own Node
 * range and spawns worker threads and subprocesses that expect a plain Node
 * `process.execPath`. When no runtime was staged — an unprepared dev checkout —
 * Electron's own Node stands in through `ELECTRON_RUN_AS_NODE`.
 */
function nodeBinary() {
  const bundled = process.platform === 'win32'
    ? path.join(runtimeDir(), 'node', 'node.exe')
    : path.join(runtimeDir(), 'node', 'bin', 'node')
  if (fs.existsSync(bundled)) return { path: bundled, bundled: true }
  return { path: process.execPath, bundled: false }
}

/** Absolute path of the `dsh` CLI entry inside the staged payload. */
function dshEntry() {
  const manifest = readManifest()
  const relative = manifest?.entry ?? 'node_modules/@deepseek-ai/dsh/lib/bin.js'
  return path.join(runtimeDir(), 'dsh', ...relative.split('/'))
}

/**
 * Restore the executable bits npm and archive extraction drop.
 *
 * node-pty ships `spawn-helper` as a prebuilt file whose mode does not survive
 * packing; without `+x` every pty-backed tool fails at first use. The upstream
 * package repairs this in a postinstall script, which a packaged app never runs.
 */
function ensureExecutableBits() {
  if (process.platform === 'win32') return
  const node = nodeBinary()
  const candidates = [node.bundled ? node.path : null]
  const ptyPrebuilds = path.join(runtimeDir(), 'dsh', 'node_modules', 'node-pty', 'prebuilds')
  try {
    for (const entry of fs.readdirSync(ptyPrebuilds)) {
      candidates.push(path.join(ptyPrebuilds, entry, 'spawn-helper'))
    }
  } catch {
    // No node-pty prebuilds directory: nothing to repair.
  }
  for (const candidate of candidates) {
    if (candidate === null) continue
    try {
      if ((fs.statSync(candidate).mode & 0o111) === 0) fs.chmodSync(candidate, 0o755)
    } catch {
      // A missing or read-only candidate is reported later by the boot itself.
    }
  }
}

/** Whether a usable harness payload is staged, with the reason when it is not. */
function verify() {
  const entry = dshEntry()
  if (!fs.existsSync(entry)) {
    return {
      ok: false,
      reason: `Harness runtime is missing: ${entry}\n\nRun "npm run runtime" in desktop/ to stage it.`,
    }
  }
  return { ok: true, reason: null }
}

/** Human-readable payload summary for the About dialog and the boot log. */
function describe() {
  const manifest = readManifest()
  const node = nodeBinary()
  return {
    runtimeDir: runtimeDir(),
    entry: dshEntry(),
    node: node.path,
    nodeBundled: node.bundled,
    harnessMode: manifest?.mode ?? 'unknown',
    harnessVersion: manifest?.harnessVersion ?? 'unknown',
    harnessCommit: manifest?.harnessCommit ?? null,
    nodeVersion: manifest?.nodeVersion ?? null,
    builtAt: manifest?.builtAt ?? null,
  }
}

module.exports = { runtimeDir, readManifest, nodeBinary, dshEntry, ensureExecutableBits, verify, describe }
