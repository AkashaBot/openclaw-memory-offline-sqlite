import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const repoRoot = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');

if (!fs.existsSync(cliPath)) {
  fail(`smoke-test: CLI not built: ${cliPath}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-mem-smoke-'));
const dbPath = path.join(tmpDir, 'memory.sqlite');

const res = spawnSync(process.execPath, [cliPath, '--db', dbPath, 'init'], {
  cwd: repoRoot,
  encoding: 'utf8',
});

if (res.error) fail(`smoke-test: spawn error: ${res.error.message}`);
if (res.status !== 0) {
  console.error(res.stdout || '');
  console.error(res.stderr || '');
  fail(`smoke-test: CLI exited with code ${res.status}`);
}

let parsed;
try {
  parsed = JSON.parse((res.stdout || '').trim());
} catch {
  console.error(res.stdout || '');
  fail('smoke-test: expected JSON stdout');
}

if (!parsed?.ok) fail(`smoke-test: expected { ok: true }, got: ${res.stdout}`);
if (!fs.existsSync(dbPath)) fail(`smoke-test: expected db file to exist: ${dbPath}`);

const st = fs.statSync(dbPath);
if (st.size <= 0) fail(`smoke-test: expected non-empty db file, size=${st.size}`);

console.log(JSON.stringify({ ok: true, dbPath, size: st.size }));
