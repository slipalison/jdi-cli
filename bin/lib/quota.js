'use strict';

// `jdi-cli quota [--json] [--claude-dir d]` — how close the ACCOUNT is to its
// usage limits, so an autonomous run pauses with a HANDOFF before a long step
// instead of dying in the middle of it (0.22).
// `jdi quota record` — keeps the `rate_limits` of a status line's input (the
// global command: `npm i -g jdi-cli` installs it as `jdi`).
//
// Sources, most trusted first:
//   1. status line snapshot — Claude Code hands every status line command the
//      account's real utilization (`rate_limits.five_hour` / `seven_day`:
//      used_percentage, resets_at). A status line that also pipes its input to
//      `jdi quota record` keeps the last one in
//      ~/.cache/jdi-cli/rate-limits.json (JDI_QUOTA_FILE overrides); trusted
//      while at most 15 minutes old.
//   2. a block in the transcripts — a model call refused with
//      `error: "rate_limit"` carries `quotaLimits.resetsAt`: while that time is
//      ahead, the verdict is `stop`, with the exact resume time.
//   3. local estimate — this machine's own usage (cache-weighted tokens, the
//      unit of `cost`) in the current 5-hour session and in the last 7 days,
//      against `quota.session_mtok` / `quota.weekly_mtok` when the project
//      sets them. Usage on other machines and on the web is invisible here:
//      measured on a real account, this machine's usage in the real windows of
//      four blocks ranged from 27 to 61 million — a guide, not a gauge. The
//      report lists the local usage at recent blocks to help pick the numbers.
// `--runtime <rt>` other than claude: `unknown` — every source above is Claude
// Code's, and another runtime's account is not the one they measure.
// Verdict: ok | tight (>= quota.warn_pct, default 80) | stop (>= quota.stop_pct,
// default 95, or blocked now) | unknown (no source). Exit 0 for ok and
// unknown, 3 tight, 4 stop. Writes .jdi/cache/quota.json, which `route` reads.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('./jdi-core');
const cost = require('./cost');

const SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;
const H5 = 5 * 3600 * 1000;
const TEN_MIN = 10 * 60 * 1000;
const D7 = 7 * 24 * 3600 * 1000;
const SCAN_DAYS_MS = 8 * 24 * 3600 * 1000;
const EXIT = { ok: 0, unknown: 0, tight: 3, stop: 4 };

const snapshotFile = () => process.env.JDI_QUOTA_FILE || path.join(os.homedir(), '.cache', 'jdi-cli', 'rate-limits.json');
const stateFile = (root) => path.join(root, core.JDI_DIR, 'cache', 'quota.json');
const indexFile = (root) => path.join(root, core.JDI_DIR, 'cache', 'quota-index.json');

// epoch seconds, epoch ms or an ISO string -> ms
function toMs(v) {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v || '');
  return Number.isNaN(t) ? null : t;
}

function limitOf(x) {
  if (x?.used_percentage == null) return null; // unknown, not 0%
  const pct = Number(x.used_percentage);
  return Number.isFinite(pct) ? { pct, resetsAt: toMs(x.resets_at) } : null;
}

// --------------------------------------------------------------------------
// `quota record` — runs inside a status line: fast, silent, never fails
// --------------------------------------------------------------------------

function record(readInput) {
  try {
    const rl = JSON.parse(readInput())?.rate_limits;
    if (!rl) return;
    const snap = { at: new Date().toISOString(), five_hour: limitOf(rl.five_hour), seven_day: limitOf(rl.seven_day) };
    const f = snapshotFile();
    const tmp = `${f}.${process.pid}.tmp`; // two status lines at once must not share it
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(snap) + '\n');
    fs.renameSync(tmp, f);
  } catch {
    // a status line must never break because of this
  }
}

function readSnapshot(now) {
  const s = core.readJson(snapshotFile(), null);
  if (!s?.at || now - Date.parse(s.at) > SNAPSHOT_MAX_AGE_MS) return null;
  return s;
}

// --------------------------------------------------------------------------
// Transcripts: model calls and blocks of the last days, every project
// --------------------------------------------------------------------------

function transcriptFiles(dir, since) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs >= since) out.push({ file: p, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // gone between the listing and the stat
        }
      }
    }
  };
  walk(dir);
  return out;
}

function blockOf(o) {
  const q = o.quotaLimits || o.rateLimits;
  if (o.error !== 'rate_limit' || !q) return null;
  return { ts: Date.parse(o.timestamp), resetsAt: toMs(q.resetsAt), type: q.rateLimitType || 'unknown' };
}

