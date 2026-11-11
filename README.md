# NYFF Offline — kassa kompyuteri (Electron)

Internet (markaziy server) yo'q paytda **kassa** shu kompyuterda ishlashda davom etadi: savdo, chek, "Tayyor" (kassir
bosadi). Internet qaytgach buyurtmalar markazga o'zi yuboriladi. Markaz tomoni va qarorlar —
[../NestJS_NYFF/API.md](../NestJS_NYFF/API.md) 14-bo'lim, [../NestJS_NYFF/PLAN.md](../NestJS_NYFF/PLAN.md).

## Qanday ishlaydi

- Oynasi yo'q — **fonda, tray'da** (soat yonidagi belgi). **Windows bilan birga yashirin ishga tushadi** (`--hidden`).
  Tray menyusi: holat ("ishlayapti", "internet yo'q · 3 ta buyurtma kutmoqda"), "Offline kassani ochish", "Sozlamalar",
  "Windows bilan birga ishga tushirish", "Jurnal papkasi", "To'xtatish va chiqish" (tasdiqlash bilan).
- Ichida offline server (`server/`, NestJS) Electron'ning fon jarayonida (`utilityProcess`): `http://localhost:3100`,
  faqat shu kompyuterdan. Tushib qolsa **o'zi qayta ko'tariladi** (5 s → 60 s gacha).
- Kassir brauzerda **online kassada** ishlayveradi. Internet (server) 10 soniyadan ko'p uzilsa — "Internet yo'q" oynasi,
  yana 10 soniyadan keyin online kassa o'zi `http://localhost:3100/offline` ga o'tadi (kassir, oxirgi raqam, ochiq cheklar
  va menyu bilan). Internet qaytib (har 5 soniyada tekshiriladi) hammasi yuborilgach — **5 soniyadan keyin online kassaga
  o'zi qaytadi** (ochiq cheklar bilan; "Online rejimga qaytish" — darhol). To'lov oynasi yoki buyurtmalar ochiq bo'lsa —
  sanash ular yopilguncha kutadi. Kassir kirmagan (PIN oynasi) bo'lsa ham qaytadi. Ish stolidagi "NYFF Offline kassa"
  yorlig'i — offline kassani brauzerda ochadi.
- Markazga **har daqiqa so'rov ketmaydi**: kassirlar, menyu va rasmlar nusxasi — ishga tushganda va internet qaytib
  buyurtmalar yuborilgandan keyin; tekshiruv — faqat yuboriladigan buyurtma bor yoki offline kassa ochiq paytda. Markaz
  qabul qilgan buyurtma offline bazadan darhol o'chadi.
- Kompyuter yonganda PostgreSQL kech ko'tarilsa — 2 daqiqagacha kutadi.
- **Chek chop etish** (`printer.js`, `http://127.0.0.1:3101`): online va offline kassa chekni shu dasturga yuboradi —
  **mijoz cheki** kassa printeriga, **oshxona cheki** (kassa cheki bilan bir xil, tepasida "OSHXONA", tayyor
  ichimliklarsiz — admin → Menyu → taom → "Oshxona chekiga chiqadi") oshxona printeriga, **truck cheki** (oshxona
  chekidek, faqat "Truck chekiga chiqadi" belgilangan taomlar) truck printeriga, **oynasiz va bir vaqtda**. Offline serverdan
  alohida — baza ishlamasa ham chek chiqadi. Printerlar — sozlash oynasida (Windows printerlari ro'yxati, "Sinov").
  Kassa printeri tanlanmagan yoki dastur ishlamasa — mijoz cheki hozirgidek brauzer orqali (standart printer);
  oshxona / truck cheki chiqmasa — kassada xabar (printeri tanlanmagan bo'lsa — jim, faqat qo'lda qayta chiqarishda).

## Talablar

- Windows 10/11 x64, **PostgreSQL** (servis sifatida): foydalanuvchi `postgres`, parol `root`. Baza `nyff` ni dastur
  o'zi yaratadi (boshqacha o'rnatilgan bo'lsa — sozlash oynasidagi "Baza" bo'limida).

## O'rnatish (kassa kompyuterida)

1. PostgreSQL'ni o'rnating (`postgres` / `root`).
2. `NYFF-Offline-Setup-<versiya>.exe` ni o'rnating. Imzo sertifikati yo'q — Windows "Windows protected your PC" desa:
   "More info" → "Run anyway".
