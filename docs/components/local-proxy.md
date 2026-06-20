# Local HTTP CONNECT Proxy (local-proxy.ts)

## สารบัญ
- [ภาพรวม](#ภาพรวม)
- [การทำงานของ HTTP CONNECT](#การทำงานของ-http-connect)
- [Socket Management](#socket-management)
- [Header Parsing (readHeaders)](#header-parsing-readheaders)
- [Public API](#public-api)
- [Cross-reference](#cross-reference)

---

## ภาพรวม

`local-proxy.ts` ทำหน้าที่เป็น **TCP proxy server** ขนาดเล็กที่เปิดฟังบน `localhost:random` เพื่อรับ HTTP CONNECT request จาก Chromium

**หลักการทำงาน:**
1. รอ Chromium เชื่อมต่อ TCP ที่ `127.0.0.1:XXXXX` (random port)
2. Chromium ส่ง `CONNECT discord.com:443 HTTP/1.1`
3. Proxy อ่าน HTTP headers → ได้ hostname + port
4. ส่งต่อไปยัง `terminateTls()` ใน `terminator.ts` เพื่อจัดการ TLS bridge
5. ไม่มีการแทรกแซง data หลังจาก CONNECT สำเร็จ — เป็น transparent tunnel

---

## การทำงานของ HTTP CONNECT

### Protocol Flow

```http
# Chromium ส่ง:
CONNECT discord.com:443 HTTP/1.1
Host: discord.com:443
Proxy-Connection: Keep-Alive
User-Agent: Mozilla/5.0 ...

# Proxy ตอบ (จาก terminator.ts):
HTTP/1.1 200 Connection Established

# หลังจากนี้คือ TLS traffic ทั้งหมด (raw socket)
```

### Request Parsing

```typescript
// regex ที่ใช้ parse
const match = request.match(/^CONNECT\s+([^:]+):(\d+)\s+HTTP\/1\.\d/i)
// match[1] = hostname (e.g. "discord.com")
// match[2] = port (e.g. "443")
```

**การจัดการ error:**
- ถ้า regex ไม่ match → `HTTP/1.1 400 Bad Request` + destroy socket
- ถ้า hostname หรือ port ไม่ถูกต้อง → error ใน `terminateTls()` → log error
- ถ้า socket error ระหว่างรอ headers → destroy socket

---

## Socket Management

### Server Configuration

```typescript
const server = net.createServer({ keepAlive: true }, (clientSocket) => {
  clientSocket.setTimeout(60_000, () => {
    clientSocket.destroy()  // Idle timeout 60 วินาที
  })
  handleConnection(clientSocket)
})

server.listen(0, '127.0.0.1', () => {
  // port = 0 → OS เลือก random port ให้
  // 127.0.0.1 → bind เฉพาะ localhost
})
```

### Configuration Details

| พารามิเตอร์ | ค่า | เหตุผล |
|------------|-----|--------|
| `port` | `0` (random) | ป้องกัน port contention กับแอปอื่น |
| `host` | `127.0.0.1` | ไม่ expose ไปยังเครือข่ายภายนอก |
| `keepAlive` | `true` | เปิด TCP keepalive (ป้องกัน half-open connection) |
| `idleTimeout` | `60,000 ms` | ป้องกัน zombie socket (destroy เมื่อไม่มีการส่งข้อมูล) |

---

## Header Parsing (readHeaders)

### ฟังก์ชัน: `readHeaders(socket): Promise<string>`

อ่าน HTTP headers จาก socket แบบบรรทัดต่อบรรทัดจนเจอ `\r\n\r\n`:

```typescript
function readHeaders(socket: net.Socket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let data = ''
    let aborted = false

    const onData = (chunk: Buffer) => {
      data += chunk.toString()
      if (data.includes('\r\n\r\n')) {
        cleanup()
        resolve(data)      // headers สมบูรณ์ → resolve
      }
    }

    const onError = (err: Error) => {
      if (!aborted) {
        aborted = true
        cleanup()
        reject(err)
      }
    }

    const onClose = () => {
      if (!aborted) {
        aborted = true
        cleanup()
        reject(new Error('Socket closed before headers were complete'))
      }
    }

    const cleanup = () => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }

    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}
```

**ข้อสังเกต:**
- ใช้ `includes('\r\n\r\n')` — หา end-of-header marker
- `aborted` flag ป้องกันการ resolve/reject ซ้ำ (double-settle)
- `cleanup()` ลบ event listeners หลังเสร็จ — ป้องกัน memory leak

---

## Public API

| ฟังก์ชัน | พารามิเตอร์ | คืนค่า | คำอธิบาย |
|---------|------------|--------|---------|
| `startProxy()` | — | `Promise<ProxyInfo>` | เปิด proxy server บน random port |

### ProxyInfo Interface

```typescript
interface ProxyInfo {
  port: number        // random port ที่ proxy กำลังฟัง
  close: () => void   // ฟังก์ชันหยุด server + ปิด connections ทั้งหมด
}
```

---

## Error Handling Pattern

```typescript
// error จาก terminateTls() จะไม่ทำให้ server ล่ม
terminateTls(clientSocket, hostname, port).catch((err) => {
  console.error(`[proxy] ${hostname}:${port} —`, (err as Error).message)
})
```

ข้อผิดพลาดแต่ละ connection ถูกจับและ log โดยไม่กระทบ connection อื่น — server ยังคงทำงานต่อไป

---

## Cross-reference

- [terminator.md](terminator.md) — `terminateTls()` ถูกเรียกหลังจาก parse headers สำเร็จ
- [boot-sequence.md](../boot-sequence.md) — `startProxy()` เป็นขั้นตอนที่ 2 ของ bootstrap
