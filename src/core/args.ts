// Shared "which tab?" selector flags, used by every page command. A tab can be
// addressed three ways (precedence: target > match > session):
//   -t <targetId>   exact CDP target
//   -m <substr>     any open tab whose URL or title contains substr
//   -s <name>       a saved session bookmark (see core/session.ts)
// Sessions are just named pointers — not an exclusive lock. You can always drive
// any tab on demand with -m/-t without ever creating a session.
//
// A fourth, orthogonal selector descends INTO a tab:
//   -F <substr>     a cross-origin child iframe (OOPIF) whose URL/title contains
//                   substr. OOPIFs are their own CDP targets, so every page
//                   command works inside them (Stripe Elements, embedded SSO
//                   widgets, cross-origin captchas). Same-origin frames are part
//                   of the parent target and need no -F.

export const targetArgs = {
  session: { type: 'string', short: 's', description: 'Saved session name (default: $BAC_SESSION or "default")' },
  match: { type: 'string', short: 'm', description: 'Target an existing tab whose URL or title contains this substring' },
  target: { type: 'string', short: 't', description: 'Target an exact tab by CDP targetId' },
  first: { type: 'boolean', description: 'If --match (or --frame) is ambiguous, use the first match instead of erroring' },
  frame: {
    type: 'string',
    short: 'F',
    description:
      'Descend into a CROSS-ORIGIN child iframe (OOPIF) whose URL or title contains this substring, and run the command against that frame instead of the page (e.g. -F js.stripe.com to fill Stripe Elements). Out-of-process iframes are first-class CDP targets, so snapshot/click/fill/read/eval all work inside them. Same-origin iframes are NOT separate targets — already reachable from the parent page, no -F needed. Discover frames with `list --frames`. An ambiguous substring errors (use a more distinctive substring, an exact `-t <iframeTargetId>`, or --first).',
  },
} as const

export interface TargetOpts {
  session?: string
  match?: string
  target?: string
  first?: boolean
  frame?: string
}

export function targetOpts(values: Record<string, unknown>): TargetOpts {
  return {
    session: values.session as string | undefined,
    match: values.match as string | undefined,
    target: values.target as string | undefined,
    first: values.first as boolean | undefined,
    frame: values.frame as string | undefined,
  }
}
