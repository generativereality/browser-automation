// POSIX argument pre-parser. Runs on the raw argv BEFORE gunshi sees it.
//
// Why this exists: gunshi's tokenizer (args-tokens ≤ 0.17) decides that an
// argv element is a long option when it CONTAINS `--` anywhere — not when it
// starts with it. So `fill e3 "pass the --force flag"` turned the value into an
// option named `ss the --force flag`, silently dropped it as unknown, and then
// complained "Positional argument 'value' is required". Every markdown brief
// (which contains a `---` rule) was unsendable. Upstream fixed the classifier
// in args-tokens 0.28, but even there the POSIX `--` terminator routes what
// follows into `rest`, never into `positionals`, so declared positionals stay
// "required". Neither behaviour is acceptable for a tool whose job is typing
// arbitrary text into pages, and neither should depend on a library's release
// cadence.
//
// The contract, which is plain POSIX:
//   • An argv element is an option only if it BEGINS with `-` and is shaped
//     like one (`--name`, `-x`). The shell already delimited it; nothing
//     inside an element is ever re-split, so `---` and `a --b` are values.
//   • `--` on its own ends option parsing. Everything after it is positional,
//     even `--force` or `-5`.
//   • A non-boolean option takes the NEXT element as its value, whatever it
//     looks like (`-m --weird` matches a tab titled "--weird").
//   • An element that starts with `-` and is not a declared option is an
//     error that names the element and says how to pass it as a value.
//
// What gunshi then receives is a canonical argv it cannot misread: the
// subcommand, every option as `--long` or `--long=value` (the inline form is
// split at the first `=`, so the value may contain anything), and one
// placeholder per positional. Placeholders contain a NUL byte, which no argv
// element can (they are C strings), so they cannot collide with user text.
// `restorePositionals` swaps the real values back in — see commands/index.ts.

export interface ArgSpec {
  type: 'string' | 'boolean' | 'number' | 'enum' | 'positional'
  short?: string
}

export interface Canonical {
  /** What to hand gunshi: [sub, ...options, ...placeholders]. */
  argv: string[]
  /** The real positionals, in order, keyed by placeholder index. */
  positionals: string[]
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

// gunshi adds these to every command; they must pass through as booleans.
const COMMON: Record<string, ArgSpec> = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
}

const PLACEHOLDER_PREFIX = '\u0000positional:'

export function placeholder(i: number): string {
  return `${PLACEHOLDER_PREFIX}${i}`
}

/** Map gunshi's positionals (which contain placeholders) back to the real values. */
export function restorePositionals(positionals: readonly string[], real: readonly string[]): string[] {
  return positionals.map((p) => {
    if (!p.startsWith(PLACEHOLDER_PREFIX)) return p
    const i = Number(p.slice(PLACEHOLDER_PREFIX.length))
    return real[i] ?? p
  })
}

// An option is `--name`, `--name=value`, or `-x…`, and a name starts with a
// letter or digit. `---`, `--- \n# Title`, `- item`, `-` cannot be options
// under any schema, so they are positionals without needing `--` first. An
// option-SHAPED element that is not declared (`--force`, `-5`) is an error,
// because it is far more often a typo than a value.
function isOptionShaped(arg: string): boolean {
  return /^--?[A-Za-z0-9]/.test(arg)
}

function separatorHint(sub: string, positionals: string[], token: string): string {
  const example = [...positionals, token].map((p) => `'${p}'`).join(' ')
  return `To pass it as a value, put '--' before the positionals: browser-automation ${sub} [options] -- ${example}`
}

/**
 * Canonicalise everything after the subcommand.
 *
 * @param sub    the subcommand name (argv[0])
 * @param rest   argv after the subcommand
 * @param schema the command's declared args (gunshi's `args` table)
 */
export function canonicalize(sub: string, rest: readonly string[], schema: Record<string, ArgSpec>): Canonical {
  const specs: Record<string, ArgSpec> = { ...COMMON, ...schema }
  const byShort = new Map<string, string>()
  for (const [name, spec] of Object.entries(specs)) if (spec.short) byShort.set(spec.short, name)

  const options: string[] = []
  const positionals: string[] = []

  const unknown = (token: string): never => {
    throw new UsageError(`'${token}' is not an option of '${sub}'. ${separatorHint(sub, positionals, token)}`)
  }

  const takesValue = (name: string): boolean => specs[name].type !== 'boolean'

  let i = 0
  let terminated = false
  while (i < rest.length) {
    const arg = rest[i++]

    if (!terminated && arg === '--') {
      terminated = true
      continue
    }

    if (terminated || !isOptionShaped(arg)) {
      positionals.push(arg)
      continue
    }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      if (!(name in specs) || specs[name].type === 'positional') return unknown(arg)
      if (!takesValue(name)) {
        if (eq !== -1) throw new UsageError(`'--${name}' is a flag and takes no value (got '${arg}')`)
        options.push(`--${name}`)
        continue
      }
      let value: string
      if (eq !== -1) value = arg.slice(eq + 1)
      else if (i < rest.length) value = rest[i++]
      else throw new UsageError(`'${arg}' needs a value`)
      options.push(`--${name}=${value}`)
      continue
    }

    // Short option or group: -t <v>, -tVALUE, -t=VALUE, -abc (booleans), -abt <v>.
    let j = 1
    while (j < arg.length) {
      const short = arg[j++]
      const name = byShort.get(short)
      if (!name) return unknown(`-${short}`)
      if (!takesValue(name)) {
        options.push(`--${name}`)
        continue
      }
      let remainder = arg.slice(j)
      if (remainder.startsWith('=')) remainder = remainder.slice(1)
      let value: string
      if (remainder.length > 0) value = remainder
      else if (i < rest.length) value = rest[i++]
      else throw new UsageError(`'-${short}' needs a value`)
      options.push(`--${name}=${value}`)
      break
    }
  }

  return {
    argv: [sub, ...options, ...positionals.map((_, k) => placeholder(k))],
    positionals,
  }
}
