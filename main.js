const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell, utilityProcess } = require('electron')
const fs = require('fs')
const http = require('http')
const netTcp = require('net')
const path = require('path')
const { ROLES, printHtml, startPrintServer, testReceiptHtml } = require('./printer')

/*
 * NYFF Offline: kassa kompyuterida fonda ishlaydigan offline kassa serveri (NestJS, `server/`). Oynasi yo'q — faqat tray.
 * Kassir brauzerda online kassada ishlaydi; internet uzilsa online kassa o'zi http://localhost:3100/offline ga o'tadi,
 * buyurtmalar shu kompyuterdagi PostgreSQL'ga yoziladi va internet qaytgach markazga yuboriladi. Windows bilan birga
 * yashirin ishga tushadi, server tushib qolsa qayta ko'tariladi. Birinchi ishga tushishda — sozlash oynasi (markaz
 * manzili va admin paneldagi "Offline kalit").
 * Chek chop etish (`printer.js`): online va offline kassa chekni shu dasturga yuboradi — kassa va oshxona printeriga
 * oynasiz, parallel (printerlar — sozlamalar oynasida).
 */
const APP_NAME = 'NYFF Offline'
const DEFAULT_PORT = 3100
const DEFAULT_CENTRAL_URL = 'https://newyork24.uz'
const API_TIMEOUT_MS = 90_000
// Kompyuter yonganda PostgreSQL servisi ilovadan keyin ko'tarilishi mumkin — shuncha kutiladi
const DB_WAIT_MS = 120_000
const RESTART_MIN_MS = 5_000
const RESTART_MAX_MS = 60_000
// Tray holati (shu kompyuterdagi serverdan) — markazga so'rov ketmaydi
const STATUS_POLL_MS = 10_000
// Filial kaliti: `br_….<maxfiy qism>` (admin "Filiallar" → "Offline kalit")
const KEY_PATTERN = /^br_[A-Za-z0-9_]+\.[A-Za-z0-9_-]{16,}$/

// PostgreSQL standart 5432 portida, `postgres` / `root`, baza `nyff` (kassa kompyuteriga shunday o'rnatiladi).
// "localhost" o'rniga aniq manzillar: Node IPv4 yoki IPv6 ni tanlashi mumkin, ularda turli server bo'lishi mumkin.
const DB_DEFAULTS = {
  host: 'localhost',
  hosts: ['127.0.0.1', '::1'],
  ports: [5432],
  user: 'postgres',
  password: 'root',
  database: 'nyff',
}

// Test yoki ikkinchi nusxa uchun ma'lumotlar papkasini almashtirish (odatda bo'sh)
if (process.env.NYFF_OFFLINE_DATA_DIR) app.setPath('userData', process.env.NYFF_OFFLINE_DATA_DIR)

// NSIS yorlig'i bilan bir xil ID: aks holda Windows taskbar oynani yorliqdan alohida guruhlaydi.
app.setAppUserModelId('uz.idgroup.nyff.offline')

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

// Windows bilan birga ishga tushganda — oynasiz, faqat tray
const startHidden = process.argv.includes('--hidden')
const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'app-resources')
const frontendDir = path.join(resourcesDir, 'frontend')
const backendDir = path.join(resourcesDir, 'backend')

const userDir = app.getPath('userData')
// Server ishchi papkasi: markazdan yuklangan rasmlar shu yerda (o'rnatish papkasiga — Program Files — yozib bo'lmaydi).
const dataDir = path.join(userDir, 'data')
const logDir = path.join(userDir, 'logs')
const configPath = path.join(userDir, 'config.json')
const iconPath = path.join(__dirname, 'logo.png')

let config = null
let backend = null
let backendReady = false
let restartDelay = RESTART_MIN_MS
let restartTimer = null
let statusTimer = null
let syncStatus = null
let setupWindow = null
let tray = null
let quitting = false
let logStream = null

// ------------------------------------------------------------------ sozlamalar va jurnal

function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

