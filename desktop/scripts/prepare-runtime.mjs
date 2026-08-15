#!/usr/bin/env node
/**
 * Stage the payload the Electron shell runs: a self-contained `dsh` install
 * plus the Node.js binary that executes it, both under `desktop/runtime/`.
 *
 * Two payload sources are supported. `npm` installs the published
 * `@deepseek-ai/dsh` and needs no repository toolchain; `source` builds this
 * checkout and deploys its `apps/cli` closure, which is what picks up local
 * harness edits. Either way the result is one directory tree that
 * electron-builder copies verbatim into the app as `extraResources`.
 *
 * Native dependencies decide the build topology: `koffi` ships its binding as a
 * platform-specific optional dependency and `node-pty` as per-platform
 * prebuilds, both resolved for the installing host. A payload must therefore be
 * staged on the machine architecture it will ship to. Cross-staging is possible
 * for the Node binary alone (`--platform`/`--arch`), not for the harness closure.
 *
 * Usage:
 *   node scripts/prepare-runtime.mjs [options]
 *     --mode npm|source     Override harness.json's mode.
 *     --version <semver>    npm mode: the @deepseek-ai/dsh version to install.
 *     --repo <path>         source mode: repository root, relative to desktop/.
 *     --node <major|semver> Node.js to bundle; "22" resolves the latest 22.x LTS.
 *     --platform <p>        Node binary target: darwin | win32 | linux.
 *     --arch <a>            Node binary target: arm64 | x64.
 *     --skip-node           Do not bundle Node; the shell falls back to Electron's.
 *     --no-prune            Keep foreign node-pty prebuilds and source maps.
 *     --keep                Keep an existing runtime/ instead of clearing it.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = path.join(desktopRoot, 'runtime')
const dshDir = path.join(runtimeDir, 'dsh')
const nodeDir = path.join(runtimeDir, 'node')

/**
 * Dependencies whose install scripts the harness genuinely needs. npm 11 gates
 * every install script behind an allowlist, and a silently skipped one leaves a
 * native module without its binary — a failure that only surfaces at runtime.
 */
const KNOWN_SCRIPT_PACKAGES = [
  '@deepseek-ai/dsh-subprocess-local',
  '@google/genai',
  'koffi',
  'node-pty',
  'protobufjs',
]

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    if (key === 'skip-node' || key === 'keep' || key === 'no-prune') {
      options[key] = true
      continue
    }
    options[key] = argv[index + 1]
    index += 1
  }
  return options
}

function log(message) {
  console.log(`prepare-runtime: ${message}`)
}

function fail(message) {
  console.error(`prepare-runtime: ${message}`)
  process.exit(1)
}

