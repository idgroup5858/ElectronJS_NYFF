// UI (React — ../ReactJS_NYFF) va offline kassa serverini (./server) build qilib, electron-builder `extraResources`
// sifatida oladigan `app-resources/` papkasiga joylaydi (ElectronJS_HR_System bilan bir xil yo'l).
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FRONTEND_SRC = path.resolve(ROOT, '..', 'ReactJS_NYFF')
const SERVER_SRC = path.join(ROOT, 'server')

const OUT = path.join(ROOT, 'app-resources')
const FRONTEND_OUT = path.join(OUT, 'frontend')
const BACKEND_OUT = path.join(OUT, 'backend')

function run(command, cwd) {
  console.log(`\n> ${command}\n  (${cwd})`)
  execSync(command, { cwd, stdio: 'inherit', shell: true })
}

function fail(message) {
  console.error(`\nPREPARE FAILED: ${message}`)
  process.exit(1)
}

for (const dir of [FRONTEND_SRC, SERVER_SRC]) {
  if (!fs.existsSync(path.join(dir, 'package.json'))) fail(`project not found: ${dir}`)
}

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(BACKEND_OUT, { recursive: true })

// 1. UI — avval tiplar tekshiriladi, keyin build to'g'ridan-to'g'ri app-resources ga. Offline kassa (`/offline`)
// so'rov va rasmlarni doim o'zi ochilgan serverdan oladi — `VITE_API_URL` bo'lsa ham. `--base /`: markazda xodimlar
// tizimi maxfiy yo'lda (`/shorva`), offline server esa web ilovani ildizdan beradi (`localhost:3100/offline`).
run('npx tsc -b', FRONTEND_SRC)
run(`npx vite build --base / --outDir "${FRONTEND_OUT}" --emptyOutDir`, FRONTEND_SRC)
if (!fs.existsSync(path.join(FRONTEND_OUT, 'index.html'))) fail('frontend index.html missing')

// 2. Offline kassa serveri: build (server/dist) → app-resources/backend + faqat ishlash uchun kerakli paketlar
run('npm run build', SERVER_SRC)
fs.cpSync(path.join(SERVER_SRC, 'dist'), path.join(BACKEND_OUT, 'dist'), { recursive: true })
const mainJs = path.join(BACKEND_OUT, 'dist', 'main.js')
if (!fs.existsSync(mainJs)) fail('backend dist/main.js missing')
const migrations = path.join(BACKEND_OUT, 'dist', 'offline', 'migrations')
if (!fs.existsSync(migrations) || !fs.readdirSync(migrations).some((f) => f.endsWith('.js'))) {
  fail('backend migrations missing')
}

for (const file of ['package.json', 'package-lock.json']) {
  fs.copyFileSync(path.join(SERVER_SRC, file), path.join(BACKEND_OUT, file))
}
run('npm ci --omit=dev --no-audit --no-fund', BACKEND_OUT)

for (const mod of ['@nestjs/core', '@nestjs/serve-static', 'typeorm', 'pg', 'bcryptjs']) {
  if (!fs.existsSync(path.join(BACKEND_OUT, 'node_modules', ...mod.split('/')))) {
    fail(`backend dependency missing: ${mod}`)
  }
}

console.log('\nPREPARE OK — app-resources ready.')
