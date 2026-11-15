// Pemuat .env minimal (tanpa dependensi). Tidak menimpa variabel yang sudah ada di environment.
import { readFileSync, existsSync } from 'node:fs';

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

export function loadEnvFile(file, target = process.env) {
  if (!existsSync(file)) return { loaded: 0 };
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  let loaded = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (target[k] === undefined || target[k] === '') { target[k] = v; loaded += 1; }
  }
  return { loaded };
}
