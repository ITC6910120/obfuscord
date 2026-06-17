/**
 * Certificate Pinning for Discord domains.
 *
 * Verifies the server's TLS certificate against a stored SPKI fingerprint.
 *
 * ## How it works
 *
 * 1. **Pre-fetch (bootstrap)** — `pinAllDiscordDomains()` connects to each
 *    known Discord domain *without SNI*, retrieves the certificate, computes
 *    the SHA-256 of the SubjectPublicKeyInfo (SPKI) in DER form, and stores
 *    the fingerprint in memory.
 *
 * 2. **Verify (per-request)** — `verifyPin()` is called from `terminator.ts`
 *    after the client-side TLS handshake completes. If a pin exists, the
 *    received certificate's SPKI fingerprint is compared against it. On
 *    mismatch the connection is rejected.
 *
 * 3. **TOFU fallback** — If no pin exists yet (e.g. a domain that wasn't
 *    pre-fetched), the first certificate seen is stored as the pin. This
 *    minimises the window of vulnerability while keeping the boot fast.
 *
 * ## Why SPKI fingerprinting?
 *
 * - SPKI (SubjectPublicKeyInfo) binds to the **public key**, not the whole
 *   certificate. When a certificate is renewed with the same key pair, the
 *   SPKI fingerprint stays the same, so the pin doesn't need updating.
 * - Using the public key also means we don't care about the exact cert
 *   presented (no dependency on CN/SAN which we can't verify without SNI).
 */

import tls from 'tls'
import crypto from 'crypto'
import { resolveA } from './doh-resolver.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PinEntry {
  spkiFingerprint: string // "sha256/<base64>"
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** In-memory store: hostname → SPKI fingerprint */
const pinStore = new Map<string, PinEntry>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Computes the SHA-256 fingerprint of a certificate's SubjectPublicKeyInfo.
 *
 * Uses `cert.raw` + `crypto.X509Certificate` as the primary path because
 * `cert.pubkey` may be `undefined` in some Node.js / Electron versions
 * (especially when `servername` is not set on the TLS socket).
 *
 * Returns a string in `"sha256/<base64>"` format.
 */
function computeSpkiFingerprint(cert: tls.PeerCertificate): string {
  // --- Primary: cert.raw + X509Certificate (reliable across Node versions) ---
  if (cert.raw) {
    const x509 = new crypto.X509Certificate(cert.raw)
    const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' }) as Buffer
    const hash = crypto.createHash('sha256').update(spkiDer).digest('base64')
    return `sha256/${hash}`
  }

  // --- Fallback: direct pubkey (may be undefined in some environments) -------
  const pubkey = cert.pubkey
  if (!pubkey) {
    throw new Error('Certificate has no public key and no raw DER')
  }

  let spkiDer: Buffer

  // Node.js >= 15: pubkey is a crypto.KeyObject
  if (typeof (pubkey as any).export === 'function') {
    spkiDer = (pubkey as any).export({ type: 'spki', format: 'der' }) as Buffer
  } else {
    // Node.js < 15: pubkey is a raw Buffer (already SPKI DER)
    spkiDer = pubkey as unknown as Buffer
  }

  const hash = crypto.createHash('sha256').update(spkiDer).digest('base64')
  return `sha256/${hash}`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stores a certificate pin for a domain (first-seen / TOFU).
 */
function storePin(hostname: string, cert: tls.PeerCertificate): void {
  const fingerprint = computeSpkiFingerprint(cert)
  pinStore.set(hostname, { spkiFingerprint: fingerprint })
}

/**
 * Verifies a server certificate against the stored pin.
 *
 * - **Pin exists** — compares the received cert's SPKI fingerprint.
 *   Returns an `Error` on mismatch (caller should destroy the socket).
 * - **No pin yet** — stores the cert as a pin (TOFU) and returns `undefined`.
 *
 * Called from `terminator.ts` after the client-side TLS handshake completes.
 */
export function verifyPin(
  hostname: string,
  cert: tls.PeerCertificate,
): Error | undefined {
  const existing = pinStore.get(hostname)

  if (!existing) {
    // Trust On First Use — no prior pin, store this one
    storePin(hostname, cert)
    return undefined
  }

  try {
    const actual = computeSpkiFingerprint(cert)

    if (actual !== existing.spkiFingerprint) {
      return new Error(
        `Certificate pin mismatch for ${hostname}\n` +
        `  Expected SPKI: ${existing.spkiFingerprint}\n` +
        `  Actual SPKI:   ${actual}`,
      )
    }

    return undefined // OK — identity verified
  } catch (err) {
    return new Error(
      `Failed to verify cert pin for ${hostname}: ${(err as Error).message}`,
    )
  }
}

/**
 * Returns `true` if a domain already has a stored pin (for debugging).
 */
export function isPinned(hostname: string): boolean {
  return pinStore.has(hostname)
}

// ---------------------------------------------------------------------------
// Bootstrap — pre-fetch pins for all known Discord domains
// ---------------------------------------------------------------------------

/**
 * Connects to a single domain **without SNI**, retrieves the server
 * certificate, and stores its SPKI fingerprint.
 *
 * Mimics the exact TLS behaviour used in `terminator.ts` so the
 * certificate we pin is the one our proxy will actually see.
 */
async function pinDomain(hostname: string): Promise<void> {
  const ips = await resolveA(hostname)
  if (ips.length === 0) {
    throw new Error(`DoH returned no IPs for ${hostname}`)
  }

  return new Promise<void>((resolve, reject) => {
    const socket = tls.connect({
      host: ips[0]!,       // Connect directly to the resolved IP
      port: 443,
      servername: undefined, // ★ No SNI — matches production behaviour
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined, // Bypass hostname check (no SNI)
    })

    // Safety timeout — if Discord doesn't respond within 10 s, skip this domain
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Timeout connecting to ${hostname}`))
    }, 10_000)

    socket.on('secureConnect', () => {
      clearTimeout(timer)
      try {
        const cert = socket.getPeerCertificate()
        storePin(hostname, cert)
        socket.end()
        socket.destroy()
        resolve()
      } catch (err) {
        socket.destroy()
        reject(err)
      }
    })

    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * Pre-fetches and stores certificate pins for all known Discord domains.
 *
 * Designed to be called **once** during bootstrap. Runs asynchronously
 * (non-blocking) — failures are logged but don't halt boot. Any domain
 * that wasn't pre-fetched will be pinned via TOFU on its first request.
 *
 * Known Discord domains (sourced from `doh-resolver.ts`):
 * - discord.com           — main web app
 * - cdn.discordapp.com    — static assets
 * - media.discordapp.net  — media proxy
 * - gateway.discord.gg    — WebSocket gateway
 * - discord.gg            — short-link / invites
 * - discordapp.com        — legacy / redirect
 */
export async function pinAllDiscordDomains(): Promise<void> {
  const domains = [
    'discord.com',
    'cdn.discordapp.com',
    'media.discordapp.net',
    'gateway.discord.gg',
    'discord.gg',
    'discordapp.com',
  ]

  const results = await Promise.allSettled(
    domains.map((domain) =>
      pinDomain(domain)
        .then(() => ({ domain, ok: true as const }))
        .catch((err: unknown) => ({
          domain,
          ok: false as const,
          error: (err as Error).message,
        })),
    ),
  )

  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { domain, ok, error } = r.value
      if (ok) {
        console.log('[pinner] Pinned', domain)
      } else {
        console.warn('[pinner] Skipped', domain, '-', error)
      }
    }
  }
}
