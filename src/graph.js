// vetobench graph: a self-contained HTML report of who approved the agent's actions, day by day.
// Pure rendering (totals in, a string out) plus one file write. The page holds counts, shares and dates only, and it
// loads nothing: no external scripts, fonts, images or links, and its Content-Security-Policy refuses every request.
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { SHAPES, scanAll } from './analyze.js'
import { claudeVersions, headline, num, pct } from './render.js'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86400000
const ms = (s) => Date.parse(`${s}T00:00:00Z`)
const iso = (t) => new Date(t).toISOString().slice(0, 10)
/** A real calendar day, YYYY-MM-DD. Day keys and dates come from transcript fields, so nothing else gets through. */
export const isDay = (s) => typeof s === 'string' && DAY.test(s) && Number.isFinite(ms(s)) && iso(ms(s)) === s
const count = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 }

/**
 * The daily chart's series by gate, bottom to top: [key, legend label, the scanner gates it adds up, short name for
 * hover labels and tables].
 */
export const GATE_SERIES = [
  ['static', 'Static rules', ['rule', 'rules-compound', 'static-other'], 'Static rules'],
  ['classifier', 'AI classifier', ['classifier'], 'AI classifier'],
  ['other', 'Other (permission mode, answers)', ['mode', 'answer'], 'Other'],
  ['blocked', 'Blocked', ['classifier-rejected', 'safety-rejected', 'human-rejected', 'rejected-other'], 'Blocked'],
  ['human', 'You, through a prompt', ['human'], 'You'],
]
const GATE_OF = new Map(GATE_SERIES.flatMap(([k, , gates]) => gates.map((g) => [g, k])))
/** Short shape names for the chart; the shape totals use the full SHAPES labels. */
const SHAPE_SHORT = { interactive: 'Main sessions', loop: 'Loops', graph: 'Subagents' }

// A longer window is drawn in buckets of whole weeks, so a bar never gets thinner than a phone can show.
export const MAX_BARS = 92

/**
 * totals.byDay folded into consecutive buckets from the first to the last day of the window (empty days included).
 * Each bucket: { start, end, days, withDecision, gates: {static, classifier, other, blocked, human}, shapes }.
 * A gate the scanner does not name counts as "other", so every bar adds up to its decisions.
 */
export function graphData(t = {}) {
  const byDay = t.byDay && typeof t.byDay === 'object' ? t.byDay : {}
  const keys = Object.keys(byDay).filter(isDay).sort()
  const ends = [t.firstTs, t.lastTs, keys[0], keys[keys.length - 1]].filter(isDay).sort()
  const total = count(t.withDecision)
  if (!ends.length) return { buckets: [], size: 1, drawn: 0, undated: total }
  const first = ms(ends[0])
  const last = ms(ends[ends.length - 1])
  const span = Math.round((last - first) / DAY_MS) + 1
  const size = span <= MAX_BARS ? 1 : Math.ceil(span / MAX_BARS / 7) * 7
  const buckets = []
  for (let start = first; start <= last; start += size * DAY_MS) {
    const end = Math.min(start + (size - 1) * DAY_MS, last)
    buckets.push({ start: iso(start), end: iso(end), days: Math.round((end - start) / DAY_MS) + 1, withDecision: 0,
      gates: Object.fromEntries(GATE_SERIES.map(([k]) => [k, 0])), shapes: Object.fromEntries(SHAPES.map(([k]) => [k, 0])) })
  }
  let drawn = 0
  for (const k of keys) {
    const d = byDay[k]
    if (!d || typeof d !== 'object') continue
    const b = buckets[Math.floor((ms(k) - first) / DAY_MS / size)]
    for (const [g, v] of Object.entries(d.gates && typeof d.gates === 'object' ? d.gates : {})) {
      const n = count(v)
      b.gates[GATE_OF.get(g) || 'other'] += n
      b.withDecision += n
      drawn += n
    }
    for (const [s] of SHAPES) b.shapes[s] += count(d.shapes && d.shapes[s])
  }
  return { buckets, size, drawn, undated: Math.max(0, total - drawn) }
}