function loadConfig() {
  let loaded = {}
  try {
    loaded = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
    // Birinchi ishga tushirish yoki buzilgan fayl — standart sozlamalar bilan qayta yoziladi.
  }
  const defaults = {
    port: DEFAULT_PORT,
    autoStart: true,
    centralUrl: '',
    key: '',
    db: {
      host: DB_DEFAULTS.host,
      port: null,
      user: DB_DEFAULTS.user,
      password: DB_DEFAULTS.password,
      database: DB_DEFAULTS.database,
    },
    // Windows printer nomlari: mijoz cheki, oshxona cheki va truck cheki; bo'sh — tanlanmagan
    printers: { receipt: '', kitchen: '', truck: '' },
  }
  config = { ...defaults, ...loaded, db: { ...defaults.db, ...loaded.db }, printers: { ...defaults.printers, ...loaded.printers } }
  if (JSON.stringify(config) !== JSON.stringify(loaded)) saveConfig()
}

/** Sozlangan: markaz manzili va filial kaliti bor. */
const configured = () => Boolean(config.centralUrl && config.key)

function openLog() {
  fs.mkdirSync(logDir, { recursive: true })
  const current = path.join(logDir, 'offline.log')
  if (fs.existsSync(current)) fs.renameSync(current, path.join(logDir, 'offline.prev.log'))
  logStream = fs.createWriteStream(current, { flags: 'a' })
}

function log(line) {
  logStream?.write(`[${new Date().toISOString()}] ${line}\n`)
}

function logTail(lines = 15) {
  try {
    return fs
      .readFileSync(path.join(logDir, 'offline.log'), 'utf8')
      .replace(/\x1b\[[0-9;]*m/g, '')
      .trim()
      .split('\n')
      .slice(-lines)
      .join('\n')
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------ PostgreSQL

function dbCandidates(db, lastWorking) {
  const hosts = db.host && db.host !== 'localhost' ? [db.host] : DB_DEFAULTS.hosts
  const ports = db.port ? [db.port] : DB_DEFAULTS.ports
  const list = []
  // Oldingi safar ishlagan manzil birinchi — lekin u endi ishlamasa, qolganlari ham sinaladi.
  if (lastWorking?.host && lastWorking?.port) list.push(lastWorking)
  for (const port of ports) for (const host of hosts) list.push({ host, port })
  return list.filter((c, i) => list.findIndex((o) => o.host === c.host && o.port === c.port) === i)
}

function describeDbError(error) {
  if (error.code === '28P01') return "parol noto'g'ri"
  if (error.code === 'ECONNREFUSED') return 'server ishlamayapti'
  if (/timeout/i.test(error.message)) return 'javob yo‘q'
  return `${error.code ?? ''} ${error.message}`.trim()
}

/**
 * Barcha manzil/port juftliklarini sinaydi va baza bo'lmasa yaratadi.
 * Server hali ko'tarilmagan bo'lsa (kompyuter endi yondi) — [waitMs] gacha kutadi;
 * parol noto'g'ri bo'lsa kutish befoyda — darhol xato.
 */
async function prepareDatabase(db, lastWorking, waitMs = DB_WAIT_MS) {
  const { Client } = require(path.join(backendDir, 'node_modules', 'pg'))
  const started = Date.now()

  for (;;) {
    const attempts = []
    for (const { host, port } of dbCandidates(db, lastWorking)) {
      const client = new Client({ host, port, user: db.user, password: db.password, database: 'postgres', connectionTimeoutMillis: 4000 })
      try {
        await client.connect()
      } catch (error) {
        attempts.push({ where: `${host.includes(':') ? `[${host}]` : host}:${port}`, reason: describeDbError(error), code: error.code })
        continue
      }
      try {
        const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [db.database])
        if (exists.rowCount === 0) {
          log(`database "${db.database}" not found — creating`)
          await client.query(`CREATE DATABASE "${db.database.replace(/"/g, '""')}"`)
        }
        log(`postgres ok on ${host}:${port}, database "${db.database}"`)
        return { host, port }
      } finally {
        await client.end().catch(() => {})
      }
    }

    const wrongPassword = attempts.some((a) => a.code === '28P01')
    if (wrongPassword || Date.now() - started > waitMs) {
      const checked = attempts.map((a) => `${a.where} — ${a.reason}`).join('\n')
      throw new Error(
        (wrongPassword
          ? `PostgreSQL topildi, lekin «${db.user}» foydalanuvchisi uchun parol to'g'ri kelmadi.`
          : "PostgreSQL'ga ulanib bo'lmadi. PostgreSQL o'rnatilgani va servisi ishlayotganini tekshiring.") +
          `\n\nTekshirildi:\n${checked}`,
      )
    }
    log(`postgres not ready yet: ${attempts.map((a) => `${a.where} ${a.reason}`).join('; ')}`)
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}

// ------------------------------------------------------------------ server

function ensurePortFree(port) {
  return new Promise((resolve, reject) => {
    const server = netTcp.createServer()
    server.once('error', (error) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`${port}-port boshqa dastur tomonidan band. Uni to'xtatib, ${APP_NAME}ni qayta oching.`)
          : error,
      ),
    )
    server.once('listening', () => server.close(resolve))
    server.listen(port, '127.0.0.1')
  })
}

function startBackend(dbTarget) {
  fs.mkdirSync(dataDir, { recursive: true })
  backendReady = false

  backend = utilityProcess.fork(path.join(backendDir, 'dist', 'main.js'), [], {
    cwd: dataDir,
    stdio: 'pipe',
    serviceName: 'NYFF Offline server',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TZ: 'Asia/Tashkent',
      OFFLINE_PORT: String(config.port),
      DB_HOST: dbTarget.host,
      DB_PORT: String(dbTarget.port),
      DB_USER: config.db.user,
      DB_PASSWORD: config.db.password,
      DB_NAME: config.db.database,
      CENTRAL_URL: config.centralUrl,
      OFFLINE_KEY: config.key,
      UI_DIST: frontendDir,
      IMAGES_DIR: path.join(dataDir, 'uploads'),
    },
  })

  backend.stdout?.on('data', (chunk) => logStream?.write(chunk))
  backend.stderr?.on('data', (chunk) => logStream?.write(chunk))

  const current = backend
  current.on('exit', (code) => {
    log(`backend exited with code ${code}`)
    if (backend !== current) return
    backend = null
    backendReady = false
    updateTray()
    if (!quitting) scheduleRestart(dbTarget)
  })
}

