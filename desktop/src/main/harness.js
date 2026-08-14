'use strict'

/**
 * Supervises one `dsh web` child process.
 *
 * The harness prints its URL line once the plugin tree has settled and the
 * `/api` route owner is mounted, which upstream documents as the readiness
 * signal for supervisors. This shell waits for exactly that line rather than
 * polling the port, so the window never loads a half-mounted tree.
 */

const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const net = require('node:net')

/** How long a boot may take before the shell reports it as stuck. */
const READY_TIMEOUT_MS = 180_000
/** Upstream drains its plugin tree in up to five seconds after SIGTERM. */
const STOP_GRACE_MS = 8_000
/** `dsh web: http://127.0.0.1:3080 (LAN: ...)` — the leading URL is ours. */
const URL_LINE = /^dsh web:\s*(https?:\/\/\S+)/m

/** Ask the OS for a loopback port that is free right now. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

class HarnessProcess extends EventEmitter {
  /**
   * @param options.nodeBin - Node.js binary that runs the harness.
   * @param options.useElectronNode - Run `nodeBin` as plain Node (Electron fallback).
   * @param options.entry - `dsh` CLI entry script.
   * @param options.cwd - Working directory; the harness default workspace root.
   * @param options.dshHome - `$DSH_HOME` override, or null for the harness default.
   * @param options.port - Fixed port, or 0 to let the shell pick a free one.
   * @param options.userPath - `PATH` handed to the harness.
   * @param options.logger - Sink for harness output.
   */
  constructor(options) {
    super()
    this.options = options
    this.child = null
    this.url = null
    this.state = 'idle'
    this.recentOutput = []
    this.readyTimer = null
    this.stopping = false
  }

  /** Last lines of harness output, for an error dialog or the boot screen. */
  tail(lines = 40) {
    return this.recentOutput.slice(-lines).join('\n')
  }

  #record(chunk) {
    this.options.logger.writeRaw(chunk)
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length === 0) continue
      this.recentOutput.push(line)
      this.emit('output', line)
    }
    if (this.recentOutput.length > 500) this.recentOutput = this.recentOutput.slice(-500)
  }

  async start() {
    if (this.child !== null) return
    this.state = 'starting'
    this.url = null
    this.recentOutput = []

    const port = this.options.port > 0 ? this.options.port : await findFreePort()
    const env = { ...process.env }
    // Electron leaks its own launch variables into children; the harness must
    // see a plain Node environment.
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_NO_ASAR
    delete env.NODE_OPTIONS
    env.PATH = this.options.userPath
    env.DSH_DESKTOP = '1'
    if (this.options.dshHome !== null) env.DSH_HOME = this.options.dshHome
    if (this.options.useElectronNode) env.ELECTRON_RUN_AS_NODE = '1'

    const args = [this.options.entry, 'web', '--port', String(port)]
    this.options.logger.write(`spawn ${this.options.nodeBin} ${args.join(' ')} (cwd=${this.options.cwd})`)

    const child = spawn(this.options.nodeBin, args, {
      cwd: this.options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      this.#record(chunk)
      const match = chunk.match(URL_LINE)
      if (match !== null && this.state === 'starting') this.#markReady(match[1])
    })
    child.stderr.on('data', chunk => this.#record(chunk))

    child.on('error', error => {
      // A spawn failure emits 'error' without an 'exit', so the handle is
      // cleared here as well or a restart would refuse to start a new one.
      this.child = null
      this.state = 'failed'
      this.#clearReadyTimer()
      this.emit('failed', `Could not start the harness process: ${error.message}`)
    })

    child.on('exit', (code, signal) => {
      const wasReady = this.state === 'ready'
      this.child = null
      this.#clearReadyTimer()
      this.options.logger.write(`harness exited (code=${String(code)} signal=${String(signal)})`)
      if (this.stopping) {
        this.state = 'stopped'
        this.emit('stopped')
        return
      }
      this.state = 'failed'
      this.emit('failed', wasReady
        ? `The harness process exited unexpectedly (code ${String(code)}).`
        : `The harness process exited during startup (code ${String(code)}).`)
    })

    this.readyTimer = setTimeout(() => {
      if (this.state !== 'starting') return
      this.state = 'failed'
      this.emit('failed', 'The harness did not report a URL within three minutes.')
    }, READY_TIMEOUT_MS)
    this.readyTimer.unref?.()
  }

  #markReady(url) {
    this.#clearReadyTimer()
    this.state = 'ready'
    this.url = url
    this.options.logger.write(`harness ready at ${url}`)
    this.emit('ready', url)
  }

  #clearReadyTimer() {
    if (this.readyTimer === null) return
    clearTimeout(this.readyTimer)
    this.readyTimer = null
  }

  /**
   * Stop the harness, preferring its own graceful drain.
   * @returns once the child is gone, or after the grace period forces it.
   */
  async stop() {
    const child = this.child
    if (child === null) return
    this.stopping = true
    this.#clearReadyTimer()
    await new Promise(resolve => {
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        // A second signal is upstream's documented escalation; on Windows there
        // is no drain to escalate, so the tree is taken down directly.
        try {
          if (process.platform === 'win32') child.kill()
          else child.kill('SIGKILL')
        } catch {
          // Already gone between the timeout and this call.
        }
        resolve()
      }, STOP_GRACE_MS)
      child.once('exit', done)
      try {
        child.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
      } catch {
        done()
      }
    })
    this.child = null
    this.stopping = false
    this.state = 'stopped'
  }
}

module.exports = { HarnessProcess, findFreePort }
