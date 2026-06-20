# Certificate Pinning (pinner.ts)

## สารบัญ
- [ภาพรวม](#ภาพรวม)
- [SPKI Fingerprint](#spki-fingerprint)
- [กลไกการทำงาน](#กลไกการทำงาน)
- [TOFU (Trust-On-First-Use)](#tofu-trust-on-first-use)
- [Pre-fetch (Bootstrap)](#pre-fetch-bootstrap)
- [Verify (Per-request)](#verify-per-request)
- [Public API](#public-api)
- [ข้อควรระวัง](#ข้อควรระวัง)
- [Cross-reference](#cross-reference)

---

## ภาพรวม

`pinner.ts` เพิ่ม **ความปลอดภัยในการตรวจสอบตัวตนของเซิร์ฟเวอร์ Discord** ด้วยเทคนิค Certificate Pinning — ตรวจสอบ Public Key ของใบรับรองจริงๆ เทียบกับค่าที่รู้จัก เพื่อป้องกัน MITM Attack แม้ไม่ส่ง SNI

**แนวคิด:**

```
Pre-fetch (bootstrap):
  resolveA("discord.com") → tls.connect(IP, 443, { servername: undefined })
  → getPeerCertificate()
  → compute SPKI fingerprint (SHA-256 ของ SubjectPublicKeyInfo)
  → store ใน pinStore (in-memory Map)

Verify (per request, terminator.ts):
  TLS handshake กับ Discord เสร็จ → getPeerCertificate()
  → verifyPin(hostname, cert)
  → fingerprint ตรง → ✅ pipe data
  → fingerprint ไม่ตรง → ❌ destroy socket (MITM detected!)
```

---

## SPKI Fingerprint

### SubjectPublicKeyInfo (SPKI)

ใช้ **public key** ไม่ใช่ทั้ง certificate:
- เมื่อ Discord ต่ออายุ certificate ด้วย key pair เดิม → pin ยังใช้ได้ (SPKI fingerprint ไม่เปลี่ยน)
- ไม่ต้องพึ่งพา CN/SAN — ซึ่งไม่สามารถตรวจสอบได้เพราะไม่มี SNI

### การคำนวณ: `computeSpkiFingerprint(cert)`

```typescript
function computeSpkiFingerprint(cert: tls.PeerCertificate): string {
  // Primary path: cert.raw + X509Certificate (reliable)
  if (cert.raw) {
    const x509 = new crypto.X509Certificate(cert.raw)
    const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' })
    const hash = crypto.createHash('sha256').update(spkiDer).digest('base64')
    return `sha256/${hash}`
  }

  // Fallback: cert.pubkey (อาจ undefined ในบาง environment)
  const pubkey = cert.pubkey
  if (!pubkey) throw new Error('Certificate has no public key and no raw DER')

  let spkiDer: Buffer
  if (typeof (pubkey as any).export === 'function') {
    spkiDer = (pubkey as any).export({ type: 'spki', format: 'der' })
  } else {
    spkiDer = pubkey as unknown as Buffer  // Node < 15
  }

  const hash = crypto.createHash('sha256').update(spkiDer).digest('base64')
  return `sha256/${hash}`
}
```

**รูปแบบ:** `sha256/<base64>` — format เดียวกับ HPKP (RFC 7469)

---

## กลไกการทำงาน

### State

```typescript
interface PinEntry {
  spkiFingerprint: string  // "sha256/<base64>"
}

const pinStore = new Map<string, PinEntry>()
```

### Flow Diagram

```
bootstrap()
  │
  ├── resolveA("discord.com") → DoH (Cloudflare)
  ├── tls.connect({ host: IP, servername: undefined })
  ├── secureConnect → getPeerCertificate()
  ├── compute SHA-256 ของ SPKI DER
  └── store pinStore["discord.com"] = "sha256/abc123..."

terminateTls("discord.com")
  │
  ├── signCert() + 200 + server TLS (เหมือนเดิม)
  ├── resolveA() + tlsConnect(IP, 443) → TLS handshake (NO SNI)
  ├── getPeerCertificate()
  ├── verifyPin("discord.com", cert)
  │   ├── pinStore มี → เทียบ fingerprint
  │   │   ├── ตรง → ✅ pipe data
  │   │   └── ไม่ตรง → ❌ MITM detected! destroy socket
  │   └── pinStore ไม่มี → TOFU (Trust On First Use)
  └── pipe(serverSide, serverSide2)
```

---

## TOFU (Trust-On-First-Use)

### หลักการ

```typescript
export function verifyPin(hostname: string, cert: tls.PeerCertificate): Error | undefined {
  const existing = pinStore.get(hostname)

  if (!existing) {
    // Trust On First Use — ไม่มี pin มาก่อน → เก็บ cert ปัจจุบันเป็น pin
    storePin(hostname, cert)
    return undefined  // OK
  }

  // ... verification logic
}
```

**ข้อดี:** ไม่ต้อง hardcode pin ล่วงหน้า — ระบบเรียนรู้ pin ด้วยตัวเอง
**ข้อเสีย (TOFU Risk):** ถ้า attacker MITM ในครั้งแรก → pin ที่เก็บไว้คือของ attacker

### การบรรเทาความเสี่ยง TOFU

- **Pre-fetch:** `pinAllDiscordDomains()` ทำงานตั้งแต่ bootstrap (ก่อนมี traffic จริง)
- **ถ้า pre-fetch สำเร็จ:** ทุก domain มี pin แล้วก่อนที่ Chromium จะเชื่อมต่อ
- **ถ้า pre-fetch ล้มเหลว:** TOFU จะทำงานใน request แรก — มีความเสี่ยงในช่วงแรก

---

## Pre-fetch (Bootstrap)

### ฟังก์ชัน: `pinDomain(hostname)`

```typescript
async function pinDomain(hostname: string): Promise<void> {
  const ips = await resolveA(hostname)
  if (ips.length === 0) throw new Error(`DoH returned no IPs for ${hostname}`)

  return new Promise<void>((resolve, reject) => {
    const socket = tls.connect({
      host: ips[0]!,
      port: 443,
      servername: undefined,   // ★ No SNI — matches production behaviour
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined,
    })

    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Timeout connecting to ${hostname}`))
    }, 10_000)

    socket.on('secureConnect', () => {
      clearTimeout(timer)
      const cert = socket.getPeerCertificate()
      storePin(hostname, cert)
      socket.end()
      socket.destroy()
      resolve()
    })

    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}
```

### ฟังก์ชัน: `pinAllDiscordDomains()`

```typescript
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
  // log results
}
```

**เรียกระหว่าง bootstrap** — async, non-blocking:
- ทุก domain ทำแบบ parallel (Promise.allSettled)
- Fail → log warning, ไม่ halt boot
- Timeout: 10 วิ ต่อ domain

---

## Verify (Per-request)

### ฟังก์ชัน: `verifyPin(hostname, cert)`

```typescript
export function verifyPin(
  hostname: string,
  cert: tls.PeerCertificate,
): Error | undefined {
  const existing = pinStore.get(hostname)

  if (!existing) {
    // TOFU
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

    return undefined  // OK
  } catch (err) {
    return new Error(
      `Failed to verify cert pin for ${hostname}: ${(err as Error).message}`,
    )
  }
}
```

| กรณี | ผล | คำอธิบาย |
|------|-----|---------|
| Pin exists + fingerprint ตรง | `undefined` (OK) | ตัวตน verified |
| Pin exists + fingerprint ไม่ตรง | `Error` | MITM detected! Caller ต้อง destroy socket |
| No pin exists | TOFU (store + `undefined`) | เรียนรู้ pin ใหม่ |

---

## Public API

| ฟังก์ชัน | พารามิเตอร์ | คืนค่า | คำอธิบาย |
|---------|------------|--------|---------|
| `verifyPin(hostname, cert)` | `hostname: string`, `cert: PeerCertificate` | `Error \| undefined` | ตรวจสอบ cert เทียบ pin หรือ TOFU |
| `isPinned(hostname)` | `hostname: string` | `boolean` | เช็คว่า domain มี pin แล้วหรือยัง |
| `pinAllDiscordDomains()` | — | `Promise<void>` | Pre-fetch pins สำหรับ 6 Discord domains |

---

## ข้อควรระวัง

1. **TOFU Risk** — การเชื่อมต่อครั้งแรกสุ่มเสี่ยง ถ้า attacker อยู่บน network ในจังหวะนั้น
2. **No Pin Rotation** — เมื่อ pin แล้ว ไม่มี mechanism อัปเดต — ถ้า Discord เปลี่ยน key pair → connection reject
3. **No Backup Pins** — ควรมี pin หลายค่า (main + backup) สำหรับ key rotation
4. **Single IP Pre-fetch** — Pre-fetch ไปยัง IP แรกที่ DoH คืน — อาจไม่ใช่ IP ที่ CDN จ่ายใน request จริง
5. **HPKP (HTTP Public Key Pinning)** ไม่มี — application-level pinning เท่านั้น

---

## Cross-reference

- [terminator.md](terminator.md) — `verifyPin()` ถูกเรียกใน `terminateTls()` หลัง client TLS handshake
- [doh-resolver.md](doh-resolver.md) — `resolveA()` ใช้สำหรับ pre-fetch pins
- [security-model.md](../security-model.md) — ดูการวิเคราะห์ความปลอดภัยของ pinning
- [limitations.md](../limitations.md) — TOFU risk และข้อจำกัดอื่นๆ
