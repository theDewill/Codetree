import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';

const env = { ...process.env };
try {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && env[match[1]] === undefined) env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }

mkdirSync('.cache', { recursive: true });
await new Promise((resolve, reject) => {
  const build = spawn('go', ['build', '-o', '.cache/codetree-api', './cmd/api'], { stdio: 'inherit', env });
  build.on('error', reject);
  build.on('exit', code => code === 0 ? resolve() : reject(new Error(`Go build failed (${code})`)));
});
const grouped = process.platform !== 'win32';
const children = [
  spawn('.cache/codetree-api', [], { stdio: 'inherit', env, detached: grouped }),
  spawn('npm', ['run', 'dev', '--workspace', 'apps/web'], { stdio: 'inherit', env, detached: grouped }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach(child => { try { if (grouped && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {} });
  setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
children.forEach(child => child.on('exit', code => { if (!stopping) stop(code ?? 1); }));
children.forEach(child => child.on('error', error => { process.stderr.write(error.message + '\n'); stop(1); }));
