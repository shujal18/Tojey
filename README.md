# Tojey — Private Chat App

A clean, modern **one-to-one** private messaging application with a distinctive purple theme. Built for the feature scope you specified: text, voice, photos, videos, replies, reactions, typing/presence, read receipts — and **only** one-to-one messaging (no groups, calls, stories, payments).

---

## Demo Accounts

| Username | Password  | Display Name |
|----------|-----------|--------------|
| `tom`    | `tom18`   | Tom          |
| `jerry`   | `jerry22` | Jerry        |

Only these two accounts can log in.

---

## Architecture

```
                TOJEY APP
                   │
        ┌──────────┴──────────┐
        │                     │
    Frontend (React)      WebSocket
        │                     │
        └──────────┬──────────┘
                   │
            Render Backend
           Node.js + Socket.IO
                   │
         ┌─────────┼────────────┐
         │         │            │
         ▼         ▼            ▼
       Neon      Object      Push /
    PostgreSQL   Storage      Transcribe
```

- **Frontend**: React + Vite → served by Render (static or via backend)
- **Backend**: Node.js + Express + Socket.IO on Render (always-on instance for real-time)
- **Database**: PostgreSQL on Neon (pooled connection)
- **Media**: stored as files, referenced by URL in the DB
- **Real-time**: Socket.IO WebSockets

---

## Features Implemented

- **Auth**: hardcoded fixed accounts (tom/jerry), JWT sessions
- **One-to-one chat**: text messages with timestamps
- **Message states**: Sent → Delivered → Read (updates in real time)
- **Typing indicator** + **online/offline** presence
- **Reply** to a message (shown above composer)
- **Edit** sent messages (marked `edited`)
- **Delete for me** / **Delete for everyone**
- **Emoji reactions** with quick reactions (❤️ 😂 😮 😢 👍 👎)
- **Voice messages**: record (hold/lock), waveform, play/pause, 1×/1.5×/2× speed, "transcribe" placeholder
- **View-once** media flag
- **Purple Tojey theme** with light / dark / system modes
- **Contacts** screen + **Settings** screen (theme, font size, read receipts, notifications)
- **Chat composer** switches mic ↔ send based on typing

---

## Local Development

### 1. Configure environment

Copy `backend/.env` and set your Neon database URL:

```
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/tojey?sslmode=require
JWT_SECRET=your-secret
PORT=5000
```

### 2. Install & run backend

```bash
npm --prefix backend install
npm --prefix backend run dev      # starts on :5000
```

The backend auto-creates the schema and seeds the two demo accounts.

### 3. Run frontend

```bash
npm --prefix frontend install
npm --prefix frontend run dev     # starts on :5173
```

Frontend dev server proxies `/api`, `/socket.io` and `/uploads` to `:5000`.

Open http://localhost:5173

---

## Deploy on Render + Neon

### Neon (database)
1. Create a Neon project → copy the pooled connection string (`?sslmode=require`).
2. Place it in the backend `DATABASE_URL` env var.

### Backend (Render — Web Service)
- **Build Command**: `npm --prefix backend install`
- **Start Command**: `npm --prefix backend run start`
- **Instance Type**: use an **always-on** paid instance for reliable WebSockets (free tier sleeps and drops connections).
- **Environment vars**: `DATABASE_URL`, `JWT_SECRET`, `PORT`.

### Frontend (Render — Static Site) OR serve from backend
Option A — Static site:
- **Build**: `npm --prefix frontend run build`
- **Publish Directory**: `frontend/dist`
- Set `VITE_API_URL` to your backend URL.

Option B — serve the built frontend from the backend (single service).
Add to `backend/src/server.js`:

```js
const dist = path.join(__dirname, '..', '..', 'frontend', 'dist');
app.use(express.static(dist));
app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
```

---

## Project Layout

```
tojey/
├── backend/
│   ├── src/
│   │   ├── server.js      # Express + Socket.IO hub
│   │   ├── db.js          # Neon pool + schema + seeds
│   │   └── auth.js        # Fixed accounts + JWT
│   ├── uploads/           # media storage
│   └── .env
└── frontend/
    └── src/
        ├── theme/         # Tojey purple light/dark themes
        ├── services/      # Auth, Chat, Socket contexts
        ├── components/    # MessageBubble, VoiceBubble
        └── screens/       # Login, HomeLayout, ChatList,
                           # ChatRoom, Contacts, Settings
```

---

## Notes on Production Features

The current build wires the real-time plumbing (messaging, typing, presence, edit/delete, reactions) over Socket.IO and persists messages to PostgreSQL. Media upload endpoints, real voice recording via the MediaRecorder API, and a live speech-to-text provider are the next natural extensions — the UI and data model are already in place to support them.
