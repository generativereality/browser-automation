// Shared "which tab?" selector flags, used by every page command. A tab can be
// addressed three ways (precedence: target > match > session):
//   -t <targetId>   exact CDP target
//   -m <substr>     any open tab whose URL or title contains substr
//   -s <name>       a saved session bookmark (see core/session.ts)
// Sessions are just named pointers — not an exclusive lock. You can always drive
// any tab on demand with -m/-t without ever creating a session.

export const targetArgs = {
  session: { type: 'string', short: 's', description: 'Saved session name (default: $BAC_SESSION or "default")' },
  match: { type: 'string', short: 'm', description: 'Target an existing tab whose URL or title contains this substring' },
  target: { type: 'string', short: 't', description: 'Target an exact tab by CDP targetId' },
  first: { type: 'boolean', description: 'If --match is ambiguous, use the first match instead of erroring' },
} as const

export interface TargetOpts {
  session?: string
  match?: string
  target?: string
  first?: boolean
}

export function targetOpts(values: Record<string, unknown>): TargetOpts {
  return {
    session: values.session as string | undefined,
    match: values.match as string | undefined,
    target: values.target as string | undefined,
    first: values.first as boolean | undefined,
  }
}