// One file -> its model calls ([id, ts, units]) and its blocks.
function parseFile(file) {
  const msgs = [];
  const blocks = [];
  const text = core.readIf(file) || ''; // a transcript deleted mid-scan reads as empty
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"') && !line.includes('rate_limit')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const b = blockOf(o);
    if (b) blocks.push(b);
    const m = o.message;
    if (o.type === 'assistant' && m?.usage && m.id && o.timestamp) msgs.push([m.id, Date.parse(o.timestamp), Math.round(cost.weighted(cost.usageOf(m.usage)))]);
  }
  return { msgs, blocks };
}

// Unchanged files are not read again: an index per file (size + mtime).
function scan(root, claudeProjects, now) {
  const index = core.readJson(indexFile(root), null) || { files: {} };
  const next = { files: {} };
  for (const f of transcriptFiles(claudeProjects, now - SCAN_DAYS_MS)) {
    const old = index.files[f.file];
    next.files[f.file] = old && old.size === f.size && old.mtimeMs === f.mtimeMs ? old : { size: f.size, mtimeMs: f.mtimeMs, ...parseFile(f.file) };
  }
  if (fs.existsSync(path.join(root, core.JDI_DIR))) core.writeFileEnsured(indexFile(root), JSON.stringify(next), root);
  const seen = new Map();
  const blocks = [];
  for (const v of Object.values(next.files)) {
    for (const [id, ts, units] of v.msgs) seen.set(id, { ts, units });
    blocks.push(...v.blocks);
  }
  return { msgs: [...seen.values()].sort((a, b) => a.ts - b.ts), blocks };
}

// 5-hour sessions as the account counts them. A block tells the truth about
// its window (it ends at `resetsAt`); elsewhere a session starts at the first
// call after the previous one ended, rounded down to 10 minutes — as the real
// windows are. Calls on other machines can still start a window earlier.
function sessions(msgs, anchors = []) {
  const out = [];
  let cur = null;
  for (const m of msgs) {
    const a = anchors.find((x) => m.ts >= x.end - H5 && m.ts < x.end);
    if (a && cur?.end !== a.end) {
      cur = { start: a.end - H5, end: a.end, units: 0 };
      out.push(cur);
    } else if (!a && (!cur || m.ts >= cur.end)) {
      const start = Math.floor(m.ts / TEN_MIN) * TEN_MIN;
      cur = { start, end: start + H5, units: 0 };
      out.push(cur);
    }
    cur.units += m.units;
  }
  return out;
}

function localUsage(msgs, blocks, now) {
  const fiveHour = [...new Map(blocks.filter((b) => b.type === 'five_hour' && b.resetsAt).map((b) => [b.resetsAt, b])).values()];
  const all = sessions(msgs, fiveHour.map((b) => ({ end: b.resetsAt })));
  const last = all.at(-1);
  const current = last && now < last.end ? last : null;
  const weekly = msgs.filter((m) => m.ts >= now - D7).reduce((n, m) => n + m.units, 0);
  // local usage in the real window of each recent block (older ones: their
  // transcripts may be out of the scan, and a partial sum misleads)
  const atBlocks = fiveHour
    .filter((b) => b.ts >= now - D7)
    .map((b) => ({ at: new Date(b.ts).toISOString(), type: b.type, local_mtok: mtok(msgs.filter((m) => m.ts >= b.resetsAt - H5 && m.ts <= b.ts).reduce((n, m) => n + m.units, 0)) }));
  return { session: current ? { mtok: mtok(current.units), resetsAt: current.end } : { mtok: 0, resetsAt: null }, weekly_mtok: mtok(weekly), atBlocks };
}

const mtok = (units) => Math.round(units / 1e5) / 10;
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

// --------------------------------------------------------------------------
// Verdict
// --------------------------------------------------------------------------

function judge(pcts, cfg) {
  const top = Math.max(...pcts.map((p) => p.pct));
  if (top >= (cfg.stop_pct ?? 95)) return 'stop';
  if (top >= (cfg.warn_pct ?? 80)) return 'tight';
  return 'ok';
}

function fromSnapshot(snap, cfg, now) {
  const pcts = [
    ['5h', snap.five_hour],
    ['7d', snap.seven_day],
  ]
    .filter(([, x]) => x && !(x.resetsAt && x.resetsAt <= now)) // a window that already reset is empty
    .map(([window, x]) => ({ window, pct: x.pct, resets_at: iso(x.resetsAt) }));
  if (!pcts.length) return null;
  return { source: 'status line', verdict: judge(pcts, cfg), windows: pcts, why: pcts.map((p) => `${p.window} ${Math.round(p.pct)}%`).join(', ') };
}

