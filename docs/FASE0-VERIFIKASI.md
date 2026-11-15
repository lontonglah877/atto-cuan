# Fase 0 — Verifikasi Sumber Eksternal

Dijalankan: 2026-11-14T11:47:56.306Z (UTC). Mode: read-only, tanpa kredensial.

| Area | URL | HTTP | ms | Ringkasan |
|---|---|---|---|---|
| binance.time | https://data-api.binance.vision/api/v3/time | 200 | 2202 | {"serverTime":1794656869017} |
| binance.bookTicker | https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=BTCUSDT | 200 | 454 | {"symbol":"BTCUSDT","bidPrice":"67228.00000000","bidQty":"1.63089000","askPrice":"67228.01000000","askQty":"0.29941000"} |
| indodax.pairs | https://indodax.com/api/pairs | 200 | 912 | [{"ticker_id":"btc_idr","pricescale":1000,"price_precision":1000,"quantity_increment":1e-8,"minIdr":10000,"minQty":0.0000081,"feeTakerPct":0.2,"feeMakerPct":0.1},{"ticker_id":"eth_idr","pricescale":1000,"price_precision" |
| indodax.server_time | https://indodax.com/api/server_time | 200 | 338 | {"timezone":"UTC","server_time":1794656873319} |
| indodax.ticker.btc_idr | https://indodax.com/api/ticker/btc_idr | 200 | 443 | {"buy":"1234167000","high":"1280929000","last":"1234168000","low":"1222233000","sell":"1234168000","server_time":1794656869,"vol_btc":"38.54515462","vol_idr":"47930152833"} |
| indodax.ticker.eth_idr | https://indodax.com/api/ticker/eth_idr | 200 | 171 | {"buy":"34993000","high":"36297000","last":"35044000","low":"34441000","sell":"35045000","server_time":1794656870,"vol_eth":"164.20710805","vol_idr":"5771481465"} |
| indodax.ticker.usdt_idr | https://indodax.com/api/ticker/usdt_idr | 200 | 77 | {"buy":"18329","high":"18350","last":"18330","low":"18222","sell":"18330","server_time":1794656870,"vol_idr":"59208224596","vol_usdt":"3239226.54153815"} |
| indodax.depth.btc_idr | https://indodax.com/api/depth?pair=btc_idr | 200 | 898 | {"keys":["buy","sell"],"askLevels":150,"bidLevels":150,"bestAsk":["1234168000","0.66521943"]} |
| indodax.trades.btc_idr | https://indodax.com/api/trades?pair=btc_idr&limit=500 | 200 | 478 | {"n":500,"spanSec":4014,"fields":["tid","type","price","amount","date"]} |

## Nilai terverifikasi (tempel ke config.json)
```json
{
  "binanceTime": {
    "serverTime": 1794656869017
  },
  "binanceKlines": {
    "error": "{(intermediate value)(intermediate value)(intermediate value)} is not a function"
  },
  "bookTicker": {
    "symbol": "BTCUSDT",
    "bidPrice": "67228.00000000",
    "bidQty": "1.63089000",
    "askPrice": "67228.01000000",
    "askQty": "0.29941000"
  },
  "binancePrimary": {
    "error": "fetch failed"
  },
  "pairs": [
    {
      "ticker_id": "btc_idr",
      "pricescale": 1000,
      "price_precision": 1000,
      "quantity_increment": 1e-8,
      "minIdr": 10000,
      "minQty": 0.0000081,
      "feeTakerPct": 0.2,
      "feeMakerPct": 0.1
    },
    {
      "ticker_id": "eth_idr",
      "pricescale": 1000,
      "price_precision": 1000,
      "quantity_increment": 1e-8,
      "minIdr": 10000,
      "minQty": 0.00028534,
      "feeTakerPct": 0.2,
      "feeMakerPct": 0.1
    },
    {
      "ticker_id": "usdt_idr",
      "pricescale": 1,
      "price_precision": 1,
      "quantity_increment": 1e-8,
      "minIdr": 10000,
      "minQty": 0.5455835,
      "feeTakerPct": 0.2,
      "feeMakerPct": 0.1
    }
  ],
  "serverTime": {
    "timezone": "UTC",
    "server_time": 1794656873319
  },
  "tickers": {
    "btc_idr": {
      "buy": "1234167000",
      "high": "1280929000",
      "last": "1234168000",
      "low": "1222233000",
      "sell": "1234168000",
      "server_time": 1794656869,
      "vol_btc": "38.54515462",
      "vol_idr": "47930152833"
    },
    "eth_idr": {
      "buy": "34993000",
      "high": "36297000",
      "last": "35044000",
      "low": "34441000",
      "sell": "35045000",
      "server_time": 1794656870,
      "vol_eth": "164.20710805",
      "vol_idr": "5771481465"
    },
    "usdt_idr": {
      "buy": "18329",
      "high": "18350",
      "last": "18330",
      "low": "18222",
      "sell": "18330",
      "server_time": 1794656870,
      "vol_idr": "59208224596",
      "vol_usdt": "3239226.54153815"
    }
  },
  "depth": {
    "keys": [
      "buy",
      "sell"
    ],
    "askLevels": 150,
    "bidLevels": 150,
    "bestAsk": [
      "1234168000",
      "0.66521943"
    ]
  },
  "trades": {
    "n": 500,
    "spanSec": 4014,
    "fields": [
      "tid",
      "type",
      "price",
      "amount",
      "date"
    ]
  },
  "derivedTicks": {
    "btc_idr": 1000,
    "eth_idr": 1000,
    "usdt_idr": 1
  }
}
```