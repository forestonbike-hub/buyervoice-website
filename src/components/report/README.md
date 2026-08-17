# Shared Report Components

Canonical components for every BuyerVoice B2B and B2C research report. Using these guarantees cover layout, typography, palette, accordion pattern, PDF behavior, and statistical-flag rendering stay uniform across studies — no per-study CSS drift.

## Components

| Component | Purpose |
|---|---|
| `ReportLayout.astro` | Top-level layout. Renders the cover (logo, red title, subtitle, prepared-for, 4 stat cards), wires the "Save as PDF" button that expands all accordions before printing, auto-numbers sections with two-digit prefixes, loads Fraunces + DM Sans, applies the BuyerVoice palette. |
| `Section.astro` | Wraps one report section as a `<details>` accordion with the correct summary, title, subtitle, and `+/−` icon. All sections collapsed by default (framework rule); set `open` to default-expand (reserved for Executive Summary if desired). |
| `Chart.astro` | Bar chart with the dashed overall-average line and sig-flag superscripts. Renders question text as subtitle (framework rule: question text near every chart, not just Q# source cites). Reads pre-computed sig flags from props — does NOT run stats. Run stats in Python via `significance_tests.py` and pass results in. |
| `CrossTab.astro` | Cross-tab with enforced highlighting direction (`percentDirection: 'row' \| 'column'`). Auto-highlights top N per row or top N per column based on the declared direction. Mandatory footnote explains the direction. |

## Usage example

```astro
---
import ReportLayout from "../../components/report/ReportLayout.astro";
import Section from "../../components/report/Section.astro";
import Chart from "../../components/report/Chart.astro";
import CrossTab from "../../components/report/CrossTab.astro";
---

<ReportLayout
  studyName="Retail Banking"
  client="CIBC"
  preparedOn="April 2026"
  geography="Canada"
  scope="B2C buyers of primary banks"
  stats={{ interviews: 300, avgLengthMin: 24, wordsAnalyzedK: 820, thematicCodes: 73 }}
  includeAnalytics={false}
  noindex={true}
>
  <Section title="Executive Summary" subtitle="Top findings and priority recommendations">
    <p>Strategic Position paragraph...</p>
  </Section>

  <Section title="Customer Insights">
    <Chart
      title="Frustration with in-branch service, by age band"
      questionText="Q11. What's been the most frustrating part of banking with your primary bank in the last year?"
      overallAverage={24.3}
      overallN={300}
      rows={[
        { label: '18-25', value: 38.0, n: 42, sigFlag: '*' },
        { label: '65+',   value: 11.0, n: 31, sigFlag: '*' },
      ]}
      footnote="Significance test compares the subgroup vs all other respondents combined; dashed line shows the overall sample average including the subgroup (n=300). α = 0.10 two-tailed."
    />
  </Section>
</ReportLayout>
```

## Non-negotiable conventions baked into these components

1. **All accordions collapsed on load.** Framework rule.
2. **"Save as PDF" expands all accordions before print, restores after.** `beforeprint` listener enforces the same behavior for browser-menu prints.
3. **Question text renders as a subtitle on every Chart and CrossTab** — `questionText` is a required prop. There is no way to render a chart without the question text.
4. **`percentDirection` is required on CrossTab.** The highlighting direction tracks the percentage direction automatically; no way to accidentally highlight top-per-row on a column-percentage table.
5. **Stat-flag rendering is deterministic.** Pass `sigFlag: '*'` and `sigLetter: 'a'` as props; the component renders them as superscripts. Run the significance tests in Python using `significance_tests.py` (α = 0.10, two-tailed, Fisher's exact fallback) and embed the results in `report-stats.json` so the Astro build reads them in.
6. **BuyerVoice palette and typography are imposed globally.** Setting `--ink`, `--paper`, `--signal` elsewhere in the page will change the look, but the defaults match the brand system.

## What these components do NOT do

- They do NOT compute statistics. Use `significance_tests.py` in Python.
- They do NOT check denominators. Use `variable-dictionary.csv` during analysis.
- They do NOT fetch data. Pass it in as props from a `.json` sibling file loaded via `readFileSync` in the Astro frontmatter.
- They do NOT replace the framework docs. `b2b/stakeholder-first-report-framework.md` and `b2c/stakeholder-first-report-framework.md` define the content; these components enforce the visual and interactive layer.
