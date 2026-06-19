# Obfuscord — Discord Obfuscated Desktop Client

> Desktop client สำหรับ Discord ที่อำพรางการสื่อสารระดับเครือข่าย
> ด้วยเทคนิค Man-in-the-Middle (MITM) TLS proxy ที่ทำงานในหน่วยความจำ (In-Memory)

## Core Architecture

```
Chromium → local-proxy → server-side TLS (cert โดย In-Memory CA)
                       → DoH resolve IP → client-side TLS (NO SNI) → Discord
```

## Key Principles

- **No SNI**: `servername: undefined` → ClientHello ไม่มี Server Name Indication → DPI ไม่รู้ target domain
- **In-Memory CA**: Root CA + per-domain certificates ใน RAM ทั้งหมด, ไม่มีไฟล์ `.pem`, `.crt`, `.key` บนดิสก์
- **Certificate Pinning**: SPKI fingerprint (SHA-256 ของ SubjectPublicKeyInfo) ตรวจสอบ Discord certificate หลัง TLS handshake — ป้องกัน MITM
- **DoH DNS**: Cloudflare DoH (primary) → Google DoH (fallback), in-memory cache พร้อม TTL clamp 60–600 วินาที
- **Dual Certificate Verify**: `certificate-error` event + `setCertificateVerifyProc` — ตรวจสอบ issuerName ว่า cert มาจาก CA ของเราเท่านั้น

## Tech Stack

| Technology | Version | Role |
|------------|---------|------|
| **Bun** | 1.3.14+ | Runtime + Bundler (ไม่ใช้ tsc) |
| **Electron** | 42.4.1 | Chromium wrapper |
| **TypeScript** | 5.x | ภาษา |
| **node-forge** | 1.4.0 | Pure JS crypto (RSA, X.509, PEM) |
| **Cloudflare DoH** | — | DNS resolution หลัก |
| **Google DoH** | — | DNS resolution สำรอง |

## Modules

| Module | File | Dependencies |
|--------|------|-------------|
| **Entry point** | `index.ts` | ca, local-proxy, pinner, picker |
| **CA** | `src/ca.ts` | node-forge |
| **Local proxy** | `src/local-proxy.ts` | terminator |
| **Terminator** | `src/terminator.ts` | ca, doh-resolver, pinner |
| **DoH resolver** | `src/doh-resolver.ts` | — |
| **Pinner** | `src/pinner.ts` | doh-resolver |
| **Picker** | `src/picker.ts` | Electron |

## Key Files

- `index.ts` — Electron main process, boot sequence, proxy config, window creation
- `src/terminator.ts` — TLS termination bridge (หัวใจของระบบ)
- `src/ca.ts` — In-memory Root CA generation + per-domain cert signing
- `src/pinner.ts` — Certificate pinning with SPKI fingerprint + TOFU
- `src/doh-resolver.ts` — DNS-over-HTTPS with in-memory cache
- `src/local-proxy.ts` — HTTP CONNECT proxy on random localhost port

## Critical Boot Order (must not change)

1. Module-level `certificate-error` handler registration
2. `initCa()` — generate Root CA
3. `startProxy()` — start local proxy
4. `pinAllDiscordDomains()` — pre-fetch pins (async, non-blocking)
5. `app.whenReady()` — Electron ready
6. `session.defaultSession.setProxy()` — route Chromium through our proxy
7. `createWindow()` — load `https://discord.com/app`

## Known Limitations

- **IPv4 only**: DoH query type A เท่านั้น, IPv6 จะ fail
- **TOFU Risk**: การเชื่อมต่อครั้งแรกสุ่มเสี่ยงต่อ MITM (ถ้า pre-fetch ยังไม่เสร็จ)
- **No connection pooling**: ทุก request สร้าง TLS socket ใหม่
- **Hardcoded domains**: 6 Discord domains ต้องอัปเดตเอง
- **No tests**: เปลี่ยนโค้ดต้อง manual test ทุกครั้ง
