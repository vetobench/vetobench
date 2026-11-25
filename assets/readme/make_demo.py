"""Render the vetobench demo: assets/readme/demo.svg (animated, for the README) and assets/readme/demo.mp4 (1280x720, for X).

Both show the real CLI's exact output on synthetic data. The script builds a throwaway HOME from test/fixtures/demo-home/,
copies the hand-written transcripts in test/fixtures/demo/ into its ~/.claude/projects, and runs `vetobench`,
`vetobench fix` (a dry run) and `vetobench replay` there. It never reads real transcripts or settings. The captured text is
saved to assets/readme/demo-output.txt; the animation types `npx vetobench`, prints the card line by line, then types
`npx vetobench fix` and prints its dry run.

Run from anywhere:  python3 -I assets/readme/make_demo.py [svg] [mp4] [--stills DIR]
  svg            write demo.svg and demo-output.txt (needs node)
  mp4            write demo.mp4 (needs node, Google Chrome and ffmpeg); frames render in parallel headless Chrome processes
  --stills DIR   also write PNG stills of the SVG at a few moments into DIR, to check the layout (needs Chrome)
With no job named (and no --stills), it writes both. Standard library only. Set VETOBENCH_CHROME to use another Chrome binary.
"""
import html, json, math, os, queue, re, shutil, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CHROME = os.environ.get('VETOBENCH_CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
INK, LIGHT, GREY, ORANGE, LINE, TERM_BG = '#141416', '#F2F2F0', '#8E8E94', '#FF5A1F', '#2C2C33', '#0C0C0E'
MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace"
COLS = 102  # terminal width: both long card lines wrap at a space at 102 columns


# ---- 1. The CLI's exact output, from synthetic data only ------------------------------------------------------------
def capture():
    tmp = tempfile.mkdtemp(prefix='vetobench-demo-')
    try:
        home = os.path.join(tmp, 'home')
        shutil.copytree(os.path.join(ROOT, 'test', 'fixtures', 'demo-home'), home)
        shutil.copytree(os.path.join(ROOT, 'test', 'fixtures', 'demo'), os.path.join(home, '.claude', 'projects'))
        work = os.path.join(home, 'work')  # a folder without project settings: only the demo's global settings apply
        os.makedirs(work)
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': home, 'USERPROFILE': home, 'LANG': 'en_US.UTF-8'}
        out = {}
        for name, args in (('card', []), ('fix', ['fix']), ('replay', ['replay'])):
            r = subprocess.run(['node', os.path.join(ROOT, 'bin', 'vetobench.js'), *args], cwd=work, env=env,
                               capture_output=True, text=True, timeout=60)
            if r.returncode != 0:
                sys.exit(f'vetobench {" ".join(args)} failed: {r.stderr.strip()}')
            out[name] = r.stdout.rstrip('\n').split('\n')
        return out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def save_output(out):
    path = os.path.join(HERE, 'demo-output.txt')
    with open(path, 'w') as f:
        f.write('Example output: the real CLI run on the synthetic transcripts in test/fixtures/demo/ with the settings in\n'
                'test/fixtures/demo-home/. Not anyone\'s real numbers. Regenerate with: python3 -I assets/readme/make_demo.py svg\n')
        for name, cmd in (('card', 'npx vetobench'), ('fix', 'npx vetobench fix'), ('replay', 'npx vetobench replay')):
            f.write(f'\n$ {cmd}\n' + '\n'.join(out[name]) + '\n')
    print('wrote', os.path.relpath(path, ROOT), os.path.getsize(path))


def wrap(lines, cols=COLS):
    """Hard-wrap at the terminal width, as a terminal does. Warn when a break would split a word."""
    rows = []
    for line in lines:
        while len(line) > cols:
            if line[cols - 1] != ' ' and line[cols] != ' ':
                print(f'warning: a {len(line)}-character line breaks mid-word at {cols} columns', file=sys.stderr)
            rows.append(line[:cols])
            line = line[cols:]
        rows.append(line)
    return rows


# ---- 2. One timeline for both renderings -----------------------------------------------------------------------------
class Term:
    """Rows of a terminal with the time each appears, typed commands, and the cursor."""

    def __init__(self):
        self.rows = []  # {'text', 't', 'typed': None | (start index, [time of each typed char])}
        self.cursor = []  # segments (t0, t1, row, mode, times): mode 'idle' (blinks) or 'type' (moves at each typed char's time)
        self.marks = {}

    def prompt(self, t):
        self.rows.append({'text': '$ ', 't': t, 'typed': None})
        return len(self.rows) - 1

    def type(self, row, cmd, t, dt):
        times = []
        for i, ch in enumerate(cmd):
            times.append(t)
            t += dt * (1 + 0.45 * math.sin(i * 2.3 + 1)) + (0.06 if ch == ' ' else 0)
        r = self.rows[row]
        r['text'] += cmd
        r['typed'] = (2, times)
        self.cursor.append((r['t'], times[0], row, 'idle', None))
        self.cursor.append((times[0], t, row, 'type', times))
        return t

    def run(self, lines, t, dt):
        first = len(self.rows)
        for i, line in enumerate(lines):
            self.rows.append({'text': line, 't': t + i * dt, 'typed': None})
        return first, t + len(lines) * dt

    def find(self, prefix, after=0):
        for i, r in enumerate(self.rows[after:], after):
            if r['text'].startswith(prefix):
                return i
        sys.exit(f'the output has no line starting with {prefix!r}: update make_demo.py for the new format')

    def cursor_at(self, t):
        """(row, col, visible) at time t: blinking after an idle prompt, solid while typing, hidden while a command runs."""
        t += 1e-4  # a change scheduled at exactly t has happened
        for t0, t1, row, mode, times in self.cursor:
            if t0 <= t < t1:
                if mode == 'idle':
                    return row, 2, int((t - t0) / 0.5) % 2 == 0
                return row, 2 + sum(1 for x in times if x <= t), True
        return None, None, False


def script(card, fix, p):
    """The demo: type `npx vetobench`, print the card, type `npx vetobench fix`, print the dry run."""
    term = Term()
    r = term.prompt(0.0)
    t = term.type(r, 'npx vetobench', p['first_key'], p['key_dt'])
    term.marks['enter1'] = t
    first, t = term.run(wrap(card), t + p['scan'], p['line_dt'])
    term.marks['card'] = (first, len(term.rows) - 1, t)
    r = term.prompt(t)
    term.marks['prompt2'] = r
    t += p['hold_card']
    t2 = term.type(r, 'npx vetobench fix', t, p['key_dt'])
    term.marks['type2'] = t
    t = t2
    first, t = term.run(wrap(fix), t + p['scan'], p['line_dt'])
    term.marks['fix'] = (first, len(term.rows) - 1, t)
    r = term.prompt(t)
    term.cursor.append((t, t + p['hold_fix'] + 99, r, 'idle', None))
    term.marks['end'] = t + p['hold_fix']
    return term


# ---- 3. The animated SVG for the README (SMIL, no script, no external reference) -------------------------------------
S = {'font': 14, 'adv': 8.4, 'lh': 19, 'pad': 22, 'bar': 38, 'rows': 27}


def num(x):
    s = f'{x:.4f}'.rstrip('0').rstrip('.')
    return s if s not in ('', '-0') else '0'


def anim(attr, changes, T, calc='discrete', tag='animate', extra=''):
    """A looping animation from [(time, value)], first at time 0. Repeats of a value are dropped."""
    pts = []
    for t, v in changes:
        if pts and pts[-1][1] == v and calc == 'discrete':
            continue
        pts.append((max(0.0, min(t / T, 1.0)), v))
    if calc != 'discrete' and pts[-1][0] < 1:
        pts.append((1.0, pts[-1][1]))
    if len(pts) == 1:
        return None
    kt = ';'.join(num(k) for k, _ in pts)
    vals = ';'.join(str(v) for _, v in pts)
    return (f'<{tag} attributeName="{attr}"{extra} values="{vals}" keyTimes="{kt}" dur="{num(T)}s" '
            f'repeatCount="indefinite" calcMode="{calc}"/>')


def esc(s):
    return html.escape(s, quote=False)


def svg_rows(term, adv, lh, x0, font_baseline, typed_clip_prefix):
    """Shared row markup: one <text> per row with textLength, so every monospace font lays out the same width."""
    parts, clips = [], []
    for i, r in enumerate(term.rows):
        text = r['text']
        if not text:
            continue
        y = i * lh + font_baseline
        body = esc(text)
        if text.startswith('$ '):
            body = f'<tspan fill="{ORANGE}">$</tspan>{esc(text[1:])}'
        attrs = f'x="{num(x0)}" y="{num(y)}" textLength="{num(len(text) * adv)}" lengthAdjust="spacing"'
        if r['typed']:
            attrs += f' clip-path="url(#{typed_clip_prefix}{i})"'
            clips.append(i)
        parts.append((i, attrs, body))
    return parts, clips


def build_svg(term):
    a, lh, pad, bar, R = S['adv'], S['lh'], S['pad'], S['bar'], S['rows']
    T = term.marks['end'] + 0.6
    W = round(pad * 2 + COLS * a)
    top = bar + 12
    H = top + R * lh + 14
    base = round(lh * 0.73, 2)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc">',
           '<title id="title">vetobench demo (example data)</title>',
           '<desc id="desc">A terminal types npx vetobench and prints a card of who approved a coding agent\'s actions, then types '
           'npx vetobench fix and prints a dry run of the allow-rules it would remove. Example data from synthetic transcripts.</desc>',
           '<style>text{white-space:pre}</style>',
           f'<rect width="{W}" height="{H}" rx="12" fill="{TERM_BG}"/>',
           f'<rect x="1" y="1" width="{W - 2}" height="{H - 2}" rx="11" fill="none" stroke="{LINE}" stroke-width="2"/>',
           f'<path d="M1 {bar}H{W - 1}" stroke="{LINE}" stroke-width="2"/>']
    for k in range(3):
        out.append(f'<circle cx="{pad + 6 + k * 20}" cy="{num(bar / 2 + 0.5)}" r="6" fill="{LINE}"/>')
    pill_w = 112  # the "example data" label, so nobody takes these numbers for real ones
    out.append(f'<rect x="{W - pad - pill_w}" y="{num(bar / 2 - 11.5)}" width="{pill_w}" height="23" rx="11.5" fill="none" '
               f'stroke="{ORANGE}" stroke-width="1.5"/>')
    out.append(f'<text x="{num(W - pad - pill_w / 2)}" y="{num(bar / 2 + 5)}" text-anchor="middle" font-size="13" '
               f'fill="{ORANGE}">example data</text>')
    out.append(f'<clipPath id="screen"><rect x="0" y="{top - 1}" width="{W}" height="{R * lh + 2}"/></clipPath>')
    parts, clips = svg_rows(term, a, lh, pad, base, 'k')
    defs = []
    for i in clips:
        r = term.rows[i]
        start, times = r['typed']
        widths = [(0.0, num(start * a + 1))] + [(t, num((start + n + 1) * a + 1)) for n, t in enumerate(times)]
        defs.append(f'<clipPath id="k{i}"><rect x="{pad - 2}" y="{i * lh}" width="{num(len(r["text"]) * a + 2)}" height="{lh}">'
                    f'{anim("width", widths, T)}</rect></clipPath>')
    out.append('<defs>' + ''.join(defs) + '</defs>')
    # Fade out at the end of each loop; the scroll follows the newest row like a terminal.
    fade = anim('opacity', [(0, 1), (T - 0.6, 1), (T - 0.05, 0)], T, calc='linear')
    out.append(f'<g clip-path="url(#screen)"><g>{fade}')
    scroll = [(0.0, '0 0')]
    for i, r in enumerate(term.rows):
        if i >= R:
            scroll.append((r['t'], f'0 {num(-(i - R + 1) * lh)}'))
    out.append(f'<g transform="translate(0 {top})">')
    out.append('<g>' + anim('transform', scroll, T, tag='animateTransform', extra=' type="translate"'))
    out.extend(highlight_svg(term, T))
    for i, attrs, body in parts:
        r = term.rows[i]
        show = anim('visibility', [(0, 'hidden'), (r['t'], 'visible')], T) if r['t'] > 0 else None
        out.append(f'<text {attrs}>{show or ""}{body}</text>')
    out.append(cursor_svg(term, T))
    out.append('</g></g></g></g>')
    out.append('</svg>')
    svg = '\n'.join(out)
    # Text styling once, on the root: monospace, light, xml:space for renderers that ignore white-space on SVG text.
    svg = svg.replace('role="img"', f'xml:space="preserve" font-family="{MONO}" font-size="{S["font"]}" fill="{LIGHT}" role="img"', 1)
    return svg


