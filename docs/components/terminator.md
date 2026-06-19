# TLS Termination Bridge (terminator.ts)

## สารบัญ
- [ภาพรวม](#ภาพรวม)
- [การทำงานทีละขั้นตอน](#การทำงานทีละขั้นตอน)
- [Safety Timeouts](#safety-timeouts)
- [TLS Connect (Client-side)](#tls-connect-client-side)
- [Wait For Secure (Server-side)](#wait-for-secure-server-side)
- [Piping และ Cleanup](#piping-และ-cleanup)
- [ข้อสังเกตสำคัญ](#ข้อสังเกตสำคัญ)
- [Cross-reference](#cross-reference)

---

## ภาพรวม

`terminator.ts` คือ **หัวใจของระบบ** — ทำหน้าที่เป็นสะพาน (bridge) ระหว่าง TLS สองฝั่ง:

```
Chromium ←── Server-side TLS ←──→ terminator.ts ←──→ Client-side TLS (NO SNI) ←──→ Discord
```

**ความรับผิดชอบ:**
1. สร้าง certificate สำหรับ domain ที่ร้องขอ (เรียก `signCert()`)
2. ตอบ `200 Connection Established` กลับไปยัง Chromium
3. ทำ Server-side TLS กับ Chromium (proxy ปลอมตัวเป็น Discord)
4. ถาม IP จริงของ Discord ผ่าน DoH
5. ทำ Client-side TLS ไปยัง Discord **โดยไม่ส่ง SNI**
6. ตรวจสอบ Certificate Pinning หลัง TLS handshake
7. Pipe HTTP/2 data ระหว่างสอง TLS sockets

---

## การทำงานทีละขั้นตอน

### Sequence Diagram

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
   │    (คิดว่า proxy คือ Discord)      │    (isServer: true,           │
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
   │                                    │── tlsConnect(IP, 443)        │
   │                                    │    (isServer: false,          │
   │                                    │     servername: undefined)    │
   │                                    │    ★ NO SNI ★               │
   │                                    │                                │
   │                                    │═══ TLS Handshake ═══════════▶│
   │                                    │◀══ Certificate + Verify ═════│
   │                                    │                                │
   │                                    │── verifyPin("discord.com")   │
   │                                    │   (pinner.ts)                │
   │                                    │   → SPKI fingerprint check   │
   │                                    │                                │
   │◀══ HTTP/2 plaintext ══════════════│◀══ HTTP/2 plaintext ═════════│
   │    (ผ่าน .pipe())                  │    (ผ่าน .pipe())             │
   │════ HTTP/2 plaintext ════════════▶│════ HTTP/2 plaintext ════════▶│
   │                                    │                                │
```

### ขั้นตอนโดยละเอียด

#### Step 1: signCert(hostname)

```typescript
const bundle = signCert(hostname)
```
- เรียก `ca.ts` เพื่อสร้าง certificate สำหรับ domain
- **สำคัญ:** ต้องทำ **ก่อน** ส่ง `200 Connection Established` — Chromium รอ response

#### Step 2: 200 Connection Established

```typescript
clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
```
- Chromium ทราบว่าสามารถเริ่ม TLS handshake ได้
- หลังจากนี้ data บน socket คือ TLS traffic

#### Step 3: Server-side TLS (กับ Chromium)

```typescript
const serverSide = new tls.TLSSocket(clientSocket, {
  isServer: true,
  key: bundle.key,       // private key ของ domain cert
  cert: bundle.cert,     // certificate ที่ sign โดย Root CA
})
await waitForSecure(serverSide)
```
- Proxy ทำหน้าที่เป็น TLS server
- Chromium คิดว่ากำลังเชื่อมต่อ Discord โดยตรง
- หลัง `waitForSecure()` → TLS terminated → HTTP/2 plaintext

#### Step 4: DoH Resolution

```typescript
const ips = await resolveA(hostname)
if (ips.length === 0) {
  serverSide.destroy()
  throw new Error(`DoH returned no IPs for ${hostname}`)
}
```
- ถาม Cloudflare/Google ว่า IP จริงของ Discord คืออะไร
- ถ้าไม่มี IP → destroy socket + throw error

#### Step 5: Client-side TLS (ไปยัง Discord) ★ สำคัญที่สุด

```typescript
const serverSide2 = await tlsConnect(ips[0]!, port)
```
- สร้าง TLS connection ใหม่ไปยัง Discord
- **ไม่มี SNI** — network ไม่เห็น target domain
- ดูรายละเอียดใน [TLS Connect (Client-side)](#tls-connect-client-side)

#### Step 6: Certificate Pinning

```typescript
const cert = serverSide2.getPeerCertificate()
if (!cert || !cert.raw) {
  serverSide2.destroy()
  throw new Error(`No certificate available for ${hostname}`)
}
const pinError = verifyPin(hostname, cert)
if (pinError) {
  serverSide2.destroy()
  throw pinError
}
```
- ตรวจสอบ SPKI fingerprint ของ certificate ที่ Discord ส่งมา
- เทียบกับค่าที่ pre-fetch ไว้ตอน bootstrap (หรือ TOFU)
- ถ้าไม่ตรง → MITM detected → destroy socket

#### Step 7: Bridge/Pipe Data

```typescript
serverSide.pipe(serverSide2)  // Chromium → Discord
serverSide2.pipe(serverSide)  // Discord → Chromium

const cleanup = () => {
  serverSide.destroy()
  serverSide2.destroy()
}
serverSide.on('error', cleanup)
serverSide.on('close', cleanup)
serverSide2.on('error', cleanup)
serverSide2.on('close', cleanup)
```
- HTTP/2 data ถูก pipe แบบ transparent
- ถ้าฝั่งใดฝั่งหนึ่ง error/close → destroy ทั้งสอง socket

---

## Safety Timeouts

| ฟังก์ชัน | ใช้ที่ | Timeout Default | เกิดอะไรขึ้นเมื่อ timeout |
|----------|-------|-----------------|------------------------|
| `tlsConnect()` | Client-side TLS ไปยัง Discord IP | 15,000 ms | destroy socket + reject promise |
| `waitForSecure()` | Server-side TLS กับ Chromium | 10,000 ms | reject promise + cleanup listeners |

ทั้งสองฟังก์ชันใช้ `settled` flag และ `clearTimeout()` เพื่อป้องกัน **double resolve/reject**:

```typescript
let settled = false
const timer = setTimeout(() => {
  if (!settled) {
    settled = true
    socket.destroy()
    reject(new Error('Timeout'))
  }
}, timeoutMs)
socket.on('secureConnect', () => {
  if (!settled) {
    settled = true
    clearTimeout(timer)
    resolve(socket)
  }
})
socket.on('error', (err) => {
  if (!settled) {
    settled = true
    clearTimeout(timer)
    reject(err)
  }
})
```

---

## TLS Connect (Client-side)

### ฟังก์ชัน: `tlsConnect(ip, port, timeoutMs)`

```typescript
function tlsConnect(
  ip: string,
  port: number,
  timeoutMs = 15_000,
): Promise<tls.TLSSocket> {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    let settled = false

    const socket = tls.connect({
      host: ip,
      port,
      servername: undefined,       // ★ No SNI — obfuscation
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined, // Bypass hostname check (no SNI)
    })
    // ... timeout + event handlers
  })
}
```

### ประเด็นสำคัญ

| พารามิเตอร์ | ค่า | เหตุผล |
|------------|-----|--------|
| `host` | `ip` (DoH result) | เชื่อมต่อด้วย IP โดยตรง ไม่ใช้ domain |
| `servername` | `undefined` | **ไม่ส่ง SNI** → network ไม่รู้ target domain |
| `rejectUnauthorized` | `true` | ยังตรวจสอบ chain of trust ของ Discord cert |
| `checkServerIdentity` | `() => undefined` | bypass hostname check (ไม่มี SNI) — ป้องกันด้วย pinning |

**ทำไมใช้ `tls.connect()` ไม่ใช่ `new tls.TLSSocket(wrapping)`:**
- wrapping อาจทำให้ `getPeerCertificate()` ไม่ populate `raw`/`pubkey`
- โดยเฉพาะเมื่อ `servername` เป็น `undefined`

---

## Wait For Secure (Server-side)

### ฟังก์ชัน: `waitForSecure(socket, timeoutMs)`

```typescript
function waitForSecure(
  socket: tls.TLSSocket,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (socket.encrypted) {
      resolve()  // Already secure (rare case)
      return
    }
    // ... timeout + event handlers for 'secure', 'error', 'close'
  })
}
```

รองรับ 3 events:
| Event | เกิดเมื่อ | ผล |
|-------|---------|-----|
| `secure` | TLS handshake สำเร็จ | resolve |
| `error` | TLS handshake ล้มเหลว | reject |
| `close` | Socket ปิดก่อน handshake | reject |

---

## Piping และ Cleanup

### Data Flow

```
serverSide (decrypted HTTP/2)
        │
        ├── .pipe(serverSide2) → Client TLS → Discord
        │
serverSide2 (decrypted HTTP/2)
        │
        └── .pipe(serverSide) → Server TLS → Chromium
```

### Cleanup Logic

```typescript
const cleanup = () => {
  serverSide.destroy()
  serverSide2.destroy()
}

serverSide.on('error', cleanup)
serverSide.on('close', cleanup)
serverSide2.on('error', cleanup)
serverSide2.on('close', cleanup)
```

ทั้ง 4 events trigger cleanup:
- socket ใด socket หนึ่ง error → destroy ทั้งคู่
- socket ใด socket หนึ่ง close → destroy ทั้งคู่

---

## ข้อสังเกตสำคัญ

1. **No Connection Pooling** — ทุก request สร้าง TLS socket ใหม่ → latency + overhead
2. **No ALPN Setting** — ไม่ได้ระบุ ALPN protocols (`h2`, `http/1.1`) — ใช้ default ของ Node.js
3. **RSA Key Gen ทุก Connection แรก** — CPU-intensive (~2-5ms) แต่บรรเทาด้วย cert cache 1 ชม.
4. **WebSocket Support** — การ pipe raw data (HTTP/2) ควรรองรับ WebSocket upgrade โดยธรรมชาติ

---

## Cross-reference

- [ca.md](ca.md) — `signCert()` สร้าง certificate สำหรับ server-side TLS
- [doh-resolver.md](doh-resolver.md) — `resolveA()` สำหรับหา IP Discord
- [pinner.md](pinner.md) — `verifyPin()` ตรวจสอบ SPKI fingerprint หลัง TLS handshake
- [connection-flow.md](../connection-flow.md) — ดูภาพรวมการเชื่อมต่อ 1 ครั้ง
