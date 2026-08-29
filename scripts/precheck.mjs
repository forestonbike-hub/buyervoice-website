// precheck.mjs — the scripted pre-publish check (review G6).
//
// Mechanizes 12 of the 18 items from the pre-publish checklist against the
// BUILT html (dist/<path>/index.html, script/style stripped) plus
// registry-consistency checks driven by src/data/reports.json.
//
// Run:  npm run precheck        (after npm run build)
// Deploy depends on it: npm run deploy = build + precheck + wrangler.
//
// Severity: ERROR items fail the run (exit 1). WARN items print but pass.
// A legacy report can carry named exemptions in its reports.json row
// ("precheckSkip": ["pvalues-in-prose"]); exemptions print loudly and new
// reports must not use them.
//
// Six items stay manual by design (run them in the browser before deploy):
// horizontal scroll bars at 1280px, overlapping text, clipped labels,
// PDF print expansion, same-data-presented-twice, process-language prose.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { reports } = JSON.parse(readFileSync(join(root, 'src', 'data', 'reports.json'), 'utf-8'));

let errors = 0;
let warnings = 0;
const say = (level, slug, rule, msg) => {
  const tag = level === 'ERROR' ? 'ERROR' : level === 'SKIP' ? 'skip ' : 'warn ';
  console.log(`  [${tag}] ${slug} ${rule}: ${msg}`);
  if (level === 'ERROR') errors += 1;
  if (level === 'WARN') warnings += 1;
};

const stripScriptStyle = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Inline style attributes carry computed bar-fill widths
    // (style="width: 93.6%"), which the decimal rule must not count: the
    // framework allows decimals in CSS width properties, never in text.
    .replace(/\sstyle="[^"]*"/gi, '');

// Source notes, q-cites, and chart footnotes are exactly where the framework
// SENDS statistical detail ("test details belong in the source-note under
// the chart"), so the p-value rule runs on html with those paragraphs
// removed.
const stripSourceNotes = (html) =>
  html.replace(/<p class="[^"]*(?:source-note|q-cite|chart-footnote|footnote)[^"]*"[^>]*>[\s\S]*?<\/p>/gi, '');

// Mojibake patterns are written as unicode escapes on purpose: the literal
// byte sequences include C1 control characters that editors (and diff
// tooling) render invisibly.
const MOJIBAKE = new RegExp(
  [
    '\\u00e2\\u20ac',        // was a smart quote / dash
    '\\u00e2\\u2020',        // was a rightwards arrow
    '\\u00ce\\u00b1',        // was a Greek alpha
    '\\u00c2\\u00a3',        // was a pound sign
    '\\u00c3\\u00b1',        // was an n with tilde
    '\\u00e2\\u2030',        // was an almost-equal sign
    '[\\u0080-\\u009f]',     // any bare C1 control character
  ].join('|'),
  'g'
);

