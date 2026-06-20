# การเชื่อมต่อ 1 ครั้ง ทำงานอย่างไร

## สารบัญ
- [ภาพรวม](#ภาพรวม)
- [ขั้นตอนโดยละเอียด (15 Steps)](#ขั้นตอนโดยละเอียด-15-steps)
- [Sequence Diagram เต็ม](#sequence-diagram-เต็ม)
- [Safety Timeouts](#safety-timeouts)
- [Cross-reference](#cross-reference)

---

## ภาพรวม

เมื่อผู้ใช้เปิด Discord แล้ว Chromium ต้องการโหลด `https://discord.com/app` — คำขอเดียวนี้ต้องผ่านขั้นตอนต่างๆ มากมายตั้งแต่ proxy จนถึง TLS bridge ก่อนที่ข้อมูลจะถึง Discord จริง

---

## ขั้นตอนโดยละเอียด (15 Steps)

| ลำดับ | เกิดอะไรขึ้น | ใครทำ |
|-------|-------------|-------|
| 1 | Chromium ตรวจสอบ proxy settings → พบว่าต้องใช้ `http://127.0.0.1:XXXXX` | Electron / Chromium |
| 2 | Chromium สร้าง TCP connection ไปยัง `127.0.0.1:XXXXX` | OS / net |
| 3 | Chromium ส่ง `CONNECT discord.com:443 HTTP/1.1` | Chromium → local-proxy.ts |
| 4 | `local-proxy.ts` อ่าน HTTP headers → ได้ hostname `discord.com` | local-proxy.ts |
| 5 | เรียก `signCert("discord.com")` → สร้าง RSA key pair + sign cert ด้วย Root CA | ca.ts |
| 6 | ส่ง `HTTP/1.1 200 Connection Established` กลับไป | terminator.ts |
| 7 | สร้าง `tls.TLSSocket` ฝั่ง server เพื่อรับ TLS handshake จาก Chromium | terminator.ts |
| 8 | Chromium ส่ง ClientHello → proxy ส่ง ServerHello + Certificate กลับ | terminator.ts + Chromium |
| 9 | TLS handshake สำเร็จ → Chromium เริ่มส่ง HTTP/2 requests (plaintext ที่ proxy เห็น) | terminator.ts |
| 10 | DoH resolver ถาม Cloudflare ว่า `discord.com` IP คืออะไร | doh-resolver.ts |
| 11 | สร้าง TCP connection ไปยัง IP จริงของ Discord (เช่น `104.16.X.X:443`) | terminator.ts |
| 12 | `tlsConnect()` — TLS handshake กับ Discord **โดยไม่ส่ง SNI** | terminator.ts |
| 13 | TLS handshake กับ Discord สำเร็จ | Discord |
| **13.5** | **★ `verifyPin()` ตรวจสอบ SPKI fingerprint ของ Discord cert เทียบกับ pin → mismatch = reject** | **pinner.ts** |
| 14 | `serverSide.pipe(serverSide2)` — HTTP/2 data จาก Chromium → Discord | terminator.ts |
| 15 | `serverSide2.pipe(serverSide)` — HTTP/2 data จาก Discord → Chromium | terminator.ts |

**ผลลัพธ์:** Chromium คุยกับ Discord ได้ปกติ แต่เครือข่ายเห็นแค่ TLS ไปยัง Cloudflare IP โดยไม่มี SNI

---

## Sequence Diagram เต็ม

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

---

## Safety Timeouts

| ฟังก์ชัน | ใช้ที่ | Timeout | Default | เกิดอะไรขึ้นเมื่อ timeout |
|----------|-------|---------|---------|------------------------|
| `tlsConnect()` | Client-side TLS ไปยัง Discord IP | `timeoutMs` | 15,000 ms | destroy socket + reject promise → log error |
| `waitForSecure()` | Server-side TLS กับ Chromium | `timeoutMs` | 10,000 ms | reject promise → cleanup socket |

ทั้งสองฟังก์ชันใช้ `settled` flag และ `clearTimeout()` เพื่อป้องกัน **double resolve/reject** — กรณี socket เกิดทั้ง `secureConnect` และ `error` พร้อมกัน จะมีเพียง event แรกเท่านั้นที่ถูกดำเนินการ

---

## Cross-reference

- [boot-sequence.md](boot-sequence.md) — การบู๊ตก่อนหน้าที่ทำให้ระบบพร้อมทำงาน
- [components/terminator.md](components/terminator.md) — TLS bridge (หัวใจของระบบ)
- [components/ca.md](components/ca.md) — `signCert()` (Step 5)
- [components/doh-resolver.md](components/doh-resolver.md) — `resolveA()` (Step 10)
- [components/pinner.md](components/pinner.md) — `verifyPin()` (Step 13.5)
