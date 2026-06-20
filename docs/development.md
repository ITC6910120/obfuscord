# คู่มือการพัฒนา (Development Guide)

## สารบัญ
- [ภาพรวม](#ภาพรวม)
- [การติดตั้ง](#การติดตั้ง)
- [คำสั่งพื้นฐาน](#คำสั่งพื้นฐาน)
- [Toolchain Quirks](#toolchain-quirks)
- [Debugging](#debugging)
- [Cross-reference](#cross-reference)

---

## ภาพรวม

Obfuscord ใช้ **Bun** เป็นทั้ง runtime และ bundler (ไม่ใช้ `tsc`) และ **Electron** สำหรับ desktop wrapper

---

## การติดตั้ง

### สิ่งที่ต้องมี

| เครื่องมือ | เวอร์ชัน | หมายเหตุ |
|-----------|---------|---------|
| [Bun](https://bun.sh) | 1.3.14+ | Runtime + Bundler |
| Node.js | (optional) | Bun มี Node.js API compatibility |

### ขั้นตอน

```bash
# Clone และติดตั้ง dependencies
git clone <repo-url>
cd obfuscord
bun install
```

หมายเหตุ: `node-forge` และ `electron` อยู่ใน `devDependencies` — ต้องใช้ `bun install` (ไม่ใช่ `bun install --production`)

---

## คำสั่งพื้นฐาน

| คำสั่ง | รายละเอียด |
|-------|-----------|
| `bun run index.ts` | Dev mode — Bun รัน `.ts` โดยตรง (ไม่ต้อง build) |
| `bun run build` | Bundle → `dist/index.js` (ไฟล์เดียว ~525KB) |
| `bun run start` | Build + เปิดผ่าน `electron .` |
| `bun run start:debug` | Build + debug mode (`DEBUG_PROXY=true`) + electron |

### Build Command (โดยละเอียด)

```bash
bun build --target node --external electron --outdir dist index.ts
```

| Flag | ความหมาย |
|------|---------|
| `--target node` | Bundle สำหรับ Node.js environment |
| `--external electron` | Electron ถูก keep เป็น external (ไม่อยู่ใน bundle) |
| `--outdir dist` |  output directory |

### การออกจากโปรแกรม

| วิธี | รายละเอียด |
|------|-----------|
| ปิดหน้าต่าง | ปกติ (บน macOS แอปไม่ปิด — ต้องปิดจาก Dock) |
| Ctrl+C | หยุดทุกอย่าง |
| Cmd+Q (macOS) | ปิดแอปสมบูรณ์ |

---

## Toolchain Quirks

### Bun เป็นทั้ง Runtime และ Bundler

```json
// tsconfig.json
{
  "compilerOptions": {
    "module": "Preserve",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true
  }
}
```

- `noEmit: true` — Bun ไม่ใช้ `tsc` สำหรับ compile; Bun รัน `.ts` โดยตรง
- `moduleResolution: "bundler"` — รองรับ `.js` extension ใน import (`import { foo } from './bar.js'`)
- `allowImportingTsExtensions: true` — (สำหรับ type-checking)
- `verbatimModuleSyntax: true` — type import/export ต้องใช้ `type` keyword

### Electron อยู่ใน devDependencies

```json
{
  "devDependencies": {
    "electron": "^42.4.1"
  }
}
```

Electron ถูก keep เป็น external ใน bundle (`--external electron`) → ต้องมี Electron ใน `node_modules` ตอนรัน

### node-forge เป็น Dependency หลัก (เกือบ) เดียว

```json
{
  "devDependencies": {
    "node-forge": "^1.4.0"
  }
}
```

- Pure JavaScript crypto library — **compiles ได้ทุกแพลตฟอร์ม** (ไม่มี native binding)
- ใช้สำหรับ RSA key generation, X.509 certificate creation, PEM encoding

### TypeScript Strictness

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noUnusedLocals": false,     // อนุญาต unused variables (ช่วง dev)
    "noUnusedParameters": false  // อนุญาต unused parameters (Electron callbacks)
  }
}
```

---

## Debugging

### Debug Mode

```bash
bun run start:debug
# หรือ
$env:DEBUG_PROXY="true"; bun run start  # PowerShell
```

เมื่อ `DEBUG_PROXY=true`:
- ระบบจะ log รายละเอียด permission ที่ deny
- verbose logging ใน CA module (`setVerbose(true)`)

### เปิด/ปิด verbose logging

```typescript
import { setVerbose } from './src/ca.js'
setVerbose(true)   // เปิด log CA activity
setVerbose(false)  // ปิด (default)
```

### ข้อควรระวังในการ Debug

- `setContentProtection(true)` อาจทำให้ screenshot debug tools เห็นหน้าต่างเป็นสีดำ
- `sandbox: true` จำกัดความสามารถของ devtools ใน renderer
- ใช้ `console.error` สำหรับ error logging — log ไปยัง terminal (ไม่ใช่ renderer)

---

## Scripts ที่มี

```json
{
  "scripts": {
    "build": "bun build --target node --external electron --outdir dist index.ts",
    "start": "bun run build && electron .",
    "start:debug": "bun run build && cmd /c \"set DEBUG_PROXY=true && electron .\""
  }
}
```

หมายเหตุ: `start:debug` ใช้ `cmd /c` (Windows) — สำหรับ macOS/Linux ต้องปรับเป็น `DEBUG_PROXY=true electron .`

---

## Cross-reference

- [architecture.md](architecture.md) — ภาพรวม tech stack
- [boot-sequence.md](boot-sequence.md) — ลำดับการบู๊ต (critical, ห้ามเปลี่ยน)
- [security-model.md](security-model.md) — ความปลอดภัยของแอป
