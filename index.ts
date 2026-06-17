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

import { app, BrowserWindow, session, desktopCapturer } from 'electron'
import { initCa, getCaName } from './src/ca.js'
import { startProxy } from './src/local-proxy.js'
import { showPicker } from './src/picker.js'
import { pinAllDiscordDomains } from './src/pinner.js'

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
// Only certificates issued by our in-memory CA are accepted — all others
// are rejected, preventing a malicious actor from feeding Chromium a fake
// certificate through our proxy.
app.on('certificate-error', (event, _webContents, _url, _error, certificate, callback) => {
  // Accept only if the issuer matches our in-memory Root CA.
  // certificate can be undefined in some Electron versions.
  if (certificate?.issuerName?.includes(getCaName())) {
    event.preventDefault()
    callback(true)
  } else {
    callback(false)
  }
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

  // Permission REQUEST handler — grants permission when web content requests it
  // via APIs like getUserMedia(), getDisplayMedia(), etc.
  win.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = [
        'display-capture',   // Screen/window capture for screen sharing
        'speaker-selection', // Audio output device selection for screen share
        'media',
        'notifications',
        'fullscreen',
        'clipboard-read',
        'clipboard-sanitized-write',
      ]
      callback(allowed.includes(permission))
    },
  )

  // Override user agent to look like Chrome.
  // Discord's web app checks the user agent before enabling screen sharing;
  // if it detects Electron it shows "download the desktop app" instead.
  win.webContents.userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'

  // Permission CHECK handler — must also be set for complete permission coverage.
  // Many web APIs (including getDisplayMedia) CHECK permission first before
  // making a request; without this handler the check defaults to deny.
  win.webContents.session.setPermissionCheckHandler(
    (_webContents, permission, _requestingOrigin) => {
      const allowed = [
        'display-capture',
        'speaker-selection',
        'media',
        'notifications',
        'fullscreen',
        'clipboard-read',
        'clipboard-sanitized-write',
      ]
      const granted = allowed.includes(permission)
      if (!granted && process.env.DEBUG_PROXY) {
        console.log('[permission] Denied:', permission)
      }
      return granted
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

  // Step 3: Pre-fetch certificate pins for Discord domains (non-blocking).
  //   This connects directly to each domain without SNI, retrieves the
  //   server certificate, and stores its SPKI fingerprint in memory.
  //   If pre-fetch fails (e.g. network issue), per-request TOFU will
  //   handle it — the app will still work but without pin protection
  //   on the very first request to each domain.
  pinAllDiscordDomains()

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

  // Accept only certificates issued by our in-memory Root CA.
  // This hooks directly into Chromium's network service certificate verification
  // pipeline, which is more reliable than the app.on('certificate-error') event
  // in modern Electron (network service runs in a separate process).
  //
  // callback(0)  = trust the certificate.
  // callback(-3) = fall back to Chromium's default verification (which will
  //                reject our self-signed cert since it isn't in the system
  //                trust store).
  const caName = getCaName()
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (request.certificate?.issuerName?.includes(caName)) {
      callback(0)    // Accept — issued by our CA
    } else {
      callback(-3)   // Reject — use Chromium's built-in verification
    }
  })

  // Register display media handler for screen sharing (getDisplayMedia).
  // Uses desktopCapturer to list screens/windows and shows the picker UI.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (process.env.DEBUG_PROXY) {
        console.log('[display-media] Request from:', request.securityOrigin,
          'video:', request.videoRequested, 'audio:', request.audioRequested)
      }
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          // Small thumbnail to speed up loading
          thumbnailSize: { width: 200, height: 150 },
        })
        if (process.env.DEBUG_PROXY) {
          console.log('[display-media] Sources found:', sources.length,
            sources.map(s => s.name))
        }
        if (sources.length === 0) {
          callback({ video: undefined, audio: undefined })
          return
        }

        // Open a small picker window for the user to choose.
        const source = await showPicker(sources)

        if (!source) {
          // User cancelled — send empty stream so Discord closes the share prompt
          callback({ video: undefined, audio: undefined })
          return
        }

        callback({ video: source, audio: 'loopback' })
      } catch (err) {
        console.error('[display-media] Failed to get sources:', err)
        callback({ video: undefined, audio: undefined })
      }
    },
  )

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