def highlight_svg(term, T):
    a, lh, pad = S['adv'], S['lh'], S['pad']
    out = []
    for row, t_on, t_off in highlights(term, 'svg'):
        w = len(term.rows[row]['text']) * a + 14
        op = anim('opacity', [(0, 0), (t_on, 0), (t_on + 0.25, 1), (t_off, 1), (t_off + 0.25, 0)], T, calc='linear')
        out.append(f'<g opacity="0">{op}<rect x="{pad - 8}" y="{row * lh}" width="{num(w)}" height="{lh}" rx="3" fill="{ORANGE}" '
                   f'fill-opacity="0.16"/><rect x="{pad - 8}" y="{row * lh}" width="3" height="{lh}" fill="{ORANGE}"/></g>')
    return out


def highlights(term, kind):
    """(row, on, off): the headline line once the card is out, then the fix's summary line."""
    card_first, card_last, card_done = term.marks['card']
    fix_first, fix_last, fix_done = term.marks['fix']
    summary = term.find('Static rules approved', card_first)
    remove = term.find('Would remove', fix_first)
    if kind == 'svg':
        return [(summary, card_done + 0.3, term.marks['type2'] - 0.2), (remove, fix_done + 0.3, term.marks['end'])]
    return []


def cursor_svg(term, T):
    a, lh, pad = S['adv'], S['lh'], S['pad']
    xs, ys, vis = [], [], []
    times = sorted({0.0} | {x for seg in term.cursor for x in (seg[0], seg[1])} |
                   {x for seg in term.cursor if seg[3] == 'type' for x in seg[4]} |
                   {seg[0] + k * 0.5 for seg in term.cursor if seg[3] == 'idle' for k in range(int((seg[1] - seg[0]) / 0.5) + 1)})
    for t in times:
        if t > T:
            break
        row, col, on = term.cursor_at(t)
        if row is not None:
            xs.append((t, num(pad + col * a)))
            ys.append((t, num(row * lh + 2)))
        vis.append((t, 'visible' if on else 'hidden'))
    return (f'<rect x="{xs[0][1]}" y="{ys[0][1]}" width="{a}" height="{lh - 3}" fill="{ORANGE}" fill-opacity="0.85">'
            f'{anim("x", xs, T) or ""}{anim("y", ys, T) or ""}{anim("visibility", vis, T) or ""}</rect>')


