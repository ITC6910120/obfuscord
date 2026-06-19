# Security Model (รูปแบบความปลอดภัย)

## สารบัญ
- [ภาพรวม](#ภาพรวม)
- [จุดแข็ง](#จุดแข็ง)
- [Certificate Verification](#certificate-verification)
- [Permission Handlers](#permission-handlers)
- [Content Protection](#content-protection)
- [Sandboxed Renderer](#sandboxed-renderer)
- [Certificate Pinning](#certificate-pinning)
- [Cross-reference](#cross-reference)

---

## ภาพรวม

Obfuscord มีมาตรการรักษาความปลอดภัยหลายชั้น (defense in depth) ทั้งในระดับเครือข่าย (TLS, DNS, proxy) และระดับแอปพลิเคชัน (Electron security hardening)

---

## จุดแข็ง

| ด้าน | รายละเอียด |
|------|-----------|
| **No SNI** | การเข้ารหัสสำคัญที่สุด — ไม่มี SNI ใน ClientHello → DPI ไม่รู้ target |
| **In-Memory CA** | ไม่มี certificate file บนดิสก์ → forensic trace น้อยมาก |
| **DoH + DNS Cache** | DNS resolution ปลอดภัยจาก hijacking/poisoning + cache ลด latency |
| **Certificate Pinning** | ตรวจสอบ SPKI fingerprint หลัง TLS handshake — ป้องกัน MITM แม้ไม่มี SNI |
| **Certificate Verification (CA Check)** | `setCertificateVerifyProc` และ `certificate-error` ตรวจสอบ issuerName ว่า cert มาจาก CA ของเราเท่านั้น |
| **Sandboxed Renderer** | Chromium sandbox + context isolation + nodeIntegration ปิด |
| **Minimal Dependencies** | พึ่งพาแค่ `node-forge` + `electron` — attack surface เล็ก |
| **Dual Verification** | ทั้ง `certificate-error` (Electron event) และ `setCertificateVerifyProc` (Chromium network service) ป้องกันกัน |
| **Content Protection** | `setContentProtection(true)` — ป้องกัน OS-level screen capture |

---

## Certificate Verification

### กลไกตรวจสอบ certificate แบบ 2 ชั้น

#### ชั้นที่ 1: `certificate-error` (Electron Event)

```typescript
app.on('certificate-error', (event, _webContents, _url, _error, certificate, callback) => {
  if (certificate?.issuerName?.includes(getCaName())) {
    event.preventDefault()
    callback(true)   // ✅ Accept — cert มาจาก CA ของเรา
  } else {
    callback(false)  // ❌ Reject
  }
})
```

- Electron event ที่ fire เมื่อ Chromium พบ certificate error
- Accept **เฉพาะ** cert ที่ issuerName ตรงกับ CA ของเรา
- `preventDefault()` + `callback(true)` = trust cert
- **ป้องกัน:** attacker ที่ปล่อย cert ผ่าน proxy ของเรา

#### ชั้นที่ 2: `setCertificateVerifyProc` (Chromium Network Service)

```typescript
session.defaultSession.setCertificateVerifyProc((request, callback) => {
  if (request.certificate?.issuerName?.includes(caName)) {
    callback(0)    // ✅ Accept — มาจาก CA ของเรา
  } else {
    callback(-3)   // ❌ ใช้ Chromium default verification
  }
})
```

- Hooks เข้าไปใน Chromium network service (แยก process)
- callback(0) = trust cert
- callback(-3) = Chromium default verification (reject self-signed cert ที่ไม่ใช่ CA ของเรา)
- **ป้องกัน:** cert ที่ไม่ใช่ของ CA เราแต่ผ่าน proxy มายังโดน Chromium reject

#### ทำไมต้องมี 2 ชั้น?

```
certificate-error (Electron main process)
  └── รับ event เมื่อ Chromium พบ certificate error
      → ป้องกัน cert error dialog ที่อาจเกิดขึ้นเร็ว

setCertificateVerifyProc (Chromium network service process)
  └── ตรวจสอบทุก cert ที่ Chromium network service ได้รับ
      → ป้องกัน cert ที่รั่วไหลผ่าน pathway อื่น
```

### หมายเหตุเกี่ยวกับ `issuerName.includes()`

```typescript
// ตรวจสอบ string แบบ includes (ไม่ใช่ exact match)
certificate?.issuerName?.includes(getCaName())
```

- `getCaName()` คืนค่า `"Discord Obfuscated Proxy CA"`
- `includes()` — มีความเสี่ยง false positive ถ้ามี CA อื่นที่มีชื่อคล้ายกัน
- แต่ในทางปฏิบัติ cert ที่ผ่าน proxy ควรเป็น cert ที่เราสร้างเองเท่านั้น

---

## Permission Handlers

### Permission Request Handler

```typescript
win.webContents.session.setPermissionRequestHandler(
  (_webContents, permission, callback) => {
    const allowed = [
      'display-capture',   // Screen sharing
      'speaker-selection', // Audio output selection
      'media',
      'notifications',
      'fullscreen',
      'clipboard-read',
      'clipboard-sanitized-write',
    ]
    callback(allowed.includes(permission))
  },
)
```

**สิทธิ์ที่ Discord ได้รับ:**

| Permission | เหตุผล |
|-----------|--------|
| `display-capture` | Screen sharing |
| `speaker-selection` | เลือกอุปกรณ์เสียง |
| `media` | กล้องและไมโครโฟน (voice/video call) |
| `notifications` | การแจ้งเตือน |
| `fullscreen` | โหมดเต็มจอ |
| `clipboard-read` | แปะลิงก์/ข้อความ |
| `clipboard-sanitized-write` | คัดลอกข้อความ |

**สิทธิ์ที่ถูกปฏิเสธ:** `geolocation`, `midi`, `usb`, `serial`, `bluetooth`, `hid` — Discord ไม่จำเป็นต้องใช้

### Permission Check Handler

```typescript
win.webContents.session.setPermissionCheckHandler(
  (_webContents, permission, _requestingOrigin) => {
    const allowed = [ /* same list */ ]
    const granted = allowed.includes(permission)
    if (!granted && process.env.DEBUG_PROXY) {
      console.log('[permission] Denied:', permission)
    }
    return granted
  },
)
```

- ต้องมีทั้ง `setPermissionRequestHandler` และ `setPermissionCheckHandler`
- อันแรกสำหรับ permission request API (`getUserMedia` ฯลฯ)
- อันที่สองสำหรับ permission check API (`navigator.permissions.query`)

---

## Content Protection

```typescript
win.setContentProtection(true)
```

- **Windows:** ใช้ `SetWindowDisplayAffinity` API — window content ถูกป้องกันไม่ให้ถูก screen capture โดยแอปทั่วไป
- **macOS:** ใช้ `NSWindowSharingNone` — เหมือนกัน
- **Linux:** อาจไม่ support (แล้วแต่ compositor)

**ผลกระทบ:**
- Screenshot ทั่วไป (PrintScreen, Snipping Tool) จะเห็นหน้าต่างเป็นสีดำ
- Screen share ใน Discord (ผ่าน `getDisplayMedia`) — thumbnail จะเป็นสีดำ
  - ได้ filter ออกจาก picker ใน `index.ts` โดยการเช็ค `s.name.includes('discord')`

---

## Sandboxed Renderer

```typescript
webPreferences: {
  nodeIntegration: false,   // Renderer เรียก Node.js API ไม่ได้
  contextIsolation: true,   // แยก JavaScript context (preload vs renderer)
  sandbox: true,            // Chromium sandbox (OS-level isolation)
}
```

| มาตรการ | ป้องกันอะไร |
|---------|------------|
| `nodeIntegration: false` | Renderer process เรียก `require()`, `process`, `fs` ไม่ได้ |
| `contextIsolation: true` | preload script และ web page มี context แยกกัน |
| `sandbox: true` | Chromium sandbox จำกัดความสามารถของ renderer process |

---

## Certificate Pinning

ดูรายละเอียดเพิ่มเติมที่ [components/pinner.md](components/pinner.md)

### สรุป

- ตรวจสอบ SPKI fingerprint ของ certificate Discord จริง
- เทียบกับที่ pre-fetch ไว้ตอน boot (non-blocking)
- ถ้าไม่ตรง → destroy socket (MITM detected)
- TOFU fallback สำหรับ domain ที่ยังไม่มี pin

---

## Cross-reference

- [components/pinner.md](components/pinner.md) — Certificate pinning (SPKI, TOFU, pre-fetch)
- [components/ca.md](components/ca.md) — In-memory CA (การสร้าง cert ที่เรา trust)
- [boot-sequence.md](boot-sequence.md) — การลงทะเบียน certificate-error handler
