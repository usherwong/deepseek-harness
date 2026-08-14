'use strict'

/**
 * Append-only log files under `userData/logs`, kept small enough to attach to a
 * bug report. The harness stream and the shell's own events are separated so a
 * boot failure can be read without the shell's noise around it.
 */

const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const MAX_BYTES = 5 * 1024 * 1024

function logsDir() {
  return path.join(app.getPath('userData'), 'logs')
}

function createLogger(name) {
  const file = path.join(logsDir(), `${name}.log`)
  let stream = null

  function open() {
    if (stream !== null) return stream
    fs.mkdirSync(logsDir(), { recursive: true })
    // Rotate by truncation: one previous generation is enough context for a
    // failed boot, and an unbounded log on a long-lived agent session is not.
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`)
    } catch {
      // No existing log, or a rename the filesystem refused.
    }
    stream = fs.createWriteStream(file, { flags: 'a' })
    return stream
  }

  return {
    file,
    write(line) {
      const stamped = `[${new Date().toISOString()}] ${line}`
      try {
        open().write(`${stamped}\n`)
      } catch {
        // Logging must never be the reason a boot fails.
      }
      if (!app.isPackaged) console.log(`${name}: ${line}`)
    },
    /** Raw harness output, already carrying its own line breaks. */
    writeRaw(chunk) {
      try {
        open().write(chunk)
      } catch {
        // See write().
      }
    },
  }
}

module.exports = { createLogger, logsDir }
