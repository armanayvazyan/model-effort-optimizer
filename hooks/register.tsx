import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { Effort, Notice, Route, Tier } from '../types'

const ID = 'model-effort-optimizer'
const NOTICE = { plugin: 'model-effort-optimizer', key: 'notice' } as const
const PINNED = { plugin: 'model-effort-optimizer', key: 'pinned' } as const

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable']
const TIER_LABEL: Record<Tier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }

/** Model the classifier itself runs on: cheap and fast, it runs once per prompt. */
const CLASSIFIER_MODEL = 'claude-haiku-5-5'
const NOTICE_TTL_MS = 12_000
const COLOR = { accent: '#7c6cf0', ok: '#16a34a' }

type Mode = 'ask' | 'auto' | 'off'
type Verdict = Route & { reason: string }
type Now = { tier: Tier | ''; effort: Effort | '' }

/**
 * Per-session runtime. Module variables reset when the mod reloads;
 * anything a drawing needs lives in $.state instead.
 */
const rt = {
  mode: 'ask' as Mode,
  /** Bumped per prompt; a classification for an older prompt is discarded. */
  promptSeq: 0,
  noticeSeq: 0,
  /** The prompt waiting to be classified on its turn's first request. */
  pending: null as { text: string; seq: number } | null,
  /** Raw model/effort the engine put on the latest main-chat request. */
  rawModel: '',
  rawEffort: '',
  /** The pinned route, plus the picker values when it was pinned: a picker change unpins. */
  pin: null as (Route & { atModel: string; atEffort: string }) | null,
}

const fmt = (r: Route) => `${TIER_LABEL[r.tier]} · ${r.effort}`

function toTier(v: unknown): Tier | '' {
  if (typeof v !== 'string') return ''
  const s = v.toLowerCase()
  return TIERS.find(t => s.includes(t)) ?? ''
}

function toEffort(v: unknown): Effort | '' {
  if (typeof v !== 'string') return ''
  const s = v.toLowerCase().replace(/[^a-z]/g, '')
  const e = s === 'extrahigh' ? 'xhigh' : s
  return (EFFORTS as readonly string[]).includes(e) ? (e as Effort) : ''
}

function now(): Now {
  return { tier: rt.pin?.tier ?? toTier(rt.rawModel), effort: rt.pin?.effort ?? toEffort(rt.rawEffort) }
}

function repaint($: EngineInterface) {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // Next state write repaints anyway.
  }
}

async function pin($: EngineInterface, r: Route) {
  rt.pin = { ...r, atModel: rt.rawModel, atEffort: rt.rawEffort }
  await $.state.set(PINNED, { tier: r.tier, effort: r.effort })
  repaint($)
}

async function unpin($: EngineInterface) {
  rt.pin = null
  if ((await $.state.get(PINNED)).value) {
    await $.state.set(PINNED, null)
    repaint($)
  }
}

async function notify($: EngineInterface, v: Verdict, before: Now) {
  const id = ++rt.noticeSeq
  const previous = before.tier ? `${TIER_LABEL[before.tier]}${before.effort ? ` · ${before.effort}` : ''}` : ''
  await $.state.set(NOTICE, { id, route: { tier: v.tier, effort: v.effort }, previous, reason: v.reason })
  void (async () => {
    await $.clock.sleep(NOTICE_TTL_MS)
    const { value } = await $.state.get(NOTICE)
    if (value?.id === id) await $.state.set(NOTICE, null)
  })().catch(() => undefined)
}

function lastReply(messages: readonly SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.text.trim()) return m.text.slice(0, 500)
  }
  return ''
}

export function classifierPrompt(request: string, context: string, current: Now): string {
  return `Route a request to a coding assistant. Choose a model tier and an effort level.

Model tiers, cheapest to strongest:
| tier   | use for |
| haiku  | lookups, one-liners, renames, formatting, shell one-offs, small talk |
| sonnet | routine coding, edits in a few files, tests, docs, debugging a clear error |
| opus   | design decisions, unclear bugs, wide refactors, security, concurrency, risky reviews |
| fable  | the rare hardest case: long unattended builds, deep research, many-tradeoff system design, bugs that resisted opus |

Effort levels (how long the assistant deliberates and verifies):
- low: quick or conversational; the user will iterate
- medium: the default when nothing below applies
- high: correctness matters; analysis, review, verification
- xhigh: long, critical work handed off with no one around to answer questions
- max: only when the request explicitly demands the deepest possible effort

Rules: pick the cheapest tier that will do the job well. A long task is not automatically a hard one.
If the request is just an approval or continuation ("ok", "go on", "yes do it", "option 2"), answer "keep" for both.

Currently: tier=${current.tier || 'unknown'} effort=${current.effort || 'unknown'}

Previous assistant reply (truncated):
"""
${context || '(none)'}
"""

Request:
"""
${request}
"""

Respond with only JSON: {"tier":"haiku|sonnet|opus|fable|keep","effort":"low|medium|high|xhigh|max|keep","reason":"<= 10 words"}`
}

export function parseVerdict(raw: string, current: Now): Verdict | null {
  const json = /\{[\s\S]*\}/.exec(raw)?.[0]
  if (!json) return null
  try {
    const o = JSON.parse(json) as Record<string, unknown>
    const tier = toTier(o.tier) || current.tier
    const effort = toEffort(o.effort) || current.effort
    if (!tier || !effort) return null
    const reason = typeof o.reason === 'string' ? o.reason.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
    return { tier, effort, reason }
  } catch {
    return null
  }
}