/** Run a command, streaming its output, and stop the build when it fails. */
function run(command, args, cwd) {
  log(`$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error !== undefined) fail(`${command} could not be started: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} exited with status ${String(result.status)}`)
}

/** Run a command for its output, returning null when it is unavailable. */
function capture(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    }).trim()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- npm payload

function stageFromNpm(config) {
  const spec = `${config.npm.package}@${config.npm.version}`
  fs.mkdirSync(dshDir, { recursive: true })
  fs.writeFileSync(
    path.join(dshDir, 'package.json'),
    `${JSON.stringify({
      name: 'dsh-runtime',
      version: '0.0.0',
      private: true,
      description: 'Staged DeepSeek Harness runtime for the Electron shell.',
      dependencies: { [config.npm.package]: config.npm.version },
      allowScripts: Object.fromEntries(KNOWN_SCRIPT_PACKAGES.map(name => [name, true])),
    }, null, 2)}\n`,
  )

  log(`installing ${spec}`)
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=warn'], dshDir)
  approveInstallScripts()

  const manifestPath = path.join(dshDir, 'node_modules', config.npm.package, 'package.json')
  if (!fs.existsSync(manifestPath)) fail(`npm install did not produce ${manifestPath}`)
  const installed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  return {
    entry: `node_modules/${config.npm.package}/lib/bin.js`,
    harnessVersion: installed.version,
    harnessCommit: null,
  }
}

/**
 * Approve and re-run every install script in the staged tree.
 *
 * npm 11 skips unapproved scripts with a warning rather than an error, so a new
 * upstream dependency would otherwise ship without its native binary. The
 * approval is announced because it decides what code runs at install time.
 */
function approveInstallScripts() {
  if (capture('npm', ['install-scripts', 'ls', '--json'], dshDir) === null) {
    log('npm install-scripts is unavailable; this npm runs install scripts directly')
    return
  }
  log('approving dependency install scripts (koffi and node-pty need theirs to place native binaries)')
  run('npm', ['install-scripts', 'approve', '--all', '--no-allow-scripts-pin'], dshDir)
  run('npm', ['rebuild', '--loglevel=warn'], dshDir)
}

// ------------------------------------------------------------- source payload

function stageFromSource(config) {
  const repoRoot = path.resolve(desktopRoot, config.source.repoRoot)
  if (!fs.existsSync(path.join(repoRoot, 'pnpm-workspace.yaml'))) {
    fail(`${repoRoot} is not a harness checkout (no pnpm-workspace.yaml).`)
  }
  if (capture('pnpm', ['--version']) === null) {
    fail('pnpm is required for source mode. Install it with "npm i -g pnpm", or use --mode npm.')
  }

  run('pnpm', ['install', '--frozen-lockfile'], repoRoot)
  run('pnpm', ['run', 'build'], repoRoot)

  // The deploy flags mirror the repository's own single-executable build: a
  // hoisted, symlink-free closure with peers supplied by the manifest.
  run('pnpm', [
    '--filter', config.source.filter,
    'deploy',
    '--legacy',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    dshDir,
  ], repoRoot)

  restoreLegacyHoists(repoRoot)
  materializeLinks(path.join(dshDir, 'node_modules'))
  restoreMissingWorkspacePackages(repoRoot)

  const staged = JSON.parse(fs.readFileSync(path.join(dshDir, 'package.json'), 'utf8'))
  const binEntry = typeof staged.bin === 'string' ? staged.bin : staged.bin?.dsh
  if (binEntry === undefined) fail('the deployed package declares no dsh bin entry')
  if (!fs.existsSync(path.join(dshDir, binEntry))) {
    fail(`the deployed package is missing ${binEntry}; did "pnpm run build" succeed?`)
  }
  return {
    entry: binEntry.replace(/^\.\//, ''),
    harnessVersion: staged.version,
    harnessCommit: capture('git', ['rev-parse', 'HEAD'], repoRoot),
  }
}

/**
 * Copy direct dependencies pnpm's legacy hoister left beside the deploy source.
 *
 * Legacy deploy can place a peer-specialized workspace package in the source
 * tree rather than the target, which leaves the staged closure short of a
 * dependency it declares.
 */
function restoreLegacyHoists(repoRoot) {
  const staged = JSON.parse(fs.readFileSync(path.join(dshDir, 'package.json'), 'utf8'))
  const sources = [
    path.join(repoRoot, 'apps', 'cli', 'node_modules'),
    path.join(repoRoot, 'node_modules'),
  ]
  const restored = []
  for (const dependency of Object.keys(staged.dependencies ?? {})) {
    const destination = path.join(dshDir, 'node_modules', dependency)
    if (fs.existsSync(destination)) continue
    const source = sources.map(base => path.join(base, dependency)).find(candidate => fs.existsSync(candidate))
    if (source === undefined) fail(`staged closure is missing ${dependency} and no source copy was found`)
    const nested = path.join(source, 'node_modules')
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.cpSync(source, destination, {
      recursive: true,
      dereference: true,
      filter: entry => entry !== nested && !entry.startsWith(nested + path.sep),
    })
    restored.push(dependency)
  }
  if (restored.length > 0) log(`restored legacy deploy hoists: ${restored.join(', ')}`)
}

/**
 * Replace symlinks with real copies.
 *
 * The payload is copied into an app bundle and, on Windows, onto a filesystem
 * where an unprivileged process cannot create links at all; a linked closure
 * would arrive broken on the user's machine.
 */
function materializeLinks(root) {
  if (!fs.existsSync(root)) return
  let replaced = 0
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        // A dangling `.bin` shim is disposable; a linked package is not.
        const resolved = fs.existsSync(target) ? fs.realpathSync(target) : null
        fs.rmSync(target, { recursive: true, force: true })
        if (resolved !== null) {
          fs.cpSync(resolved, target, { recursive: true, dereference: true })
          replaced += 1
        }
        continue
      }
      if (entry.isDirectory()) walk(target)
    }
  }
  walk(root)
  if (replaced > 0) log(`materialized ${String(replaced)} staged links`)
}

/**
 * The legacy deploy can omit transitive WORKSPACE packages (vendor and
 * nested packages) that the deploy root only reaches indirectly through
 * another workspace package. The published npm closure never hits this
 * because npm hoists every transitive dep; source mode must copy the missing
 * workspace packages from the built checkout so the staged closure is complete.
 */
function restoreMissingWorkspacePackages(repoRoot) {
  const workspaceByName = new Map()
  const scan = (dir, depth) => {
    if (depth === 0) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(dir, entry.name)
      const manifestPath = path.join(candidate, 'package.json')
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
          if (typeof manifest.name === 'string') workspaceByName.set(manifest.name, candidate)
        } catch {
          // A malformed manifest is not a package; skip it.
        }
      } else if (depth > 1) {
        scan(candidate, depth - 1)
      }
    }
  }
  scan(path.join(repoRoot, 'vendor'), 1)
  scan(path.join(repoRoot, 'packages'), 2)

  const modules = path.join(dshDir, 'node_modules')
  const staged = name => fs.existsSync(path.join(modules, name))
  const queue = []
  const seen = new Set()
  const rootManifest = JSON.parse(fs.readFileSync(path.join(dshDir, 'package.json'), 'utf8'))
  for (const dep of Object.keys(rootManifest.dependencies ?? {})) queue.push(dep)

  let copied = 0
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)

    let manifest
    const stagedManifest = path.join(modules, name, 'package.json')
    if (fs.existsSync(stagedManifest)) {
      manifest = JSON.parse(fs.readFileSync(stagedManifest, 'utf8'))
    } else {
      const source = workspaceByName.get(name)
      // Non-workspace missing packages are left to fail loudly on first load.
      if (source === undefined) continue
      const destination = path.join(modules, name)
      const nested = path.join(source, 'node_modules')
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.cpSync(source, destination, {
        recursive: true,
        dereference: true,
        filter: entry => entry !== nested && !entry.startsWith(nested + path.sep),
      })
      copied += 1
      log(`restored missing workspace package ${name}`)
      manifest = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'))
    }

    for (const key of ['dependencies', 'peerDependencies']) {
      for (const dep of Object.keys(manifest[key] ?? {})) queue.push(dep)
    }
  }
  if (copied > 0) log(`restored ${String(copied)} missing workspace package(s)`)
}

// -------------------------------------------------------------------- pruning

/** Source maps only feed a debugger; the shipped payload has no use for them. */
const SOURCE_MAP_SUFFIXES = ['.js.map', '.cjs.map', '.mjs.map', '.css.map']

/**
 * Drop payload files no installed build reads.
 *
 * node-pty publishes prebuilt bindings for every platform it supports in one
 * tarball, and each build ships to exactly one of them. Together with source
 * maps that is roughly a third of the staged closure.
 */
function prunePayload() {
  const modules = path.join(dshDir, 'node_modules')
  if (!fs.existsSync(modules)) return
  let bytes = 0

  const drop = target => {
    try {
      bytes += fs.statSync(target).size
      fs.rmSync(target, { recursive: true, force: true })
    } catch {
      // A file that vanished between the walk and the removal needs no report.
    }
  }

  const keep = `${process.platform}-${process.arch}`
  const prebuilds = path.join(modules, 'node-pty', 'prebuilds')
  if (fs.existsSync(prebuilds)) {
    for (const entry of fs.readdirSync(prebuilds)) {
      if (entry === keep) continue
      bytes += directorySize(path.join(prebuilds, entry))
      fs.rmSync(path.join(prebuilds, entry), { recursive: true, force: true })
    }
    if (!fs.existsSync(path.join(prebuilds, keep))) {
      fail(`node-pty ships no prebuild for ${keep}; the payload would have no pty support`)
    }
  }

  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(target)
      else if (SOURCE_MAP_SUFFIXES.some(suffix => entry.name.endsWith(suffix))) drop(target)
    }
  }
  walk(modules)

  log(`pruned ${String(Math.round(bytes / 1024 / 1024))} MB of foreign prebuilds and source maps`)
}

function directorySize(target) {
  let total = 0
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name)
    if (entry.isDirectory()) total += directorySize(child)
    else if (entry.isFile()) total += fs.statSync(child).size
  }
  return total
}

// ------------------------------------------------------------- native repairs

/** Restore the executable bit npm and archive extraction strip from prebuilts. */
function fixExecutableBits() {
  if (process.platform === 'win32') return
  const prebuilds = path.join(dshDir, 'node_modules', 'node-pty', 'prebuilds')
  if (!fs.existsSync(prebuilds)) return
  for (const entry of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, entry, 'spawn-helper')
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
  }
  log('restored spawn-helper executable bits')
}

// -------------------------------------------------------------- node bundling

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) fail(`GET ${url} failed with ${String(response.status)}`)
  return response.json()
}

async function fetchText(url) {
  const response = await fetch(url)
  if (!response.ok) fail(`GET ${url} failed with ${String(response.status)}`)
  return response.text()
}

/** Resolve a Node major such as "22" to the newest matching LTS release. */
async function resolveNodeVersion(request) {
  if (/^v?\d+\.\d+\.\d+$/.test(request)) return request.startsWith('v') ? request : `v${request}`
  const major = request.replace(/^v/, '')
  const index = await fetchJson('https://nodejs.org/dist/index.json')
  const match = index.find(release => release.version.startsWith(`v${major}.`) && release.lts !== false)
    ?? index.find(release => release.version.startsWith(`v${major}.`))
  if (match === undefined) fail(`no Node.js release found for major ${major}`)
  return match.version
}

async function bundleNode(version, platform, arch) {
  const osTag = platform === 'win32' ? 'win' : platform
  const isZip = platform === 'win32'
  const base = `node-${version}-${osTag}-${arch}`
  const file = `${base}.${isZip ? 'zip' : 'tar.gz'}`
  const url = `https://nodejs.org/dist/${version}/${file}`

  log(`downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) fail(`GET ${url} failed with ${String(response.status)}`)
  const archive = Buffer.from(await response.arrayBuffer())

  const shasums = await fetchText(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)
  const expected = shasums.split('\n').find(line => line.trim().endsWith(` ${file}`))?.split(/\s+/)[0]
  const actual = createHash('sha256').update(archive).digest('hex')
  if (expected === undefined) fail(`SHASUMS256.txt has no entry for ${file}`)
  if (expected !== actual) fail(`checksum mismatch for ${file}: expected ${expected}, got ${actual}`)
  log(`checksum verified (${actual.slice(0, 16)}…)`)

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-node-'))
  const archivePath = path.join(scratch, file)
  fs.writeFileSync(archivePath, archive)
  extract(archivePath, scratch, isZip)

  const extracted = path.join(scratch, base)
  fs.mkdirSync(nodeDir, { recursive: true })
  if (platform === 'win32') {
    // The Windows distribution is a flat directory; only the interpreter and
    // the ICU data beside it are needed to run the harness.
    fs.copyFileSync(path.join(extracted, 'node.exe'), path.join(nodeDir, 'node.exe'))
  } else {
    fs.mkdirSync(path.join(nodeDir, 'bin'), { recursive: true })
    fs.copyFileSync(path.join(extracted, 'bin', 'node'), path.join(nodeDir, 'bin', 'node'))
    fs.chmodSync(path.join(nodeDir, 'bin', 'node'), 0o755)
  }
  for (const notice of ['LICENSE']) {
    const source = path.join(extracted, notice)
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(nodeDir, `${notice}.node.txt`))
  }
  fs.rmSync(scratch, { recursive: true, force: true })
  log(`bundled Node.js ${version} (${platform}-${arch})`)
}

function extract(archivePath, destination, isZip) {
  if (!isZip) {
    run('tar', ['-xzf', archivePath, '-C', destination])
    return
  }
  if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path "${archivePath}" -DestinationPath "${destination}" -Force`])
    return
  }
  run('unzip', ['-q', archivePath, '-d', destination])
}

