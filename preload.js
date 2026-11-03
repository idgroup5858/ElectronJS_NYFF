const { contextBridge, ipcRenderer } = require('electron')

// Sozlash oynasi uchun: sozlamalarni o'qish, saqlash (tekshirib), offline kassani brauzerda ochish, printerlar
contextBridge.exposeInMainWorld('nyff', {
  load: () => ipcRenderer.invoke('setup:load'),
  save: (input, force = false) => ipcRenderer.invoke('setup:save', input, force),
  openKassa: () => ipcRenderer.invoke('setup:open-kassa'),
  printers: () => ipcRenderer.invoke('printers:load'),
  setPrinter: (role, name) => ipcRenderer.invoke('printers:set', role, name),
  testPrinter: (role) => ipcRenderer.invoke('printers:test', role),
})
