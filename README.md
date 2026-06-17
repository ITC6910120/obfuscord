# Discord Obfuscated Desktop Client

Desktop client สำหรับ Discord ที่ **อำพรางการสื่อสารในระดับเครือข่าย** โดยใช้เทคนิค Man-in-the-Middle (MITM) TLS proxy ที่ทำงานทั้งหมดในหน่วยความจำ (In-Memory) โดยไม่ทิ้งร่องรอยบนดิสก์

---

## สารบัญ

- [แนวคิดและที่มา](#แนวคิดและที่มา)
- [สถาปัตยกรรมโดยรวม](#สถาปัตยกรรมโดยรวม)
- [ส่วนประกอบของระบบ](#ส่วนประกอบของระบบ)
  - [1. index.ts — Entry Point / Electron Main Process](#1-indexts--entry-point--electron-main-process)
  - [2. src/ca.ts — In-Memory Certificate Authority](#2-srccats--in-memory-certificate-authority)
  - [3. src/doh-resolver.ts — DNS-over-HTTPS](#3-srcdoh-resolverts--dns-over-https)
  - [4. src/local-proxy.ts — HTTP CONNECT Proxy](#4-srclocal-proxyts--http-connect-proxy)
  - [5. src/terminator.ts — TLS Termination Bridge](#5-srcterminatorsts--tls-termination-bridge)
  - [6. src/pinner.ts — Certificate Pinning](#6-srcpinnerts--certificate-pinning)
- [ลำดับการทำงาน (Boot Sequence)](#ลำดับการทำงาน-boot-sequence)
- [การเชื่อมต่อ 1 ครั้ง ทำงานอย่างไร](#การเชื่อมต่อ-1-ครั้ง-ทำงานอย่างไร)
- [จุดแข็งและข้อจำกัด](#จุดแข็งและข้อจำกัด)
- [การติดตั้งและรัน](#การติดตั้งและรัน)
- [โครงสร้างโปรเจค](#โครงสร้างโปรเจค)

---

## แนวคิดและที่มา

### ปัญหาที่ต้องการแก้

การเชื่อมต่อไปยัง Discord โดยปกติจะ:
1. ส่ง **Server Name Indication (SNI)** ซึ่งระบุ `discord.com` ใน TLS handshake → ผู้ให้บริการเครือข่ายเห็นทันที
2. ใช้ **ระบบ DNS ของเครื่อง** ซึ่งอาจถูกแทรกแซง (DNS hijacking) หรือถูกบล็อก (DNS poisoning)
3. ใช้ **Root CA ของระบบ** เพื่อตรวจสอบใบรับรอง → หน่วยงานหรือมัลแวร์ที่สามารถติดตั้ง CA ลงในเครื่องสามารถ MITM ได้อยู่แล้ว

### แนวทางแก้

โปรเจคนี้ใช้แนวคิด **"Self-MITM Proxy"** หรือการสร้าง MITM proxy ขึ้นมาเองในเครื่อง:

1. **In-Memory Root CA** — สร้าง Certificate Authority ขึ้นมาเองในหน่วยความจำ (ไม่เคยแตะดิสก์)
2. **Local Proxy** — เปิด HTTP CONNECT proxy ที่ `localhost` แบบ random port
3. **บังคับ Chromium** (ผ่าน Electron) ให้ใช้ proxy นี้
4. **Terminate TLS** — ถอดรหัส TLS จาก Chromium แล้วสร้าง TLS ใหม่ไปยัง Discord
5. **ไม่มี SNI** — TLS handshake รอบที่สอง (ไปยัง Discord) **ไม่ส่ง SNI** ทำให้เครือข่ายไม่รู้ target

ผลลัพธ์: เครือข่ายเห็นแค่ TLS ไปยัง IP ของ Cloudflare โดยไม่มี SNI → ไม่สามารถระบุได้ว่ากำลังเชื่อมต่อไปยัง Discord

---

## สถาปัตยกรรมโดยรวม

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        YOUR COMPUTER                                     │
│                                                                          │
│  ┌──────────────────────────────────────────┐                            │
│  │           Electron / Chromium            │                            │
│  │                                          │                            │
│  │  https://discord.com/app                 │                            │
│  │         │                                │                            │
│  │         │  HTTP CONNECT                  │                            │
│  │         │  discord.com:443               │                            │
│  └─────────┼────────────────────────────────┘                            │
│            │                                                             │
│            ▼                                                             │
│  ┌──────────────────────────────────────────┐                            │
│  │         local-proxy.ts                   │                            │
│  │   (localhost:XXXXX random port)          │                            │
│  │                                          │                            │
│  │  TCP socket → terminator.ts              │                            │
│  └─────────┼────────────────────────────────┘                            │
│            │                                                             │
│            ▼                                                             │
│  ┌──────────────────────────────────────────┐                            │
│  │         terminator.ts                    │                            │
│  │                                          │                            │
│  │  1. signCert("discord.com") ← ca.ts     │                            │
│  │  2. 200 Connection Established           │                            │
│  │  3. Server-side TLS (with Chromium)      │                            │
│  │  4. resolveA("discord.com") ← doh.ts     │◄─── Cloudflare DoH        │
│  │  5. tlsConnect(IP, 443) — NO SNI!       │                            │
│  │  6. verifyPin("discord.com", cert)      │                            │
│  │     ← pinner.ts                          │                            │
│  │  7. Pipe HTTP/2 data                     │                            │
│  └─────────┼────────────────────────────────┘                            │
│            │                                                             │
└────────────┼─────────────────────────────────────────────────────────────┘
             │
             │  TLS to Cloudflare IP, no SNI
             │  (looks like generic Cloudflare traffic)
             ▼
┌──────────────────────────────────────────┐
│           Discord (via Cloudflare)       │
│  gateway.discord.gg                      │
│  discord.com                             │
└──────────────────────────────────────────┘
```

### ผัง Dependency

```
index.ts
├── src/ca.ts              ← Certificate generation
├── src/local-proxy.ts
│   └── src/terminator.ts
│       ├── src/ca.ts              ← signCert()
│       ├── src/doh-resolver.ts    ← resolveA()
│       └── src/pinner.ts          ← verifyPin()
├── src/pinner.ts          ← pinAllDiscordDomains()
└── electron (devDependency, external in bundle)
```

---

## ส่วนประกอบของระบบ

### 1. `index.ts` — Entry Point / Electron Main Process

ไฟล์แรกที่ถูกรัน ทำหน้าที่เป็นศูนย์กลางของแอปพลิเคชัน Electron และควบคุมลำดับการบู๊ต

**ความรับผิดชอบ:**

| หน้าที่ | รายละเอียด |
|---------|-----------|
| `certificate-error` handler | ลงทะเบียนตั้งแต่ module level เพื่อรับ self-signed cert ที่ proxy สร้าง — **ตรวจสอบ issuerName ว่าตรงกับ CA (`getCaName()`) ก่อน accept** — ต้องมาก่อน `app.whenReady()` |
| `setCertificateVerifyProc` | ตรวจสอบ issuerName ของ cert ที่ Chromium ได้ผ่าน network service — accept เฉพาะ cert ที่ CA ของเราออก, นอกนั้นใช้ Chromium default verification (`callback(-3)`) |
| `bootstrap()` | เรียก `initCa()` → `startProxy()` → คืนค่า proxy port |
| `session.setProxy()` | กำหนดให้ Chromium ใช้ proxy ของเรา — ต้องเรียก **หลัง** `app.whenReady()` |
| `createWindow()` | สร้าง `BrowserWindow` ด้วย `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` |
| macOS lifecycle | `window-all-closed` ไม่ปิดแอปบน macOS (native convention), `activate` สร้างหน้าต่างใหม่ |
| Cleanup | `before-quit` → หยุด proxy server |

**Security hardening ใน renderer:**
```typescript
webPreferences: {
  nodeIntegration: false,   // renderer ใช้ Node.js API ไม่ได้
  contextIsolation: true,   // แยก context renderer
  sandbox: true,            // เปิด sandbox ของ Chromium
}
```

### 2. `src/ca.ts` — In-Memory Certificate Authority

โมดูลที่สร้างและจัดการ **Certificate Authority และใบรับรองทั้งหมดในหน่วยความจำ**

**กลไกการทำงาน:**

#### Root CA Generation (`initCa()`)

```
┌─────────────────────────────────────┐
│         Root CA Certificate        │
│                                     │
│  Subject: CN = Discord Obfuscated  │
│           Proxy CA                  │
│  Issuer:  (self-signed)            │
│  Validity: 10 years                │
│  Key: RSA 2048-bit                  │
│                                     │
│  Extensions:                        │
│  ├── basicConstraints: CA=true     │
│  ├── keyUsage: keyCertSign         │
│  ├── subjectKeyIdentifier          │
│  └── authorityKeyIdentifier        │
└─────────────────────────────────────┘
```

#### Per-Domain Certificate (`signCert(domain)`)

```
┌─────────────────────────────────────┐
│   Certificate for discord.com       │
│                                     │
│  Subject: CN = discord.com         │
│  Issuer:  Discord Obfuscated       │
│           Proxy CA                  │
│  Validity: 1 hour (cached)         │
│  Key: RSA 2048-bit                  │
│                                     │
│  Extensions:                        │
│  ├── basicConstraints: CA=false    │
│  ├── keyUsage: digitalSignature,   │
│  │              keyEncipherment    │
│  ├── extKeyUsage: serverAuth       │
│  └── subjectAltName: DNS:discord   │
│                      .com          │
└─────────────────────────────────────┘
         ↑ signed by Root CA
```

**คุณสมบัติเด่น:**
- **In-Memory ทั้งหมด** — ไม่มีไฟล์ `.pem`, `.crt`, `.key` บนดิสก์
- **Cache 1 ชั่วโมง** — domain เดิมไม่ต้อง generate ใหม่ทุก request (Map in memory)
- **Serial Number** — ใช้ timestamp ป้องกันการซ้ำ (แต่ไม่ใช่ cryptographic random)
- **ใช้ `node-forge`** — pure JavaScript crypto library ไม่ต้อง native binding

### 3. `src/doh-resolver.ts` — DNS-over-HTTPS

ระบบ DNS ที่ทำงานผ่าน HTTPS แทนการใช้ DNS ปกติของระบบปฏิบัติการ

**เหตุผล:** ป้องกัน DNS hijacking, DNS poisoning, hosts file manipulation

**Flow การทำงาน:**

```
Client  ──HTTPS──▶  cloudflare-dns.com/dns-query?name=discord.com&type=A
                        │
                        │ ถ้าล้มเหลว
                        ▼
                    dns.google/resolve?name=discord.com&type=A
                        │
                        ▼
                    return ["104.16.x.x", ...]
```

**Discord domains ที่ hardcode ไว้ (6 domains):**

| Domain | การใช้งาน |
|--------|----------|
| `discord.com` | Web app หลัก |
| `cdn.discordapp.com` | Static assets (avatar, emoji, icons) — `cdn.discord.com` ไม่มี (NXDOMAIN) |
| `media.discordapp.net` | Media proxy (images, embeds) — `cdn.discordapp.net` ไม่มี |
| `gateway.discord.gg` | WebSocket gateway สำหรับ real-time events |
| `discord.gg` | Short-link / invite links |
| `discordapp.com` | Legacy / redirect |

**ข้อจำกัดสำคัญ:** IPv4 **เท่านั้น** — DNS query ใช้ type A (ไม่รองรับ AAAA record สำหรับ IPv6)

#### DNS Cache (In-Memory)

เพื่อลด latency ที่เกิดจากการเรียก DoH ซ้ำ ๆ สำหรับ domain เดิม (เช่น CDN assets หลายไฟล์จาก `cdn.discordapp.com`), ระบบมี **in-memory DNS cache**:

- **TTL จาก response จริง** — ใช้ค่า TTL ที่ Cloudflare/Google คืนมา **clamp** ไว้ที่ 60–600 วินาที
- **Cache key** — hostname (เช่น `discord.com`, `cdn.discordapp.com`)
- `resolveA()` เช็ค cache ก่อน DoH → cache hit → คืนทันที → **ลด latency ~50-150ms** ต่อ request
- cache expire → resolution ใหม่โดยอัตโนมัติผ่าน Cloudflare → Google fallback

```
resolveA("discord.com")
  ├── DNS Cache hit (TTL ยังไม่หมด) → return cached IPs
  └── DNS Cache miss → DoH Cloudflare → cache result → return
```

### 4. `src/local-proxy.ts` — HTTP CONNECT Proxy

TCP proxy server ขนาดเล็กที่ทำงานบน `localhost:random`

**ลักษณะการทำงาน:**

```http
# Chromium ส่ง:
CONNECT discord.com:443 HTTP/1.1
Host: discord.com:443

# Proxy ตอบ:
HTTP/1.1 200 Connection Established

# หลังจากนี้คือ TLS traffic ทั้งหมด (raw socket)
```

**รายละเอียด:**
- ใช้ `net.createServer({ keepAlive: true })` — เปิด TCP connection ค้างไว้
- Random port (`listen(0, '127.0.0.1')`) — ป้องกัน port contention
- อ่าน HTTP headers แบบบรรทัดต่อบรรทัดจนเจอ `\r\n\r\n`
- เมื่อได้ hostname:port แล้ว ส่งต่อไปยัง `terminateTls()` ทันที
- **Idle timeout 60 วินาที** — client socket ที่ไม่ตอบสนองจะถูก `destroy()` โดยอัตโนมัติ ป้องกัน resource leak (`clientSocket.setTimeout(60_000)`)


### 5. `src/terminator.ts` — TLS Termination Bridge

**หัวใจของระบบ** — ทำหน้าที่เป็นสะพานเชื่อม TLS ระหว่างสองฝั่ง

#### ขั้นตอนโดยละเอียด (ต่อ 1 request):

```
Chromium                          terminator.ts                      Discord Server
   │                                    │                                │
   │──── CONNECT discord.com:443 ──────▶│                                │
   │                                    │                                │
   │                                    │── signCert("discord.com")    │
   │                                    │   (ca.ts)                     │
   │                                    │                                │
   │◀── 200 Connection Established ─────│                                │
   │                                    │                                │
   │═══ TLS ClientHello ══════════════▶│═══ Server-side TLS ══════════▶│
   │    (คิดว่าเราคือ Discord)          │    (isServer: true,           │
   │                                    │     ใช้ cert ที่ sign ใหม่)  │
   │                                    │                                │
   │◀══ Server Hello + Cert ═══════════│                                │
   │                                    │                                │
   │═══ Change Cipher Spec ═══════════▶│                                │
   │◀══ Change Cipher Spec ════════════│                                │
   │                                    │                                │
   │              [TLS Established]     │                                │
   │                                    │                                │
   │                                    │── resolveA("discord.com")    │
   │                                    │   (doh-resolver.ts)          │
   │                                    │   → Cloudflare DoH           │
   │                                    │   → ["104.16.X.X", ...]      │
   │                                    │                                │
   │                                    │── net.createConnection(       │
   │                                    │     443, "104.16.X.X")       │
   │                                    │                                │
   │                                    │═══ Client-side TLS ═════════▶│
   │                                    │    (isServer: false,          │
   │                                    │     servername: undefined)    │
   │                                    │    ★ NO SNI ★               │
   │                                    │                                │
   │◀══ HTTP/2 plaintext ══════════════│◀══ HTTP/2 plaintext ═════════│
   │    (ผ่าน .pipe())                  │    (ผ่าน .pipe())             │
   │════ HTTP/2 plaintext ════════════▶│════ HTTP/2 plaintext ════════▶│
   │                                    │                                │
```

**ประเด็นสำคัญของ TLS ฝั่ง Client (ไปยัง Discord):**

```typescript
// ใช้ tls.connect() แทน new tls.TLSSocket(wrapping)
// เพราะ wrapping อาจทำให้ getPeerCertificate() ไม่ populate raw/pubkey
const serverSide2 = await tlsConnect(ips[0]!, port)

// หลัง TLS handshake → ตรวจสอบ SPKI fingerprint
const cert = serverSide2.getPeerCertificate()
const pinError = verifyPin(hostname, cert)
if (pinError) {
  serverSide2.destroy()
  throw pinError
}
```

- `tlsConnect()` ภายในใช้ `servername: undefined` → ClientHello จะไม่มี SNI extension → ไฟร์วอลล์/DPI ไม่เห็น target
- `rejectUnauthorized: true` → ยังตรวจสอบ chain of trust ของใบรับรอง (certificate validity, signing chain)
- `checkServerIdentity: () => undefined` → ถูก bypass (เพราะไม่มี SNI) แต่ **ป้องกันด้วย Certificate Pinning**:
  - `verifyPin()` ตรวจสอบ SPKI fingerprint เทียบกับค่าที่ pre-fetch ไว้
  - ถ้าไม่ตรง → reject connection ทันที → ป้องกัน MITM

#### Safety Timeouts

เพื่อป้องกัน connection ค้างเมื่อ Discord server ไม่ตอบสนอง (network partition, server down), ฟังก์ชันหลักทั้งสองมี timeout:

| ฟังก์ชัน | ใช้ที่ | Timeout | Default | เกิดอะไรขึ้นเมื่อ timeout |
|----------|-------|---------|---------|------------------------|
| `tlsConnect()` | Client-side TLS ไปยัง Discord IP | `timeoutMs` | 15,000 ms | destroy socket + reject promise → log error |
| `waitForSecure()` | Server-side TLS กับ Chromium | `timeoutMs` | 10,000 ms | reject promise → cleanup socket |

ทั้งสองฟังก์ชันใช้ `settled` flag และ `clearTimeout()` เพื่อป้องกัน **double resolve/reject** — กรณี socket เกิดทั้ง `secureConnect` และ `error` พร้อมกัน จะมีเพียง event แรกเท่านั้นที่ถูกดำเนินการ

---

### 6. `src/pinner.ts` — Certificate Pinning

โมดูลที่เพิ่ม **ความปลอดภัยในการตรวจสอบตัวตนของเซิร์ฟเวอร์ Discord** ด้วยเทคนิค Certificate Pinning — ตรวจสอบ Public Key ของใบรับรองจริง ๆ เทียบกับค่าที่รู้จัก เพื่อป้องกัน MITM Attack แม้ไม่ส่ง SNI

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

TOFU (Trust-On-First-Use):
  ถ้ายังไม่มี pin สำหรับ domain นี้ → เก็บ cert ปัจจุบันเป็น pin ทันที
```

**SPKI fingerprint (SubjectPublicKeyInfo)**
- ใช้ **public key** ไม่ใช่ทั้ง certificate → เมื่อ Discord ต่ออายุ certificate ด้วย key pair เดิม pin ยังใช้ได้
- ไม่ต้องพึ่งพา CN/SAN — ซึ่งไม่สามารถตรวจสอบได้เพราะไม่มี SNI

**Pinning Flow:**

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

**การนำไปใช้จริง:**

- **Pre-fetch ระหว่าง bootstrap** — `pinAllDiscordDomains()` ถูกเรียกแบบ async (ไม่บล็อก boot) ทันทีหลังจาก `startProxy()`
- **Fallback TOFU** — ถ้า pre-fetch ไม่ทัน (เช่น โดเมนใหม่ที่ยังไม่มีในรายการ), `verifyPin()` จะ TOFU ในการเชื่อมต่อแรก
- **ใช้ `cert.raw` + `crypto.X509Certificate`** — รองรับ Node.js ทุกเวอร์ชันที่ Electron 42 ใช้

---

## ลำดับการทำงาน (Boot Sequence)

ลำดับนี้ **ห้ามเปลี่ยน** เพราะแต่ละขั้นตอนขึ้นต่อกัน:

```
เวลา  ┌─────────────────────────────────────────────────┐
│     │ Module scope                                   │
│     │  • app.on('certificate-error') ← register ก่อน │
│     │    ทุกอย่าง (Electron event อาจมาก่อน ready)    │
│     ├─────────────────────────────────────────────────┤
│     │ bootstrap()                                    │
│     │  1. initCa()                                   │
│     │     └─ สร้าง Root CA key pair + self-signed    │
│     │  2. startProxy()                               │
│     │     └─ เปิด proxy ที่ localhost:random          │
│     │  3. pinAllDiscordDomains() (async)             │
│     │     └─ pre-fetch SPKI fingerprint ของ 6 domains│
│     ├─────────────────────────────────────────────────┤
│     │ app.whenReady()                                │
│     │  └─ Electron พร้อมใช้งาน                        │
│     ├─────────────────────────────────────────────────┤
│     │ session.defaultSession.setProxy()              │
│     │  └─ ตั้งค่าให้ Chromium ใช้ proxy ของเรา        │
│     │    ★ ต้องหลัง whenReady() ★                   │
│     ├─────────────────────────────────────────────────┤
│     │ createWindow()                                 │
│     │  └─ เปิด https://discord.com/app               │
│     ▼                                                │
```

**หมายเหตุสำคัญ:**
- `certificate-error` handler **ต้องอยู่ที่ module level** (ใน `index.ts`) เพราะ Electron อาจ emit event นี้ก่อน `app.whenReady()` — ปัจจุบันตรวจสอบ issuerName ว่า cert มาจาก CA ของเราหรือไม่
- `initCa()` **ต้องมาก่อน** `startProxy()` เพราะเมื่อ Chromium ส่ง CONNECT มา ฟังก์ชัน `signCert()` จะถูกเรียกทันที
- `pinAllDiscordDomains()` ทำงานแบบ async (non-blocking) คู่ขนานกับ `startProxy()` — ถ้ามี connection เข้ามาก่อน pinning เสร็จ, TOFU จะจัดการให้
- `session.setProxy()` **ต้องหลัง** `app.whenReady()` เพราะ `session` ยังไม่พร้อมก่อนหน้านั้น

---

## การเชื่อมต่อ 1 ครั้ง ทำงานอย่างไร

ยกตัวอย่างเมื่อผู้ใช้เปิด Discord แล้ว Chromium ต้องการโหลด `https://discord.com/app`:

| ลำดับ | เกิดอะไรขึ้น | ใครทำ |
|-------|-------------|-------|
| 1 | Chromium ตรวจสอบ proxy settings → พบว่าต้องใช้ `http://127.0.0.1:XXXXX` | Electron / Chromium |
| 2 | Chromium สร้าง TCP connection ไปยัง `127.0.0.1:XXXXX` | OS / net |
| 3 | Chromium ส่ง `CONNECT discord.com:443 HTTP/1.1` | Chromium → local-proxy.ts |
| 4 | `local-proxy.ts` อ่าน HTTP headers → ได้ hostname `discord.com` | local-proxy.ts |
| 5 | เรียก `signCert("discord.com")` → สร้าง RSA key pair + sign cert ด้วย Root CA | ca.ts |
| 6 | ส่ง `HTTP/1.1 200 Connection Established` กลับไป | terminator.ts |
| 7 | สร้าง `tls.TLSSocket` ฝั่ง server เพื่อรับ TLS handshake จาก Chromium | terminator.ts |
| 8 | Chromium ส่ง ClientHello → เรา (tls server) ส่ง ServerHello + Certificate กลับ | terminator.ts + Chromium |
| 9 | TLS handshake สำเร็จ → Chromium เริ่มส่ง HTTP/2 requests (plaintext ที่เราเห็น) | terminator.ts |
| 10 | DoH resolver ถาม Cloudflare ว่า `discord.com` IP คืออะไร | doh-resolver.ts |
| 11 | สร้าง TCP connection ไปยัง IP จริงของ Discord (เช่น `104.16.X.X:443`) | terminator.ts |
| 12 | `tlsConnect()` — TLS handshake กับ Discord **โดยไม่ส่ง SNI** | terminator.ts |
| 13 | TLS handshake กับ Discord สำเร็จ | Discord |
| **13.5** | **★ `verifyPin()` ตรวจสอบ SPKI fingerprint ของ Discord cert กับ pin ที่ pre-fetch ไว้ → mismatch = reject** | **pinner.ts** |
| 14 | `serverSide.pipe(serverSide2)` — HTTP/2 data จาก Chromium → Discord | terminator.ts |
| 15 | `serverSide2.pipe(serverSide)` — HTTP/2 data จาก Discord → Chromium | terminator.ts |

ผลลัพธ์: Chromium คุยกับ Discord ได้ปกติ แต่เครือข่ายเห็นแค่ TLS ไปยัง Cloudflare IP โดยไม่มี SNI

---

## จุดแข็งและข้อจำกัด

### จุดแข็ง

| ด้าน | รายละเอียด |
|------|-----------|
| **No SNI** | การเข้ารหัสสำคัญที่สุด — ไม่มี SNI ใน ClientHello → DPI ไม่รู้ target |
| **In-Memory CA** | ไม่มี certificate file บนดิสก์ → forensic trace น้อยมาก |
| **DoH + DNS Cache** | DNS resolution ปลอดภัยจาก hijacking/poisoning + in-memory cache ลด latency ~50-150ms ต่อ request |
| **Certificate Pinning** | ตรวจสอบ SPKI fingerprint หลัง TLS handshake — ป้องกัน MITM แม้ไม่มี SNI, TOFU + pre-fetch |
| **Certificate Verification (CA Check)** | `setCertificateVerifyProc` และ `certificate-error` ตรวจสอบ issuerName ว่า cert มาจาก CA ของเราเท่านั้น — ไม่ blanket accept |
| **Sandboxed Renderer** | Chromium sandbox + context isolation + nodeIntegration ปิด |
| **Minimal Dependencies** | พึ่งพาแค่ `node-forge` + `electron` — attack surface เล็ก |
| **Single Responsibility** | แต่ละไฟล์มีหน้าที่เดียวชัดเจน (SOC) |

### ข้อจำกัด

| ข้อจำกัด | ผลกระทบ | สาเหตุ |
|----------|---------|--------|
| **IPv4 only** | ถ้า Discord ย้ายเป็น IPv6 ล้วนจะใช้ไม่ได้ | DoH query type A เท่านั้น |
| **checkServerIdentity bypass** | ไม่ตรวจสอบ hostname (ไม่มี SNI) แต่ **ป้องกันด้วย Certificate Pinning** (`src/pinner.ts`) ซึ่งตรวจสอบ SPKI fingerprint หลัง handshake | `() => undefined` + `verifyPin()` ที่ terminator.ts |
| **TOFU Risk** | การเชื่อมต่อครั้งแรกไปยัง domain ใด ๆ ยังสุ่มเสี่ยง — ถ้า attacker อยู่บน network ในจังหวะนั้น, pin ที่เก็บจะเป็นของ attacker | pre-fetch อาจยังไม่เสร็จเมื่อ request แรกมา |
| **ไม่มี Connection Pooling** | ทุก request สร้าง TLS socket ใหม่ → latency + overhead | ใช้ `new tls.TLSSocket()` ทุกครั้ง |
| **Hardcoded Domains** | ถ้า Discord เปลี่ยน domain structure ต้องอัปเดตเอง | รายชื่อใน doh-resolver.ts:111–118 |
| **ไม่มี Tests** | เปลี่ยนโค้ดแล้วต้อง manual test ทุกครั้ง | ไม่มี test framework/config |
| **WebSocket Gateway** | `gateway.discord.gg` ถูก resolve แต่ bridge รองรับ WebSocket จริงหรือไม่ — ต้องตรวจสอบ | การ pipe raw data ควรใช้ได้ แต่ยังไม่ได้ทดสอบ |
| **No Logging** | Debug ยาก | log แค่ verbose mode + console.error |

---

## การติดตั้งและรัน

### สิ่งที่ต้องมี

- [Bun](https://bun.sh) v1.3.14+ (runtime + bundler)
- ระบบปฏิบัติการ: Windows, macOS, หรือ Linux

### คำสั่ง

```bash
# ติดตั้ง dependencies
bun install

# รันในโหมดพัฒนา (Bun รัน .ts โดยตรง)
bun run index.ts

# หรือ build + รันผ่าน Electron (production)
bun run build     # bundle → dist/index.js (ไฟล์เดียว ~525KB)
bun run start     # build + electron .
```

### การออกจากโปรแกรม

| วิธี | รายละเอียด |
|------|-----------|
| ปิดหน้าต่าง | ปกติ (บน macOS แอปไม่ปิด — ต้องปิดจาก Dock) |
| Ctrl+C | หยุดทุกอย่าง |
| Cmd+Q (macOS) | ปิดแอปสมบูรณ์ |

---

## โครงสร้างโปรเจค

```
discord/
├── index.ts              # Entry point — Electron main process
├── src/
│   ├── ca.ts             # In-memory Root CA + cert signing
│   ├── doh-resolver.ts   # DNS-over-HTTPS (Cloudflare → Google)
│   ├── local-proxy.ts    # HTTP CONNECT proxy
│   ├── pinner.ts         # Certificate pinning (SPKI fingerprint) + pre-fetch
│   └── terminator.ts     # TLS termination bridge (core logic)
├── dist/
│   └── index.js          # Build output (~530KB, single-file)
├── package.json          # "main": "dist/index.js"
├── tsconfig.json         # noEmit: true, bundler mode
├── bun.lock              # Bun lockfile v1
└── AGENTS.md             # Instruction file for OpenCode agents
```

### ไฟล์ที่เกี่ยวข้อง

| ไฟล์ | ความสำคัญ |
|------|-----------|
| `package.json` | ชี้ `main` → `dist/index.js`, script `build` ใช้ `bun build` |
| `tsconfig.json` | `noEmit: true` (Bun ไม่ใช้ tsc), `moduleResolution: "bundler"` |
| `AGENTS.md` | คำแนะนำสำหรับ OpenCode agent — ลำดับ boot, toolchain quirks, known limitations |

---

## เทคโนโลยีที่ใช้

| เทคโนโลยี | เวอร์ชัน | บทบาท |
|-----------|---------|--------|
| **Bun** | 1.3.14 | Runtime + Bundler (ไม่ใช้ tsc) |
| **Electron** | 42.4.1 | Chromium wrapper for desktop app |
| **TypeScript** | 5.x | ภาษา + type checking |
| **node-forge** | 1.4.0 | Pure JS crypto (RSA, X.509, PEM) |
| **Cloudflare DoH** | — | DNS resolution หลัก |
| **Google DoH** | — | DNS resolution สำรอง |
