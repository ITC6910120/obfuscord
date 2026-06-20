# DNS-over-HTTPS Resolver (doh-resolver.ts)

## สารบัญ
- [ภาพรวม](#ภาพรวม)
- [DoH Providers](#doh-providers)
- [DNS Cache (In-Memory)](#dns-cache-in-memory)
- [Discord Domains](#discord-domains)
- [Public API](#public-api)
- [Cross-reference](#cross-reference)

---

## ภาพรวม

`doh-resolver.ts` ทำหน้าที่ **DNS resolution ผ่าน HTTPS** แทนการใช้ DNS ปกติของระบบปฏิบัติการ

**เหตุผลที่ต้องใช้ DoH:**
- ป้องกัน **DNS hijacking** — ISP หรือไฟร์วอลล์เปลี่ยน DNS response
- ป้องกัน **DNS poisoning** — ปลอมแปลง DNS record
- ป้องกัน **hosts file manipulation** — มัลแวร์แก้ไข `/etc/hosts`

**สถาปัตยกรรม:**

```
resolveA("discord.com")
    │
    ├── In-memory DNS Cache hit?
    │   ├── Yes → return cached IPs
    │   └── No → Continue
    │
    ├── Cloudflare DoH (Primary)
    │   GET https://cloudflare-dns.com/dns-query
    │   ?name=discord.com&type=A
    │   Accept: application/dns-json
    │   │
    │   └── ถ้าล้มเหลว → Google DoH (Fallback)
    │       GET https://dns.google/resolve
    │       ?name=discord.com&type=A
    │
    └── cache result → return ["104.16.X.X", ...]
```

---

## DoH Providers

### Primary: Cloudflare

```typescript
async function resolveViaCloudflare(host: string): Promise<DnsResult> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`
  const res = await fetch(url, {
    headers: { accept: 'application/dns-json' },
  })
  if (!res.ok) throw new Error(`Cloudflare DoH returned HTTP ${res.status}`)

  const body: DnsJsonResponse = await res.json()
  const answers = (body.Answer ?? []).filter((r) => r.type === 1)
  return { ips: answers.map((r) => r.data), ttl: pickTtl(answers) }
}
```

### Fallback: Google

```typescript
async function resolveViaGoogle(host: string): Promise<DnsResult> {
  const url = `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Google DoH returned HTTP ${res.status}`)

  const body: DnsJsonResponse = await res.json()
  const answers = (body.Answer ?? []).filter((r) => r.type === 1)
  return { ips: answers.map((r) => r.data), ttl: pickTtl(answers) }
}
```

### การเลือก TTL

```typescript
function pickTtl(answers: DnsAnswer[]): number {
  const ttls = answers
    .filter((a) => a.TTL !== undefined)
    .map((a) => a.TTL as number)
  return ttls.length > 0 ? Math.min(...ttls) : DNS_CACHE_MIN_TTL
}
```

เลือก TTL ที่ **น้อยที่สุด** ในบรรดา A-record answers → conservative (กัน cache stale)

---

## DNS Cache (In-Memory)

### Constants

```typescript
const DNS_CACHE_MIN_TTL = 60   // 1 นาที — ไม่ cache น้อยกว่านี้
const DNS_CACHE_MAX_TTL = 600  // 10 นาที — ไม่ cache เกินนี้
```

### Cache Entry

```typescript
interface CacheEntry {
  ips: string[]      // IPv4 addresses
  expiresAt: number  // epoch ms (Date.now() + TTL * 1000)
}

const dnsCache = new Map<string, CacheEntry>()
```

### กลไก

```typescript
function cacheResult(host: string, result: DnsResult): void {
  const ttl = Math.max(
    DNS_CACHE_MIN_TTL,
    Math.min(result.ttl, DNS_CACHE_MAX_TTL),  // clamp TTL
  )
  dnsCache.set(host, {
    ips: result.ips,
    expiresAt: Date.now() + ttl * 1000,
  })
}
```

### Cache Flow

```
resolveA("discord.com")
  │
  ├── Cache hit (TTL ยังไม่หมด)
  │   └── return cached.ips (ภายใน 0.01ms)
  │
  └── Cache miss (หมดอายุหรือไม่เคยมี)
      ├── DoH Cloudflare (wait ~50-150ms)
      ├── cacheResult() → store ใน Map
      └── return result.ips
```

**ประโยชน์:** ลด latency ~50-150ms ต่อ request สำหรับ domain เดิม

---

## Discord Domains

### รายชื่อ 6 Domains (hardcoded)

| Domain | การใช้งาน |
|--------|----------|
| `discord.com` | Web app หลัก |
| `cdn.discordapp.com` | Static assets (avatar, emoji, icons) — *cdn.discord.com* ไม่มี (NXDOMAIN) |
| `media.discordapp.net` | Media proxy (images, embeds) — *cdn.discordapp.net* ไม่มี |
| `gateway.discord.gg` | WebSocket gateway สำหรับ real-time events |
| `discord.gg` | Short-link / invite links |
| `discordapp.com` | Legacy / redirect |

### ฟังก์ชัน Utility: `resolveDiscordDomains()`

```typescript
export async function resolveDiscordDomains(): Promise<Map<string, string>> {
  const results = new Map<string, string>()
  await Promise.allSettled(
    DISCORD_DOMAINS.map(async (domain) => {
      const ips = await resolveA(domain)
      if (ips.length > 0) results.set(domain, ips[0]!)
    })
  )
  return results
}
```

resolve ทุก domain แบบ parallel — domain ที่ fail จะถูก skip (ไม่ throw)

---

## Public API

| ฟังก์ชัน | พารามิเตอร์ | คืนค่า | คำอธิบาย |
|---------|------------|--------|---------|
| `resolveA(host)` | `host: string` | `Promise<string[]>` | resolve domain → IPv4 addresses (cache-aware) |
| `resolveDiscordDomains()` | — | `Promise<Map<string, string>>` | resolve ทุก Discord domain แบบ parallel |

---

## ข้อจำกัด

| ข้อจำกัด | รายละเอียด |
|----------|-----------|
| **IPv4 only** | Query type A เท่านั้น — ไม่รองรับ AAAA (IPv6) |
| **Sequential fallback** | ลอง Cloudflare ก่อน → ถ้า fail ค่อยลอง Google — latency เพิ่ม |
| **No EDNS** | ไม่ส่ง EDNS Client Subnet (ECS) — CDN อาจให้ IP ที่ optimize ไม่เต็มที่ |
| **No CNAME follow** | ไม่ตาม CNAME chain — resolve เฉพาะ domain ที่เรียกตรงๆ |
| **Hardcoded domains** | ถ้า Discord เปลี่ยน domain structure ต้องอัปเดตเอง |

---

## Cross-reference

- [terminator.md](terminator.md) — `resolveA()` ถูกเรียกใน `terminateTls()` ก่อน tlsConnect
- [pinner.md](pinner.md) — `pinDomain()` ใช้ `resolveA()` เพื่อ pre-fetch pins
