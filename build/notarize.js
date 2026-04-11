/**
 * build/notarize.js
 *
 * macOS notarisation hook — called by electron-builder after code signing.
 * Requires: npm install --save-dev @electron/notarize
 *
 * To activate, add these GitHub Actions secrets:
 *   APPLE_ID          — your Apple ID email
 *   APPLE_ID_PASSWORD — app-specific password (not your account password)
 *                       Generate at appleid.apple.com → App-Specific Passwords
 *   APPLE_TEAM_ID     — your 10-character Team ID from developer.apple.com
 *   APPLE_IDENTITY    — certificate name shown in Keychain Access, e.g.
 *                       "Developer ID Application: Framework Ltd (XXXXXXXXXX)"
 *
 * Once those secrets are set, this hook runs automatically on macOS CI builds.
 * On local builds or Windows, it exits immediately without doing anything.
 */

const { notarize } = require('@electron/notarize')

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context

  // Only run on macOS builds
  if (electronPlatformName !== 'darwin') return

  // Skip gracefully if credentials are not configured
  if (!process.env.APPLE_ID || !process.env.APPLE_ID_PASSWORD || !process.env.APPLE_TEAM_ID) {
    console.log('[notarize] Skipping — APPLE_ID / APPLE_ID_PASSWORD / APPLE_TEAM_ID not set.')
    console.log('[notarize] Add these as GitHub Actions secrets to enable notarisation.')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = `${appOutDir}/${appName}.app`

  console.log(`[notarize] Notarising ${appPath}...`)
  console.log(`[notarize] Apple ID: ${process.env.APPLE_ID}`)
  console.log(`[notarize] Team ID:  ${process.env.APPLE_TEAM_ID}`)

  await notarize({
    tool:            'notarytool',
    appPath,
    appleId:          process.env.APPLE_ID,
    appleIdPassword:  process.env.APPLE_ID_PASSWORD,
    teamId:           process.env.APPLE_TEAM_ID,
  })

  console.log('[notarize] Notarisation complete.')
}
