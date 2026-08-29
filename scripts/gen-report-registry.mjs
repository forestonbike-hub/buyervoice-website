// gen-report-registry.mjs — regenerates the GATED_REPORTS and
// DEFAULT_PUBLIC_REPORTS blocks in public/_worker.js from the single
// source of truth at src/data/reports.json (review G12).
//
// Runs automatically before every build via the package.json "prebuild"
// hook. Idempotent: re-running on an up-to-date worker produces no diff.
// Refuses to run if the generation markers are missing, so a hand edit
// that removes them fails loudly instead of silently diverging.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'src', 'data', 'reports.json');
const workerPath = join(root, 'public', '_worker.js');

const { reports } = JSON.parse(readFileSync(manifestPath, 'utf-8'));

const gated = reports.filter((r) => r.publicSlug && r.publicPath);
const defaultPublic = gated.filter((r) => r.defaultPublic);

const BEGIN = '// [gen:report-registry] BEGIN — generated from src/data/reports.json; edit that file and run `npm run gen:registry`, never this block';
const END = '// [gen:report-registry] END';

const block = [
  BEGIN,
  'const GATED_REPORTS = {',
  ...gated.map((r) => `  '${r.publicSlug}': '${r.publicPath}',`),
  '};',
  '',
  '// Reports that default to public when no KV flag has been set yet.',
  '// The dashboard toggle still takes precedence once a flag has been',
  '// written explicitly. With the worker failing CLOSED when KV is unbound,',
  '// these are also the only gated pages a preview deployment serves.',
  'const DEFAULT_PUBLIC_REPORTS = new Set([',
  ...defaultPublic.map((r) => `  '${r.publicSlug}',`),
  ']);',
  END,
].join('\n');

const worker = readFileSync(workerPath, 'utf-8');
const beginIdx = worker.indexOf(BEGIN);
const endIdx = worker.indexOf(END);
if (beginIdx === -1 || endIdx === -1) {
  console.error('gen-report-registry: generation markers not found in public/_worker.js');
  process.exit(1);
}
const updated = worker.slice(0, beginIdx) + block + worker.slice(endIdx + END.length);
if (updated !== worker) {
  writeFileSync(workerPath, updated);
  console.log(`gen-report-registry: rewrote registry (${gated.length} gated, ${defaultPublic.length} default-public)`);
} else {
  console.log('gen-report-registry: registry already up to date');
}
