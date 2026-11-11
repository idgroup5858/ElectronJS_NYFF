const http = require('http')
const { BrowserWindow } = require('electron')

/*
 * Chek chop etish xizmati — Electron'ning asosiy jarayonida (offline serverdan alohida: baza yoki server ishlamasa ham
 * chek chiqadi). Web kassa (online — https://newyork24.uz, offline — localhost:3100/offline) chekni tayyor HTML qilib
 * `POST http://127.0.0.1:3101/print` ga yuboradi; bu yerda u sozlamalardagi printerga (kassa / oshxona / truck) oynasiz
 * chiqadi. Cheklar parallel. Faqat shu kompyuterdan (`127.0.0.1`) va ruxsat etilgan sahifalardan (markaz, localhost).
 */

const PRINT_PORT = 3101
const MAX_BODY = 1024 * 1024
const ROLES = ['receipt', 'kitchen', 'truck']

/** HTML'ni Windows printeriga nomi bilan, oynasiz chop etadi. Printer yo'q / o'chiq — xato. */
async function printHtml(html, deviceName) {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await new Promise((resolve, reject) => {
      win.webContents.print({ silent: true, deviceName, printBackground: true, margins: { marginType: 'none' } }, (ok, reason) =>
        ok ? resolve() : reject(new Error(reason || 'print failed')),
      )
    })
  } finally {
    win.destroy()
  }
}

/** Chek turlari bo'yicha natija: `ok` | `not_set` (printer tanlanmagan) | `error`. */
async function printJobs(jobs, printers, log) {
  const results = {}
  await Promise.all(
    jobs.map(async ({ to, html }) => {
      const deviceName = printers[to]
      if (!deviceName) {
        results[to] = 'not_set'
        return
      }
      try {
        await printHtml(html, deviceName)
        results[to] = 'ok'
      } catch (error) {
        log(`print ${to} → "${deviceName}" failed: ${error.message}`)
        results[to] = 'error'
      }
    }),
  )
  return results
}

const isLoopback = (origin) => {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)
  } catch {
    return false
  }
}

/**
 * Xizmatni ishga tushiradi. `getCentralUrl()` — markaz manzili (uning sahifalari chop eta oladi), `getPrinters()` —
 * `{ receipt, kitchen, truck }` printer nomlari (sozlamalardan, har so'rovda — o'zgarsa qayta ishga tushirish kerak emas).
 */
function startPrintServer({ getCentralUrl, getPrinters, log }) {
  const allowed = (origin) => {
    // brauzer bo'lmagan so'rov (shu kompyuterdagi dastur) — Origin yo'q
    if (!origin) return true
    if (isLoopback(origin)) return true
    try {
      return new URL(getCentralUrl()).origin === origin
    } catch {
      return false
    }
  }

  const send = (res, status, body, origin) => {
    const headers = { 'Content-Type': 'application/json', Vary: 'Origin' }
    if (origin) headers['Access-Control-Allow-Origin'] = origin
    res.writeHead(status, headers)
    res.end(JSON.stringify(body))
  }

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin
    // boshqa saytlar shu kompyuterdagi printerga chek chiqara olmasin (oddiy so'rov preflight'siz keladi — shu yerda)
    if (!allowed(origin)) return send(res, 403, { error: 'forbidden' })

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin ?? '*',
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type',
        // Chrome: ommaviy sayt (https://newyork24.uz) → shu kompyuter
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      })
      return res.end()
    }

    const url = req.url?.split('?')[0]
    if (req.method === 'GET' && url === '/status') {
      const printers = getPrinters()
      return send(res, 200, Object.fromEntries(ROLES.map((role) => [role, Boolean(printers[role])])), origin)
    }
    if (req.method !== 'POST' || url !== '/print') return send(res, 404, { error: 'not_found' }, origin)

    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY) req.destroy()
    })
    req.on('end', async () => {
      let jobs
      try {
        jobs = JSON.parse(body).jobs
      } catch {
        return send(res, 400, { error: 'invalid_input' }, origin)
      }
      const valid =
        Array.isArray(jobs) &&
        jobs.length > 0 &&
        jobs.every((job) => ROLES.includes(job?.to) && typeof job.html === 'string') &&
        new Set(jobs.map((job) => job.to)).size === jobs.length
      if (!valid) return send(res, 400, { error: 'invalid_input' }, origin)
      send(res, 200, { results: await printJobs(jobs, getPrinters(), log) }, origin)
    })
  })

  server.on('error', (error) => log(`print server: ${error.message}`))
  server.listen(PRINT_PORT, '127.0.0.1', () => log(`print server on 127.0.0.1:${PRINT_PORT}`))
  return server
}

/** Sozlamalar oynasidagi "Sinov cheki". */
function testReceiptHtml(title, deviceName) {
  const escape = (text) => String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])
  const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' })
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: 80mm auto; margin: 0 }
body { width: 80mm; margin: 0; padding: 4mm; font: 12px/1.35 'Courier New', monospace; color: #000; text-align: center }
.big { font: 900 28px/1.1 'Arial Black', Arial, sans-serif; margin: 3mm 0 }
.credit { font-size: 9px; margin-top: 4mm }
</style></head><body>
<b>NEW YORK FAST FOOD</b>
<div class="big">SINOV CHEKI</div>
<div>${escape(title)}</div>
<div>${escape(deviceName)}</div>
<div>${escape(now)}</div>
<div class="credit">by ID GROUP team</div>
</body></html>`
}

module.exports = { PRINT_PORT, ROLES, printHtml, startPrintServer, testReceiptHtml }
