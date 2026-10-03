// Inject probes + source discovery for Jostraca.
// Convention: RED = rule violated (weakness confirmed), GREEN = rule holds.
// Tests named [I*] marked INFO never fail: they only print what happened.
// Put this file next to the other test files and run:  node inject.test.mjs
//
// API used (taken from node_modules/jostraca/dist/cmp/Inject.d.ts):
//   Inject({ name, markers?: [start, end], exclude? }, children)
//   - `name` is the path of an EXISTING file below the enclosing folder
//   - default markers: '#--START--#\n' and '\n#--END--#'
//   - Inject.js says the markers become a  start(.*?)end  regex

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync,
  existsSync, readdirSync, statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import * as J from 'jostraca'

const { Jostraca, Project, Content, Inject } = J
const require = createRequire(import.meta.url)

// ---------- helpers ----------
const read = (p) => readFileSync(p, 'utf8')
const firstLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 160)

function sandbox(t) {
  const base = mkdtempSync(join(tmpdir(), 'jprobe-'))
  const out = join(base, 'out')
  mkdirSync(out, { recursive: true })
  t.after(() => rmSync(base, { recursive: true, force: true }))
  return { base, out }
}

const START = '#--START--#\n'
const END = '\n#--END--#'
// a file as a user would keep it: own lines around a generator-owned region
const seeded = (body, start = START, end = END) =>
  `# user header\nUSER=1\n${start}${body}${end}\n# user footer\n`

const inject = (out, name, body, props = {}) =>
  Jostraca().generate({ folder: out }, () => {
    Project({}, () => { Inject({ name, ...props }, () => { Content(body) }) })
  })

async function attempt(fn) {
  try { return { result: await fn() } } catch (e) { return { err: firstLine(e) } }
}
const show = (t, label, r, text) =>
  t.diagnostic(`${label}: err=${r.err ?? '-'} | lists=${JSON.stringify(r.result?.files)} | file=${JSON.stringify(text)}`)