# ---- 4. The video for X: 1280x720, a camera that zooms onto the lines that matter, captions, an end card --------------
V = {'w': 1280, 'h': 720, 'fps': 30}
PANEL = (32, 88, 1248, 620)  # x0, y0, x1, y1 of the terminal panel
INSET = 22
VW, VH = PANEL[2] - PANEL[0] - 2 * INSET, PANEL[3] - PANEL[1] - 2 * INSET
VADV = VW / COLS
VFONT = round(VADV / 0.6, 2)
VLH = round(VFONT * 1.36)


def logo(height):
    svg = open(os.path.join(ROOT, 'assets', 'logo', 'lockup-dark.svg')).read()
    return svg.replace('width="444" height="100"', f'height="{height}" width="{round(height * 4.44)}"', 1)


def view(box, smax=10.0):
    """The camera (centre x, centre y, scale) that fits rows r0..r1 and columns c0..c1, with a margin, into the panel."""
    r0, r1, c0, c1 = box
    w, h = (c1 - c0 + 4) * VADV, (r1 - r0 + 1.6) * VLH
    s = min(VW / w, VH / h, smax)
    return ((c0 + c1) / 2 * VADV, (r0 + r1 + 1) / 2 * VLH, s)


def ease(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def camera(keys, t):
    """keys: [(time, (cx, cy, s))]; eased between keys, scale interpolated in log space."""
    if t <= keys[0][0]:
        return keys[0][1]
    for (ta, a), (tb, b) in zip(keys, keys[1:]):
        if ta <= t <= tb:
            u = ease((t - ta) / (tb - ta)) if tb > ta else 1
            return (a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, math.exp(math.log(a[2]) + (math.log(b[2]) - math.log(a[2])) * u))
    return keys[-1][1]


def fade(t, on, off, d=0.3):
    return round(min(ease((t - on) / d), 1 - ease((t - off) / d)), 3)


def video_plan(term, out):
    m = term.marks
    card_first, card_last, card_done = m['card']
    fix_first, fix_last, fix_done = m['fix']
    rows = term.rows
    gates_first = card_first + 3
    human = term.find('  You, through a permission prompt', card_first)
    summary = term.find('Static rules approved', card_first)
    where = term.find('Where the agent was running:', card_first)
    loops = term.find('  Loops (/loop, /goal)', where)
    sub = term.find('  Inside subagents', where)
    remove = term.find('Would remove', fix_first)
    prompt2 = m['prompt2']
    last = len(rows) - 1
    width = lambda a, b: max(len(rows[i]['text']) for i in range(a, b + 1)) + 2
    # The captions restate the output's own numbers, read back from it.
    you = re.search(r'you ([\d,]+) action', rows[summary]['text']).group(1)
    of = re.search(r'· ([\d,]+) of [\d,]+ tool calls carry a recorded decision', out['card'][1]).group(1)
    zero = all(rows[i]['text'].rstrip().endswith('· you 0') for i in (loops, sub))
    caps = ['Who approved your coding agent\'s actions?',
            f'In this example, you approved <b>{you}</b> of the agent\'s {of} actions yourself.',
            'Loops and subagents: you approved <b>0</b>. Rules and the AI classifier decided.' if zero else
            'Where the agent was running, and who approved its actions there.',
            'Then <span class="m">fix</span> counts the allow-rules it would remove.',
            'A dry run: nothing changes until you add <span class="m">--write</span>.']
    t_where = m['type2'] - 3.0
    t_back = m['type2'] - 0.7
    keys = [(0.0, view((0, 0, 0, 44), 1.9)), (m['enter1'] + 0.15, view((0, 0, 0, 44), 1.9)),
            (card_done + 0.25, view((0, prompt2, 0, COLS))), (card_done + 0.75, view((0, prompt2, 0, COLS))),
            (card_done + 1.35, view((gates_first, summary, 0, width(gates_first, summary)))),
            (t_where, view((gates_first, summary, 0, width(gates_first, summary)))),
            (t_where + 0.55, view((where, sub, 0, width(where, sub)))), (t_back, view((where, sub, 0, width(where, sub)))),
            (m['type2'] - 0.05, view((prompt2 - 4, prompt2 + 2, 0, 66), 1.6)), (fix_done - 0.6, view((prompt2 - 4, prompt2 + 2, 0, 66), 1.6)),
            (fix_done + 0.4, view((prompt2, last, 0, width(prompt2, last)))), (m['end'], view((prompt2, last, 0, width(prompt2, last))))]
    hl = [(human, card_done + 1.35, t_where), (summary, card_done + 1.35, t_where), (loops, t_where + 0.55, t_back),
          (sub, t_where + 0.55, t_back), (remove, fix_done + 0.5, m['end'] + 0.3)]
    # The first caption is on from frame 0, so the video's first frame (its preview) says what it is about.
    cap_t = [(-1, card_done + 0.9), (card_done + 1.35, t_where), (t_where + 0.55, t_back), (t_back + 0.45, fix_done + 0.1),
             (fix_done + 0.5, m['end'] + 0.3)]
    return keys, hl, caps, cap_t


def video_page(term, keys, hl, caps, cap_t, T):
    parts, clips = svg_rows(term, VADV, VLH, 0, round(VLH * 0.73, 2), 'k')
    rows = ''.join(f'<text id="r{i}" {attrs}>{body}</text>' for i, attrs, body in parts)
    clipdefs = ''.join(f'<clipPath id="k{i}"><rect id="kr{i}" x="-2" y="{i * VLH}" height="{VLH}" width="0"/></clipPath>' for i in clips)
    hls = ''.join(f'<g id="h{n}" opacity="0"><rect x="-10" y="{row * VLH}" width="{num(len(term.rows[row]["text"]) * VADV + 18)}" '
                  f'height="{VLH}" rx="4" fill="{ORANGE}" fill-opacity="0.17"/><rect x="-10" y="{row * VLH}" width="4" height="{VLH}" '
                  f'fill="{ORANGE}"/></g>' for n, (row, _, _) in enumerate(hl))
    capdivs = ''.join(f'<div class="cap" id="c{n}">{c}</div>' for n, c in enumerate(caps))
    css = f'''* {{ box-sizing: border-box; }}
    html, body {{ margin: 0; width: {V['w']}px; height: {V['h']}px; overflow: hidden; background: {INK}; color: {LIGHT};
      font-family: system-ui, -apple-system, sans-serif; }}
    .top {{ position: absolute; left: {PANEL[0]}px; right: {V['w'] - PANEL[2]}px; top: 26px; height: 44px; display: flex; align-items: center; }}
    .pill {{ margin-left: auto; border: 2.5px solid {ORANGE}; color: {ORANGE}; border-radius: 22px; padding: 5px 18px 6px;
      font: 700 22px/1 Menlo, monospace; }}
    .panel {{ position: absolute; left: {PANEL[0]}px; top: {PANEL[1]}px; width: {PANEL[2] - PANEL[0]}px; height: {PANEL[3] - PANEL[1]}px;
      background: {TERM_BG}; border: 2px solid {LINE}; border-radius: 16px; overflow: hidden; }}
    .panel svg {{ position: absolute; left: {INSET - 2}px; top: {INSET - 2}px; overflow: hidden;
      mask-image: linear-gradient(to right, #000 calc(100% - 32px), transparent),
        linear-gradient(to bottom, transparent, #000 12px, #000 calc(100% - 12px), transparent); mask-composite: intersect; }}
    text {{ white-space: pre; }}
    .cap {{ position: absolute; left: {PANEL[0]}px; right: {V['w'] - PANEL[2]}px; top: {PANEL[3] + 18}px; text-align: center;
      font-size: 35px; font-weight: 600; letter-spacing: -0.01em; opacity: 0; white-space: nowrap; }}
    .cap b {{ color: {ORANGE}; }} .cap .m {{ font-family: Menlo, monospace; font-size: 31px; color: {ORANGE}; }}
    .end {{ position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px;
      opacity: 0; }}
    .end h2 {{ margin: 6px 0 0; font-size: 50px; letter-spacing: -0.02em; }}
    .end .cmd {{ font: 600 40px Menlo, monospace; background: {TERM_BG}; border: 2px solid {LINE}; border-radius: 14px; padding: 16px 30px; }}
    .end .cmd span {{ color: {ORANGE}; }}
    .end p {{ margin: 0; color: {GREY}; font-size: 27px; }}
    .end .note {{ position: absolute; bottom: 34px; font-size: 22px; }}'''
    body = f'''<div class="top">{logo(40)}<span class="pill">example data</span></div>
    <div class="panel" id="panel"><svg width="{VW + 4}" height="{VH + 4}" viewBox="-2 -2 {VW + 4} {VH + 4}" xml:space="preserve"
      font-family="Menlo, monospace" font-size="{VFONT}" fill="{LIGHT}"><defs>{clipdefs}</defs><g id="cam">{hls}{rows}
      <rect id="cur" width="{num(VADV)}" height="{VLH - 4}" y="0" fill="{ORANGE}" fill-opacity="0.85"/></g></svg></div>
    {capdivs}
    <div class="end" id="end">{logo(76)}<h2>Run it on your own agent</h2>
      <div class="cmd"><span>$</span> npx vetobench</div>
      <p>Reads your Claude Code transcripts locally and prints counts. Nothing is sent anywhere.</p>
      <p class="note">Example data from synthetic transcripts</p></div>'''
    frames = []
    n = int(round(T * V['fps']))
    for f in range(n):
        t = f / V['fps']
        cx, cy, s = camera(keys, t)
        visible = sum(1 for r in term.rows if r['t'] <= t)
        k = {}
        for i in clips:
            start, times = term.rows[i]['typed']
            k[i] = num((start + sum(1 for x in times if x <= t)) * VADV + 1)
        row, col, on = term.cursor_at(t)
        end = fade(t, term.marks['end'], 99, 0.5)
        frames.append({'v': visible, 'k': k, 'cam': f'translate({num(VW / 2 - cx * s)} {num(VH / 2 - cy * s)}) scale({num(s)})',
                       'cur': [num(col * VADV) if on else 0, row * VLH + 2 if on else 0, 1 if on else 0],
                       'h': [fade(t, a, b) for _, a, b in hl], 'c': [fade(t, a, b) for a, b in cap_t], 'e': end})
    js = '''const F = %s, N = %d;
const st = F[Math.min(+location.hash.slice(1) || 0, F.length - 1)];
for (let i = 0; i < N; i++) { const r = document.getElementById('r' + i); if (r) r.style.visibility = i < st.v ? 'visible' : 'hidden'; }
for (const [i, w] of Object.entries(st.k)) document.getElementById('kr' + i).setAttribute('width', w);
document.getElementById('cam').setAttribute('transform', st.cam);
const c = document.getElementById('cur'); c.setAttribute('x', st.cur[0]); c.setAttribute('y', st.cur[1]); c.style.visibility = st.cur[2] ? 'visible' : 'hidden';
st.h.forEach((o, i) => document.getElementById('h' + i).setAttribute('opacity', o));
st.c.forEach((o, i) => document.getElementById('c' + i).style.opacity = o);
document.getElementById('end').style.opacity = st.e;
document.getElementById('panel').style.opacity = 1 - st.e;
st.c.forEach((o, i) => { if (st.e) document.getElementById('c' + i).style.opacity = o * (1 - st.e); });''' % (json.dumps(frames, separators=(',', ':')), len(term.rows))
    doc = f'<!doctype html><html lang="en"><head><meta charset="utf-8"><style>{css}</style></head><body>{body}<script>{js}</script></body></html>'
    return doc, n


def chrome_shots(page, jobs, w, h, scale, workers=8):
    """Screenshot page#<fragment> for each (fragment, png) with parallel headless Chrome processes, one profile each."""
    if not os.path.exists(CHROME):
        sys.exit(f'Chrome not found at {CHROME}; set VETOBENCH_CHROME')
    profiles = queue.Queue()
    base = tempfile.mkdtemp(prefix='vetobench-chrome-')
    for k in range(workers):
        profiles.put(os.path.join(base, f'p{k}'))

    def shot(job):
        frag, png = job
        prof = profiles.get()
        try:
            for _ in range(3):
                subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
                                '--disable-extensions', '--mute-audio', f'--user-data-dir={prof}', f'--force-device-scale-factor={scale}',
                                f'--window-size={w},{h}', f'--screenshot={png}', f'file://{page}#{frag}'], capture_output=True, timeout=90)
                if os.path.exists(png) and os.path.getsize(png) > 0:
                    return
            raise RuntimeError(f'Chrome did not write {png}')
        finally:
            profiles.put(prof)

    try:
        with ThreadPoolExecutor(workers) as ex:
            list(ex.map(shot, jobs))
    finally:
        shutil.rmtree(base, ignore_errors=True)


