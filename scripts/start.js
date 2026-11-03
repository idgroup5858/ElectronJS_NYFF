// Dev'da ishga tushirish. VS Code (o'zi Electron) terminalga ELECTRON_RUN_AS_NODE=1 ni uzatadi —
// u bilan electron.exe oddiy Node bo'lib ishlaydi va `require('electron').app` bo'lmaydi.
const { spawn } = require('child_process')
const path = require('path')
const electron = require('electron') // Node'dan chaqirilganda — electron.exe yo'li

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, [path.resolve(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 0))
