/**
 * Local HTTP CONNECT proxy with TLS termination.
 *
 * Listens on a random localhost port and handles HTTPS CONNECT requests:
 * 1. Reads the CONNECT request from Chromium
 * 2. Delegates to terminateTls() which generates a cert, does server-side TLS
 *    with Chromium, then creates an obfuscated TLS connection to the real server
 * 3. Bridges plaintext HTTP/2 between the two TLS sockets
 */

import net from 'net'
import { terminateTls } from './terminator.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProxyInfo {
  /** The random port the proxy is listening on (127.0.0.1) */
  port: number
  /** Close the proxy server and all active connections */
  close: () => void
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

/**
 * Starts the local HTTP CONNECT proxy on a random port.
 *
 * @returns The port number and a close function
 */
export async function startProxy(): Promise<ProxyInfo> {
  const server = net.createServer({ keepAlive: true }, (clientSocket) => {
    handleConnection(clientSocket)
  })

  return new Promise<ProxyInfo>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('Failed to get proxy server address (address is null or string)'))
        return
      }
      resolve({ port: addr.port, close: () => server.close() })
    })
    server.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

/**
 * Reads the HTTP CONNECT request and hands off to the TLS terminator.
 */
async function handleConnection(clientSocket: net.Socket): Promise<void> {
  // Read until we have the full HTTP headers (terminated by \r\n\r\n)
  let request: string
  try {
    request = await readHeaders(clientSocket)
  } catch {
    clientSocket.destroy()
    return
  }

  // Parse the CONNECT request line
  const match = request.match(/^CONNECT\s+([^:]+):(\d+)\s+HTTP\/1\.\d/i)
  if (!match) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return
  }

  const hostname = match[1]!
  const port = Number(match[2]!)

  // Hand off to the TLS terminator (async, runs in background).
  // terminateTls handles: cert generation → 200 → server TLS → DoH → client TLS → bridge
  terminateTls(clientSocket, hostname, port).catch((err) => {
    console.error(`[proxy] ${hostname}:${port} —`, (err as Error).message)
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Accumulates data from a socket until the HTTP header terminator (\r\n\r\n)
 * is found, then returns the complete header string.
 */
function readHeaders(socket: net.Socket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let data = ''
    let aborted = false

    const onData = (chunk: Buffer) => {
      data += chunk.toString()
      if (data.includes('\r\n\r\n')) {
        cleanup()
        resolve(data)
      }
    }

    const onError = (err: Error) => {
      if (!aborted) {
        aborted = true
        cleanup()
        reject(err)
      }
    }

    const onClose = () => {
      if (!aborted) {
        aborted = true
        cleanup()
        reject(new Error('Socket closed before headers were complete'))
      }
    }

    const cleanup = () => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }

    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}