/** Server tushib qolsa — kutib (5 s → 60 s gacha oshib boradi) qayta ishga tushiriladi. */
function scheduleRestart(dbTarget) {
  clearTimeout(restartTimer)
  log(`restarting backend in ${restartDelay / 1000}s`)
  restartTimer = setTimeout(async () => {
    try {
      await ensurePortFree(config.port)
      startBackend(dbTarget)
      await waitForApi(API_TIMEOUT_MS)
      onBackendReady()
    } catch (error) {
      log(`restart failed: ${error.message}`)
      backend?.kill()
    }
  }, restartDelay)
  restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS)
}

function onBackendReady() {
  backendReady = true
  restartDelay = RESTART_MIN_MS
  log(`backend ready on port ${config.port}`)
  void pollStatus()
}

function getJson(pathname, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: config.port, path: pathname, timeout }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
  })
}

function waitForApi(timeoutMs) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (!backend) return reject(new Error('backend exited'))
      getJson('/api/health').then(resolve, retry)
    }
    const retry = () => {
      if (Date.now() - started > timeoutMs) reject(new Error('timeout'))
      else setTimeout(attempt, 500)
    }
    attempt()
  })
}

async function startLocalBackend() {
  const dbTarget = await prepareDatabase(config.db, config.lastWorkingDb)
  if (config.lastWorkingDb?.host !== dbTarget.host || config.lastWorkingDb?.port !== dbTarget.port) {
    config.lastWorkingDb = dbTarget
    saveConfig()
  }
  await ensurePortFree(config.port)
  startBackend(dbTarget)
  try {
    await waitForApi(API_TIMEOUT_MS)
  } catch (error) {
    backend?.kill()
    throw new Error(`Server javob bermadi: ${error.message}\n\n${logTail()}`)
  }
  onBackendReady()
}