async function classify($: EngineInterface, text: string, current: Now): Promise<Verdict | null> {
  try {
    await $.ui.status('routing…')
  } catch {
    // Optional.
  }
  try {
    const context = lastReply(await $.session.messages())
    const r = await $.model.complete({
      model: CLASSIFIER_MODEL,
      prompt: classifierPrompt(text.slice(0, 4000), context, current),
      maxTokens: 120,
      timeoutMs: 15_000,
    })
    return r.isAnswered ? parseVerdict(r.text, current) : null
  } finally {
    try {
      await $.ui.status(undefined)
    } catch {
      // Optional.
    }
  }
}

/** Runs on the turn's first request: classify, then pin (auto) or ask first (ask). */
async function route($: EngineInterface, text: string, seq: number) {
  const before = now()
  const v = await classify($, text, before)
  if (!v || seq !== rt.promptSeq) return
  if (v.tier === before.tier && v.effort === before.effort) return
  if (rt.mode === 'ask') {
    const yes = `Use ${fmt(v)}`
    const always = `Use ${fmt(v)} and stop asking`
    let choice = ''
    try {
      choice = await $.ui.ask(`Route this prompt to ${fmt(v)}?${v.reason ? ` (${v.reason})` : ''}`, {
        header: 'Router',
        options: [yes, always, 'No, keep current'],
      })
    } catch {
      return
    }
    if (choice === always) {
      rt.mode = 'auto'
      await $.store.set('mode', 'auto')
    } else if (choice !== yes) return
  }
  await pin($, v)
  await notify($, v, before)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: ID,
      description: 'Route each prompt to a model + effort. ask | auto | off | reset',
      argumentHint: '[ask|auto|off|reset]',
    })
    const stored = await $.store.get('mode')
    rt.mode = stored === 'auto' || stored === 'off' ? stored : 'ask'
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (rt.mode === 'off') return next(e)
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    const text = e.text.trim()
    if (text && !text.startsWith('/')) rt.pending = { text, seq: ++rt.promptSeq }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    // Subagents keep whatever their spawner chose.
    if (e.agentId !== undefined) return yield* next(e)
    rt.rawModel = e.model
    rt.rawEffort = typeof e.effort === 'string' ? e.effort : ''
    // A manual picker change (or a stale pin from a previous load) hands control back.
    if (!rt.pin || rt.pin.atModel !== rt.rawModel || rt.pin.atEffort !== rt.rawEffort) await unpin($)

    if (rt.mode !== 'off' && rt.pending && e.index === 0) {
      const p = rt.pending
      rt.pending = null
      await route($, p.text, p.seq).catch(() => undefined)
    }

    const p = rt.pin
    if (rt.mode === 'off' || !p) return yield* next(e)
    const model = toTier(e.model) === p.tier ? e.model : p.tier
    // A model that takes no effort is sent none.
    const effort = typeof e.effort === 'string' ? p.effort : e.effort
    if (model === e.model && effort === e.effort) return yield* next(e)
    return yield* next({ ...e, model, effort })
  })

  on('command.run', { command: ID }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'ask' || arg === 'auto' || arg === 'off') {
      rt.mode = arg
      await $.store.set('mode', arg)
      if (arg === 'off') {
        await unpin($)
        await $.state.set(NOTICE, null)
      }
      const what = { ask: 'asks before rerouting', auto: 'reroutes on its own', off: 'is off' }[arg]
      return { text: `Router ${what}.` }
    }
    if (arg === 'reset') {
      await unpin($)
      return { text: 'Router unpinned: requests follow your pickers again.' }
    }
    const pinned = (await $.state.get(PINNED)).value
    return {
      text: [
        `Router mode: ${rt.mode}.`,
        pinned ? `Pinned: ${fmt(pinned)}.` : 'Nothing pinned: requests follow your pickers.',
        `Usage: /${ID} ask | auto | off | reset`,
      ].join('\n'),
    }
  })

  on('ui.press', { plugin: 'model-effort-optimizer', element: 'undo' }, async ($, e) => {
    await unpin($)
    await $.state.set(NOTICE, null)
    return { element: e.element }
  })

  // The app's own menus can't be moved by a chat; the footer shows what is really sent.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const pinned = rt.mode === 'off' ? null : (await $.state.get(PINNED)).value
    if (!pinned) return next(e)
    const text = `⇢ ${fmt(pinned)}`
    if (e.surface === 'desktop' || e.surface === 'vscode') {
      const { Text } = $.ui.resolve(e)
      return <Text color={COLOR.accent}>{text}</Text>
    }
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, text] } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (rt.mode === 'off' || e.props.hasSurvey) return next(e)
    const n: Notice | null = (await $.state.get(NOTICE)).value ?? null
    if (!n) return next(e)
    const rest = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {rest}
        <Box flexDirection="row" gap={1}>
          <Text wrap="truncate-end">
            <Text color={COLOR.ok}>⇢</Text>
            <Text> Routed to </Text>
            <Text bold>{fmt(n.route)}</Text>
            {n.previous ? <Text dimColor> from {n.previous}</Text> : null}
            {n.reason ? <Text dimColor> · {n.reason}</Text> : null}
          </Text>
          <Button key="undo" label="Undo" variant="secondary" onPress={() => undefined} />
        </Box>
      </Box>
    )
  })
}
