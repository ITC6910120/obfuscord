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
  // 4. Resolve the real target IP via DoH and create a TCP connection.
  // -----------------------------------------------------------------------
  const ips = await resolveA(hostname)
  if (ips.length === 0) {
    serverSide.destroy()
    throw new Error(`DoH returned no IPs for ${hostname}`)
  }

  const tcpSocket = net.createConnection(port, ips[0]!)

  // -----------------------------------------------------------------------
  // 5. Perform **client-side** TLS to the real server.
  //    No SNI is sent — the target domain is hidden from the network.
  // -----------------------------------------------------------------------
  const serverSide2 = new tls.TLSSocket(tcpSocket, {
    isServer: false,
    servername: undefined,
    rejectUnauthorized: true,
    checkServerIdentity: () => undefined,
  })

  await waitForSecure(serverSide2)

  // -----------------------------------------------------------------------
  // 6. Bridge application data between both TLS sockets.
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
// Helper
// ---------------------------------------------------------------------------

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
