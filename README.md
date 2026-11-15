# Atto Cuan — Pemantau Pasar Pribadi

Bot Telegram pemantau pasar kripto (BTC, ETH) + guardrail data Indodax.
Prinsip: **sinyal bukan perintah** — keputusan beli/jual tetap di manusia.
Spesifikasi lengkap: `STRATEGI.md` v1.1 (terkunci).

## Cara kerja
- **Siklus 15 menit**: harga Binance (fallback data-api.binance.vision), indikator dari **closed candle only**,
  guardrail silang Indodax vs Binance×kurs (dev > 2% → `DATA_ANOMALY`, sinyal ditahan).
- **Digest 07:00 WIB** dan **heartbeat 08:00 WIB** otomatis via GitHub Actions.
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

### A. Hosting Node.js 24/7 (Botkeep dan sejenis)
1. Hubungkan repo GitHub ini (branch `main`). `package.json` sudah ada, start command: `npm start`.
2. Isi Environment / env var di panel — **jangan** unggah `.env`:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
3. Start. Log console yang sehat: `START` → `CYCLE_DONE` (`errors: 0`) → `SLEEP`.
4. `data/` (state + rantai audit) otomatis dibuat dari `seed/` saat pertama jalan.
   `seed/` hanya dipakai bila `data/state.json` belum ada, jadi data yang sudah jalan tidak pernah ditimpa.
5. Ekuitas acuan berumur 7 hari (`risk.equityTtlDays`). Setelah lewat, gerbang `EQUITY_STALE`
   menahan sinyal sampai dikonfirmasi ulang: `npm run equity -- --confirm`.

### B. Windows Task Scheduler (lokal)
`AttoCuan-Cycle` tiap 15 menit lewat `run-cycle.bat`.
Jalankan **salah satu** saja (A atau B) — dua instance akan mengirim pesan dobel ke chat yang sama.

## Deployment (riwayat v1.3.1, tidak lagi dipakai)
1. Push repo ini ke GitHub (publik — tidak ada rahasia di kode).
2. Settings → Secrets and variables → Actions → New repository secret:
   - `ATTO_CUAN_TOKEN` = token bot dari @BotFather
   - `ATTO_CUAN_CHAT` = chat ID Telegram kamu
3. Actions aktif → workflow jalan tiap 15 menit + digest + heartbeat.
   Tes manual: tab Actions → "Atto Cuan — siklus pasar" → Run workflow.

⚠️ Token bot hanya boleh dipakai SATU konsumen. Matikan instance lama sebelum menyalakan yang baru.
