// Black-box regression tests for argument parsing. They drive the built CLI
// (dist/index.js) exactly the way a shell would, with the CDP endpoint pointed
// at a closed port so nothing can reach a real Chrome. A command that parses
// correctly therefore dies trying to connect; a command that mis-parses dies
// earlier, in the parser. The assertions tell those two deaths apart.
//
// History: every value containing a whitespace-delimited token that begins
// with `--` (a `---` markdown rule, prose mentioning `--force`) was rejected
// with "Positional argument 'value' is required". The tokenizer classified any
// argv element CONTAINING `--` anywhere as a long option. See src/core/argv.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')
const DEAD_ENDPOINT = 'http://127.0.0.1:1'

function run(...argv) {
  const r = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, BROWSER_AUTOMATION_CDP: DEAD_ENDPOINT, NO_COLOR: '1' },
  })
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr }
}

/** The command got past the parser: it failed only because there is no Chrome. */
function assertReachedChrome(r, label) {
  assert.doesNotMatch(r.all, /Positional argument .* is required/, `${label}: parser rejected the arguments:\n${r.all}`)
  assert.doesNotMatch(r.all, /is not an option/, `${label}: parser rejected a token:\n${r.all}`)
  assert.equal(r.code, 1, `${label}: expected exit 1 from the connection failure, got ${r.code}:\n${r.all}`)
  assert.match(r.all, /127\.0\.0\.1:1|fetch failed|ECONNREFUSED/, `${label}: expected a connection failure, got:\n${r.all}`)
}

const VALUES_WITH_DOUBLE_DASH = [
  'pass the --force flag here',
  'we use --native for this',
  'alpha -- beta',
  'alpha\n---\nbeta',
  'foo--bar',
  '--- \n# Title\n---',
]

for (const value of VALUES_WITH_DOUBLE_DASH) {
  test(`fill accepts a value containing ${JSON.stringify(value)}`, () => {
    assertReachedChrome(run('fill', '-t', 'deadbeef', '--native', 'e3', value), 'fill')
  })
}

test('eval accepts an expression containing --', () => {
  assertReachedChrome(run('eval', '-t', 'deadbeef', 'x--; y --'), 'eval')
})

test('goto accepts a URL containing --', () => {
  assertReachedChrome(run('goto', '-t', 'deadbeef', 'https://example.test/?q=--force&r=a--b'), 'goto')
})

test('new accepts a URL containing --', () => {
  assertReachedChrome(run('new', 'https://example.test/a--b'), 'new')
})

test('POSIX -- ends option parsing: a value that starts with -- is accepted after it', () => {
  assertReachedChrome(run('fill', '-t', 'deadbeef', '--native', '--', 'e3', '--force'), 'fill --')
})

test('POSIX --: a value that starts with a single dash is accepted after it', () => {
  assertReachedChrome(run('fill', '-t', 'deadbeef', '--', 'e3', '-5'), 'fill -- -5')
})

test('options may follow the positionals', () => {
  assertReachedChrome(run('fill', 'e3', 'hello --world', '--native', '-t', 'deadbeef'), 'trailing options')
})

test('a value that STARTS with -- and is not an option is named in the error', () => {
  const r = run('fill', '-t', 'deadbeef', 'e3', '--force')
  assert.equal(r.code, 1, `expected exit 1:\n${r.all}`)
  assert.match(r.all, /'--force'/, `error must name the rejected token:\n${r.all}`)
  assert.match(r.all, /--/, 'error must mention the -- separator')
  assert.doesNotMatch(r.all, /Positional argument .* is required/, 'must not blame the positional')
})

test('an unknown short option is named in the error', () => {
  const r = run('fill', '-t', 'deadbeef', '-Z', 'e3', 'v')
  assert.equal(r.code, 1, `expected exit 1:\n${r.all}`)
  assert.match(r.all, /'-Z'/, `error must name the rejected token:\n${r.all}`)
})

test('a genuinely missing positional still exits non-zero', () => {
  const r = run('fill', '-t', 'deadbeef', 'e3')
  assert.equal(r.code, 1, `expected exit 1:\n${r.all}`)
  assert.match(r.all, /value/)
})

test('a string option that is given no value is reported', () => {
  const r = run('fill', 'e3', 'v', '-t')
  assert.equal(r.code, 1, `expected exit 1:\n${r.all}`)
  assert.match(r.all, /'-t'/, `error must name the option:\n${r.all}`)
})

test('--help still renders usage and exits 0', () => {
  const r = run('fill', '--help')
  assert.equal(r.code, 0, r.all)
  assert.match(r.all, /--native/)
})

test('-h still renders usage and exits 0', () => {
  const r = run('fill', '-h')
  assert.equal(r.code, 0, r.all)
  assert.match(r.all, /--native/)
})

test('--version still prints the version and exits 0', () => {
  const r = run('--version')
  assert.equal(r.code, 0, r.all)
  assert.match(r.out, /^\d+\.\d+\.\d+/)
})

test('port still answers without touching Chrome', () => {
  const r = run('port')
  assert.equal(r.code, 0, r.all)
  assert.match(r.out, /^\d+\s*$/)
})

// Elements that begin with a dash but cannot be an option under any schema
// are values without needing `--` first: a brief's leading `---` frontmatter
// rule, a list item, a lone `-`.
for (const value of ['---', '--- \n# Title\n---', '- item one\n- item two', '-']) {
  test(`fill accepts a leading-dash value that is not option-shaped: ${JSON.stringify(value)}`, () => {
    assertReachedChrome(run('fill', '-t', 'deadbeef', 'e3', value), 'leading dash')
  })
}

test('a string option takes the next element as its value even when it starts with --', () => {
  assertReachedChrome(run('snapshot', '-m', '--weird-title'), 'option value starting with --')
})
