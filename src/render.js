// vetobench shareable card formats: markdown, a 1200x630 SVG and a prefilled issue link. Pure: totals in, strings out.
// Every string printed here is a count, a share, a checked date or version, or a label defined in code.
import { GATES, SHAPES } from './analyze.js'

export const pct = (n, d) => (d ? ((n / d) * 100).toFixed(n / d < 0.001 && n > 0 ? 3 : 1) + '%' : '-')
export const num = (n) => (Number(n) || 0).toLocaleString('en-US')

// Dates and versions come from transcript fields, so only well-formed values get through.
const DAY = /^\d{4}-\d{2}-\d{2}$/
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/
const day = (s) => (typeof s === 'string' && DAY.test(s) ? s : '?')
// Family and category keys are code-defined upstream; anything else is folded into "other" rather than printed.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,39}$/

/** The three headline numbers, computed exactly as the text card does. */
export function headline(t) {
  const g = (k) => t.gates?.[k] || 0
  return { d: t.withDecision || 0, static: g('rule') + g('rules-compound') + g('static-other'), classifier: g('classifier'), human: g('human') }
}

/** Claude Code version range of the recorded decisions, e.g. "2.1.306 to 2.1.320", or null. */
export function claudeVersions(t) {
  const parts = (v) => v.split('.').map(Number)
  const vs = Object.keys(t.versions || {}).filter((v) => VERSION.test(v))
    .sort((a, b) => { const [x, y] = [parts(a), parts(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] })
  if (!vs.length) return null
  return vs.length === 1 ? vs[0] : `${vs[0]} to ${vs[vs.length - 1]}`
}

/** [name, count] rows, largest first; unsafe names and the tail beyond `limit` rows become "other". */
export function tally(obj, limit = 6) {
  const merged = {}
  for (const [k, v] of Object.entries(obj || {})) {
    const n = Number(v) || 0
    if (n <= 0) continue
    const key = SAFE_NAME.test(k) ? k : 'other'
    merged[key] = (merged[key] || 0) + n
  }
  let other = merged.other || 0
  delete merged.other
  const rows = Object.entries(merged).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const keep = rows.length + (other ? 1 : 0) > limit ? limit - 1 : rows.length
  for (const [, n] of rows.splice(keep)) other += n
  if (other) rows.push(['other', other])
  return rows
}

const list = (rows) => rows.map(([k, n]) => `${k} ${num(n)}`).join(' · ')
const sum = (rows) => rows.reduce((s, [, n]) => s + n, 0)
const cell = (s) => String(s).replace(/\|/g, '\\|')
const row = (cells) => `| ${cells.map(cell).join(' | ')} |`

/**
 * "612 of 850 shell allow-rules never approved a command in this window.", or null when no shell rule was checked.
 * u is { shellRules, unused, from }: from 'rules' when the rules came from --rules files.
 */
export function unusedLine(u) {
  if (!u || typeof u !== 'object') return null
  const total = Number(u.shellRules) || 0
  if (total <= 0) return null
  const unused = Math.min(Math.max(Number(u.unused) || 0, 0), total)
  return `${num(unused)} of ${num(total)} shell allow-rule${total === 1 ? '' : 's'}${u.from === 'rules' ? ' in the --rules files' : ''} ` +
    'never approved a command in this window.'
}

/** The card as GitHub-flavoured markdown. rules is auditSettings() output. */
export function renderMarkdown(t, rules = {}, { version } = {}) {
  const h = headline(t)
  const { d } = h
  const g = (k) => t.gates?.[k] || 0
  const cc = claudeVersions(t)
  const out = []
  out.push("### Who approved my coding agent's actions?")
  out.push('')
  out.push([`vetobench ${version}`, `${day(t.firstTs)} to ${day(t.lastTs)}`, `${num(t.files)} transcripts`,
    `${num(d)} of ${num(t.toolResults)} tool calls carry a recorded decision`, ...(cc ? [`Claude Code ${cc}`] : [])].join(' · '))
  out.push('')
  if (!d) {
    out.push('No recorded permission decisions found. Claude Code records them from about v2.1.306 onward.')
  } else {
    out.push(`Static rules approved **${pct(h.static, d)}**, the AI classifier **${pct(h.classifier, d)}**, a human **${num(h.human)}** action(s).`)
    out.push('')
    out.push(row(['Gate', 'Actions', 'Share']))
    out.push('| --- | ---: | ---: |')
    for (const [key, label] of GATES) if (g(key)) out.push(row([label, num(g(key)), pct(g(key), d)]))
    out.push(row(['**Recorded decisions**', `**${num(d)}**`, '**100%**']))
    if (g('answer')) out.push('', `${num(g('answer'))} answers to the agent's own questions are not counted as approvals.`)
    shapes(t, d, out)
  }
  if (rules.files) {
    out.push('', `**Allow-rules now:** ${num(rules.allow)} allow in ${num(rules.files)} settings file(s) · ${num(rules.deny)} deny · ` +
      `${num(rules.ask)} ask · ${num(rules.wildcard)} wildcard interpreter/remote rule(s) · ${num(rules.secret)} with a secret inline`)
  }
  const unused = unusedLine(t.ruleUse)
  if (unused) out.push('', `**Unused rules:** ${unused}`)
  // The lower of the two matchings (plain prefix, word boundary) is the honest "at least".
  const wcAtLeast = t.wildcard && typeof t.wildcard === 'object'
    ? Math.min(Number(t.wildcard.actions) || 0, Number(t.wildcard.wordBoundary ?? t.wildcard.actions) || 0) : 0
  if (wcAtLeast > 0) { // totals always carry it; hide a zero
    const fam = tally(t.wildcard.byFamily)
    out.push('', `**Wildcard reliance:** at least ${num(wcAtLeast)} static-approved shell action(s) relied on a wildcard ` +
      `interpreter/remote rule${fam.length ? ` (${list(fam)})` : ''}`)
  }
  if (t.secrets && typeof t.secrets === 'object') {
    const cats = tally(t.secrets.byCategory)
    out.push('', `**Secrets in plaintext transcripts:** ${num(sum(cats))} across ${num(t.secrets.transcriptsWithSecrets)} transcript(s)` +
      `${cats.length ? ` (${list(cats)})` : ''}`)
  }
  out.push('', '_Counts only, made locally: nothing left my machine. Approvals given in chat are not counted._')
  return out.join('\n')
}

// The "where the agent was running" split, shown like the text card: only when work ran in more than one shape.
function shapes(t, d, out) {
  if (!t.byShape || typeof t.byShape !== 'object') return
  const rows = SHAPES.filter(([k]) => t.byShape[k]?.withDecision)
  if (rows.length < 2) return
  out.push('', '**Where the agent was running**', '')
  out.push(row(['Where', 'Decisions', 'Share', 'Static rules', 'AI classifier', 'Human']))
  out.push('| --- | ---: | ---: | ---: | ---: | ---: |')
  for (const [key, label] of rows) {
    const s = t.byShape[key]
    const h = headline(s)
    out.push(row([label, num(s.withDecision), pct(s.withDecision, d), pct(h.static, s.withDecision), pct(h.classifier, s.withDecision), num(h.human)]))
  }
}

export const ISSUE_URL = 'https://github.com/vetobench/vetobench/issues/new'
export const MAX_URL_LENGTH = 7000

/**
 * New-issue link for the card form. Issue forms prefill a field from the query parameter named by its id
 * (`card` and `versions` in .github/ISSUE_TEMPLATE/card.yml); a plain `body` parameter would be ignored.
 */
export function shareUrl(t, md) {
  const h = headline(t)
  const q = [['template', 'card.yml'], ['title', `Card: ${pct(h.static, h.d)} static rules, ${pct(h.classifier, h.d)} classifier, ${num(h.human)} human`]]
  const cc = claudeVersions(t)
  if (cc) q.push(['versions', cc])
  q.push(['card', md])
  return `${ISSUE_URL}?${q.map(([k, v]) => `${k}=${encode(v)}`).join('&')}`
}

// Also escape !'()* so terminals and chat apps do not cut the link short at a parenthesis.
const encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/** The markdown card, then the link for the user to open. vetobench never opens it or sends anything. */
export function renderShare(t, rules = {}, { version, maxUrl = MAX_URL_LENGTH } = {}) {
  const md = renderMarkdown(t, rules, { version })
  const url = shareUrl(t, md)
  const tail = url.length <= maxUrl
    ? ['To submit it, open this link in your browser. vetobench does not open it and sends nothing:', url]
    : [`This card is too long for a prefilled link. Open ${ISSUE_URL}?template=card.yml and paste the markdown above.`]
  return [md, '', '---', '', ...tail].join('\n')
}

const INK = '#141416'
const GREY = '#8E8E94'
const ACCENT = '#FF5A1F'
const LIGHT = '#F2F2F0'
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// The [y/N] glyphs (assets/logo/mark.svg) and the wordmark (assets/logo/lockup-dark.svg), inlined because assets/
// is not in the npm package. The mark's tile is ink, the card's background, so it is left out.
const LOGO = `<g transform="translate(10.23 39.93) scale(0.265)">
      <g fill="${GREY}">
        <path d="M18 -8H44V4H30V76H44V88H18Z"/>
        <path d="M67.5 20H80.5L95.5 64H82.5Z"/>
        <path d="M99.5 20H112.5L85.5 90H72.5Z"/>
        <path d="M157.5 -6H170.5L142.5 86H129.5Z"/>
        <path d="M256 -8H282V88H256V76H270V4H256Z"/>
      </g>
      <path fill="${ACCENT}" d="M188 0H201L220 42.9V0H232V70H219L200 27.1V70H188Z"/>
    </g>
    <g transform="translate(121.8 29) scale(0.6)">
      <path fill="${LIGHT}" d="M7 20H20L30 50.3L40 20H53L36.5 70H23.5Z"/>
      <g fill="none" stroke="${LIGHT}" stroke-width="12" stroke-linejoin="round">
        <path transform="translate(60 0)" d="M12 45H48A18 19 0 1 0 41.6 59.6"/>
        <path transform="translate(120 0)" d="M26 6V52A12 12 0 0 0 38 64H50M10 26H48"/>
        <ellipse cx="210" cy="45" rx="18" ry="19"/>
        <path d="M254 0V70"/>
        <ellipse cx="271" cy="45" rx="17" ry="19"/>
        <path transform="translate(300 0)" d="M12 45H48A18 19 0 1 0 41.6 59.6"/>
        <path transform="translate(360 0)" d="M14 20V70M14 42A16 16 0 0 1 46 42V70"/>
        <path transform="translate(420 0)" d="M44 32.8A17 19 0 1 0 44 57.2"/>
        <path transform="translate(480 0)" d="M14 0V70M14 42A16 16 0 0 1 46 42V70"/>
      </g>
    </g>`

/** A 1200x630 social card. Self-contained: no scripts, links, images or external fonts. */
export function renderSvg(t, { version } = {}) {
  const h = headline(t)
  const range = `${day(t.firstTs)} to ${day(t.lastTs)}`
  const big = [
    [pct(h.static, h.d), 'static allow-rules', LIGHT],
    [pct(h.classifier, h.d), 'AI classifier', LIGHT],
    [num(h.human), 'human approvals', ACCENT],
  ]
  // Monospace digits are ~0.6em wide: keep the widest number inside its 352px column with a gap to the next.
  const size = Math.min(96, Math.floor(300 / (0.6 * Math.max(...big.map(([v]) => v.length)))))
  const cols = big.map(([value, label, fill], i) => {
    const x = 72 + i * 352
    return `  <text x="${x}" y="424" font-family="${MONO}" font-size="${size}" font-weight="700" fill="${fill}">${xml(value)}</text>
  <text x="${x}" y="470" font-family="${SANS}" font-size="26" fill="${GREY}">${xml(label)}</text>`
  }).join('\n')
  const summary = `Static allow-rules ${big[0][0]}, AI classifier ${big[1][0]}, human approvals ${big[2][0]}; ${range}.`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title desc">
  <title id="title">vetobench card: who approved my coding agent's actions?</title>
  <desc id="desc">${xml(summary)}</desc>
  <rect width="1200" height="630" fill="${INK}"/>
  <g transform="translate(58.5 37.9) scale(0.9)">
    ${LOGO}
  </g>
  <text x="1128" y="92" text-anchor="end" font-family="${MONO}" font-size="24" fill="${GREY}">${xml(range)}</text>
  <text font-family="${SANS}" font-size="60" font-weight="700" fill="${LIGHT}">
    <tspan x="72" y="204">Who approved my</tspan>
    <tspan x="72" y="276">coding agent's actions?</tspan>
  </text>
${cols}
  <path d="M72 520H1128" stroke="${GREY}" stroke-opacity="0.35" stroke-width="2"/>
  <text x="72" y="568" font-family="${SANS}" font-size="24" fill="${GREY}">${xml(`vetobench ${version} · local, nothing left my machine`)}</text>
  <text x="1128" y="568" text-anchor="end" font-family="${MONO}" font-size="22" fill="${GREY}">${xml(`${num(h.d)} recorded decisions`)}</text>
</svg>
`
}
