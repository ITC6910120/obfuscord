# In-Memory Certificate Authority (ca.ts)

## สารบัญ
- [ภาพรวม](#ภาพรวม)
- [Root CA Generation](#root-ca-generation)
- [Per-Domain Certificate (signCert)](#per-domain-certificate-signcert)
- [Certificate Cache](#certificate-cache)
- [Public API](#public-api)
- [Cross-reference](#cross-reference)

---

## ภาพรวม

`ca.ts` ทำหน้าที่สร้างและจัดการ **Certificate Authority และใบรับรองทั้งหมดในหน่วยความจำ (In-Memory)** โดยไม่มีการเขียนไฟล์ลงดิสก์ (ไม่มี `.pem`, `.crt`, `.key`)

**หลักการทำงาน:**
1. สร้าง Root CA แบบ self-signed ครั้งเดียวก่อน (ตอน `initCa()`)
2. สร้าง per-domain certificate สำหรับแต่ละ domain ที่ Chromium ร้องขอ (ตอน `signCert()`)
3. Root CA เซ็น (sign) ใบรับรองของ domain ต่างๆ
4. Chromium เชื่อถือใบรับรองนี้เพราะผ่าน `certificate-error` handler ใน `index.ts`

**ความปลอดภัย:** ทุกอย่างอยู่ใน RAM เมื่อปิดแอป = certificate หายไป ไม่มีร่องรอย

---

## Root CA Generation

### ฟังก์ชัน: `initCa()`

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

**รายละเอียดทางเทคนิค:**
- สร้าง RSA 2048-bit key pair (`forge.pki.rsa.generateKeyPair`)
- สร้าง self-signed X.509 certificate ด้วย `forge.pki.createCertificate()`
- Validity 10 ปี (สำหรับ 개발/signing เท่านั้น — ไม่ได้ใช้สำหรับ production)
- บันทึกในตัวแปร `caContext` (module-level private variable)
- เรียกครั้งเดียวตอน `bootstrap()` ใน `index.ts`

---

## Per-Domain Certificate (signCert)

### ฟังก์ชัน: `signCert(domain: string): CertBundle`

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

**รายละเอียดทางเทคนิค:**
- สร้าง key pair ใหม่ทุกครั้ง (RSA 2048-bit)
- Serial number ใช้ `Date.now().toString(16)` — ป้องกัน serial ซ้ำ
- Certificate validity: 1 ชั่วโมง (ค่าเริ่มต้น `CERT_TTL_MS = 60 * 60 * 1000`)
- extensions:
  - `basicConstraints: CA=false` — ไม่ใช่ CA
  - `keyUsage: digitalSignature, keyEncipherment` — สำหรับ server auth
  - `extKeyUsage: serverAuth` — ใช้เป็น server certificate
  - `subjectAltName: DNS:domain` — รองรับ SNI (แต่ไม่ได้ใช้)

---

## Certificate Cache

### กลไก: In-Memory Cache พร้อม TTL

```typescript
interface CacheEntry {
  bundle: CertBundle   // { key: string, cert: string } (PEM)
  expires: Date        // เวลาหมดอายุ
}

const certCache = new Map<string, CacheEntry>()
const CERT_TTL_MS = 60 * 60 * 1000 // 1 ชั่วโมง
```

**พฤติกรรม:**
1. มีการเรียก `signCert("discord.com")`
2. เช็ค `certCache.get("discord.com")`
3. ถ้ามี **และยังไม่ expire** → return cached bundle (ไม่ต้อง generate ใหม่)
4. ถ้าไม่มี **หรือ expire แล้ว** → generate ใหม่ → store cache → return

**ประโยชน์:** Chromium มักเปิดหลาย connection ไปยัง domain เดียวกัน (โดยเฉพาะ CDN) — cache ลดการ generate RSA key pair ซ้ำๆ ~2-5ms ต่อ request

---

## Public API

| ฟังก์ชัน | พารามิเตอร์ | คืนค่า | คำอธิบาย |
|---------|------------|--------|---------|
| `initCa()` | — | `void` | สร้าง Root CA ในหน่วยความจำ (เรียกครั้งเดียว) |
| `getCaName()` | — | `string` | คืนค่า `"Discord Obfuscated Proxy CA"` สำหรับตรวจสอบ issuerName |
| `signCert(domain)` | `domain: string` | `CertBundle` | สร้างหรือดึง certificate + key สำหรับ domain |
| `setVerbose(v)` | `v: boolean` | `void` | เปิด/ปิด verbose logging (สำหรับ debug) |

### CertBundle Interface

```typescript
interface CertBundle {
  key: string  // PEM-encoded private key
  cert: string // PEM-encoded certificate
}
```

---

## หมายเหตุสำคัญ

1. **RSA 2048-bit** — ปลอดภัย แต่ช้ากว่า ECDSA P-256 ถึง ~10 เท่า สำหรับ key generation
2. **Serial number ใช้ timestamp** — ไม่ใช่ cryptographic random แต่เพียงพอสำหรับการใช้งานเฉพาะนี้ (unique ต่อ millisecond)
3. **ใช้ `node-forge`** — pure JavaScript crypto library ไม่ต้อง native binding (compile ได้ทุกแพลตฟอร์ม)
4. **ไม่มี OCSP/CRL** — ไม่จำเป็นเพราะเป็น self-signed CA สำหรับ MITM ภายในเครื่อง

---

## Cross-reference

- [boot-sequence.md](../boot-sequence.md) — `initCa()` เป็นขั้นตอนแรกของ bootstrap
- [terminator.md](terminator.md) — `signCert()` ถูกเรียกจาก `terminateTls()` ก่อน `200 Connection Established`
- [pinner.md](pinner.md) — Certificate pinning ทำงานหลัง TLS handshake ฝั่ง client
