// Critical size check: production output (public/) must stay under 1 MB.
// Run: node scripts/size-check.mjs
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const LIMIT = 1024 * 1024; // hard budget
const WARN = 768 * 1024;   // warning threshold

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(PUB);
const byExt = {};
let total = 0;
for (const f of files) {
  const size = statSync(f).size;
  const ext = path.extname(f) || '(none)';
  byExt[ext] = (byExt[ext] || 0) + size;
  total += size;
}
for (const [ext, size] of Object.entries(byExt).sort((a, b) => b[1] - a[1])) {
  console.log(`${ext.padEnd(8)} ${(size / 1024).toFixed(1)} KB`);
}
console.log(`${'TOTAL'.padEnd(8)} ${(total / 1024).toFixed(1)} KB  (${files.length} files)`);
if (total > LIMIT) {
  console.error(`SIZE CHECK FAILED: ${(total / 1024).toFixed(1)} KB > 1024 KB — shrink the feature, do not raise the budget.`);
  process.exit(1);
}
console.log(`SIZE CHECK PASSED${total > WARN ? ' (warning: > 750 KB)' : ''}`);
