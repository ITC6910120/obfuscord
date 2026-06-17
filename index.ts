/**
 * Discord Obfuscated Desktop Client
 *
 * Launches Discord through a local TLS-terminating proxy that:
 *
 * 1. Generates an in-memory Root CA + per-domain certificates
 * 2. Terminates Chromium's TLS (MITM) — accepts the self-signed cert via
 *    the `certificate-error` Electron event
 * 3. Creates a new TLS connection to Discord (no SNI, custom parameters)
 * 4. Bridges HTTP/2 traffic between the two TLS sockets
 *
 * The network sees TLS to a Cloudflare IP without SNI — it cannot determine
 * the target is Discord.
 */

import { app, BrowserWindow, session } from 'electron'
import { initCa } from './src/ca.js'
import { startProxy } from './src/local-proxy.js'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Cleanup function returned by the proxy server. */
let stopProxy: (() => void) | null = null

// ---------------------------------------------------------------------------
// Accept our self-signed certificates
// ---------------------------------------------------------------------------

// Register immediately (at the module level) so no events are missed.
// All external HTTPS passes through our local proxy, which terminates TLS
// with a self-signed cert. Chromium would normally reject this cert, but
// we override the certificate-error event to accept it.
app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
  event.preventDefault()
  callback(true)
})

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,  // Renderer cannot access Node.js APIs
      contextIsolation: true,  // Secure isolate renderer context
      sandbox: true,           // Enable Chromium sandbox for renderer
    },
  })

  // Allow only permissions Discord actually needs (notifications, media, fullscreen, clipboard).
  // Allowed automatically — no popup — because the renderer is sandboxed and trusted only for Discord.
  win.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = [
        'media',
        'notifications',
        'fullscreen',
        'clipboard-read',
        'clipboard-sanitized-write',
      ]
      callback(allowed.includes(permission))
    },
  )

  await win.loadURL('https://discord.com/app')
  return win
}

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

// Track whether we have initialised the CA + proxy.
// Needed because macOS `activate` may trigger createWindow() again.
let bootstrapped = false

async function bootstrap(): Promise<number> {
  if (bootstrapped) return 0
  bootstrapped = true

  // Step 1: Generate in-memory Root CA (RSA key pair + self-signed cert)
  initCa()

  // Step 2: Start local HTTP CONNECT proxy on a random port
  const { port, close } = await startProxy()
  stopProxy = close

  return port
}

async function main(): Promise<void> {
  const proxyPort = await bootstrap()

  await app.whenReady()

  // Route all Chromium traffic through our local proxy.
  // This must happen after app.whenReady() — session is not available before.
  await session.defaultSession.setProxy({
    proxyRules: `http://127.0.0.1:${proxyPort}`,
    proxyBypassRules: '<local>',  // Bypass proxy for local traffic
  })

  await createWindow()
}

// Start the boot sequence (top-level, runs immediately)
main().catch((err) => {
  console.error('Fatal error during startup:', err)
  app.quit()
})

// ---------------------------------------------------------------------------
// macOS lifecycle
// ---------------------------------------------------------------------------

// Keep the app alive when all windows are closed (macOS convention)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Re-create a window when the dock icon is clicked and no window exists
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    main()
  }
})

// Stop the proxy server when the app quits
app.on('before-quit', () => {
  stopProxy?.()
})
