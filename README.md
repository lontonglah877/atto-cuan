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
cp .env.contoh .env   # isi token & chat id
node sentinel.mjs cycle      # satu siklus penuh
node sentinel.mjs digest     # digest harian
node sentinel.mjs heartbeat  # heartbeat
```

## Deployment (GitHub Actions, gratis)
1. Push repo ini ke GitHub (publik — tidak ada rahasia di kode).
2. Settings → Secrets and variables → Actions → New repository secret:
   - `ATTO_CUAN_TOKEN` = token bot dari @BotFather
   - `ATTO_CUAN_CHAT` = chat ID Telegram kamu
3. Actions aktif → workflow jalan tiap 15 menit + digest + heartbeat.
   Tes manual: tab Actions → "Atto Cuan — siklus pasar" → Run workflow.

⚠️ Token bot hanya boleh dipakai SATU konsumen. Matikan instance lama sebelum menyalakan yang baru.