/** A y-axis top and step from 1, 2 or 5 times a power of ten, about five gridlines, whole numbers only. */
export function niceAxis(max) {
  if (!(max > 0)) return { top: 1, step: 1 }
  const raw = max / 5
  const p = 10 ** Math.floor(Math.log10(raw))
  const step = Math.max(1, [1, 2, 5, 10].find((m) => m * p >= raw) * p)
  return { top: Math.ceil(max / step) * step, step }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;').replace(/\n/g, '&#10;')
const f = (x) => String(Math.round(x * 1000) / 1000)
const compact = (v) => v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(1)}K` : String(v)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const short = (s) => `${MONTHS[Number(s.slice(5, 7)) - 1]} ${Number(s.slice(8, 10))}`
const when = (b) => (b.days === 1 ? b.start : `${b.start} to ${b.end} (${b.days} days)`)

// Chart geometry, in CSS pixels. Bars are at most BAR wide and at most 70% of their slot (see bars below).
const PLOT_H = 200
const PAD_T = 12
const STRIP = 20
const AXIS = 26
const GAP = 2
const BAR = 24
const GUTTER = 52

/**
 * One stacked bar chart as two inline SVGs: a gutter with the y-axis labels, and the plot. The plot is as wide as its
 * card: x positions are percentages and y positions pixels, so text stays crisp and nothing scrolls sideways. Each bar
 * is a BAR-wide shape centred in an SVG viewport 70% of its slot wide, which clips it on narrow screens.
 * strips: [[key, label]] rows of dots under the plot, for counts too small to see in a bar.
 */
function chart({ label, buckets, series, get, tip, strips = [] }) {
  const n = buckets.length
  const totals = buckets.map((b) => series.reduce((s, [k]) => s + get(b, k), 0))
  const { top, step } = niceAxis(Math.max(0, ...totals))
  const scale = PLOT_H / top
  const base = PAD_T + PLOT_H
  const stripTop = base + 8
  const height = (strips.length ? stripTop + strips.length * STRIP : base) + AXIS
  const pc = (x) => `${f(x * 100)}%`
  const gutter = []
  const plot = []
  for (let v = 0; v <= top; v += step) {
    const y = Math.round(base - v * scale) + 0.5
    plot.push(`<line class="${v ? 'grid' : 'base'}" x1="0" x2="100%" y1="${y}" y2="${y}"/>`)
    gutter.push(`<text class="tick" x="${GUTTER - 8}" y="${y + 3.5}" text-anchor="end">${esc(top >= 10000 ? compact(v) : num(v))}</text>`)
  }
  buckets.forEach((b, i) => {
    plot.push(`<rect class="hit" x="${pc(i / n)}" y="0" width="${pc(1 / n)}" height="${height - AXIS + 4}" data-tip="${esc(tip(b))}"/>`)
  })
  buckets.forEach((b, i) => {
    const parts = []
    let cum = 0
    for (const [k] of series) {
      const c = get(b, k)
      if (!c) continue
      const bottom = base - cum * scale - (cum ? GAP : 0) // a 2px surface gap above the segment below
      cum += c
      if (bottom - (base - cum * scale) > 0) parts.push([k, base - cum * scale, bottom])
    }
    if (!parts.length) return
    const shapes = parts.map(([k, y0, y1], j) => {
      if (j < parts.length - 1) return `<rect class="s-${k}" x="${-BAR / 2}" y="${f(y0)}" width="${BAR}" height="${f(y1 - y0)}"/>`
      const r = Math.min(4, y1 - y0) // rounded data end, square at the baseline
      const h = BAR / 2
      return `<path class="s-${k}" d="M${-h} ${f(y1)}V${f(y0 + r)}A${f(r)} ${f(r)} 0 0 1 ${f(-h + r)} ${f(y0)}H${f(h - r)}` +
        `A${f(r)} ${f(r)} 0 0 1 ${h} ${f(y0 + r)}V${f(y1)}Z"/>`
    })
    plot.push(`<svg class="bar" x="${pc((i + 0.15) / n)}" width="${pc(0.7 / n)}" height="${base}"><svg x="50%" overflow="visible">${shapes.join('')}</svg></svg>`)
  })
  strips.forEach(([k, name], r) => {
    const cy = stripTop + r * STRIP + STRIP / 2
    gutter.push(`<text class="tick" x="${GUTTER - 8}" y="${cy + 3.5}" text-anchor="end">${esc(name)}</text>`)
    plot.push(`<line class="grid" x1="0" x2="100%" y1="${cy + 0.5}" y2="${cy + 0.5}"/>`)
    buckets.forEach((b, i) => { if (get(b, k)) plot.push(`<circle class="s-${k}" cx="${pc((i + 0.5) / n)}" cy="${cy}" r="4"/>`) })
  })
  // About eight date labels on a wide screen, half of them on a phone.
  const wide = Math.max(1, Math.ceil(n / 8))
  const narrow = wide * Math.max(1, Math.ceil(Math.ceil(n / 4) / wide))
  for (let i = 0; i < n; i += wide) {
    plot.push(`<text class="xl${i % narrow ? ' wide' : ''}" x="${pc((i + 0.5) / n)}" y="${height - 8}" text-anchor="middle">${esc(short(buckets[i].start))}</text>`)
  }
  return `<div class="frame">
<svg class="gut" width="${GUTTER}" height="${height}" aria-hidden="true">${gutter.join('')}</svg>
<svg class="plot" width="100%" height="${height}" role="img" aria-label="${esc(label)}">${plot.join('')}</svg>
</div>`
}

