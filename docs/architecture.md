# สถาปัตยกรรมโดยรวม

## สารบัญ
- [แนวคิดและที่มา](#แนวคิดและที่มา)
- [สถาปัตยกรรมโดยรวม](#สถาปัตยกรรมโดยรวม)
- [ผัง Dependency](#ผัง-dependency)
- [เทคโนโลยีที่ใช้](#เทคโนโลยีที่ใช้)
- [โครงสร้างโปรเจค](#โครงสร้างโปรเจค)
- [Cross-reference](#cross-reference)

---

## แนวคิดและที่มา

### ปัญหาที่ต้องการแก้

การเชื่อมต่อไปยัง Discord โดยปกติจะ:
1. ส่ง **Server Name Indication (SNI)** ซึ่งระบุ `discord.com` ใน TLS handshake → ผู้ให้บริการเครือข่ายเห็น target domain ทันที
2. ใช้ **ระบบ DNS ของเครื่อง** ซึ่งอาจถูกแทรกแซง (DNS hijacking) หรือถูกบล็อก (DNS poisoning)
3. ใช้ **Root CA ของระบบ** เพื่อตรวจสอบใบรับรอง → หน่วยงานหรือมัลแวร์ที่สามารถติดตั้ง CA ลงในเครื่องสามารถ MITM ได้อยู่แล้ว

### แนวทางแก้

โปรเจคนี้ใช้แนวคิด **"Self-MITM Proxy"** หรือการสร้าง MITM proxy ขึ้นมาเองในเครื่อง:

1. **In-Memory Root CA** — สร้าง Certificate Authority ขึ้นมาเองในหน่วยความจำ (ไม่เคยแตะดิสก์)
2. **Local Proxy** — เปิด HTTP CONNECT proxy ที่ `localhost` แบบ random port
3. **บังคับ Chromium** (ผ่าน Electron) ให้ใช้ proxy นี้
4. **Terminate TLS** — ถอดรหัส TLS จาก Chromium แล้วสร้าง TLS ใหม่ไปยัง Discord
5. **ไม่มี SNI** — TLS handshake รอบที่สอง (ไปยัง Discord) **ไม่ส่ง SNI** ทำให้เครือข่ายไม่รู้ target

**ผลลัพธ์:** เครือข่ายเห็นแค่ TLS ไปยัง IP ของ Cloudflare โดยไม่มี SNI → ไม่สามารถระบุได้ว่ากำลังเชื่อมต่อไปยัง Discord

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

---

## ผัง Dependency

```
index.ts               # Entry point — Electron main process
├── src/ca.ts          # Certificate generation (Root CA + signCert)
├── src/local-proxy.ts
│   └── src/terminator.ts
│       ├── src/ca.ts              ← signCert()
│       ├── src/doh-resolver.ts    ← resolveA()
│       └── src/pinner.ts          ← verifyPin()
├── src/pinner.ts       # pinAllDiscordDomains()
├── src/picker.ts       # Screen sharing picker UI
└── electron            # (devDependency, external in bundle)
```

### ตาราง Dependency

| ไฟล์ | ขึ้นอยู่กับ | ถูกเรียกจาก |
|------|-----------|-----------|
| `index.ts` | `ca.ts`, `local-proxy.ts`, `pinner.ts`, `picker.ts` | — |
| `src/ca.ts` | `node-forge` | `index.ts`, `terminator.ts` |
| `src/local-proxy.ts` | `terminator.ts` | `index.ts` |
| `src/terminator.ts` | `ca.ts`, `doh-resolver.ts`, `pinner.ts` | `local-proxy.ts` |
| `src/doh-resolver.ts` | — | `terminator.ts`, `pinner.ts` |
| `src/pinner.ts` | `doh-resolver.ts` | `index.ts`, `terminator.ts` |
| `src/picker.ts` | Electron `BrowserWindow` | `index.ts` |

---

## เทคโนโลยีที่ใช้

| เทคโนโลยี | เวอร์ชัน | บทบาท |
|-----------|---------|--------|
| **Bun** | 1.3.14+ | Runtime + Bundler (ไม่ใช้ tsc) |
| **Electron** | 42.4.1 | Chromium wrapper สำหรับ desktop app |
| **TypeScript** | 5.x | ภาษา + type checking |
| **node-forge** | 1.4.0 | Pure JS crypto (RSA, X.509, PEM) |
| **Cloudflare DoH** | — | DNS resolution หลัก |
| **Google DoH** | — | DNS resolution สำรอง |

---

## โครงสร้างโปรเจค

```
obfuscord/
├── index.ts                  # Entry point — Electron main process
├── src/
│   ├── ca.ts                 # In-memory Root CA + cert signing
│   ├── doh-resolver.ts       # DNS-over-HTTPS (Cloudflare → Google)
│   ├── local-proxy.ts        # HTTP CONNECT proxy
│   ├── pinner.ts             # Certificate pinning (SPKI fingerprint)
│   ├── terminator.ts         # TLS termination bridge (core logic)
│   └── picker.ts             # Screen/window picker UI
├── dist/
│   └── index.js              # Build output (~530KB, single-file)
├── docs/
│   ├── architecture.md       # (ไฟล์นี้)
│   ├── boot-sequence.md      # ลำดับการบู๊ต
│   ├── connection-flow.md    # ขั้นตอนการเชื่อมต่อ 1 ครั้ง
│   ├── security-model.md     # ความปลอดภัย
│   ├── limitations.md        # ข้อจำกัด
│   ├── development.md        # คู่มือพัฒนาต่อ
│   └── components/           # รายละเอียดแต่ละ component
│       ├── ca.md
│       ├── doh-resolver.md
│       ├── local-proxy.md
│       ├── terminator.md
│       ├── pinner.md
│       └── picker.md
├── package.json              # "main": "dist/index.js"
├── tsconfig.json             # noEmit: true, bundler mode
├── bun.lock                  # Bun lockfile v1
├── AGENTS.md                 # Instruction สำหรับ OpenCode agent
└── README.md                 # ภาพรวมระดับสูง + Quick Start
```

---

## Cross-reference

- [boot-sequence.md](boot-sequence.md) — ลำดับการบู๊ตที่ห้ามเปลี่ยน
- [connection-flow.md](connection-flow.md) — การเชื่อมต่อ 1 ครั้งทำงานอย่างไร
- [components/terminator.md](components/terminator.md) — TLS bridge (หัวใจของระบบ)
- [components/ca.md](components/ca.md) — In-memory CA
- [components/pinner.md](components/pinner.md) — Certificate pinning
