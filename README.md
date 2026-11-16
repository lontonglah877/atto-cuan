# Atto Cuan — Pemantau Pasar Pribadi

Bot Telegram pemantau pasar kripto (BTC, ETH) + guardrail data Indodax.
Prinsip: **sinyal bukan perintah** — keputusan beli/jual tetap di manusia.
Spesifikasi lengkap: `STRATEGI.md` v1.1 (terkunci).

## Cara kerja
- **Siklus 15 menit**: harga Binance (fallback data-api.binance.vision), indikator dari **closed candle only**,
  guardrail silang Indodax vs Binance×kurs (dev > 2% → `DATA_ANOMALY`, sinyal ditahan).
- **Digest 07:00 WIB** dan **heartbeat 08:00 WIB** (dijadwalkan di dalam loop server).
- Sinyal hanya terbit bila: tren 4H naik (harga > EMA200) + RSI 1H balik dari < 30,
  dengan SL −1,5 ATR / TP +3,0 ATR, cooldown 24 jam, plafon risiko terbuka 2%.

## Menjalankan lokal (uji)
```
cp .env.contoh .env   # isi TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID (jangan di-commit)
npm start                    # loop 15 menit (hosting / server yang berjalan terus)
npm run once                 # satu siklus saja, lalu berhenti
npm run equity -- --confirm  # konfirmasi ulang ekuitas acuan (TTL 7 hari)
npm test                     # tes unit + e2e
```

## Deployment

### A. Hosting Node.js 24/7 (Botkeep — dipakai sekarang)

Server: Botkeep Standard Free, Node.js 22, app `AttoCuan` (`0d6156f0-07de-4203-9e42-573919e8bb69`).

1. Kode ada di subfolder **`attocuan-upload/`** di dalam app (bukan di root app).
   Upload lewat **Files → Upload folder** (import GitHub tidak dipakai).
2. Env Telegram diisi di panel (**Environment**) atau file `.env` di root app.
   **Jangan** unggah `.env` dari laptop; jangan pernah commit.
3. **Startup command** (tab Startup → Apply configuration):
   ```
   cd attocuan-upload && set -a && . ../.env && set +a; npm start
   ```
   Arti: masuk folder kode, ekspor variabel dari `.env` di root app, lalu jalankan loop.
4. Start. Log console yang sehat: `START` → `CYCLE_DONE` (`errors: 0`) → `SLEEP`.
   `SLEEP` menghitung sisa waktu ke batas 15 menit berikutnya, jadi jadwal tetap rata.
5. `data/` (state + rantai audit) dibuat dari `seed/` saat pertama jalan dan **tidak** ditimpa
   pada restart berikutnya (`seeded: null`).
6. Cek isi state kapan pun: Files → `attocuan-upload/data/state.json` (editor teks).
7. Ekuitas acuan berumur 7 hari (`risk.equityTtlDays`). Setelah lewat, gerbang `EQUITY_STALE`
   menahan sinyal sampai dikonfirmasi ulang. Di hosting tanpa shell, jalankan sekali lewat
   Startup command sementara:
   ```
   cd attocuan-upload && set -a && . ../.env && set +a; npm run equity -- --confirm; npm start
   ```
   setelah `EQUITY_*` muncul di console, kembalikan startup command ke butir 3.

### B. Windows Task Scheduler (lokal) — **sudah dihapus**

Dulu `AttoCuan-Cycle` tiap 15 menit lewat `run-cycle.bat`. Sudah di-`Unregister-ScheduledTask`
karena Botkeep yang menjalankan siklus. Jalankan **salah satu** saja — dua instance mengirim pesan dobel.

## Deployment (riwayat v1.3.1, tidak lagi dipakai)
1. Push repo ini ke GitHub (publik — tidak ada rahasia di kode).
2. Settings → Secrets and variables → Actions → New repository secret:
   - `ATTO_CUAN_TOKEN` = token bot dari @BotFather
   - `ATTO_CUAN_CHAT` = chat ID Telegram kamu
3. Actions aktif → workflow jalan tiap 15 menit + digest + heartbeat.
   Tes manual: tab Actions → "Atto Cuan — siklus pasar" → Run workflow.

⚠️ Token bot hanya boleh dipakai SATU konsumen. Matikan instance lama sebelum menyalakan yang baru.
