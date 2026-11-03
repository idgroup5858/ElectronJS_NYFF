# ElectronJS_NYFF

Foydalanuvchi bilan o'zbek tilida (lotin) gaplashiladi. Kod faqat aniq "boshla" dan keyin yoziladi.

"NYFF Offline" — kassa kompyuteridagi offline kassa (internet yo'q paytda savdo, internet qaytgach markazga yuboradi):
Electron qobig'i (`main.js`, tray, sozlash oynasi) + offline server (`server/`, NestJS) + web ilovaning build'i
(`../ReactJS_NYFF`, sahifa `/offline`). Tuzilishi `../ElectronJS_HR_System` bilan bir xil.

Markaz tomoni (`/api/sync/*`, filial kaliti) va qarorlar — `../NestJS_NYFF/API.md` 14-bo'lim va `../NestJS_NYFF/PLAN.md`
("Offline kassa"). `server/src/shared/` — markaz bilan bir xil bo'lishi shart bo'lgan turlar va qoidalar (nusxa):
markazda o'zgarsa — shu yerda ham.
