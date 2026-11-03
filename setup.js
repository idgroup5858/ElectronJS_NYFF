// Sozlash oynasi: markaz manzili, filial kaliti, PostgreSQL ulanishi. Saqlashda tekshiriladi (`main.js` → setup:save).
const $ = (id) => document.getElementById(id)
const form = $('form')
const message = $('message')
const save = $('save')
// markaz javob bermadi — ikkinchi bosishda baribir saqlanadi
let warned = false

function show(kind, text) {
  message.className = `message ${kind}`
  message.textContent = text
  message.hidden = !text
}

function read() {
  return {
    centralUrl: $('centralUrl').value,
    key: $('key').value,
    db: {
      host: $('dbHost').value,
      port: $('dbPort').value,
      user: $('dbUser').value,
      password: $('dbPassword').value,
      database: $('dbName').value,
    },
  }
}

window.nyff.load().then((config) => {
  $('centralUrl').value = config.centralUrl
  $('key').value = config.key
  $('dbHost').value = config.db.host
  $('dbPort').value = config.db.port
  $('dbUser').value = config.db.user
  $('dbPassword').value = config.db.password
  $('dbName').value = config.db.database
  $('openKassa').hidden = !config.configured
  ;(config.centralUrl ? $('key') : $('centralUrl')).focus()
})

// maydon o'zgarsa — ogohlantirish qaytadan
form.addEventListener('input', () => {
  warned = false
  save.textContent = 'Saqlash'
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  save.disabled = true
  show('', '')
  save.textContent = 'Tekshirilmoqda…'
  const result = await window.nyff.save(read(), warned)
  save.disabled = false
  save.textContent = 'Saqlash'
  if (result.status === 'ok') {
    show('ok', `Saqlandi${result.branch ? ` — ${result.branch}` : ''}. Dastur fonda ishlaydi.`)
    $('openKassa').hidden = false
  } else if (result.status === 'warning') {
    warned = true
    save.textContent = 'Baribir saqlash'
    show('warning', result.message)
  } else {
    if (result.field === 'db') $('dbBox').open = true
    show('error', result.message)
  }
})

$('openKassa').addEventListener('click', () => window.nyff.openKassa())

// ------------------------------------------------------------------ printerlar

const printerMessage = $('printerMessage')
const selects = [...document.querySelectorAll('select[data-role]')]

function showPrinter(kind, text) {
  printerMessage.className = `message ${kind}`
  printerMessage.textContent = text
  printerMessage.hidden = !text
}

/** Windows printerlari ro'yxati; tanlangani ulanmagan bo'lsa ham ro'yxatda qoladi ("topilmadi"). */
async function loadPrinters() {
  const { list, selected } = await window.nyff.printers()
  for (const select of selects) {
    const current = selected[select.dataset.role] ?? ''
    const options = [new Option("— tanlanmagan —", '')]
    for (const printer of list) options.push(new Option(printer.displayName, printer.name))
    if (current && !list.some((printer) => printer.name === current)) options.push(new Option(`${current} (topilmadi)`, current))
    select.replaceChildren(...options)
    select.value = current
  }
}

for (const select of selects) {
  select.addEventListener('change', async () => {
    await window.nyff.setPrinter(select.dataset.role, select.value)
    showPrinter('ok', 'Saqlandi')
  })
}

for (const button of document.querySelectorAll('button[data-test]')) {
  button.addEventListener('click', async () => {
    button.disabled = true
    showPrinter('', '')
    const result = await window.nyff.testPrinter(button.dataset.test)
    button.disabled = false
    showPrinter(result.status === 'ok' ? 'ok' : 'error', result.status === 'ok' ? 'Sinov cheki yuborildi' : result.message)
  })
}

$('reloadPrinters').addEventListener('click', () => {
  showPrinter('', '')
  void loadPrinters()
})

void loadPrinters()
