// Jostraca weakness probes.
// Each test states a RULE a good re-runnable generator should satisfy.
//   RED   = the rule is violated  -> weakness CONFIRMED
//   GREEN = the rule holds        -> weakness NOT confirmed
// Diagnostics (lines starting with ℹ) show what the library actually did.
//
// Assumptions taken from the tutorial (verify in the reference if a test errors oddly):
//   - generate() resolves to a result object with `files.*` lists
//   - `existing: { txt: {...} }` applies to the files used below (.sh/.json)
//   - the merge base store lives in `.jostraca/` beside the output folder

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync,
  appendFileSync, existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as J from 'jostraca'

const { Jostraca, Project, File, Content, Fragment, Slot } = J

// ---------- helpers ----------
const read = (p) => readFileSync(p, 'utf8')

function sandbox(t) {
  const base = mkdtempSync(join(tmpdir(), 'jprobe-'))
  const out = join(base, 'out')
  mkdirSync(out, { recursive: true })
  t.after(() => rmSync(base, { recursive: true, force: true }))
  return { base, out }
}

// run one generate over `out` with the given Jostraca options and tree body
const gen = (out, opts, body) =>
  Jostraca(opts).generate({ folder: out }, () => { Project({}, body) })

// tree body with a single file
const one = (name, text) => () => File({ name }, () => Content(text))

const M = { write: true, merge: true }
const MERGE = { existing: { txt: M } }

// =====================================================================
// W1 - the default must not destroy user edits
// =====================================================================
test('[W1] default mode keeps a hand-added line on regenerate', async (t) => {
  const { out } = sandbox(t)
  const f = join(out, 'config.sh')
  await gen(out, {}, one('config.sh', 'PORT=8080\n'))
  appendFileSync(f, 'DEBUG=1\n')
  await gen(out, {}, one('config.sh', 'PORT=9090\n'))
  assert.match(read(f), /DEBUG=1/, 'default mode silently deleted the user edit')
})

// =====================================================================
// W2 - enabling `present` alone must not overwrite the file
// =====================================================================
test('[W2] `present: true` alone leaves the file untouched', async (t) => {
  const { out } = sandbox(t)
  const f = join(out, 'config.sh')
  const opts = { existing: { txt: { present: true } } } // note: write NOT set to false
  await gen(out, opts, one('config.sh', 'PORT=8080\n'))
  appendFileSync(f, 'DEBUG=1\n')
  await gen(out, opts, one('config.sh', 'PORT=9090\n'))
  assert.match(read(f), /DEBUG=1/, 'present without write:false overwrote the file')
})

// =====================================================================
// W3 - escaping
// =====================================================================
test('[W3a] model values with quote/newline must not corrupt JSON output', async (t) => {
  const { out } = sandbox(t)
  const model = { service: { name: 'a"b\nc' } }
  try {
    await Jostraca({ model }).generate({ folder: out }, () => {
      Project({}, () => {
        File({ name: 'p.json' }, () => Content('{ "name": "$$service.name$$" }\n'))
      })
    })
  } catch (e) {
    t.diagnostic('generate threw (acceptable, loud): ' + e.message)
    return
  }
  const text = read(join(out, 'p.json'))
  t.diagnostic('output: ' + JSON.stringify(text))
  assert.doesNotThrow(() => JSON.parse(text), 'substitution produced invalid JSON (no escaping)')
})

test('[W3b] library ships some escaping / formatting helper (heuristic)', async (t) => {
  const names = Object.keys(J).sort()
  t.diagnostic('exports: ' + names.join(', '))
  const hits = names.filter((n) => /escape|quote|stringify|format|prettier|hook|post/i.test(n))
  assert.ok(hits.length > 0, 'no export looks like an escape/format/post-process helper')
})

// =====================================================================
// W4 - `$$` collisions and missing paths
// =====================================================================
test('[W4a] literal shell `$$` survives substitution', async (t) => {
  const { out } = sandbox(t)
  const src = 'echo "pid=$$ home=$$HOME"\n'
  await Jostraca({ model: {} }).generate({ folder: out }, () => {
    Project({}, () => File({ name: 'x.sh' }, () => Content(src)))
  })
  assert.equal(read(join(out, 'x.sh')), src, 'literal $$ was altered (look for an escape syntax in the docs)')
})