const swatch = (k) => `<i class="sw s-${k}"></i>`
const legend = (items) => `<ul class="legend">${items.map(([k, name, value]) => `<li>${swatch(k)}${esc(name)} <b>${esc(value)}</b></li>`).join('')}</ul>`

/** A chart's numbers as a table (its accessible twin): one row per bar, then the totals. */
function table(caption, cols, rows) {
  const sums = cols.slice(1).map((_, j) => rows.reduce((s, r) => s + r[j + 1], 0))
  const cells = (r, tag) => r.map((c, j) => (j ? `<${tag} class="n">${esc(num(c))}</${tag}>` : `<${tag}>${esc(c)}</${tag}>`)).join('')
  return `<details><summary>${esc(caption)}</summary><div class="tw"><table>
<thead><tr>${cols.map((c, j) => `<th${j ? ' class="n"' : ''}>${esc(c)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r) => `<tr>${cells(r, 'td')}</tr>`).join('\n')}</tbody>
<tfoot><tr>${cells(['Total', ...sums], 'td')}</tr></tfoot>
</table></div></details>`
}

function gateSection(data) {
  const { buckets } = data
  const sum = (k) => buckets.reduce((s, b) => s + b.gates[k], 0)
  const drawn = data.drawn
  const shown = GATE_SERIES.filter(([k]) => sum(k) || k === 'static' || k === 'classifier' || k === 'human')
  const strips = [['human', 'You'], ['blocked', 'Blocked']].filter(([k]) => sum(k))
  const tip = (b) => [when(b), `${num(b.withDecision)} decisions`,
    ...shown.map(([k, , , name]) => `${name} ${num(b.gates[k])}${b.gates[k] ? ` · ${pct(b.gates[k], b.withDecision)}` : ''}`)].join('\n')
  const unit = data.size === 1 ? 'UTC day' : `${data.size} days (UTC)`
  return `<section class="card">
<h2>Who approved each action, over time</h2>
<p class="sub">Recorded decisions per ${unit}, by the gate that made them.${strips.length ? ' Dots under the bars mark the days with an approval by you or a block: too few to see in a bar.' : ''}</p>
${legend(shown.map(([k, name]) => [k, name, num(sum(k))]))}
${chart({ label: `Recorded decisions per ${unit} by gate, ${buckets[0].start} to ${buckets[buckets.length - 1].end}`, buckets,
    series: GATE_SERIES, get: (b, k) => b.gates[k], tip, strips })}
${data.undated ? `<p class="sub">${num(data.undated)} decision(s) carry no valid timestamp and are not drawn.</p>` : ''}
${table(`The numbers (${num(drawn)} decisions)`, [data.size === 1 ? 'Day' : 'From', 'Decisions', ...shown.map(([, , , name]) => name)],
    buckets.map((b) => [b.start, b.withDecision, ...shown.map(([k]) => b.gates[k])]))}
</section>`
}

function shapeSection(data) {
  const { buckets } = data
  const sum = (k) => buckets.reduce((s, b) => s + b.shapes[k], 0)
  const total = buckets.reduce((s, b) => s + b.withDecision, 0)
  const tip = (b) => [when(b), `${num(b.withDecision)} decisions`,
    ...SHAPES.map(([k]) => `${SHAPE_SHORT[k]} ${num(b.shapes[k])}${b.shapes[k] ? ` · ${pct(b.shapes[k], b.withDecision)}` : ''}`)].join('\n')
  const unit = data.size === 1 ? 'UTC day' : `${data.size} days (UTC)`
  return `<section class="card">