// Content rules run against stripped built HTML. `id` matches precheckSkip.
const CONTENT_RULES = [
  { id: 'emdash', level: 'ERROR', re: /—|&mdash;/g,
    msg: 'em dash in reader-facing text (use commas, periods, or parentheses)' },
  { id: 'decimal-pct', level: 'ERROR', re: /\d+\.\d+%/g,
    msg: 'decimal percentage (every displayed percentage is a ceiled whole number)' },
  { id: 'open-accordion', level: 'ERROR', re: /class="accordion"[^>]*\sopen[\s>]/g,
    msg: 'accordion defaults open (all sections load collapsed, no exceptions)' },
  { id: 'q-numbers', level: 'ERROR', re: /\(Q\d+\b|\bW[12][\s_]Q\d+\b|\bQ\d+\./g,
    msg: 'Q-number visible to the reader (spell out the question text instead)' },
  { id: 'mojibake', level: 'ERROR', re: MOJIBAKE,
    msg: 'UTF-8 mojibake artifact (fix the encoding or use plain ASCII)' },
  { id: 'barval-parens', level: 'ERROR', re: /class="bar-val[^>]*>[^<]*\([^<]*\)[^<]*</g,
    msg: 'bar value carries a parenthetical (percentage only inside bars; n goes in the source note)' },
  { id: 'pvalues-in-prose', level: 'ERROR', re: /\bp\s*[=<]\s*0?\.\d+/g,
    msg: 'p-value in reader-facing prose (test details belong in source notes as tier/alpha language)' },
];

const workerSrc = readFileSync(join(root, 'public', '_worker.js'), 'utf-8');

// ── Registry consistency (review G6/G12) ────────────────────────────────
console.log('Registry consistency (src/data/reports.json)');
const slugs = new Set();
for (const r of reports) {
  if (slugs.has(r.slug)) say('ERROR', r.slug, 'registry', 'duplicate slug');
  slugs.add(r.slug);
  if (r.publicSlug) {
    if (!r.publicPath) say('ERROR', r.slug, 'registry', 'publicSlug without publicPath');
    if (!workerSrc.includes(`'${r.publicSlug}': '${r.publicPath}'`))
      say('ERROR', r.slug, 'registry',
        `worker GATED_REPORTS missing '${r.publicSlug}' (run npm run gen:registry)`);
    if (r.defaultPublic && !workerSrc.includes(`  '${r.publicSlug}',`))
      say('ERROR', r.slug, 'registry', 'defaultPublic not reflected in DEFAULT_PUBLIC_REPORTS');
  }
}
if (workerSrc.includes('fail open')) say('ERROR', '_worker.js', 'registry', 'worker fail-open path reintroduced');

// ── Page-pair + prop checks (source side) ───────────────────────────────
console.log('Page pairs and layout props (src/pages)');
for (const r of reports) {
  if (!r.publicSlug) continue;
  const pubPage = join(root, 'src', 'pages', ...r.publicPath.split('/').filter(Boolean), 'index.astro');
  if (!existsSync(pubPage)) {
    say('WARN', r.slug, 'page-pair', `no public page source at ${r.publicPath}index.astro (data-dependent pages may be underscore-disabled)`);
  } else {
    const src = readFileSync(pubPage, 'utf-8');
    if (/includeAnalytics=\{false\}/.test(src))
      say('ERROR', r.slug, 'analytics-prop', 'public page passes includeAnalytics={false} (public pages always carry analytics)');
    if (/noindex=\{true\}/.test(src) || /noindex,\s*nofollow/.test(src))
      say('WARN', r.slug, 'noindex-prop', 'public page looks noindexed; confirm that is intended');
  }
  if (r.internal) {
    const intPage = join(root, 'src', 'pages', ...r.internal.split('/').filter(Boolean), 'index.astro');
    if (!existsSync(intPage))
      say('WARN', r.slug, 'page-pair', `no internal page source at ${r.internal}index.astro`);
  }
}

// ── Component-source rules ──────────────────────────────────────────────
console.log('Component sources (paired labels, hand-typed numbers)');
for (const r of reports) {
  const body = join(root, 'src', 'components', r.slug, 'ReportBody.astro');
  if (!existsSync(body)) continue;
  const src = readFileSync(body, 'utf-8');
  if (/paired/i.test(src)) {
    const mw = [...src.matchAll(/min-width[^;]*;/g)]
      .filter((m) => /label/i.test(src.slice(Math.max(0, m.index - 300), m.index)));
    if (mw.length)
      say('WARN', r.slug, 'paired-minwidth', `min-width near a label in a paired-chart context (${mw.length} hit(s)); paired labels need fixed width`);
  }
  const prose = src.replace(/\{[^}]*\}/g, '');
  const typed = [...prose.matchAll(/(?<![\w.{])\d{1,3}%/g)].length;
  if (typed > 0)
    say('WARN', r.slug, 'hand-typed-pct', `${typed} literal percentage(s) in body source outside {bindings}; numbers should bind to report-stats.json`);
}

// ── Built-HTML content rules ────────────────────────────────────────────
console.log('Built pages (dist)');
let checkedPages = 0;
for (const r of reports) {
  const paths = [r.publicPath, r.internal].filter(Boolean);
  for (const p of paths) {
    const f = join(root, 'dist', ...p.split('/').filter(Boolean), 'index.html');
    if (!existsSync(f)) {
      if (p === r.publicPath && r.publicSlug)
        say('WARN', r.slug, 'missing-dist', `built page missing at dist${p}index.html (run npm run build; underscore-disabled pages warn only)`);
      continue;
    }
    checkedPages += 1;
    const raw = readFileSync(f, 'utf-8');
    const html = stripScriptStyle(raw);
    const skips = new Set(r.precheckSkip || []);
    // Internal mirrors of legacy pages downgrade to WARN: the deploy risk
    // the precheck guards is the PUBLIC page; new reports share one body, so
    // their violations still fail on the public path.
    const isInternalMirror = p !== r.publicPath;
    for (const rule of CONTENT_RULES) {
      const target = rule.id === 'pvalues-in-prose' ? stripSourceNotes(html) : html;
      const hits = [...target.matchAll(rule.re)];
      if (!hits.length) continue;
      if (skips.has(rule.id)) {
        say('SKIP', r.slug, rule.id, `${hits.length} hit(s) on ${p} exempted by reports.json precheckSkip (legacy report; never add exemptions to new reports)`);
      } else {
        say(isInternalMirror ? 'WARN' : 'ERROR', r.slug, rule.id, `${hits.length} hit(s) on ${p}: ${rule.msg} (first: ${JSON.stringify(hits[0][0])})`);
      }
    }
    // Inline __VX payload size + PII scan on the RAW html (the payload lives
    // inside a script tag).
    const vx = raw.match(/window\.__VX\s*=\s*([\s\S]*?)<\/script>/);
    if (vx) {
      const bytes = Buffer.byteLength(vx[1], 'utf-8');
      if (bytes > 1_500_000)
        say('WARN', r.slug, 'vx-size', `inline __VX payload is ${(bytes / 1e6).toFixed(1)} MB on ${p}; cap quotes per (code, cohort) and lazy-load before a real study ships`);
      if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(vx[1]))
        say('WARN', r.slug, 'pii-email', `email-like string inside the __VX payload on ${p}; strip re-identifying free text`);
    }
  }
}

console.log('');
console.log(`Checked ${checkedPages} built page(s). ${errors} error(s), ${warnings} warning(s).`);
console.log('Manual items still on you: horizontal scroll at 1280px, overlapping or');
console.log('clipped labels, PDF print expansion, duplicate data across sections,');
console.log('process-language prose, first-use abbreviation expansion, cross-references.');
process.exit(errors ? 1 : 0);
