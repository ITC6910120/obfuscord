/**
 * TLS termination bridge.
 *
 * 1. Receives a connected TCP socket from Chromium (after CONNECT)
 * 2. Generates a cert for the target domain (signed by our in-memory CA)
 * 3. Performs **server-side** TLS with Chromium → decrypts Chromium's HTTP/2
 * 4. Resolves target via DoH → creates TCP connection
 * 5. Performs **client-side** TLS to the real server (no SNI, custom parameters)
 * 6. Pipes plaintext application data between the two TLS sockets
 *
 * This gives us full control over the TLS handshake to Discord while keeping
 * Chromium's network stack unaware of the obfuscation.
 */

import net from 'net'
import tls from 'tls'
import { signCert } from './ca.js'
import { resolveA } from './doh-resolver.js'
import { verifyPin } from './pinner.js'

/**
 * Terminates TLS from Chromium and establishes a new TLS connection to the
 * real server, bridging application data between them.
 *
 * @param clientSocket - The raw TCP socket already connected to Chromium
 *                       (after CONNECT 200 was sent)
 * @param hostname     - The target domain (e.g. "discord.com")
 * @param port         - The target port (typically 443)
 */
export async function terminateTls(
  clientSocket: net.Socket,
  hostname: string,
  port: number,
): Promise<void> {
  // -----------------------------------------------------------------------
  // 1. Generate a cert for this domain (signed by our in-memory Root CA)
  //    This MUST happen before sending 200 — Chromium waits for the response.
  // -----------------------------------------------------------------------
  const bundle = signCert(hostname)

  // -----------------------------------------------------------------------
  // 2. Notify Chromium that the tunnel is ready.
  //    Chromium will now send its TLS ClientHello on this socket.
  // -----------------------------------------------------------------------
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

  // -----------------------------------------------------------------------
  // 3. Perform **server-side** TLS with Chromium.
  //    We act as a TLS server, presenting our generated cert.
  // -----------------------------------------------------------------------
  const serverSide = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key: bundle.key,
    cert: bundle.cert,
  })

  await waitForSecure(serverSide)

  // -----------------------------------------------------------------------
  // 4. Resolve the real target IP via DoH.
  // -----------------------------------------------------------------------
  const ips = await resolveA(hostname)
  if (ips.length === 0) {
    serverSide.destroy()
    throw new Error(`DoH returned no IPs for ${hostname}`)
  }

  // -----------------------------------------------------------------------
  // 5. Perform **client-side** TLS to the real server.
  //    No SNI is sent — the target domain is hidden from the network.
  //
  //    Uses tls.connect() instead of new tls.TLSSocket(net.createConnection())
  //    because the latter can fail to populate getPeerCertificate() in some
  //    Node.js / Electron versions (especially when servername is undefined).
  // -----------------------------------------------------------------------
  const serverSide2 = await tlsConnect(ips[0]!, port)

  // -----------------------------------------------------------------------
  // 6. Verify the server's certificate against our stored pin.
  //    Without SNI we can't check the hostname normally, so we use SPKI
  //    fingerprint comparison (pinning). If verification fails the
  //    connection is rejected — preventing MITM attacks.
  // -----------------------------------------------------------------------
  const cert = serverSide2.getPeerCertificate()

  // Guard: if the TLS handshake completed, `raw` should always be present.
  // If it's missing it indicates a Node.js / Electron environment quirk.
  if (!cert || !cert.raw) {
    serverSide2.destroy()
    throw new Error(`No certificate available for ${hostname} (raw missing)`)
  }

  const pinError = verifyPin(hostname, cert)
  if (pinError) {
    serverSide2.destroy()
    throw pinError
  }

  // -----------------------------------------------------------------------
  // 7. Bridge application data between both TLS sockets.
  //    Both sides see plaintext (HTTP/2 frames) after TLS termination.
  // -----------------------------------------------------------------------
  serverSide.pipe(serverSide2)
  serverSide2.pipe(serverSide)

  // Cleanup: destroy both if either side closes or errors
  const cleanup = () => {
    serverSide.destroy()
    serverSide2.destroy()
  }

  serverSide.on('error', cleanup)
  serverSide.on('close', cleanup)
  serverSide2.on('error', cleanup)
  serverSide2.on('close', cleanup)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a client-side TLS connection to an IP address **without SNI**.
 *
 * Uses `tls.connect()` (not `new tls.TLSSocket` wrapping a raw socket)
 * because the wrapping approach can fail to populate `getPeerCertificate()`
 * in some Electron / Node.js versions when `servername` is `undefined`.
 *
 * @param ip   - Target IP address (resolved via DoH)
 * @param port - Target port (typically 443)
 * @returns A promise that resolves with the secure TLSSocket
 */
function tlsConnect(ip: string, port: number): Promise<tls.TLSSocket> {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const socket = tls.connect({
      host: ip,
      port,
      servername: undefined,       // ★ No SNI — obfuscation
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined, // Bypass hostname check (no SNI)
    })

    socket.on('secureConnect', () => resolve(socket))
    socket.on('error', reject)
  })
}

/**
 * Waits for the TLS handshake to complete on a TLSSocket.
 * Rejects if the handshake fails.
 */
function waitForSecure(socket: tls.TLSSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // If already secure (e.g., client socket connected synchronously)
    if (socket.encrypted) {
      resolve()
      return
    }

    const onSecure = () => {
      cleanup()
      resolve()
    }

    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }

    const onClose = () => {
      cleanup()
      reject(new Error('TLS socket closed during handshake'))
    }

    const cleanup = () => {
      socket.removeListener('secure', onSecure)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }

    socket.on('secure', onSecure)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}
