// Transport Telegram Bot API. Hanya kirim (sendMessage). Tidak ada perintah masuk di sini.
// Token dibaca dari env; tidak pernah dicatat. Error dipetakan ke permanen / sementara.

export class TelegramTransport {
  constructor({ token, chatId, parseMode = 'HTML', timeoutMs = 15000, fetchImpl = globalThis.fetch }) {
    if (!token || !chatId) throw new Error('TELEGRAM_CONFIG_MISSING');
    this.token = token;
    this.chatId = chatId;
    this.parseMode = parseMode;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.name = 'telegram';
  }

  async send({ text, parseMode, idempotencyKey }) {
    let res;
    try {
      res = await this.fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: parseMode || this.parseMode,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // Jaringan/timeout: sementara, coba lagi.
      return { ok: false, error: `NETWORK:${e.name || 'ERR'}`, permanent: false };
    }
    let body = {};
    try { body = await res.json(); } catch { /* badan bukan JSON */ }
    if (res.ok && body.ok) return { ok: true, messageId: body.result?.message_id ?? null };

    const desc = String(body.description || `HTTP_${res.status}`).slice(0, 160);
    if (res.status === 429) {
      const retry = Number(body.parameters?.retry_after) || 30;
      return { ok: false, error: `RATE_LIMITED:${desc}`, permanent: false, retryAfterSec: retry };
    }
    if (res.status >= 500) return { ok: false, error: `SERVER:${res.status}`, permanent: false };
    // 400/401/403/404: salah konfigurasi atau pesan ditolak; mengulang tidak membantu.
    return { ok: false, error: `REJECTED:${res.status}:${desc}`, permanent: true };
  }

  /** getMe untuk verifikasi token (tanpa mengirim pesan). */
  async getMe() {
    const res = await this.fetch(`https://api.telegram.org/bot${this.token}/getMe`, { signal: AbortSignal.timeout(this.timeoutMs) });
    const body = await res.json().catch(() => ({}));
    return body.ok ? { ok: true, username: body.result.username, id: body.result.id } : { ok: false, status: res.status };
  }
}

/** Pembungkus error agar pesan token tidak bocor lewat stack/message. */
export function redact(text, token) {
  if (!token) return String(text);
  return String(text).split(token).join('[REDACTED]');
}