<h2>Where the agent was running</h2>
<p class="sub">The same decisions per ${unit}, by where the agent ran: a main session, a loop (/loop, /goal) or a subagent.</p>
${legend(SHAPES.map(([k]) => [k, SHAPE_SHORT[k], num(sum(k))]))}
${chart({ label: `Recorded decisions per ${unit} by where the agent ran, ${buckets[0].start} to ${buckets[buckets.length - 1].end}`,
    buckets, series: SHAPES, get: (b, k) => b.shapes[k], tip })}
${table(`The numbers (${num(total)} decisions)`, [data.size === 1 ? 'Day' : 'From', 'Decisions', ...SHAPES.map(([k]) => SHAPE_SHORT[k])],
    buckets.map((b) => [b.start, b.withDecision, ...SHAPES.map(([k]) => b.shapes[k])]))}
</section>`
}

/** The whole window by shape: a segmented bar of the shares, then one tile per shape (as the text card's section). */
function shapeTotals(t) {
  const rows = SHAPES.map(([k, name]) => {
    const s = (t.byShape && t.byShape[k]) || {}
    return { k, name, n: count(s.withDecision), h: headline(s), files: count(t.shapeFiles && t.shapeFiles[k]) }
  })
  const all = rows.reduce((s, r) => s + r.n, 0)
  let x = 0
  const segs = rows.filter((r) => r.n).map((r) => {
    const w = (r.n / all) * 100
    const share = pct(r.n, all)
    // A share is printed inside its part only when it fits on a phone-width bar (about 300px).
    const fits = (w / 100) * 300 >= share.length * 7.5 + 16
    const out = `<svg x="${f(x)}%" width="${f(w)}%" height="28"><rect class="s-${r.k}" width="100%" height="28" rx="4"/>` +
      `${fits ? `<text class="on-${r.k}" x="8" y="18.5">${esc(share)}</text>` : ''}</svg>`
    x += w
    return out
  })
  const tiles = rows.map((r) => `<div class="tile">
<div class="tl">${swatch(r.k)}${esc(r.name)}</div>
<div class="tv">${esc(num(r.n))}</div>
<div class="ts">${esc(`${pct(r.n, count(t.withDecision))} of decisions · ${num(r.files)} transcript${r.files === 1 ? '' : 's'}`)}</div>
<div class="ts">${r.n ? [`Static rules ${pct(r.h.static, r.n)}`, `AI classifier ${pct(r.h.classifier, r.n)}`, `You ${num(r.h.human)}`]
    .map((s) => `<span class="nw">${esc(s)}</span>`).join(' · ') : 'No recorded decisions'}</div>
</div>`).join('\n')
  return `<section class="card">
