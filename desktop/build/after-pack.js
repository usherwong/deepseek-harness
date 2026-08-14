'use strict'

/**
 * Ad-hoc sign unsigned macOS builds.
 *
 * Apple silicon refuses to execute a Mach-O binary that carries no signature at
 * all, so an unsigned build would install and then fail to launch. electron-
 * builder skips signing entirely when no Developer ID is configured; this hook
 * fills that gap with an ad-hoc signature, which is enough to run locally.
 *
 * It stays out of the way of real signing: when a certificate is configured,
 * electron-builder's own signing step owns the bundle and this hook does
 * nothing. An ad-hoc signature is not notarization — a downloaded build still
 * carries the quarantine flag until the user clears it.
 */

const { execFileSync } = require('node:child_process')
const path = require('node:path')

/** Whether a real certificate is configured, treating an empty value as none. */
function isSigningConfigured() {
  return ['CSC_LINK', 'CSC_NAME'].some(name => (process.env[name] ?? '').trim().length > 0)
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (isSigningConfigured()) return

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  try {
    execFileSync('codesign', [
      '--force',
      '--deep',
      '--sign', '-',
      '--options', 'runtime',
      '--entitlements', path.join(__dirname, 'entitlements.mac.plist'),
      appPath,
    ], { stdio: 'inherit' })
    console.log(`after-pack: ad-hoc signed ${appPath}`)
  } catch (error) {
    console.warn(`after-pack: ad-hoc signing failed (${error.message}); the build may not launch on Apple silicon`)
  }
}