SVG_TIMES = {'key_dt': 0.075, 'first_key': 0.6, 'scan': 0.45, 'line_dt': 0.06, 'hold_card': 3.4, 'hold_fix': 4.2}
VIDEO_TIMES = {'key_dt': 0.07, 'first_key': 0.55, 'scan': 0.4, 'line_dt': 0.07, 'hold_card': 7.0, 'hold_fix': 3.1}
END_CARD = 2.4


def make_svg(out):
    term = script(out['card'], out['fix'], SVG_TIMES)
    svg = build_svg(term)
    path = os.path.join(HERE, 'demo.svg')
    with open(path, 'w') as f:
        f.write(svg + '\n')
    print('wrote', os.path.relpath(path, ROOT), os.path.getsize(path), f'({term.marks["end"] + 0.6:.1f} s loop)')
    return term


def make_stills(out, folder):
    """PNG stills of demo.svg at chosen moments: the SVG inline in a page that pauses its animations at a time."""
    term = script(out['card'], out['fix'], SVG_TIMES)
    svg = build_svg(term)
    m = term.marks
    times = {'typing': 1.0, 'card': m['card'][2] + 1.0, 'typing-fix': m['type2'] + 0.6, 'fix': m['fix'][2] + 1.0,
             'last': m['end'] + 0.3}
    os.makedirs(folder, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix='vetobench-stills-')
    page = os.path.join(tmp, 'still.html')
    W, H = re.search(r'width="(\d+)" height="(\d+)"', svg).groups()
    with open(page, 'w') as f:
        f.write(f'<!doctype html><html><head><meta charset="utf-8"><style>html,body{{margin:0;background:{INK}}}</style></head>'
                f'<body>{svg}<script>const s = document.querySelector("svg"); s.pauseAnimations(); '
                f's.setCurrentTime(parseFloat(location.hash.slice(1)));</script></body></html>')
    chrome_shots(page, [(f'{t:.3f}', os.path.join(folder, f'svg-{name}.png')) for name, t in times.items()], int(W), int(H), 2, workers=5)
    shutil.rmtree(tmp, ignore_errors=True)
    print('wrote stills to', folder)