<h2>Totals by where the agent ran</h2>
<p class="sub">The whole window. A session that ran /loop or /goal counts as a loop from its start; subagents started from a loop count as subagents.</p>
${all ? `<svg class="seg" width="100%" height="28" role="img" aria-label="${esc(rows.filter((r) => r.n).map((r) => `${r.name} ${pct(r.n, all)}`).join(', '))}">${segs.join('')}</svg>` : ''}
<div class="tiles">
${tiles}
</div>
</section>`
}

// The [y/N] mark and the wordmark (assets/logo/lockup-light.svg), inlined because assets/ is not in the npm package.
const LOGO = `<svg class="logo" viewBox="0 0 444 100" width="160" height="36" role="img" aria-label="vetobench">
<rect class="tile-bg" width="100" height="100" rx="22"/>
<g transform="translate(10.23 39.93) scale(0.265)"><g fill="#8E8E94"><path d="M18 -8H44V4H30V76H44V88H18Z"/><path d="M67.5 20H80.5L95.5 64H82.5Z"/><path d="M99.5 20H112.5L85.5 90H72.5Z"/><path d="M157.5 -6H170.5L142.5 86H129.5Z"/><path d="M256 -8H282V88H256V76H270V4H256Z"/></g><path fill="#FF5A1F" d="M188 0H201L220 42.9V0H232V70H219L200 27.1V70H188Z"/></g>
<g transform="translate(121.8 29) scale(0.6)"><path class="wm" d="M7 20H20L30 50.3L40 20H53L36.5 70H23.5Z"/><g class="wm-s" fill="none" stroke-width="12" stroke-linejoin="round"><path transform="translate(60 0)" d="M12 45H48A18 19 0 1 0 41.6 59.6"/><path transform="translate(120 0)" d="M26 6V52A12 12 0 0 0 38 64H50M10 26H48"/><ellipse cx="210" cy="45" rx="18" ry="19"/><path d="M254 0V70"/><ellipse cx="271" cy="45" rx="17" ry="19"/><path transform="translate(300 0)" d="M12 45H48A18 19 0 1 0 41.6 59.6"/><path transform="translate(360 0)" d="M14 20V70M14 42A16 16 0 0 1 46 42V70"/><path transform="translate(420 0)" d="M44 32.8A17 19 0 1 0 44 57.2"/><path transform="translate(480 0)" d="M14 0V70M14 42A16 16 0 0 1 46 42V70"/></g></g>
</svg>`

const CSS = `:root{color-scheme:light dark;--bg:#F2F2F0;--card:#FFFFFF;--text:#141416;--muted:#5E5E64;--line:#E3E3E0;--base:#B9B9BD;--tile:#141416;--hover:rgba(20,20,22,.06);
--c-static:#141416;--c-classifier:#8E8E94;--c-other:#D9D9DC;--c-blocked:#55555C;--c-human:#FF5A1F;--c-interactive:#141416;--c-loop:#C6C6CA;--c-graph:#8E8E94;
--on-interactive:#F2F2F0;--on-loop:#141416;--on-graph:#141416}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1C1C1F;--text:#F2F2F0;--muted:#A4A4AA;--line:#2C2C31;--base:#4C4C52;--tile:#26262B;--hover:rgba(242,242,240,.07);
--c-static:#F2F2F0;--c-other:#3B3B41;--c-blocked:#C6C6CA;--c-interactive:#F2F2F0;--c-loop:#55555C;--on-interactive:#141416;--on-loop:#F2F2F0}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:24px 16px 32px;display:grid;gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;min-width:0}
.top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px}
.logo{display:block;height:36px;width:auto}
.tile-bg{fill:var(--tile)}.wm{fill:var(--text)}.wm-s{stroke:var(--text)}
.range{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted)}
h1{font-size:clamp(26px,5vw,40px);line-height:1.12;letter-spacing:-.015em;margin:24px 0 8px}
h2{font-size:18px;line-height:1.3;margin:0 0 4px}
.meta,.sub,.note{color:var(--muted);font-size:14px;margin:0}
.sub{margin-bottom:12px}
.big{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:28px 0 20px}
.big .v{display:block;font-size:clamp(30px,8vw,60px);font-weight:700;line-height:1.05;letter-spacing:-.02em}
.big .hum{color:var(--c-human)}
.big .l{display:block;color:var(--muted);font-size:14px;margin-top:6px}
.legend{list-style:none;margin:0 0 8px;padding:0;display:flex;flex-wrap:wrap;gap:4px 18px;font-size:13px;color:var(--muted)}
.legend b{color:var(--text);font-weight:600;font-variant-numeric:tabular-nums}
.sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.s-static{fill:var(--c-static);background:var(--c-static)}.s-classifier{fill:var(--c-classifier);background:var(--c-classifier)}
.s-other{fill:var(--c-other);background:var(--c-other)}.s-blocked{fill:var(--c-blocked);background:var(--c-blocked)}
.s-human{fill:var(--c-human);background:var(--c-human)}.s-interactive{fill:var(--c-interactive);background:var(--c-interactive)}
.s-loop{fill:var(--c-loop);background:var(--c-loop)}.s-graph{fill:var(--c-graph);background:var(--c-graph)}
.frame{display:grid;grid-template-columns:${GUTTER}px minmax(0,1fr);margin-top:12px}
.frame svg{display:block}.plot{width:100%;overflow:visible}
.grid{stroke:var(--line);stroke-width:1}.base{stroke:var(--base);stroke-width:1}
.tick,.xl{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.hit{fill:transparent}.hit.on{fill:var(--hover)}
.bar,.plot circle{pointer-events:none}.plot circle{stroke:var(--card);stroke-width:2}
.seg{display:block;margin:4px 0 0}.seg rect{stroke:var(--card);stroke-width:2}
.seg text{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.on-interactive{fill:var(--on-interactive)}.on-loop{fill:var(--on-loop)}.on-graph{fill:var(--on-graph)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:16px}
.tile{border:1px solid var(--line);border-radius:12px;padding:14px 16px;min-width:0}
.nw{white-space:nowrap}.tl{font-size:14px;color:var(--muted)}.tv{font-size:28px;font-weight:700;line-height:1.25;margin:2px 0}.ts{font-size:13px;color:var(--muted)}
details{margin-top:14px}summary{cursor:pointer;color:var(--muted);font-size:13px;width:max-content;max-width:100%}
.tw{overflow-x:auto;margin-top:8px}
table{border-collapse:collapse;width:100%;font-size:12px;font-variant-numeric:tabular-nums}
th,td{padding:4px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{color:var(--muted);font-weight:600;white-space:normal;vertical-align:bottom}.n{text-align:right}tfoot td{font-weight:600;border-bottom:0}
footer{color:var(--muted);font-size:13px;text-align:center;padding:8px 16px 0}
footer strong{color:var(--text)}
#tip{position:fixed;left:0;top:0;z-index:10;pointer-events:none;background:var(--text);color:var(--card);font-size:12px;line-height:1.5;padding:8px 10px;border-radius:8px;max-width:260px;font-variant-numeric:tabular-nums;box-shadow:0 4px 18px rgba(0,0,0,.18)}
#tip .h{font-weight:700}
@media (max-width:560px){.wrap{padding:16px 16px 24px;gap:12px}.card{padding:16px;border-radius:12px}h1{margin-top:18px}.big{gap:10px;margin:22px 0 16px}.big .l{font-size:13px}.xl.wide{display:none}}`

// Hover and tap labels. The text comes from the page's own data-tip attributes and is set with textContent.
const SCRIPT = `(function () {
  var tip = document.getElementById('tip'), on = null
  function hide() { tip.hidden = true; if (on) on.classList.remove('on'); on = null }
  function show(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null
    if (!el) return hide()
    if (el !== on) {
      hide(); on = el; el.classList.add('on')
      tip.replaceChildren.apply(tip, el.getAttribute('data-tip').split('\\n').map(function (line, i) {
        var d = document.createElement('div'); d.textContent = line; if (!i) d.className = 'h'; return d
      }))
    }
    tip.hidden = false
    var r = tip.getBoundingClientRect(), x = e.clientX + 14, y = e.clientY + 14
    if (x + r.width > innerWidth - 8) x = Math.max(8, e.clientX - r.width - 14)
    if (y + r.height > innerHeight - 8) y = Math.max(8, e.clientY - r.height - 14)
    tip.style.transform = 'translate(' + x + 'px,' + y + 'px)'
  }
  addEventListener('pointermove', show)
  addEventListener('pointerdown', show)
  document.documentElement.addEventListener('pointerleave', hide)
  addEventListener('scroll', hide, { passive: true })
})()`

const hash = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`
// default-src 'none' refuses every request the page could make; only this exact style and script may run.
const CSP = `default-src 'none'; style-src ${hash(CSS)}; script-src ${hash(SCRIPT)}; img-src 'none'; base-uri 'none'; form-action 'none'`

/** The report page. Every string in it is a count, a share, a checked date or version, or a label defined here. */
export function renderHtml(t = {}, { version } = {}) {
  const h = headline(t)
  const range = `${isDay(t.firstTs) ? t.firstTs : '?'} to ${isDay(t.lastTs) ? t.lastTs : '?'}`
  const g = (k) => count(t.gates && t.gates[k])
  const blocked = GATE_SERIES.find(([k]) => k === 'blocked')[2].reduce((s, k) => s + g(k), 0)
  const cc = claudeVersions(t)
  const ver = typeof version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(version) ? version : '?'
  const data = graphData(t)
  const notes = [
    ...(blocked ? [`${num(blocked)} blocked (${pct(blocked, h.d)}).`] : []),
    ...(g('answer') ? [`${num(g('answer'))} answers to the agent's own questions are not counted as approvals.`] : []),
    'Approvals given in chat are not counted.',
  ]
  const body = h.d && data.buckets.length
    ? [gateSection(data), shapeSection(data), shapeTotals(t)].join('\n')
    : '<section class="card"><p class="sub">No recorded permission decisions found. Claude Code records them from about v2.1.306 onward.</p></section>'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(`vetobench report: ${range}`)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="wrap">
<header class="card">
<div class="top">${LOGO}<span class="range">${esc(range)}</span></div>
<h1>Who approved my coding agent's actions?</h1>
<p class="meta">${esc([`${num(h.d)} of ${num(t.toolResults)} tool calls carry a recorded decision`, `${num(t.files)} transcripts`,
    ...(cc ? [`Claude Code ${cc}`] : [])].join(' · '))}</p>
<div class="big">
<div><span class="v">${esc(pct(h.static, h.d))}</span><span class="l">static allow-rules</span></div>
<div><span class="v">${esc(pct(h.classifier, h.d))}</span><span class="l">AI classifier</span></div>
<div><span class="v hum">${esc(num(h.human))}</span><span class="l">human approvals</span></div>
</div>
<p class="note">${esc(notes.join(' '))}</p>
</header>
${body}
<footer><strong>Counts only, made locally.</strong> ${esc(`vetobench ${ver} read the transcripts on this machine and wrote this page. It loads nothing from the network. Days are UTC.`)}</footer>
</main>
<div id="tip" hidden></div>
<script>${SCRIPT}</script>
</body>
</html>
`
}

export function graphHelp(version) {
  return `vetobench ${version} graph: a local HTML report of who approved your agent's actions, day by day

Usage: npx vetobench graph --html FILE [transcripts-dir] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--force]

  --html FILE       write the report to FILE (required); an existing FILE is never replaced without --force
  --force           replace FILE if it exists
  transcripts-dir   default: ~/.claude/projects
  --since / --until window by UTC day (until is exclusive)

One self-contained page: who approved each day's actions (static rules, the AI classifier, you, blocks), where the
agent was running (main sessions, loops, subagents), and the totals. Counts, shares and dates only. The page has no
external scripts, fonts, images or links and makes no network requests. Nothing is sent anywhere.`
}

export function parseGraphArgs(argv, defaultDir) {
  const o = { dir: defaultDir, since: null, until: null, html: undefined, force: false }
  let dirGiven = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--html') {
      const v = argv[++i]
      if (!v || v.startsWith('-')) throw new Error('--html needs an output file, e.g. --html report.html')
      o.html = v
    }
    else if (a === '--force') o.force = true
    else if (a === '--since' || a === '--until') {
      const v = argv[++i]
      if (!v || !DAY.test(v)) throw new Error(`${a} needs a date, YYYY-MM-DD`)
      o[a.slice(2)] = v
    }
    else if (a === '-h' || a === '--help') o.help = true
    else if (!a.startsWith('-')) {
      if (dirGiven) throw new Error('give one transcripts directory')
      o.dir = a
      dirGiven = true
    }
    else throw new Error(`unknown option: ${a}`)
  }
  if (!o.help && o.html === undefined) throw new Error('graph needs an output file: vetobench graph --html report.html')
  return o
}

const HTML_EXISTS = 'the --html file already exists; pass --force to replace it'

// 'wx' refuses an existing file atomically. Errors name the code only, never the path.
function writeHtml(file, html, force) {
  try {
    writeFileSync(file, html, { flag: force ? 'w' : 'wx' })
  } catch (e) {
    throw new Error(e.code === 'EEXIST' ? HTML_EXISTS : `could not write the --html file (${e.code || 'error'})`)
  }
}

/** `vetobench graph …`: writes the one named file and returns a line for the terminal (counts only, no path). */
export async function graphCommand(argv, { version, defaultDir }) {
  const o = parseGraphArgs(argv, defaultDir)
  if (o.help) return graphHelp(version)
  let isDir = false
  try { isDir = statSync(o.dir).isDirectory() } catch {}
  if (!isDir) throw new Error(`no transcripts directory at ${o.dir === defaultDir ? '~/.claude/projects' : 'the path given'}`)
  if (!o.force && existsSync(o.html)) throw new Error(HTML_EXISTS) // fail before a long scan
  const t = await scanAll(o.dir, { since: o.since, until: o.until })
  const data = graphData(t)
  writeHtml(o.html, renderHtml(t, { version }), o.force)
  const bars = data.size === 1 ? `${num(data.buckets.length)} day(s)` : `${num(data.buckets.length)} bars of ${data.size} days`
  return `vetobench ${version} graph: wrote the HTML report (${bars}, ${num(t.withDecision)} recorded decisions).\n` +
    'Open it in a browser: it loads nothing from the network. Look it over before you share it.'
}
