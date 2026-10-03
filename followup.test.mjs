// Follow-up probes for Jostraca. Same convention as weaknesses.test.mjs:
//   RED = rule violated (weakness confirmed), GREEN = rule holds.
// Put this file next to weaknesses.test.mjs and run:  node followup.test.mjs
//
// Tests:
//   [W4c]  $$ behaviour matrix       -> isolates WHY `$$` text gets altered
//   [W5d2] lost base store           -> is the silent downgrade at least reported?
//   [W7c]  async matrix              -> which async positions silently drop output
//   [DISCOVERY] dump of dist/cmp     -> source of Inject/Copy/CopyFiles for the next round

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync,
  appendFileSync, existsSync, readdirSync, statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as J from 'jostraca'

const { Jostraca, Project, File, Content, cmp, each } = J
const require = createRequire(import.meta.url)

// ---------- helpers ----------
const read = (p) => readFileSync(p, 'utf8')
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
const firstLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 140)

function sandbox(t) {
  const base = mkdtempSync(join(tmpdir(), 'jprobe-'))
  const out = join(base, 'out')
  mkdirSync(out, { recursive: true })
  t.after(() => rmSync(base, { recursive: true, force: true }))
  return { base, out }
}

const gen = (out, opts, body) =>
  Jostraca(opts).generate({ folder: out }, () => { Project({}, body) })
const one = (name, text) => () => File({ name }, () => Content(text))
const MERGE = { existing: { txt: { write: true, merge: true } } }

// =====================================================================
// W7c support - async matrix. It runs in a CHILD PROCESS because node:test
// intercepts unhandled rejections and would abort the table half-way.
// (When this file is started with JPROBE_ASYNC_CHILD=1 it only runs the matrix.)
// =====================================================================
const MARK = '@@ROWS@@'
const AsyncCmp = cmp(async function AsyncCmp() { await tick(); Content('x\n') })
const SyncCmp = cmp(function SyncCmp() { Content('x\n') })
const g = (out, body) => Jostraca().generate({ folder: out }, body)

const VARIANTS = {
  'sync (control)': (out) =>
    g(out, () => { Project({}, () => File({ name: 'f.txt' }, () => { Content('x\n') })) }),
  'sync cmp (control)': (out) =>
    g(out, () => { Project({}, () => File({ name: 'f.txt' }, () => { SyncCmp() })) }),
  'data precomputed (workaround)': async (out) => {
    const data = await Promise.resolve('x\n')            // await BEFORE generate
    return g(out, () => { Project({}, () => File({ name: 'f.txt' }, () => { Content(data) })) })
  },
  'async Project cb': (out) =>
    g(out, () => {
      Project({}, async () => { await tick(); File({ name: 'f.txt' }, () => { Content('x\n') }) })
    }),
  'async File cb': (out) =>
    g(out, () => {
      Project({}, () => File({ name: 'f.txt' }, async () => { await tick(); Content('x\n') }))
    }),
  'async cmp': (out) =>
    g(out, () => { Project({}, () => File({ name: 'f.txt' }, () => { AsyncCmp() })) }),
  'async each cb': (out) =>
    g(out, () => {
      Project({}, () => each([1], async () => { await tick(); File({ name: 'f.txt' }, () => { Content('x\n') }) }))
    }),
  'async outer cb': (out) =>
    Jostraca().generate({ folder: out }, async () => {
      await tick()
      Project({}, () => File({ name: 'f.txt' }, () => { Content('x\n') }))
    }),
}

async function runAsyncMatrix(base) {
  let late = []
  process.on('unhandledRejection', (e) => late.push(firstLine(e)))
  process.on('uncaughtException', (e) => late.push(firstLine(e)))

  const rows = []
  let i = 0
  for (const [name, build] of Object.entries(VARIANTS)) {
    const out = join(base, 'v' + i++)
    mkdirSync(out, { recursive: true })
    late = []
    let err
    try { await build(out) } catch (e) { err = e }
    await tick(40)                                       // let late work surface

    const f = join(out, 'f.txt')
    const got = existsSync(f) ? read(f) : null
    const ok = got !== null && got.includes('x')
    const loud = Boolean(err) || late.length > 0
    rows.push({
      name, got, err: err ? firstLine(err) : null, late: [...late],
      verdict: ok ? 'OK' : loud ? 'LOUD' : 'SILENT-DROP',
    })
  }
  return rows
}