test('[W4b] a typo in a $$path$$ fails loudly', async (t) => {
  const { out } = sandbox(t)
  let threw = false
  try {
    await Jostraca({ model: { service: { port: 1 } } }).generate({ folder: out }, () => {
      Project({}, () => File({ name: 'c.sh' }, () => Content('PORT=$$service.prot$$\n')))
    })
  } catch { threw = true }
  if (!threw) {
    assert.fail('no error for missing path; output was ' + JSON.stringify(read(join(out, 'c.sh'))))
  }
})

// =====================================================================
// W5 - merge semantics
// =====================================================================
test('[W5a] a merge conflict must not leave invalid JSON behind', async (t) => {
  const { out } = sandbox(t)
  const f = join(out, 'data.json')
  const json = (port) => `{\n  "port": ${port}\n}\n`
  await gen(out, MERGE, one('data.json', json(8080)))
  writeFileSync(f, json(7000))                                  // user edits the same line
  const result = await gen(out, MERGE, one('data.json', json(9090)))
  t.diagnostic('result.files = ' + JSON.stringify(result?.files))
  const text = read(f)
  t.diagnostic('final file: ' + JSON.stringify(text))
  // If the file is simply the 9090 version, merge did not apply to .json:
  // check the `existing` keys in reference-options and extend MERGE.
  assert.doesNotThrow(() => JSON.parse(text), 'conflict markers left the file as invalid JSON')
})

test('[W5b] a route removed from the model does not leave a silent orphan', async (t) => {
  const { out } = sandbox(t)
  await gen(out, {}, () => {
    File({ name: 'a.js' }, () => Content('a\n'))
    File({ name: 'b.js' }, () => Content('b\n'))
  })
  const result = await gen(out, {}, () => {
    File({ name: 'a.js' }, () => Content('a\n'))
  })
  const stale = existsSync(join(out, 'b.js'))
  const reported = JSON.stringify(result?.files ?? {}).includes('b.js')
  t.diagnostic(`stale on disk: ${stale}, mentioned in result: ${reported}`)
  assert.ok(!stale || reported, 'b.js is still on disk and the result does not mention it')
})

test('[W5c] INFO: what happens when the user renames a generated file', async (t) => {
  const { out } = sandbox(t)
  await gen(out, MERGE, one('a.sh', 'A=1\n'))
  writeFileSync(join(out, 'renamed.sh'), read(join(out, 'a.sh')))
  rmSync(join(out, 'a.sh'))
  await gen(out, MERGE, one('a.sh', 'A=2\n'))
  t.diagnostic('a.sh recreated: ' + existsSync(join(out, 'a.sh')) +
    ' | renamed.sh content: ' + JSON.stringify(read(join(out, 'renamed.sh'))))
})

test('[W5d] merge still keeps user edits when the .jostraca base store is missing', async (t) => {
  const { base, out } = sandbox(t)
  const f = join(out, 'config.sh')
  await gen(out, MERGE, one('config.sh', 'PORT=8080\nHOST=localhost\n'))
  appendFileSync(f, 'DEBUG=1\n')
  const stores = [join(base, '.jostraca'), join(out, '.jostraca')].filter(existsSync)
  t.diagnostic('base store: ' + (stores.join(', ') || 'NOT FOUND (adjust path in this test)'))
  for (const s of stores) rmSync(s, { recursive: true, force: true })
  await gen(out, MERGE, one('config.sh', 'PORT=9090\nHOST=localhost\n'))
  assert.match(read(f), /DEBUG=1/, 'with no base store the user edit was lost')
})

