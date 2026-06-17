/**
 * BrowserWindow-based screen/window picker for screen sharing.
 *
 * Shows a small modal window with source thumbnails (grid layout)
 * and returns the selected source via Promise.
 */

import { BrowserWindow } from 'electron'
import type { DesktopCapturerSource } from 'electron'

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

function buildHtml(sources: DesktopCapturerSource[]): string {
  const cards = sources
    .map(
      (s, i) => `
    <div class="card" data-index="${i}">
      <img src="${s.thumbnail.toDataURL()}" alt="${escapeAttr(s.name)}" />
      <div class="name" title="${escapeAttr(s.name)}">${escapeAttr(s.name)}</div>
      <div class="badge">${s.appIcon ? 'หน้าต่าง' : 'หน้าจอ'}</div>
    </div>`,
    )
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
  h2 {
    font-size: 15px; font-weight: 600; color: #f2f3f5;
    margin-bottom: 12px;
  }
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
  .badge {
    font-size: 10px; color: #80848e; margin-top: 2px;
  }
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Opens a small modal picker window and returns the user's chosen source.
 * Resolves with `undefined` if the user cancels.
 */
export function showPicker(
  sources: DesktopCapturerSource[],
): Promise<DesktopCapturerSource | undefined> {
  return new Promise((resolve) => {
    const html = buildHtml(sources)
    const dataUri = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)

    const picker = new BrowserWindow({
      width: 600,
      height: 400,        // Will resize after content measurement
      show: false,         // Keep hidden until resize is done
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'แชร์หน้าจอ',
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
      },
    })

    let settled = false

    // Measure content height after load, then resize + center + show
    picker.webContents.on('did-finish-load', async () => {
      const contentHeight = await picker.webContents.executeJavaScript(
        'document.documentElement.scrollHeight',
      )
      picker.setContentSize(600, Math.min(Math.max(contentHeight + 4, 200), 520))
      picker.center()
      picker.show()
    })

    picker.loadURL(dataUri)

    // Poll for user selection
    const poll = setInterval(async () => {
      try {
        const idx = await picker.webContents.executeJavaScript(
          'window.__selectedIndex',
        )
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

    // If user closes window manually
    picker.on('closed', () => {
      if (!settled) {
        settled = true
        clearInterval(poll)
        resolve(undefined)
      }
    })
  })
}
