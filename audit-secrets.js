const fs = require('fs');
const path = require('path');

const envFile = fs.readFileSync('.env.local', 'utf8');
const secrets = [];
envFile.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx > 0) {
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    // Don't flag public keys as secret violations, but check secret-role & gemini key
    if (!val) return; // Skip empty placeholder values
    if (key.includes('SECRET') || key.includes('SERVICE_ROLE') || key === 'GEMINI_API_KEY') {
      secrets.push({ key, val });
    }
  }
});

console.log('Scanning for exposure of sensitive variables:', secrets.map(s => s.key));

let exposedCount = 0;

function scanDir(dir) {
  const files = fs.readdirSync(dir);
  for (const f of files) {
    if (['node_modules', '.next', '.git', '.env.local', 'audit-secrets.js'].includes(f)) continue;
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      scanDir(full);
    } else {
      const content = fs.readFileSync(full, 'utf8');
      for (const s of secrets) {
        if (content.includes(s.val)) {
          console.log(`[VULNERABILITY] Secret ${s.key} was found hardcoded in: ${full}`);
          exposedCount++;
        }
      }
    }
  }
}

scanDir('.');
if (exposedCount === 0) {
  console.log('✓ PASS: Zero hardcoded secrets found in tracked application files.');
} else {
  console.log(`x FAIL: Found ${exposedCount} exposed secret instances!`);
}