function fromLocal(local, cfg) {
  const pcts = [];
  if (cfg.session_mtok) pcts.push({ window: '5h', pct: (100 * local.session.mtok) / cfg.session_mtok, resets_at: iso(local.session.resetsAt) });
  if (cfg.weekly_mtok) pcts.push({ window: '7d', pct: (100 * local.weekly_mtok) / cfg.weekly_mtok, resets_at: null });
  if (!pcts.length) return null;
  return { source: 'local estimate', verdict: judge(pcts, cfg), windows: pcts, why: pcts.map((p) => `${p.window} ~${Math.round(p.pct)}% of the configured limit (this machine only)`).join(', ') };
}

// Only a FULL window holds the run back: the 5h at 96% resets in an hour,
// whatever the 7d at 30% says.
function resumeOf(r, cfg) {
  if (r.verdict !== 'stop') return null;
  const full = r.windows.filter((w) => w.pct >= (cfg.stop_pct ?? 95));
  return full.map((w) => w.resets_at).filter(Boolean).sort(core.compareStr).at(-1) || null;
}

function quota(root = process.cwd(), { claudeProjects, now = Date.now() } = {}) {
  const cfg = core.loadConfig(root).quota || {};
  const { msgs, blocks } = scan(root, claudeProjects || path.join(os.homedir(), '.claude', 'projects'), now);
  const local = localUsage(msgs, blocks, now);
  const blocked = blocks.filter((b) => b.resetsAt && b.resetsAt > now).sort((a, b) => b.resetsAt - a.resetsAt)[0];
  const snap = readSnapshot(now);
  let r = (snap && fromSnapshot(snap, cfg, now)) || null;
  if (blocked && r?.verdict !== 'stop') {
    r = { source: 'transcripts', verdict: 'stop', windows: [{ window: blocked.type, pct: 100, resets_at: iso(blocked.resetsAt) }], why: `blocked (${blocked.type}) until ${iso(blocked.resetsAt)}` };
  }
  r ||= fromLocal(local, cfg) || { source: 'none', verdict: 'unknown', windows: [], why: 'no status line snapshot, no block, no quota.session_mtok/weekly_mtok — see `jdi quota record`' };
  const out = { at: new Date(now).toISOString(), ...r, resume_at: resumeOf(r, cfg), local };
  if (fs.existsSync(path.join(root, core.JDI_DIR))) core.writeFileEnsured(stateFile(root), JSON.stringify(out, null, 2) + '\n', root);
  return out;
}

// The last verdict, for `route` — only while fresh; never scans.
function cached(root, now = Date.now()) {
  const s = core.readJson(stateFile(root), null);
  return s?.at && now - Date.parse(s.at) <= SNAPSHOT_MAX_AGE_MS ? s : null;
}

function render(r) {
  const lines = [`${r.verdict} — ${r.why} [${r.source}]`];
  if (r.resume_at) lines.push(`  resume at ${r.resume_at}`);
  lines.push(`  this machine: ${r.local.session.mtok}M in the current 5-hour session, ${r.local.weekly_mtok}M in 7 days (cache-weighted tokens)`);
  for (const b of r.local.atBlocks) lines.push(`  past block ${b.at} (${b.type}): ${b.local_mtok}M used here in that session`);
  return lines.join('\n');
}

function main(argv) {
  if (argv[0] === 'record') {
    record(() => fs.readFileSync(0, 'utf8'));
    return 0;
  }
  const i = argv.indexOf('--claude-dir');
  const rt = argv[argv.indexOf('--runtime') + 1];
  if (argv.includes('--runtime') && rt !== 'claude') {
    const r = { verdict: 'unknown', source: 'none', why: `no usage source for ${rt} — quota reads Claude Code's status line and transcripts` };
    process.stdout.write((argv.includes('--json') ? JSON.stringify(r) : `${r.verdict} — ${r.why}`) + '\n');
    return 0;
  }
  const r = quota(process.cwd(), { claudeProjects: i === -1 ? undefined : argv[i + 1] });
  process.stdout.write((argv.includes('--json') ? JSON.stringify(r) : render(r)) + '\n');
  return EXIT[r.verdict];
}

module.exports = { main, quota, cached, record, sessions };