/** Serverni to'xtatadi (sozlamalar o'zgarganda — qayta ishga tushirishdan oldin). */
async function stopBackend() {
  clearTimeout(restartTimer)
  const current = backend
  if (!current) return
  backend = null
  backendReady = false
  await new Promise((resolve) => {
    current.once('exit', resolve)
    current.kill()
  })
}

/** Ishga tushmasa — sababi bilan oyna: qayta urinish / sozlamalar / chiqish. Natija: `started` | `setup` | `quit`. */
async function bootBackend() {
  for (;;) {
    try {
      await startLocalBackend()
      updateTray()
      return 'started'
    } catch (error) {
      log(`backend not started: ${error.message}`)
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: APP_NAME,
        message: `${APP_NAME} ishga tushmadi`,
        detail: `${error.message}\n\nJurnal: ${path.join(logDir, 'offline.log')}`,
        buttons: ['Qayta urinish', 'Sozlamalar', 'Chiqish'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })
      if (response === 2) return 'quit'
      if (response === 1) {
        updateTray()
        showSetup()
        return 'setup'
      }
    }
  }
}

// ------------------------------------------------------------------ tray holati

/** Tray uchun sinxronlash holati (shu kompyuterdagi serverdan; markazga so'rov ketmaydi). */
async function pollStatus() {
  clearTimeout(statusTimer)
  if (backendReady) {
    try {
      syncStatus = await getJson('/api/offline/status')
    } catch {
      syncStatus = null
    }
    updateTray()
  }
  statusTimer = setTimeout(() => void pollStatus(), STATUS_POLL_MS)
}

function statusText() {
  if (!configured()) return 'sozlanmagan'
  if (!backendReady) return 'ishga tushmoqda…'
  const status = syncStatus
  if (!status) return 'ishlayapti'
  let text = 'ishlayapti'
  if (status.error === 'unauthorized') text = "kalit noto'g'ri — Sozlamalar"
  else if (status.online === false) text = status.pending > 0 ? `internet yo'q · ${status.pending} ta buyurtma kutmoqda` : "internet yo'q"
  else if (status.pending > 0) text = `${status.pending} ta buyurtma yuborilmoqda`
  if (status.rejected > 0) text += ` · ${status.rejected} ta rad etildi`
  return text
}

// ------------------------------------------------------------------ oynalar va tray

function offlineUrl() {
  return `http://localhost:${config.port}/offline`
}

function openOfflineKassa() {
  if (!configured()) return showSetup()
  shell.openExternal(offlineUrl())
}

function showSetup() {
  if (setupWindow) {
    if (setupWindow.isMinimized()) setupWindow.restore()
    setupWindow.show()
    setupWindow.focus()
    return
  }
  Menu.setApplicationMenu(null)
  // POS monitorlari past — oyna eniga: chapda ulanish, o'ngda printerlar
  setupWindow = new BrowserWindow({
    width: 1000,
    height: 640,
    resizable: false,
    title: `${APP_NAME} — sozlamalar`,
    icon: iconPath,
    backgroundColor: '#121212',
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  })
  setupWindow.loadFile(path.join(__dirname, 'setup.html'))
  setupWindow.on('closed', () => {
    setupWindow = null
  })
}

function applyAutoStart() {
  // Dev rejimida electron.exe ni avtomatik ishga tushirishga yozib qo'ymaslik uchun
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: config.autoStart, path: process.execPath, args: ['--hidden'] })
}

