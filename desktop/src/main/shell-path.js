'use strict'

/**
 * The `PATH` the harness process should inherit.
 *
 * A macOS app launched from Finder or the Dock gets `launchd`'s minimal
 * environment, not the login shell's. The harness runs the user's real tooling —
 * git, package managers, language runtimes — so booting it under that stripped
 * `PATH` produces tool failures that look like harness bugs. Reading the login
 * shell's own `PATH` once at startup restores what a terminal `dsh` would see.
 */

const { execFileSync } = require('node:child_process')

const MARKER = '__DSH_DESKTOP_PATH__'
/** Locations a Finder-launched process misses even when the shell probe fails. */
const FALLBACKS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin']

let cached = null

function withFallbacks(value) {
  const entries = value.split(':').filter(entry => entry.length > 0)
  for (const fallback of FALLBACKS) {
    if (!entries.includes(fallback)) entries.push(fallback)
  }
  return entries.join(':')
}

/**
 * Resolve the login shell's `PATH`, memoized for the process lifetime.
 * @returns the resolved `PATH`, or the inherited one when the probe fails.
 */
function resolveUserPath() {
  if (cached !== null) return cached
  const inherited = process.env.PATH ?? ''
  if (process.platform === 'win32') {
    cached = inherited
    return cached
  }
  const shell = process.env.SHELL ?? '/bin/zsh'
  try {
    // An interactive login shell is what sources the profile files that build
    // PATH. Its stdout can carry banners and prompts, so the value is fenced by
    // a marker rather than read as the whole output.
    const output = execFileSync(shell, ['-ilc', `echo ${MARKER}:"$PATH":${MARKER}`], {
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, TERM: 'dumb', DISABLE_AUTO_UPDATE: 'true' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const match = output.match(new RegExp(`${MARKER}:(.*?):${MARKER}`))
    const resolved = match?.[1]?.trim()
    cached = withFallbacks(resolved !== undefined && resolved.length > 0 ? resolved : inherited)
  } catch {
    cached = withFallbacks(inherited)
  }
  return cached
}

module.exports = { resolveUserPath }
