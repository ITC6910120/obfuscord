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
  TTL?: number // seconds (optional — present in Cloudflare & Google responses)
}

interface DnsJsonResponse {
  Answer?: DnsAnswer[]
}

/** Internal result with IPs and the effective TTL from the response. */
interface DnsResult {
  ips: string[]
  ttl: number // seconds
}

// ---------------------------------------------------------------------------
// DNS cache
// ---------------------------------------------------------------------------

const DNS_CACHE_MIN_TTL = 60  // Minimum cache lifetime: 60 s
const DNS_CACHE_MAX_TTL = 600 // Maximum cache lifetime: 10 min

interface CacheEntry {
  ips: string[]
  expiresAt: number // epoch ms
}

const dnsCache = new Map<string, CacheEntry>()

/** Stores a resolution result with the TTL clamped to [min, max]. */
function cacheResult(host: string, result: DnsResult): void {
  const ttl = Math.max(
    DNS_CACHE_MIN_TTL,
    Math.min(result.ttl, DNS_CACHE_MAX_TTL),
  )
  dnsCache.set(host, { ips: result.ips, expiresAt: Date.now() + ttl * 1000 })
}

// ---------------------------------------------------------------------------
// DoH providers
// ---------------------------------------------------------------------------

/**
 * Picks the smallest TTL among all A-record answers, falling back to
 * DNS_CACHE_MIN_TTL if no TTL field is present.
 */
function pickTtl(answers: DnsAnswer[]): number {
  const ttls = answers
    .filter((a) => a.TTL !== undefined)
    .map((a) => a.TTL as number)
  return ttls.length > 0 ? Math.min(...ttls) : DNS_CACHE_MIN_TTL
}

/**
 * Resolves a hostname via Cloudflare's DNS-over-HTTPS API.
 * Returns IPv4 (type A) records only.
 */
async function resolveViaCloudflare(host: string): Promise<DnsResult> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`
  const res = await fetch(url, {
    headers: { accept: 'application/dns-json' },
  })

  if (!res.ok) {
    throw new Error(`Cloudflare DoH returned HTTP ${res.status}`)
  }

  const body: DnsJsonResponse = await res.json()
  const answers = (body.Answer ?? []).filter((r) => r.type === 1)
  return { ips: answers.map((r) => r.data), ttl: pickTtl(answers) }
}

/**
 * Resolves a hostname via Google's DNS-over-HTTPS API (fallback).
 * Returns IPv4 (type A) records only.
 */
async function resolveViaGoogle(host: string): Promise<DnsResult> {
  const url = `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`
  const res = await fetch(url)

  if (!res.ok) {
    throw new Error(`Google DoH returned HTTP ${res.status}`)
  }

  const body: DnsJsonResponse = await res.json()
  const answers = (body.Answer ?? []).filter((r) => r.type === 1)
  return { ips: answers.map((r) => r.data), ttl: pickTtl(answers) }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves a hostname to IPv4 addresses via DNS-over-HTTPS.
 * Results are cached in memory with the TTL provided by the resolver.
 *
 * Tries Cloudflare first, falls back to Google on failure.
 *
 * @param host - Domain name to resolve (e.g. "discord.com")
 * @returns A promise resolving to an array of IP address strings
 */
export async function resolveA(host: string): Promise<string[]> {
  // --- Check in-memory cache ---
  const cached = dnsCache.get(host)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.ips
  }

  const errors: string[] = []

  // Primary: Cloudflare
  try {
    const result = await resolveViaCloudflare(host)
    if (result.ips.length > 0) {
      cacheResult(host, result)
      return result.ips
    }
    errors.push('Cloudflare returned empty answer')
  } catch (err: unknown) {
    errors.push(`Cloudflare: ${(err as Error).message}`)
  }

  // Fallback: Google
  try {
    const result = await resolveViaGoogle(host)
    if (result.ips.length > 0) {
      cacheResult(host, result)
      return result.ips
    }
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
