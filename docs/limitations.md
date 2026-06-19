# ข้อจำกัดของระบบ (Known Limitations)

## สารบัญ
- [ภาพรวม](#ภาพรวม)
- [รายการข้อจำกัด](#รายการข้อจำกัด)
- [Cross-reference](#cross-reference)

---

## ภาพรวม

Obfuscord เป็น proof-of-concept / experimental project ที่มีข้อจำกัดหลายประการที่ควรทราบก่อนนำไปใช้จริง

---

## รายการข้อจำกัด

| # | ข้อจำกัด | ผลกระทบ | สาเหตุ | วิธีแก้ไขเบื้องต้น |
|---|---------|---------|-------|-----------------|
| 1 | **IPv4 only** | ถ้า Discord ย้ายเป็น IPv6 ล้วนจะใช้ไม่ได้ | DoH query type A เท่านั้น | เพิ่ม type AAAA query ใน `doh-resolver.ts` |
| 2 | **checkServerIdentity bypass** | ไม่ตรวจสอบ hostname (ไม่มี SNI) | `() => undefined` ใน `tlsConnect()` | Mitigated โดย Certificate Pinning (`pinner.ts`) |
| 3 | **TOFU Risk** | การเชื่อมต่อครั้งแรกสุ่มเสี่ยง — ถ้า attacker อยู่บน network ในจังหวะนั้น, pin ที่เก็บจะเป็นของ attacker | pre-fetch async อาจยังไม่เสร็จเมื่อ request แรกมา | Hardcode initial pins หรือ implement delayed verification |
| 4 | **ไม่มี Connection Pooling** | ทุก request สร้าง TLS socket ใหม่ → latency + overhead | ใช้ `new tls.TLSSocket()` ทุกครั้ง | Implement connection reuse หรือ socket pool |
| 5 | **Hardcoded Domains** | ถ้า Discord เปลี่ยน domain structure ต้องอัปเดตเอง | รายชื่อใน `doh-resolver.ts` | ย้ายเป็น configurable list หรือ auto-discover |
| 6 | **ไม่มี Tests** | เปลี่ยนโค้ดแล้วต้อง manual test ทุกครั้ง | ไม่มี test framework/config | เพิ่ม test framework (vitest, node:test) |
| 7 | **RSA Key Generation Cost** | CPU spike ตอน signCert() (~2-5ms ต่อ cert) | RSA 2048-bit key generation | เปลี่ยนเป็น ECDSA P-256 (เร็วกว่า ~10x) |
| 8 | **No ALPN Setting** | อาจ fallback เป็น HTTP/1.1 แทน HTTP/2 | ไม่ได้ระบุ `ALPNProtocols` | เพิ่ม `ALPNProtocols: ['h2', 'http/1.1']` |
| 9 | **No Pin Rotation** | ถ้า Discord เปลี่ยน key pair → connection reject | pin ถูกเก็บ forever | เพิ่ม TTL pin + multiple backup pins |
| 10 | **WebSocket Gateway Testing** | ยังไม่ได้รับการทดสอบว่า bridge รองรับ WebSocket จริงหรือไม่ | — | Manual testing กับ Discord gateway |

### รายละเอียดข้อจำกัดสำคัญ

#### 1. IPv4 Only
- `doh-resolver.ts` query type A (IPv4) เท่านั้น
- Discord ใช้ Cloudflare ซึ่งรองรับทั้ง IPv4 และ IPv6
- ถ้า ISP ให้เฉพาะ IPv6 หรือ Discord ย้ายเป็น IPv6 ล้วน — ระบบจะ fail

#### 2. checkServerIdentity bypass
```typescript
// terminator.ts
checkServerIdentity: () => undefined
```
- `tls.connect()` bypass การตรวจสอบ hostname เพราะไม่มี SNI
- **แต่ได้รับการป้องกันด้วย Certificate Pinning** — `verifyPin()` ตรวจสอบ SPKI fingerprint หลัง handshake
- ถ้า pinning ถูก bypass (TOFU attack) → ระบบไม่มีการป้องกัน hostname

#### 3. TOFU Risk
- `pinAllDiscordDomains()` ทำงานแบบ **async (non-blocking)**
- ถ้า Chromium เชื่อมต่อก่อน pre-fetch เสร็จ → `verifyPin()` จะ TOFU
- Attacker ที่ MITM ตั้งแต่ boot ครั้งแรก → compromised ตลอดไป (pin เก็บของ attacker)

#### 4. No Connection Pooling
- Chromium เปิดหลาย connection แบบ parallel (ปกติ ~6 ต่อ domain)
- แต่ละ connection ต้องผ่าน `terminateTls()` → server TLS → DoH → client TLS → verify
- Overhead สูงโดยเฉพาะตอนโหลด assets จำนวนมาก

---

## Cross-reference

- [security-model.md](security-model.md) — รายละเอียดมาตรการป้องกันข้อจำกัด
- [components/pinner.md](components/pinner.md) — TOFU, pinning mechanism
- [components/doh-resolver.md](components/doh-resolver.md) — IPv4, hardcoded domains
- [development.md](development.md) — การ setup environment, build, test
