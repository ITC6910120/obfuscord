# Screen/Window Picker UI (picker.ts)

## สารบัญ
- [ภาพรวม](#ภาพรวม)
- [การทำงาน](#การทำงาน)
- [HTML/CSS Template](#htmlcss-template)
- [Public API](#public-api)
- [Cross-reference](#cross-reference)

---

## ภาพรวม

`picker.ts` ทำหน้าที่แสดง UI ขนาดเล็กสำหรับให้ผู้ใช้เลือกหน้าจอหรือหน้าต่างที่จะแชร์ (screen sharing) ใน Discord

**หลักการทำงาน:**
1. รับรายการ `DesktopCapturerSource[]` จาก `desktopCapturer.getSources()` ใน `index.ts`
2. สร้าง HTML/CSS inline (ไม่มีไฟล์ภายนอก) แสดง thumbnail + ชื่อของแต่ละ source
3. เปิด `BrowserWindow` ขนาดเล็กแบบ modal
4. ผู้ใช้คลิกเลือก → คืนค่า selected source กลับผ่าน Promise
5. ถ้าผู้ใช้ปิดหน้าต่าง → คืน `undefined` (cancel)

---

## การทำงาน

### Data Flow

```
index.ts
  │
  ├── desktopCapturer.getSources({ types: ['screen', 'window'] })
  ├── กรอง Discord windows ออกจาก picker
  │
  ├── showPicker(filteredSources)
  │   │
  │   ├── buildHtml(sources) → HTML string
  │   ├── encodeURIComponent → data URI
  │   ├── new BrowserWindow({ show: false })
  │   ├── picker.loadURL(dataUri)
  │   │
  │   ├── did-finish-load → วัด content height → resize → center → show
  │   │
  │   ├── Polling (150ms)
  │   │   └── executeJavaScript('window.__selectedIndex')
  │   │       ├── มีค่า → settle → close → resolve(source)
  │   │       └── ไม่มี → continue polling
  │   │
  │   └── picker.closed → resolve(undefined) (cancel)
  │
  └── callback({ video: source, audio: 'loopback' })
```

### Window Configuration

```typescript
const picker = new BrowserWindow({
  width: 600,
  height: 400,          // Temporary — จะ resize หลังจากวัด content
  show: false,           // ซ่อนจนกว่าจะ resize เสร็จ
  resizable: false,
  minimizable: false,
  maximizable: false,
  title: 'แชร์หน้าจอ',
  autoHideMenuBar: true,
  webPreferences: {
    sandbox: true,
    contextIsolation: true,  // Security hardening
  },
})
```

### Content Measurement

```typescript
picker.webContents.on('did-finish-load', async () => {
  const contentHeight = await picker.webContents.executeJavaScript(
    'document.documentElement.scrollHeight',
  )
  picker.setContentSize(600, Math.min(Math.max(contentHeight + 4, 200), 520))
  picker.center()
  picker.show()
})
```

- วัดความสูงของ content จริง → resize window ให้พอดี
- clamp 200–520px (ไม่เล็กเกินไป ไม่ใหญ่เกินไป)
- `show: false` → `show()` → ไม่กระตุก

### Selection Polling

```typescript
const poll = setInterval(async () => {
  try {
    const idx = await picker.webContents.executeJavaScript('window.__selectedIndex')
    if (idx === null || idx === undefined || settled) return

    settled = true
    clearInterval(poll)
    picker.close()

    if (idx < 0 || idx >= sources.length) {
      resolve(undefined)
      return
    }
    resolve(sources[idx]!)
  } catch {
    // Page might not be loaded yet — keep polling
  }
}, 150)
```

- Polling ทุก 150ms
- `settled` flag ป้องกัน double resolve
- ถ้า index ไม่อยู่ในช่วง → cancel

---

## HTML/CSS Template

### ฟังก์ชัน: `buildHtml(sources)`

```typescript
function buildHtml(sources: DesktopCapturerSource[]): string {
  const cards = sources
    .map((s, i) => `
    <div class="card" data-index="${i}">
      <img src="${s.thumbnail.toDataURL()}" alt="${escapeAttr(s.name)}" />
      <div class="name" title="${escapeAttr(s.name)}">${escapeAttr(s.name)}</div>
      <div class="badge">${s.appIcon ? 'หน้าต่าง' : 'หน้าจอ'}</div>
    </div>`)
    .join('')

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    background: #1e1e1e; color: #b5bac1;
    padding: 16px; user-select: none;
  }
  h2 { font-size: 15px; font-weight: 600; color: #f2f3f5; margin-bottom: 12px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(20%, 1fr));
    gap: 8px;
  }
  .card {
    background: #2a2a2a; border-radius: 8px;
    padding: 6px; cursor: pointer;
    text-align: center; transition: background .15s, outline .15s;
  }
  .card:hover { background: #333; outline: 2px solid #5865f2; }
  .card img {
    width: 100%; aspect-ratio: 16 / 10;
    object-fit: cover; border-radius: 4px;
    display: block; background: #111;
  }
  .name {
    margin-top: 6px; font-size: 12px; color: #dbdee1;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .badge { font-size: 10px; color: #80848e; margin-top: 2px; }
</style>
</head>
<body>
  <h2>แชร์หน้าจอหรือหน้าต่าง</h2>
  <div class="grid">${cards}</div>
  <script>
    document.querySelectorAll('.card').forEach(el => {
      el.addEventListener('click', () => {
        window.__selectedIndex = parseInt(el.dataset.index, 10);
      });
    });
  </script>
</body>
</html>`
}
```

### คุณสมบัติ UI

| องค์ประกอบ | รายละเอียด |
|-----------|-----------|
| **Card Layout** | Grid responsive — auto-fill, min 20% width |
| **Thumbnail** | `s.thumbnail.toDataURL()` — data URI ขนาด 200x150px |
| **Hover Effect** | `outline: 2px solid #5865f2` (Discord brand color) |
| **Badge** | แสดง "หน้าต่าง" หรือ "หน้าจอ" |
| **Name** | Truncated with ellipsis |

---

## Public API

| ฟังก์ชัน | พารามิเตอร์ | คืนค่า | คำอธิบาย |
|---------|------------|--------|---------|
| `showPicker(sources)` | `sources: DesktopCapturerSource[]` | `Promise<DesktopCapturerSource \| undefined>` | เปิด picker และรอผู้ใช้เลือก |

---

## Notes

1. **ไม่ใช้ external dependencies** — HTML/CSS/JS inline — ไม่ต้องโหลดไฟล์เพิ่ม
2. **Content Protection** — Discord window ที่มี `setContentProtection(true)` จะแสดง thumbnail สีดำ → filter ออกจาก picker ใน `index.ts`
3. **Sandboxed** — `sandbox: true`, `contextIsolation: true` — renderer แยกจาก main process
4. **Window Filtering** — Discord windows ถูก filter ใน `index.ts` (`s.name.includes('discord')`) → ผู้ใช้ไม่สับสน

---

## Cross-reference

- [boot-sequence.md](../boot-sequence.md) — `createWindow()` ใน `index.ts` เรียก `showPicker()` เมื่อ screen share
- [security-model.md](../security-model.md) — Content protection + permission handlers