// =====================================================================
// I1 - basic contract (also the harness sanity check)
// =====================================================================
test('[I1] region is replaced and the text outside it is kept', async (t) => {
  const { out } = sandbox(t)
  const f = join(out, 'c.sh')
  writeFileSync(f, seeded('PORT=8080'))
  const r = await attempt(() => inject(out, 'c.sh', 'PORT=9090'))
  const text = read(f)
  show(t, 'I1', r, text)
  assert.ok(!r.err, 'Inject threw: ' + r.err)
  assert.match(text, /PORT=9090/, 'new body missing')
  assert.doesNotMatch(text, /PORT=8080/, 'old body still there')
  assert.match(text, /USER=1/, 'user line before the region was lost')
  assert.match(text, /# user footer/, 'user line after the region was lost')
})

// =====================================================================
// I2 / I3 - can it be re-run? (markers must survive the first injection)
// =====================================================================
test('[I2] a second injection still finds the markers and updates the region', async (t) => {
  const { out } = sandbox(t)
  const f = join(out, 'c.sh')
  writeFileSync(f, seeded('PORT=8080'))
  await attempt(() => inject(out, 'c.sh', 'PORT=1'))
  const r = await attempt(() => inject(out, 'c.sh', 'PORT=2'))
  const text = read(f)
  show(t, 'I2', r, text)
  assert.match(text, /PORT=2/, 'second run did not update the region (markers consumed?)')
  assert.doesNotMatch(text, /PORT=1/)
})

test('[I3] injecting the same body twice is a byte-for-byte no-op', async (t) => {
  const { out } = sandbox(t)
  const f = join(out, 'c.sh')
  writeFileSync(f, seeded('PORT=8080'))
  await attempt(() => inject(out, 'c.sh', 'PORT=1'))
  const once = read(f)
  await attempt(() => inject(out, 'c.sh', 'PORT=1'))
  assert.equal(read(f), once, 'second identical injection changed the file')
})

// =====================================================================
// I4 / I5 - failure visibility
// =====================================================================
test('[I4] markers missing from the target must not be a silent no-op', async (t) => {
  const { out } = sandbox(t)
  const f = join(out, 'c.sh')
  writeFileSync(f, 'USER=1\n')                       // exists, but has no markers
  const r = await attempt(() => inject(out, 'c.sh', 'NEW=1'))
  const text = read(f)
  show(t, 'I4', r, text)
  if (!r.err && !text.includes('NEW=1')) {
    assert.fail('no error and nothing injected; result lists: ' + JSON.stringify(r.result?.files))
  }
})

test('[I5] a missing target file fails loudly', async (t) => {
  const { out } = sandbox(t)
  const r = await attempt(() => inject(out, 'nope.sh', 'X=1'))
  t.diagnostic(`I5: err=${r.err ?? '-'} | lists=${JSON.stringify(r.result?.files)}`)
  if (!r.err) {
    assert.fail('no error for a missing target; file exists afterwards: ' + existsSync(join(out, 'nope.sh')))
  }
})

// =====================================================================
// I6 - Windows line endings (default markers contain \n)
// =====================================================================
test('[I6] a CRLF file is still injected with the default markers', async (t) => {
  const { out } = sandbox(t)
  const f = join(out, 'c.sh')
  writeFileSync(f, seeded('PORT=8080').replace(/\n/g, '\r\n'))
  const r = await attempt(() => inject(out, 'c.sh', 'PORT=9090'))
  const text = read(f)
  show(t, 'I6', r, text)
  assert.match(text, /PORT=9090/, 'default markers (they contain \\n) did not match the CRLF file')
})

// =====================================================================
// I7 - multi-line regions (regex `.` does not cross newlines by default)
// =====================================================================
test('[I7] a multi-line region is replaced as a whole', async (t) => {
  const { out } = sandbox(t)
  const f = join(out, 'c.sh')
  writeFileSync(f, seeded('L1=1\nL2=2\nL3=3'))
  const r = await attempt(() => inject(out, 'c.sh', 'NEW=1'))
  const text = read(f)
  show(t, 'I7', r, text)
  assert.match(text, /NEW=1/, 'multi-line region was not replaced')
  assert.doesNotMatch(text, /L[123]=/, 'part of the old region survived')
})

// =====================================================================
// I9 - markers that contain regex metacharacters
// =====================================================================
test('[I9] custom markers with regex metacharacters work literally', async (t) => {
  const { out } = sandbox(t)
  const f = join(out, 'c.sh')
  const MS = '// <<START [x] (y) .*>>\n'
  const ME = '\n// <<END [x] (y) .*>>'
  writeFileSync(f, seeded('OLD=1', MS, ME))
  const r = await attempt(() => inject(out, 'c.sh', 'NEW=1', { markers: [MS, ME] }))
  const text = read(f)
  show(t, 'I9', r, text)
  assert.match(text, /NEW=1/, 'metacharacters in markers broke matching (unescaped regex?)')
  assert.doesNotMatch(text, /OLD=1/)
})

// =====================================================================
// INFO probes - never fail, only print behaviour
// =====================================================================
test('[I8-INFO] two marker pairs in one file: which are replaced?', async (t) => {
  const { out } = sandbox(t)
  const f = join(out, 'c.sh')
  writeFileSync(f, seeded('A=1') + seeded('B=1'))
  const r = await attempt(() => inject(out, 'c.sh', 'NEW=1'))
  const text = read(f)
  show(t, 'I8', r, text)
  t.diagnostic(`I8 summary: NEW count=${(text.match(/NEW=1/g) || []).length}, A kept=${/A=1/.test(text)}, B kept=${/B=1/.test(text)}`)
})

test('[I10-INFO] a user edit INSIDE the region: lost, and is it reported?', async (t) => {
  const { out } = sandbox(t)
  const f = join(out, 'c.sh')
  writeFileSync(f, seeded('GEN=1\nMINE=2'))
  const r = await attempt(() => inject(out, 'c.sh', 'GEN=2'))
  const text = read(f)
  show(t, 'I10', r, text)
  t.diagnostic(`I10 summary: user line kept=${/MINE=2/.test(text)}`)
})

// =====================================================================
// DISCOVERY2 - where is the injection done, and how is `$$` substituted?
// =====================================================================
function distDir() {
  let d
  try { d = dirname(require.resolve('jostraca')) }
  catch { d = join(process.cwd(), 'node_modules', 'jostraca', 'dist') }
  return existsSync(join(d, 'cmp')) ? d : join(d, 'dist')
}
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n)
  return statSync(p).isDirectory() ? walk(p) : [p]
})

test('[DISCOVERY2] dump injection logic and `$$` handling from dist/', async (t) => {
  const dist = distDir()
  assert.ok(existsSync(dist), 'dist not found: ' + dist)
  const CTX = 14
  const out = [`# dist: ${dist}`]

  for (const p of walk(dist).filter((x) => x.endsWith('.js'))) {
    const rel = p.slice(dist.length + 1).replace(/\\/g, '/')
    if (rel === 'cmp/Inject.js' || rel === 'cmp/Content.js') continue   // dumped elsewhere
    const lines = read(p).split('\n')
    const hits = []
    lines.forEach((l, i) => { if (/inject/i.test(l) || l.includes('$$')) hits.push(i) })
    if (!hits.length) continue

    const ranges = []
    for (const i of hits) {
      const a = Math.max(0, i - CTX)
      const b = Math.min(lines.length - 1, i + CTX)
      const last = ranges[ranges.length - 1]
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b)
      else ranges.push([a, b])
    }
    out.push('', `## ${rel}  (${hits.length} hit lines)`)
    for (const [a, b] of ranges.slice(0, 6)) out.push(`--- lines ${a + 1}-${b + 1}`, ...lines.slice(a, b + 1))
  }

  const c = join(dist, 'cmp', 'Content.js')
  if (existsSync(c)) out.push('', '## cmp/Content.js (full)', read(c))

  const outDir = join(process.cwd(), 'probe-output')
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, 'jostraca-grep-dump.txt')
  writeFileSync(file, out.join('\n'))
  t.diagnostic(`dump written to ${file} (${out.length} lines)`)
})
