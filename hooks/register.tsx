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
| haiku  | lookups, one-liners, renaming a symbol (even repo-wide), formatting, shell one-offs, a quick check of a short snippet, generating sample or fixture data, bulk text work that follows a fixed rule (translating strings, reformatting lists), small talk |
| sonnet | routine coding: writing a script, a docs or README section, tests, rewriting call sites to a changed signature across files, edits in a few files, debugging a clear error |
| opus   | design decisions, unclear bugs, performance diagnosis, wide refactors, security, concurrency, risky reviews |
| fable  | the rare hardest case: long unattended builds or migrations across many services that must work first time, deep research, many-tradeoff system design, bugs that resisted opus |

Effort levels (how long the assistant deliberates and verifies):
- low: quick or conversational; the user will iterate
- medium: the default when nothing below applies
- high: correctness matters; analysis, review, verification
- xhigh: long, critical work handed off with no one around to answer questions
- max: only when the request explicitly demands the deepest possible effort

Rules:
- Pick the cheapest tier that will do the job well. Writing new logic or prose is at least sonnet; generated sample data is not.
- When torn between two tiers, pick the higher one: a weak answer costs more than the price gap.
- A long task is not automatically a hard one. A short request is not automatically an easy one: when it refers to the previous reply, judge the problem shown there.
- A trivial change in a sensitive area (payments, auth, prod config) stays trivial.
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

/** One classifier call, the same request in production and in the eval. */
async function runClassifier($: EngineInterface, text: string, context: string, current: Now) {
  const started = await $.clock.now()
  const r = await $.model.complete({
    model: CLASSIFIER_MODEL,
    prompt: classifierPrompt(text.slice(0, 4000), context, current),
    maxTokens: 120,
    timeoutMs: 15_000,
  })
  const ms = (await $.clock.now()) - started
  return {
    verdict: r.isAnswered ? parseVerdict(r.text, current) : null,
    raw: r.isAnswered ? r.text : `error: ${r.reason}`,
    ms,
    inputTokens: r.usage?.input_tokens ?? 0,
    outputTokens: r.usage?.output_tokens ?? 0,
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
    return (await runClassifier($, text, context, current)).verdict
  } finally {
    try {
      await $.ui.status(undefined)
    } catch {
      // Optional.
    }
  }
}

// ---- Dev-only eval: registered only when loaded from a dev-mods folder, never from an install. ----

const EVAL_TOOL = 'router_eval'

type EvalCase = { id: string; prompt: string; context?: string; current: { tier: Tier; effort: Effort } }

async function runEval($: EngineInterface, runs: number, ids: readonly string[] | undefined) {
  const root = $.plugin.root
  const data = JSON.parse(String(await $.fs.read(`${root}/eval/dataset.json`))) as { cases: EvalCase[] }
  const cases = data.cases.filter(c => !ids?.length || ids.includes(c.id))
  const jobs = cases.flatMap(c => Array.from({ length: runs }, (_, run) => ({ c, run })))
  const out: unknown[] = []
  let i = 0
  // Five at a time keeps it quick without hammering the API.
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (i < jobs.length) {
        const { c, run } = jobs[i++]!
        const r = await runClassifier($, c.prompt, c.context ?? '', c.current)
        out.push({ id: c.id, run, tier: r.verdict?.tier ?? null, effort: r.verdict?.effort ?? null, reason: r.verdict?.reason ?? '', raw: r.verdict ? undefined : r.raw, ms: r.ms, inputTokens: r.inputTokens, outputTokens: r.outputTokens })
      }
    }),
  )
  const path = `${root}/eval/results.json`
  await $.fs.write(path, JSON.stringify({ model: CLASSIFIER_MODEL, runs, at: new Date(await $.clock.now()).toISOString(), results: out }, null, 2))
  return `Ran ${jobs.length} classifications (${cases.length} cases x ${runs}). Results: ${path}`
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
    if ($.plugin.root.includes('/dev-mods/')) {
      await $.tool.register({
        name: EVAL_TOOL,
        description: 'Dev only: runs eval/dataset.json through the router classifier `runs` times per case and writes eval/results.json.',
        inputSchema: {
          type: 'object',
          properties: { runs: { type: 'number', description: 'Runs per case, 1-5' }, ids: { type: 'array', items: { type: 'string' } } },
          required: ['runs'],
        },
      })
    }
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

  // The tool's name only enters the generated types after it is registered once, hence the cast.
  const evalMatcher = { tool: 'mcp__model-effort-optimizer__router_eval' } as unknown as { tool: 'Bash' }
  on('tool.run', evalMatcher, async ($, e) => {
    const input = e as unknown as { runs?: number; ids?: string[] }
    const runs = Math.min(5, Math.max(1, Math.round(Number(input.runs) || 1)))
    return { result: await runEval($, runs, input.ids) }
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
