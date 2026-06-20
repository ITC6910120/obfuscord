# Obfuscord — Discord Obfuscated Desktop Client

Desktop client สำหรับ Discord ที่ **อำพรางการสื่อสารในระดับเครือข่าย** โดยใช้เทคนิค Man-in-the-Middle (MITM) TLS proxy ที่ทำงานทั้งหมดในหน่วยความจำ (In-Memory) โดยไม่ทิ้งร่องรอยบนดิสก์

---

## Quick Start

```bash
bun install
bun run build     # bundle → dist/index.js (single-file)
bun run start     # build + launch via `electron .`
```

---

## แนวคิด

Obfuscord ใช้ **Self-MITM Proxy** — สร้าง MITM proxy ขึ้นมาเองในเครื่อง:

1. **In-Memory Root CA** — Certificate Authority ใน RAM (ไม่แตะดิสก์)
2. **Local Proxy** — HTTP CONNECT proxy ที่ `localhost:random`
3. **TLS Termination** — ถอด TLS จาก Chromium → สร้าง TLS ใหม่ไปยัง Discord **โดยไม่ส่ง SNI**
4. **Certificate Pinning** — ตรวจสอบ SPKI fingerprint ป้องกัน MITM

**ผลลัพธ์:** เครือข่ายเห็นแค่ TLS ไปยัง IP Cloudflare โดยไม่มี SNI → ไม่รู้ target

---

## Tech Stack

| เทคโนโลยี          | เวอร์ชัน | บทบาท                       |
| ------------------ | -------- | --------------------------- |
| **Bun**            | 1.3.14+  | Runtime + Bundler           |
| **Electron**       | 42.4.1   | Chromium wrapper            |
| **TypeScript**     | 5.x      | ภาษา                        |
| **node-forge**     | 1.4.0    | Pure JS crypto (RSA, X.509) |
| **Cloudflare DoH** | —        | DNS resolution หลัก         |
| **Google DoH**     | —        | DNS resolution สำรอง        |

---

## เอกสารอ้างอิง (Documentation)

| เอกสาร                                                             | รายละเอียด                                                       |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                       | สถาปัตยกรรมโดยรวม + Tech Stack + Dependency                      |
| [docs/boot-sequence.md](docs/boot-sequence.md)                     | ลำดับการบู๊ต (Critical — ห้ามเปลี่ยน)                            |
| [docs/connection-flow.md](docs/connection-flow.md)                 | การเชื่อมต่อ 1 ครั้งทำงานอย่างไร                                 |
| [docs/security-model.md](docs/security-model.md)                   | ความปลอดภัย — Certificate Verify, Permission, Content Protection |
| [docs/limitations.md](docs/limitations.md)                         | ข้อจำกัดของระบบ                                                  |
| [docs/development.md](docs/development.md)                         | คู่มือพัฒนา — Setup, Build, Debug, Toolchain                     |
| [docs/components/ca.md](docs/components/ca.md)                     | In-Memory CA (Root CA + signCert)                                |
| [docs/components/local-proxy.md](docs/components/local-proxy.md)   | HTTP CONNECT Proxy                                               |
| [docs/components/terminator.md](docs/components/terminator.md)     | TLS Termination Bridge (หัวใจของระบบ)                            |
| [docs/components/doh-resolver.md](docs/components/doh-resolver.md) | DNS-over-HTTPS                                                   |
| [docs/components/pinner.md](docs/components/pinner.md)             | Certificate Pinning (SPKI + TOFU)                                |
| [docs/components/picker.md](docs/components/picker.md)             | Screen Sharing Picker UI                                         |

---

## โครงสร้างโปรเจค

```
obfuscord/
├── index.ts              # Entry point — Electron main process
├── src/
│   ├── ca.ts             # In-memory Root CA + cert signing
│   ├── doh-resolver.ts   # DNS-over-HTTPS
│   ├── local-proxy.ts    # HTTP CONNECT proxy
│   ├── pinner.ts         # Certificate pinning
│   ├── terminator.ts     # TLS termination bridge (core)
│   └── picker.ts         # Screen sharing picker UI
├── docs/                 # เอกสารทั้งหมด
│   ├── architecture.md
│   ├── boot-sequence.md
│   ├── connection-flow.md
│   ├── security-model.md
│   ├── limitations.md
│   ├── development.md
│   └── components/
│       ├── ca.md
│       ├── local-proxy.md
│       ├── terminator.md
│       ├── doh-resolver.md
│       ├── pinner.md
│       └── picker.md
├── dist/index.js         # Build output (~530KB)
├── package.json
├── tsconfig.json
├── AGENTS.md             # Instruction for OpenCode agents
└── README.md             # (ไฟล์นี้)
```

---

## ข้อควรทราบ

โปรเจคนี้เป็น **experimental / proof-of-concept** — มีข้อจำกัดที่ควรทราบ:

- **IPv4 only** — DoH query type A เท่านั้น
- **TOFU Risk** — การเชื่อมต่อครั้งแรกสุ่มเสี่ยงต่อ MITM
- **No Connection Pooling** — ทุก request สร้าง TLS socket ใหม่
- **Hardcoded Domains** — 6 Discord domains ต้องอัปเดตเอง
- **No Tests** — เปลี่ยนโค้ดต้อง manual test

ดูรายละเอียดเพิ่มเติม: [docs/limitations.md](docs/limitations.md)

---

## เครดิต

พัฒนาโดย [ITC6910120](https://github.com/ITC6910120) และ [Onlygummy](https://github.com/Onlygummy)
