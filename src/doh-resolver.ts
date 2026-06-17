/**
 * DNS-over-HTTPS (DoH) resolver.
 *
 * Resolves hostnames via encrypted DNS to prevent:
 * - System hosts file redirects (e.g. discord.com -> 127.0.0.1)
 * - Network-level DNS hijacking / NXDOMAIN blocking
 *
 * Primary: Cloudflare DoH (cloudflare-dns.com)
 * Fallback: Google DoH (dns.google)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DnsAnswer {
  type: number
  data: string
}

interface DnsJsonResponse {
  Answer?: DnsAnswer[]
}

// ---------------------------------------------------------------------------
// DoH providers
// ---------------------------------------------------------------------------

/**
 * Resolves a hostname via Cloudflare's DNS-over-HTTPS API.
 * Returns IPv4 (type A) records only.
 */
async function resolveViaCloudflare(host: string): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`
  const res = await fetch(url, {
    headers: { accept: 'application/dns-json' },
  })

  if (!res.ok) {
    throw new Error(`Cloudflare DoH returned HTTP ${res.status}`)
  }

  const body: DnsJsonResponse = await res.json()
  return (body.Answer ?? []).filter((r) => r.type === 1).map((r) => r.data)
}

/**
 * Resolves a hostname via Google's DNS-over-HTTPS API (fallback).
 * Returns IPv4 (type A) records only.
 */
async function resolveViaGoogle(host: string): Promise<string[]> {
  const url = `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`
  const res = await fetch(url)

  if (!res.ok) {
    throw new Error(`Google DoH returned HTTP ${res.status}`)
  }

  const body: DnsJsonResponse = await res.json()
  return (body.Answer ?? []).filter((r) => r.type === 1).map((r) => r.data)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves a hostname to IPv4 addresses via DNS-over-HTTPS.
 * Tries Cloudflare first, falls back to Google on failure.
 *
 * @param host - Domain name to resolve (e.g. "discord.com")
 * @returns A promise resolving to an array of IP address strings
 */
export async function resolveA(host: string): Promise<string[]> {
  const errors: string[] = []

  // Primary: Cloudflare
  try {
    const ips = await resolveViaCloudflare(host)
    if (ips.length > 0) return ips
    errors.push('Cloudflare returned empty answer')
  } catch (err: unknown) {
    errors.push(`Cloudflare: ${(err as Error).message}`)
  }

  // Fallback: Google
  try {
    const ips = await resolveViaGoogle(host)
    if (ips.length > 0) return ips
    errors.push('Google returned empty answer')
  } catch (err: unknown) {
    errors.push(`Google: ${(err as Error).message}`)
  }

  throw new Error(
    `Failed to resolve ${host} via DoH:\n  ${errors.join('\n  ')}`
  )
}

// ---------------------------------------------------------------------------
// Discord-specific
// ---------------------------------------------------------------------------

/**
 * All known domains Discord's web app may connect to.
 *
 * Sourced from Discord's DNS records observed at runtime:
 * - cdn.discord.com does NOT exist (NXDOMAIN); use cdn.discordapp.com instead
 * - cdn.discordapp.net does NOT exist; use media.discordapp.net for media proxy
 */
const DISCORD_DOMAINS: string[] = [
  'discord.com',           // Main web app
  'cdn.discordapp.com',    // Static assets (avatars, emojis, icons)
  'media.discordapp.net',  // Media proxy (images, videos, embeds)
  'gateway.discord.gg',    // WebSocket gateway (real-time events)
  'discord.gg',            // Short-link redirect / invite links
  'discordapp.com',        // Legacy/redirect domain
]

/**
 * Resolves every known Discord domain to its first IPv4 address.
 * Silently skips domains that fail resolution.
 *
 * @returns A map of domain -> IP address
 */
export async function resolveDiscordDomains(): Promise<Map<string, string>> {
  const results = new Map<string, string>()

  await Promise.allSettled(
    DISCORD_DOMAINS.map(async (domain) => {
      const ips = await resolveA(domain)
      if (ips.length > 0) {
        results.set(domain, ips[0]!)
      }
    })
  )

  return results
}