// --------------------------------------------------------------------- driver

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const config = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'harness.json'), 'utf8'))
  const mode = options.mode ?? config.mode
  if (mode !== 'npm' && mode !== 'source') fail(`unknown mode "${mode}"; expected npm or source`)
  if (options.version !== undefined) config.npm.version = options.version
  if (options.repo !== undefined) config.source.repoRoot = options.repo

  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch

  if (options.keep !== true) {
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  }
  fs.mkdirSync(runtimeDir, { recursive: true })

  log(`mode=${mode} target=${platform}-${arch}`)
  const staged = mode === 'npm' ? stageFromNpm(config) : stageFromSource(config)
  if (options['no-prune'] !== true) prunePayload()
  fixExecutableBits()

  let nodeVersion = null
  if (options['skip-node'] !== true) {
    nodeVersion = await resolveNodeVersion(options.node ?? config.node.range)
    await bundleNode(nodeVersion, platform, arch)
  } else {
    log('skipping Node.js bundling; the shell will fall back to Electron\'s runtime')
  }

  const manifest = {
    mode,
    harnessPackage: config.npm.package,
    harnessVersion: staged.harnessVersion,
    harnessCommit: staged.harnessCommit,
    entry: staged.entry,
    nodeVersion,
    platform,
    arch,
    builtAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(runtimeDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  log(`staged harness ${staged.harnessVersion} at ${dshDir}`)
  log(`entry: ${staged.entry}`)
}

await main()
