# ✦ Whiteboard — Real-time Collaborative Canvas

Real-time whiteboard: ko'p foydalanuvchi bir vaqtda chiza oladi, barcha o'zgarishlar darhol ko'rinadi.

---

## 📁 Loyiha strukturasi

```
whiteboard/
├── backend/
│   ├── server.js       ← Asosiy server (Socket.io + Express)
│   ├── db.js           ← PostgreSQL ulanish va schema
│   ├── package.json
│   └── .env.example    ← Environment variables namunasi
└── frontend/
    └── index.html      ← To'liq frontend (single file)
```

---

## 🚀 Deploy qilish — Bosqichma-bosqich

### 1. Backend → Render.com

1. [render.com](https://render.com) ga kiring → **New Web Service**
2. GitHub reponi ulang (backend papkasini)
3. Quyidagi sozlamalar:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Environment:** Node

4. **Environment Variables** qo'shing:
   ```
   NODE_ENV=production
   CLIENT_URL=https://sizning-vercel-url.vercel.app
   ```

5. **Database yaratish:** Render → New → PostgreSQL (bepul tier)
   - Yaratilgandan keyin **Internal Database URL** ni nusxalab oling
   - Environment variables ga qo'shing: `DATABASE_URL=<nusxalangan URL>`

6. Deploy → URL ni saqlang: `https://sizning-app.onrender.com`

---

### 2. Frontend → Vercel

1. `frontend/index.html` faylini oching
2. **Faqat 1 qatorni o'zgartiring** (12-qator):
   ```javascript
   const SERVER_URL = 'https://sizning-app.onrender.com';
   ```

3. [vercel.com](https://vercel.com) → New Project → frontend papkasini deploy qiling
4. Vercel URL ni oling: `https://sizning-app.vercel.app`

5. Render.com ga qayting → `CLIENT_URL` ni Vercel URL ga o'zgartiring → Redeploy

---

### 3. UptimeRobot — Cold Start oldini olish (muhim!)

Render bepul tier 15 daqiqa faolsizlikdan keyin uxlab qoladi.

1. [uptimerobot.com](https://uptimerobot.com) → Bepul hisob
2. New Monitor → HTTP(s) monitor
3. URL: `https://sizning-app.onrender.com/health`
4. Interval: **14 daqiqa**

Shundan keyin server hech qachon uxlamaydi.

---

## 🛠️ Local ishga tushirish

```bash
# Backend
cd backend
cp .env.example .env
# .env faylini to'ldiring

npm install
npm run dev   # nodemon bilan

# Frontend
# frontend/index.html ni brauzerda oching
# yoki: npx serve frontend/
```

---

## 🎨 Asboblar

| Asbob | Shortcut | Tavsif |
|-------|----------|--------|
| Qalam | P | Erkin chizish |
| O'chirg'ich | E | O'chirish |
| Chiziq | L | To'g'ri chiziq |
| To'rtburchak | R | Kvadrat/Rectangle |
| Doira | C | Ellipse/Circle |
| Uchburchak | — | Uchburchak |
| O'q | — | Arrow |
| Matn | T | Matn qo'shish |
| Tanlash | S | Select mode |

**Boshqaruv tugmalari:**
- `Ctrl+Z` — Orqaga
- `Esc` — Text inputni yopish
- O'ng klik — Context menu
- 📋 Room ID — Linkni nusxalash

---

## ⚡ Socket.io Events

### Client → Server
| Event | Ma'lumot | Tavsif |
|-------|----------|--------|
| `join-room` | `{roomId, userId}` | Xonaga kirish |
| `stroke-start` | `{tool, color, width, ...}` | Chizish boshlash |
| `stroke-point` | `{x, y}` | Nuqta yuborish |
| `stroke-end` | `{strokeId, points, ...}` | Saqlash |
| `image-add` | `{imageData, x, y, ...}` | Rasm qo'shish |
| `note-add` | `{x, y, content, bgColor}` | Sticky note |
| `note-update` | `{noteId, content, x, y}` | Note yangilash |
| `note-delete` | `{noteId}` | Note o'chirish |
| `undo` | — | Oxirgi chizmani o'chirish |
| `clear-board` | — | Hammasini tozalash |
| `cursor-move` | `{x, y}` | Cursor pozitsiyasi |

### Server → Client
| Event | Tavsif |
|-------|--------|
| `joined` | Xonaga kirildi, user info |
| `user-joined/left` | Boshqa foydalanuvchi |
| `stroke-start/point/end` | Remote chizish |
| `stroke-removed` | Undo |
| `board-cleared` | Tozalash |
| `image-add` | Remote rasm |
| `note-add/update/delete` | Remote sticky note |
| `cursor-move` | Remote cursor |

---

## 🗄️ Database Schema

```sql
rooms        — xonalar (id, name, password_hash, last_active)
strokes      — chizmalar (tool, points, shapeData, color, width, ...)
sticky_notes — yopishqoq notlar (x, y, content, bg_color, ...)
```

Eski xonalar 30 kundan keyin avtomatik o'chiriladi.