3. Birinchi ochilishda **sozlash oynasi**:
   - **Server manzili** — markaziy server domeni (`https://newyork24.uz` — standart qiymat, o'zgartirmang);
   - **Offline kalit** — admin panel → Filiallar → filial → "Offline kalit" → Nusxalash.

   "Saqlash" — PostgreSQL va kalit tekshiriladi (markaz javob bermasa — ogohlantirish, "Baribir saqlash" mumkin).
   O'ng tomonda — **Printerlar**: "Kassa printeri", "Oshxona printeri" va "Truck printeri" (avval Windows'ga drayverini o'rnating;
   ro'yxatda yo'q bo'lsa — "ro'yxatni yangilang"), har biriga "Sinov". Tanlash darhol saqlanadi.
4. Online kassani oching (`https://newyork24.uz/shorva/kassa`): Chrome **bir marta** "qurilmadagi ilovalarga ulanish"
   ruxsatini so'raydi — **"Ruxsat berish"** (eslab qoladi; ruxsat berilmasa mijoz cheki brauzer orqali chiqadi, oshxona
   cheki — yo'q). Kassa sahifasi cheklarni har doim shu dastur orqali chiqaradi — hech narsa yoqish shart emas.
5. Offline rejim uchun: online kassada "Sozlamalar" → **"Internet uzilsa offline rejimga o'tish"** (manzil
   `http://localhost:3100`). Bu faqat internet uzilganda offline kassaga o'tishni yoqadi, chek chop etishga ta'siri yo'q.

Filialda offline faqat **bitta** kassa kompyuterida (aks holda buyurtma raqamlari to'qnashadi). Kassa kompyuteri soati
to'g'ri bo'lsin. Offline'da smena ochilmaydi / yopilmaydi.

## Sozlamalar va ma'lumotlar

`%APPDATA%\NYFF Offline\`:

| Fayl / papka | Nima |
|---|---|
| `config.json` | Server manzili (`centralUrl`), filial kaliti (`key`), port (3100), PostgreSQL (`db`: standart `postgres` / `root`, baza `nyff`), `autoStart`, printerlar (`printers`: `{ receipt, kitchen, truck }` — Windows printer nomi, bo'sh — tanlanmagan) |
| `logs\offline.log` | Jurnal (oldingisi — `offline.prev.log`) |
| `data\uploads\` | Markazdan yuklangan taom va kategoriya rasmlari |

Admin kalitni yangilasa ("Yangilash") — tray → "Sozlamalar" ga yangisini kiriting (holatda "kalit noto'g'ri" chiqadi).

## Yig'ish

```bash
npm install
npm run build        # UI (../ReactJS_NYFF) + server → app-resources/, keyin dist/NYFF-Offline-Setup-<versiya>.exe
npm start            # dev: app-resources/ dan ishga tushirish (avval npm run prepare-app)
npm test             # offline server testlari (server/, markazning soxtasi bilan; baza nyff_test_offline)
```

`npm install` Electron binary'sini yuklamasa (`node_modules/electron/dist` bo'sh) — `node node_modules/electron/install.js`.
`NYFF_OFFLINE_DATA_DIR` — test uchun boshqa ma'lumotlar papkasi (o'z `config.json` i bilan).

## Tuzilishi

| Joy | Nima |
|---|---|
| `main.js` | Electron: tray, sozlash oynasi (`setup.html`, `setup.js`, `preload.js`), PostgreSQL tekshiruvi, serverni ishga tushirish |
| `printer.js` | Chek chop etish xizmati (`127.0.0.1:3101`): `POST /print` `{ jobs: { to: 'receipt' \| 'kitchen' \| 'truck', html }[] }` → `{ results: { receipt?, kitchen?, truck?: 'ok' \| 'not_set' \| 'error' } }`, `GET /status`. Faqat markaz (`centralUrl`) va `localhost` sahifalaridan (boshqa `Origin` — 403) |
| `server/` | Offline server (NestJS): offline kassa API (`/api/offline/*`), markaz bilan sinxronlash, web ilova va rasmlar. `src/shared/` — markaz (`NestJS_NYFF`) bilan bir xil turlar va qoidalar |
| `scripts/prepare.js` | `../ReactJS_NYFF` va `server/` ni build qilib `app-resources/` ga joylaydi |

### Offline server API (`http://localhost:3100/api/offline/*`)

Faqat shu kompyuterdagi offline kassa sahifasi va tray uchun. Kirgan kassir — `Authorization: Bearer <token>` (16 soat).

| Metod va yo'l | Kim | So'rov | Javob |
|---|---|---|---|
| `GET /health` | ochiq | | `{ ok: true }` |
| `GET /offline/data` | ochiq | | `{ branch: { id, name }, cashiers: { id, name, surname }[], menu: Menu \| null, kassaUrl }` |
| `GET /offline/state` | ochiq (sahifa har 3 s) | | `{ ready, number: { confirmed, last }, sync: { configured, online, pending, rejected, lastSyncAt, error } }` |
| `GET /offline/status` | ochiq (tray) | | `sync` qismi — sahifa ochiq deb hisoblanmaydi |
| `POST /offline/handover` | ochiq | `{ branchId, branchName?, returnUrl?, cashier: { id, name, surname }, lastNumber, menu? }` | `{ token, cashier }` — online kassadan o'tish: kassir PIN'siz, raqam `max(lastNumber, offline, markaz)` dan |
| `POST /offline/login` | ochiq | `{ cashierId, pin }` | `{ token, cashier }` — `wrong_pin`, `too_many_attempts` (5 marta — 5 daqiqa), `not_found` |
| `POST /offline/number` | kassir | `{ last }` | `204` — kassir oxirgi chekdagi raqamni kiritdi |
| `POST /offline/leave` | ochiq | | `204` — "Online rejimga qaytish" (kirish oynasidan ham) |
| `GET /offline/orders` | kassir | | `Order[]` — markazga hali yetib bormaganlari, yangisi birinchi |
| `POST /offline/orders` | kassir | markazdagi `POST /orders` bilan bir xil (`id` bilan — takrorlanmaydi) | `201 Order` — `number_required`, `product_unavailable`, `invalid_amount`, `invalid_qty`, `empty_order` |
| `POST /offline/orders/:id/ready` | kassir | | `200 Order` — faqat `preparing` dan |
| `POST /offline/orders/:id/cancel` | kassir | | `200 Order` — `preparing` / `ready` dan |

**Buyurtma raqami.** Online kassa ko'rgan oxirgi raqam o'tishda uzatiladi — offline undan davom etadi. Online kassadan
o'tilmagan bo'lsa (brauzer yopilgan, yorliq), yangi kun yoki offline kassa 30 daqiqa ishlatilmagan bo'lsa —
`number_required` (409, "Oxirgi buyurtma raqamini kiriting"): kassir oxirgi chekdagi raqamni kiritadi.
