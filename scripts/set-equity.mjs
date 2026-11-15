// Konfirmasi / setel ekuitas acuan lewat state machine (bukan mengedit file langsung).
// Pakai: npm run equity -- --confirm
//        npm run equity -- --total 100000 --cash 100000
// Semua perubahan tercatat sebagai event audit berantai.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../src/env.mjs';
import { loadConfig } from '../src/config.mjs';
import { Clock } from '../src/clock.mjs';
import { StateStore } from '../src/state-store.mjs';
import { setEquity } from '../src/position-manager.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE_VERSION = 'atto-cuan/1.5.0';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = Number(argv[i + 1]);
  if (!Number.isFinite(v)) throw new Error(`${name} butuh angka`);
  return v;
};

const confirm = argv.includes('--confirm');
const totalIdr = flag('--total');
const cashIdr = flag('--cash');

if (!confirm && totalIdr == null && cashIdr == null) {
  console.error('Pakai: npm run equity -- --confirm  ATAU  --total <idr> [--cash <idr>]');
  process.exit(2);
}

loadEnvFile(path.join(ROOT, '.env'));
const { config } = await loadConfig({ dir: ROOT, env: process.env });
const clock = new Clock();
const store = new StateStore({
  dataDir: path.join(ROOT, 'data'),
  config,
  clock,
  codeVersion: CODE_VERSION,
  log: () => {},
});
await store.init();
await store.recover();

const result = await store.transact((state, _outbox, nowMs) => {
  const r = setEquity(state, { totalIdr, cashIdr, confirm, nowMs });
  return { events: r.events || [] };
});

const chain = await store.verifyAuditChain();
const p = result.state.portfolio;
console.log(
  JSON.stringify(
    {
      ok: chain.ok !== false,
      events: (result.events || []).map((e) => e.kind),
      equityReferenceIdr: p.equityReferenceIdr,
      availableCashIdr: p.availableCashIdr,
      equityConfirmedAtUtc: p.equityConfirmedAtUtc,
      stateVersion: result.state.stateVersion,
      auditChainOk: chain.ok !== false,
      auditEvents: chain.count ?? chain.events ?? null,
    },
    null,
    2,
  ),
);
process.exit(chain.ok === false ? 1 : 0);