async function confirmQuit() {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: APP_NAME,
    message: `${APP_NAME} to'xtatilsinmi?`,
    detail:
      "To'xtatilsa, internet uzilganda offline kassa ochilmaydi va yuborilmagan buyurtmalar markazga ketmaydi. " +
      'Dastur qayta ochilganda (yoki kompyuter qayta yonganda) davom etadi.',
    buttons: ["To'xtatish", 'Bekor qilish'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (response === 0) {
    quitting = true
    app.quit()
  }
}

function updateTray() {
  if (!tray) return
  const status = statusText()
  tray.setToolTip(`${APP_NAME} — ${status}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `${APP_NAME}: ${status}`, enabled: false },
      { type: 'separator' },
      { label: 'Offline kassani ochish', enabled: backendReady, click: openOfflineKassa },
      { label: 'Sozlamalar', click: showSetup },
      { type: 'separator' },
      {
        label: 'Windows bilan birga ishga tushirish',
        type: 'checkbox',
        checked: config.autoStart,
        enabled: app.isPackaged,
        click: (item) => {
          config.autoStart = item.checked
          saveConfig()
          applyAutoStart()
        },
      },
      { label: 'Jurnal papkasi', click: () => shell.openPath(logDir) },
      { type: 'separator' },
      { label: "To'xtatish va chiqish", click: confirmQuit },
    ]),
  )
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }))
  tray.on('click', () => tray.popUpContextMenu())
  updateTray()
}

// ------------------------------------------------------------------ sozlash oynasi (IPC)

/** Markaz javob beradimi va kalit to'g'rimi: `ok` | `key` (rad etildi) | `network` (javob yo'q). */
async function checkCentral(centralUrl, key) {
  try {
    const response = await fetch(`${centralUrl}/api/sync/snapshot`, {
      headers: { 'x-offline-key': key },
      signal: AbortSignal.timeout(10_000),
    })
    if (response.ok) {
      const snapshot = await response.json()
      return { result: 'ok', branch: snapshot.branch?.name ?? '' }
    }
    return { result: response.status === 401 ? 'key' : 'network', status: response.status }
  } catch {
    return { result: 'network' }
  }
}

ipcMain.handle('setup:load', () => ({
  centralUrl: config.centralUrl || DEFAULT_CENTRAL_URL,
  key: config.key,
  db: { ...config.db, port: config.db.port ?? DB_DEFAULTS.ports[0] },
  configured: configured(),
}))

/**
 * Saqlash: shakl → PostgreSQL (baza bo'lmasa yaratiladi) → markaz va kalit. Markaz javob bermasa — ogohlantirish
 * (internet yo'q paytda o'rnatilayotgan bo'lishi mumkin), [force] bilan baribir saqlanadi. Keyin server qayta ishga
 * tushadi.
 */
ipcMain.handle('setup:save', async (_event, input, force) => {
  const centralUrl = String(input.centralUrl ?? '').trim().replace(/\/+$/, '')
  const key = String(input.key ?? '').trim()
  if (!/^https?:\/\/[^\s/]+/.test(centralUrl)) return { status: 'error', field: 'centralUrl', message: "Server manzili noto'g'ri — masalan: https://newyork24.uz" }
  if (!KEY_PATTERN.test(key)) return { status: 'error', field: 'key', message: "Kalit noto'g'ri — admin panel → Filiallar → «Offline kalit» dan nusxalang" }
  const db = {
    host: String(input.db?.host ?? '').trim() || DB_DEFAULTS.host,
    port: Number(input.db?.port) || DB_DEFAULTS.ports[0],
    user: String(input.db?.user ?? '').trim() || DB_DEFAULTS.user,
    password: String(input.db?.password ?? ''),
    database: String(input.db?.database ?? '').trim() || DB_DEFAULTS.database,
  }
  if (!/^[A-Za-z0-9_]+$/.test(db.database)) return { status: 'error', field: 'database', message: "Baza nomi faqat lotin harflari, raqam va _ dan iborat bo'lsin" }

  let dbTarget
  try {
    dbTarget = await prepareDatabase({ ...db, port: db.port === DB_DEFAULTS.ports[0] ? null : db.port }, null, 0)
  } catch (error) {
    return { status: 'error', field: 'db', message: error.message }
  }

  const central = await checkCentral(centralUrl, key)
  if (central.result === 'key') return { status: 'error', field: 'key', message: "Markaz bu kalitni qabul qilmadi — admin paneldan yangisini nusxalang" }
  if (central.result === 'network' && !force) {
    return { status: 'warning', message: `Markazga ulanib bo'lmadi (${centralUrl}). Manzilni va internetni tekshiring — baribir saqlasangiz, internet bo'lganda o'zi ulanadi.` }
  }

  config = {
    ...config,
    centralUrl,
    key,
    db: { ...db, port: db.port === DB_DEFAULTS.ports[0] ? null : db.port },
    lastWorkingDb: dbTarget,
  }
  saveConfig()
  log(`settings saved: ${centralUrl}, branch ${key.slice(0, key.indexOf('.'))}`)

  await stopBackend()
  updateTray()
  const boot = await bootBackend()
  if (boot === 'quit') {
    quitting = true
    app.quit()
  }
  if (boot !== 'started') return { status: 'error', message: `Server ishga tushmadi — jurnal: ${path.join(logDir, 'offline.log')}` }
  setTimeout(() => setupWindow?.close(), 1500)
  tray?.displayBalloon({
    iconType: 'info',
    title: APP_NAME,
    content: `Sozlandi${central.branch ? ` — ${central.branch}` : ''}. Dastur fonda ishlaydi; internet uzilsa kassa o'zi offline rejimga o'tadi.`,
  })
  return { status: 'ok', branch: central.branch ?? '' }
})