def make_mp4(out):
    if not shutil.which('ffmpeg'):
        sys.exit('ffmpeg not found')
    term = script(out['card'], out['fix'], VIDEO_TIMES)
    keys, hl, caps, cap_t = video_plan(term, out)
    T = term.marks['end'] + END_CARD
    doc, n = video_page(term, keys, hl, caps, cap_t, T)
    tmp = tempfile.mkdtemp(prefix='vetobench-video-')
    try:
        page = os.path.join(tmp, 'demo.html')
        with open(page, 'w') as f:
            f.write(doc)
        chrome_shots(page, [(str(i), os.path.join(tmp, f'f{i:04d}.png')) for i in range(n)], V['w'], V['h'], 2)
        path = os.path.join(HERE, 'demo.mp4')
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(V['fps']), '-i', os.path.join(tmp, 'f%04d.png'),
                        '-vf', f'scale={V["w"]}:{V["h"]}:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow',
                        '-crf', '20', '-profile:v', 'high', '-r', str(V['fps']), '-movflags', '+faststart', path], check=True)
        print('wrote', os.path.relpath(path, ROOT), os.path.getsize(path), f'({n / V["fps"]:.1f} s)')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main(argv):
    stills = None
    if '--stills' in argv:
        i = argv.index('--stills')
        stills = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    jobs = argv or ([] if stills else ['svg', 'mp4'])
    out = capture()
    if 'svg' in jobs:
        save_output(out)
        make_svg(out)
    if 'mp4' in jobs:
        make_mp4(out)
    if stills:
        make_stills(out, stills)


if __name__ == '__main__':
    main(sys.argv[1:])
