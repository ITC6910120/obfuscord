# ลำดับการบู๊ต (Boot Sequence)

## สารบัญ
- [ภาพรวม](#ภาพรวม)
- [Critical Boot Order](#critical-boot-order)
- [รายละเอียดแต่ละขั้นตอน](#รายละเอียดแต่ละขั้นตอน)
- [หมายเหตุสำคัญ](#หมายเหตุสำคัญ)
- [App Lifecycle](#app-lifecycle)
- [Cross-reference](#cross-reference)

---

## ภาพรวม

ลำดับการบู๊ตของ Obfuscord ถูกออกแบบให้แต่ละขั้นตอนขึ้นต่อกัน (sequential dependencies) — การเปลี่ยนลำดับอาจทำให้ระบบทำงานผิดพลาด

---

## Critical Boot Order

```
เวลา  ┌─────────────────────────────────────────────────┐
│     │ Module scope                                    │
│     │  • app.on('certificate-error') ← register ก่อน  │
│     │    ทุกอย่าง (Electron event อาจมาก่อน ready)    │
│     ├─────────────────────────────────────────────────┤
│     │ bootstrap()                                     │
│     │  1. initCa() ← สร้าง Root CA                    │
│     │     └─ ต้องมาก่อน startProxy()                  │
│     │                                                │
│     │  2. startProxy() ← เปิด proxy                   │
│     │     └─ localhost:random                         │
│     │                                                │
│     │  3. pinAllDiscordDomains() (async)              │
│     │     └─ pre-fetch SPKI fingerprint               │
│     │        (non-blocking, คู่ขนานกับ proxy)         │
│     ├─────────────────────────────────────────────────┤
│     │ app.whenReady()                                 │
│     │  └─ Electron พร้อมใช้งาน                        │
│     ├─────────────────────────────────────────────────┤
│     │ session.defaultSession.setProxy()               │
│     │  └─ ตั้งค่าให้ Chromium ใช้ proxy ของเรา         │
│     │    ★ ต้องหลัง whenReady() ★                    │
│     ├─────────────────────────────────────────────────┤
│     │ setCertificateVerifyProc()                      │
│     │  └─ ตรวจสอบ issuerName ของ cert                 │
│     ├─────────────────────────────────────────────────┤
│     │ setDisplayMediaRequestHandler()                 │
│     │  └─ สำหรับ screen sharing                       │
│     ├─────────────────────────────────────────────────┤
│     │ createWindow()                                  │
│     │  └─ เปิด https://discord.com/app                │
│     ▼                                                │
```

---

## รายละเอียดแต่ละขั้นตอน

### 1. Module Scope — certificate-error handler

```typescript
// index.ts — module level (บรรทัด 40)
app.on('certificate-error', (event, _webContents, _url, _error, certificate, callback) => {
  if (certificate?.issuerName?.includes(getCaName())) {
    event.preventDefault()
    callback(true)   // Accept — cert มาจาก CA ของเรา
  } else {
    callback(false)  // Reject
  }
})
```

**ทำไมต้อง module level:** Electron อาจ emit event นี้ก่อน `app.whenReady()` — ต้อง register ไว้ตั้งแต่ต้น

### 2. initCa() — สร้าง Root CA

```typescript
initCa()  // index.ts บรรทัด 135 (ใน bootstrap())
```

- สร้าง RSA 2048-bit key pair + self-signed certificate
- เก็บใน `caContext` (module-level variable)
- **ต้องมาก่อน `startProxy()`** — เพราะเมื่อ Chromium ส่ง CONNECT มา `signCert()` จะถูกเรียกทันที

### 3. startProxy() — เปิด proxy

```typescript
const { port, close } = await startProxy()
stopProxy = close
```

- เปิด TCP server บน `127.0.0.1:random`
- คืนค่า port + close function
- หลังจากนี้ Chromium สามารถเชื่อมต่อผ่าน proxy ได้

### 4. pinAllDiscordDomains() (async, non-blocking)

```typescript
pinAllDiscordDomains()  // index.ts บรรทัด 147
```

- Pre-fetch SPKI fingerprints สำหรับ 6 Discord domains
- **ไม่ block boot** — ทำงานใน background
- ถ้า connection มาก่อน pre-fetch เสร็จ → TOFU จะจัดการ

### 5. app.whenReady()

```typescript
await app.whenReady()
```

- Electron internal initialization เสร็จสมบูรณ์
- `session` พร้อมใช้งาน (ต้องหลัง whenReady)

### 6. setProxy()

```typescript
await session.defaultSession.setProxy({
  proxyRules: `http://127.0.0.1:${proxyPort}`,
  proxyBypassRules: '<local>',
})
```

- Chromium กำหนดให้ใช้ proxy ของเรา
- **ต้องหลัง `whenReady()`** — `session` ยังไม่พร้อมก่อนหน้านั้น
- `proxyBypassRules: '<local>'` — traffic ภายใน localhost ข้าม proxy

### 7. setCertificateVerifyProc()

```typescript
session.defaultSession.setCertificateVerifyProc((request, callback) => {
  if (request.certificate?.issuerName?.includes(caName)) {
    callback(0)    // Accept — มาจาก CA ของเรา
  } else {
    callback(-3)   // ใช้ Chromium default verification
  }
})
```

- ตรวจสอบ cert ที่ Chromium network service ได้รับ
- callback(0) = trust, callback(-3) = Chromium default (reject self-signed)

### 8. setDisplayMediaRequestHandler()

```typescript
session.defaultSession.setDisplayMediaRequestHandler(
  async (request, callback) => { /* ... */ }
)
```

- สำหรับ screen sharing
- เรียก `desktopCapturer.getSources()` → `showPicker()` → callback

### 9. createWindow()

```typescript
const win = new BrowserWindow({
  width: 1280,
  height: 800,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  },
})
win.setContentProtection(true)
await win.loadURL('https://discord.com/app')
```

- สร้าง BrowserWindow แบบ sandboxed
- `setContentProtection(true)` — ป้องกัน screen capture
- เปิด `https://discord.com/app`

---

## App Lifecycle

### macOS Lifecycle

```typescript
// ไม่ปิด app เมื่อปิดหน้าต่างทั้งหมด (macOS convention)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// สร้างหน้าต่างใหม่เมื่อคลิก dock icon
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    main()
  }
})
```

### Cleanup

```typescript
app.on('before-quit', () => {
  stopProxy?.()  // หยุด proxy server
})
```

---

## หมายเหตุสำคัญ

| ลำดับ | ข้อควรจำ |
|-------|---------|
| 1 | `certificate-error` handler **ต้องอยู่ที่ module level** — อย่า移到 `app.whenReady()` |
| 2 | `initCa()` **ต้องมาก่อน** `startProxy()` — `signCert()` ถูกเรียกทันทีเมื่อมี CONNECT |
| 3 | `pinAllDiscordDomains()` เป็น async non-blocking — ทำงานคู่ขนานกับ proxy |
| 4 | `session.setProxy()` **ต้องหลัง** `app.whenReady()` — `session` ยังไม่พร้อม |
| 5 | `setContentProtection(true)` ป้องกัน Discord window จาก screen capture |
| 6 | `bootstrapped` flag ป้องกัน macOS `activate` เรียก bootstrap ซ้ำ |

---

## Cross-reference

- [architecture.md](architecture.md) — ภาพรวมสถาปัตยกรรม
- [connection-flow.md](connection-flow.md) — หลังจาก boot เสร็จ → การทำงานของ 1 request
- [components/ca.md](components/ca.md) — `initCa()` และ `signCert()`
- [components/pinner.md](components/pinner.md) — `pinAllDiscordDomains()`