// =====================================================================
// W6 - protect marker
// =====================================================================
test('[W6] a protected file skipped by the generator is visible in the result', async (t) => {
  const { out } = sandbox(t)
  const f = join(out, 'x.sh')
  await gen(out, {}, one('x.sh', 'A=1\n'))
  writeFileSync(f, '# JOSTRACA_PROTECT\nMINE=1\n')
  const result = await gen(out, {}, one('x.sh', 'A=2\n'))
  assert.match(read(f), /MINE=1/, 'control failed: the marker did not protect the file')
  t.diagnostic('result = ' + JSON.stringify(result?.files))
  assert.ok(JSON.stringify(result ?? {}).includes('x.sh'), 'protected file was skipped silently')
})

// =====================================================================
// W7 - ambient context
// =====================================================================
test('[W7a] async work inside the tree either works or errors (never vanishes)', async (t) => {
  const { out } = sandbox(t)
  let err
  try {
    await Jostraca().generate({ folder: out }, () => {
      Project({}, async () => {
        await new Promise((r) => setTimeout(r, 10))
        File({ name: 'late.txt' }, () => Content('x\n'))
      })
    })
  } catch (e) { err = e }
  if (err) { t.diagnostic('threw: ' + err.message); return }
  assert.ok(existsSync(join(out, 'late.txt')), 'async work silently dropped: no error, no file')
})

test('[W7b] calling a component outside generate() throws an explicit error', () => {
  assert.throws(() => Content('x'), 'Content() outside generate() did not throw')
})

// =====================================================================
// W8 - templates
// =====================================================================
test('[W8a] Fragment path resolution does not depend on output folder depth', async (t) => {
  const { base } = sandbox(t)
  mkdirSync(join(base, 'tpl'), { recursive: true })
  writeFileSync(join(base, 'tpl', 't.html'), '<body>\n  <[SLOT]>\n</body>\n')
  const build = (out) => gen(out, {}, () => {
    File({ name: 'i.html' }, () => {
      Fragment({ from: '../tpl/t.html' }, () => { Content('hi') })
    })
  })
  await build(join(base, 'out'))              // the tutorial's layout
  await build(join(base, 'a', 'b', 'out'))    // same code, deeper output folder
})

test('[W8b] slot replacement inherits the marker indentation', async (t) => {
  const { base, out } = sandbox(t)
  mkdirSync(join(base, 'tpl'), { recursive: true })
  writeFileSync(join(base, 'tpl', 'u.html'), '<ul>\n  <[SLOT]>\n</ul>\n')
  await gen(out, {}, () => {
    File({ name: 'u.html' }, () => {
      Fragment({ from: '../tpl/u.html' }, () => { Content('<li>a</li>\n<li>b</li>') })
    })
  })
  const text = read(join(out, 'u.html'))
  t.diagnostic('output: ' + JSON.stringify(text))
  assert.ok(text.includes('  <li>a</li>\n  <li>b</li>'), 'replacement starts at column 0')
})

// =====================================================================
// W9 - determinism / line endings
// =====================================================================
test('[W9a] two identical merge runs are a no-op with no conflicts', async (t) => {
  const { out } = sandbox(t)
  const f = join(out, 'a.sh')
  await gen(out, MERGE, one('a.sh', 'A=1\nB=2\n'))
  const before = read(f)
  const result = await gen(out, MERGE, one('a.sh', 'A=1\nB=2\n'))
  assert.equal(read(f), before, 'identical re-run changed the file')
  assert.deepEqual(result?.files?.conflicted ?? [], [], 'identical re-run reported conflicts')
})

test('[W9b] CRLF conversion by the editor does not break merge', async (t) => {
  const { out } = sandbox(t)
  const f = join(out, 'c.sh')
  await gen(out, MERGE, one('c.sh', 'PORT=8080\nHOST=localhost\n'))
  writeFileSync(f, read(f).replace(/\n/g, '\r\n'))   // e.g. git autocrlf on Windows
  await gen(out, MERGE, one('c.sh', 'PORT=9090\nHOST=localhost\n'))
  const text = read(f)
  t.diagnostic('final: ' + JSON.stringify(text))
  assert.ok(!text.includes('<<<<<<<'), 'CRLF-only change produced conflict markers')
  assert.match(text, /PORT=9090/, 'generator change was lost')
})