ipcMain.handle('setup:open-kassa', () => openOfflineKassa())

// ------------------------------------------------------------------ printerlar (IPC)

const PRINTER_TITLES = { receipt: 'Kassa printeri (mijoz cheki)', kitchen: 'Oshxona printeri', truck: 'Truck printeri' }

ipcMain.handle('printers:load', async (event) => {
  const list = await event.sender.getPrintersAsync()
  return { list: list.map(({ name, displayName }) => ({ name, displayName: displayName || name })), selected: config.printers }
})

/** Tanlash darhol saqlanadi (server qayta ishga tushmaydi — chop etish har safar sozlamadan o'qiydi). */
ipcMain.handle('printers:set', (_event, role, name) => {
  if (!ROLES.includes(role)) return
  config.printers = { ...config.printers, [role]: String(name ?? '') }
  saveConfig()
  log(`printer ${role}: "${config.printers[role]}"`)
})

ipcMain.handle('printers:test', async (_event, role) => {
  const deviceName = config.printers[role]
  if (!ROLES.includes(role) || !deviceName) return { status: 'error', message: 'Avval printerni tanlang' }
  try {
    await printHtml(testReceiptHtml(PRINTER_TITLES[role], deviceName), deviceName)
    return { status: 'ok' }
  } catch (error) {
    log(`test print ${role} failed: ${error.message}`)
    return { status: 'error', message: `Chiqmadi: ${error.message}. Printer yoqilgan va ulanganini tekshiring.` }
  }
})

// ------------------------------------------------------------------ hayot sikli

// Yorliq qayta bosilsa — offline kassa brauzerda (sozlanmagan bo'lsa — sozlamalar)
app.on('second-instance', openOfflineKassa)

app.on('before-quit', () => {
  quitting = true
  clearTimeout(restartTimer)
  clearTimeout(statusTimer)
  backend?.kill()
})

// Hamma oyna yopilsa ham tray'da ishlashda davom etadi
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  openLog()
  loadConfig()
  log(`resources: ${resourcesDir}, data: ${userDir}, hidden: ${startHidden}`)
  createTray()
  applyAutoStart()
  // chek chop etish offline serverga bog'liq emas — sozlanmagan bo'lsa ham ishlaydi
  startPrintServer({ getCentralUrl: () => config.centralUrl || DEFAULT_CENTRAL_URL, getPrinters: () => config.printers, log })

  // birinchi ishga tushish — avval sozlash (server sozlangach o'sha oynadan ishga tushadi)
  if (!configured()) {
    showSetup()
    return
  }
  if ((await bootBackend()) === 'quit') {
    quitting = true
    app.quit()
  }
})