if (process.env.JPROBE_ASYNC_CHILD) {
  const base = mkdtempSync(join(tmpdir(), 'jprobe-async-'))
  try {
    const rows = await runAsyncMatrix(base)
    console.log(MARK + JSON.stringify(rows))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
  process.exit(0)
}

// =====================================================================
// W4c - matrix: which (model, content) combinations alter literal `$$`
// =====================================================================
const MODELS = {
  none: undefined,                       // Jostraca() with no model at all
  empty: {},                             // Jostraca({ model: {} })
  svc: { service: { port: 1 } },         // a model with some data
}
const CASES = {
  'dollar-only': 'echo $$\n',
  'dollar-var': 'echo $$HOME\n',
  'two-pairs': 'pid=$$ home=$$HOME\n',
  'three-empty': 'a=$$ b=$$ c=$$\n',
  'typo': 'PORT=$$service.prot$$\n',     // should fail loudly
  'valid': 'PORT=$$service.port$$\n',    // control: only meaningful with `svc`
}

async function cell(base, label, model, text) {
  const out = join(base, label)
  mkdirSync(out, { recursive: true })
  try {
    await Jostraca(model === undefined ? {} : { model }).generate({ folder: out }, () => {
      Project({}, () => File({ name: 'x.sh' }, () => Content(text)))
    })
    return { out: read(join(out, 'x.sh')) }
  } catch (e) {
    return { err: firstLine(e) }
  }
}

test('[W4c] literal `$$` is preserved for every model/content combination', async (t) => {
  const { base } = sandbox(t)
  const violations = []

  for (const [mName, model] of Object.entries(MODELS)) {
    for (const [cName, text] of Object.entries(CASES)) {
      const r = await cell(base, `${mName}-${cName}`, model, text)
      const shown = r.err ? 'THROW ' + r.err : JSON.stringify(r.out)
      t.diagnostic(`${mName.padEnd(5)} | ${cName.padEnd(11)} | ${shown}`)

      if (cName === 'valid') {
        if (mName === 'svc' && r.out !== 'PORT=1\n') violations.push('HARNESS: valid control gave ' + shown)
      } else if (cName === 'typo') {
        if (!r.err) violations.push(`${mName}/typo: no error, output ${shown}`)
      } else if (r.err || r.out !== text) {
        violations.push(`${mName}/${cName}: ${JSON.stringify(text)} -> ${shown}`)
      }
    }
  }
  assert.ok(violations.length === 0, 'violations:\n' + violations.join('\n'))
})

// =====================================================================
// W5d2 - lost base store: kept, or at least flagged?
// =====================================================================
const L1 = 'PORT=8080\nHOST=localhost\n'
const L2 = 'PORT=9090\nHOST=localhost\n'

// names of the result.files lists that mention config.sh
const listsFor = (files) =>
  Object.entries(files ?? {})
    .filter(([, v]) => Array.isArray(v) && v.some((p) => String(p).endsWith('config.sh')))
    .map(([k]) => k)

async function lostBaseScenario(t, dropBase) {
  const { out } = sandbox(t)
  const f = join(out, 'config.sh')
  await gen(out, MERGE, one('config.sh', L1))
  appendFileSync(f, 'DEBUG=1\n')
  const storeBefore = existsSync(join(out, '.jostraca'))
  if (dropBase) rmSync(join(out, '.jostraca'), { recursive: true, force: true })
  const result = await gen(out, MERGE, one('config.sh', L2))
  return {
    text: read(f),
    lists: listsFor(result?.files),
    storeBefore,
    storeAfter: existsSync(join(out, '.jostraca')),
  }
}

test('[W5d2] without a base store the lost user edit is at least reported', async (t) => {
  const control = await lostBaseScenario(t, false)
  t.diagnostic('control (base kept):  ' + JSON.stringify(control))
  assert.match(control.text, /DEBUG=1/, 'HARNESS: merge with base present should keep the edit')

  const lost = await lostBaseScenario(t, true)
  t.diagnostic('base store dropped:   ' + JSON.stringify(lost))

  const kept = /DEBUG=1/.test(lost.text)
  const flagged = lost.lists.includes('conflicted') || lost.lists.includes('presented')
  assert.ok(
    kept || flagged,
    `user edit lost AND not flagged; config.sh appears in result lists: [${lost.lists.join(', ')}]`,
  )
})

// =====================================================================
// W7c - async matrix (rows come from the child process above)
// =====================================================================
const CONTROLS = new Set(['sync (control)', 'sync cmp (control)', 'data precomputed (workaround)'])

test('[W7c] no async position silently drops output', async (t) => {
  const env = { ...process.env, JPROBE_ASYNC_CHILD: '1' }
  delete env.NODE_TEST_CONTEXT                           // do not inherit the test-runner mode
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env, encoding: 'utf8', timeout: 60000,
  })
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith(MARK))
  assert.ok(line, 'child process produced no result.\nstderr: ' + (r.stderr ?? '').slice(0, 800))
  const rows = JSON.parse(line.slice(MARK.length))

  const problems = []
  for (const row of rows) {
    t.diagnostic(
      `${row.name.padEnd(30)} | ${row.verdict.padEnd(11)} | file=${row.got === null ? 'absent' : JSON.stringify(row.got)}` +
      ` | err=${row.err ?? '-'} | late=${row.late.join(' ; ') || '-'}`,
    )
    if (CONTROLS.has(row.name) && row.verdict !== 'OK') problems.push(`HARNESS: control "${row.name}" did not produce its file`)
    if (row.verdict === 'SILENT-DROP') problems.push(`"${row.name}": output dropped with no error`)
  }
  assert.ok(problems.length === 0, 'problems:\n' + problems.join('\n'))
})

// =====================================================================
// DISCOVERY - dump the component sources so Inject can be tested for real
// =====================================================================
test('[DISCOVERY] dump dist/cmp sources (Inject, Copy, CopyFiles)', async (t) => {
  let dist
  try { dist = dirname(require.resolve('jostraca')) }
  catch { dist = join(process.cwd(), 'node_modules', 'jostraca', 'dist') }
  const cmpDir = [join(dist, 'cmp'), join(dist, 'dist', 'cmp')].find(existsSync)
  assert.ok(cmpDir, 'could not find jostraca dist/cmp near ' + dist)

  const lines = [`# jostraca cmp dir: ${cmpDir}`, '', '## files']
  for (const n of readdirSync(cmpDir).sort()) lines.push(`${n}  (${statSync(join(cmpDir, n)).size} bytes)`)

  for (const name of ['Inject', 'Copy', 'CopyFiles']) {
    for (const ext of ['.d.ts', '.js']) {
      const p = join(cmpDir, name + ext)
      if (!existsSync(p)) continue
      lines.push('', `## ${name}${ext}`, read(p))
    }
  }

  const outDir = join(process.cwd(), 'probe-output')
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, 'jostraca-cmp-dump.txt')
  writeFileSync(outFile, lines.join('\n'))
  t.diagnostic('dump written to: ' + outFile)
  console.log(lines.join('\n').split('\n').slice(0, 120).join('\n'))
})
