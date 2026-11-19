import type { TurnStepInput } from 'claude-code'
import type { TestBody } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]
type Sent = { model: string; effort: TurnStepInput['effort'] }

const STEP: TurnStepInput = { turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1 }

async function step($: Engine, input: TurnStepInput) {
  const s = $.turn.step(input)
  for await (const chunk of s) void chunk
  return s.result
}

// Stands in for the engine: auto mode stored, the picker answering `reply`, every sent request recorded.
function engine(on: On, reply: string, sent: Sent[], mode = 'auto', answer = '') {
  on('command.register', () => ({ value: { command: 'model-effort-optimizer' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: e.key === 'mode' ? mode : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [] }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.sleep', () => new Promise(() => undefined))
  on('ui.status', () => ({ value: undefined }))
  // $.ui.ask runs as an AskUserQuestion tool call; this answers it.
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = e.questions[0]?.question ?? ''
    return { result: { questions: e.questions, answers: { [q]: answer } } }
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: reply, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }))
  on('prompt.submit', (_, e) => e)
  on('turn.step', async function* (_, e) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
}

async function start($: Engine, prompt: string) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: prompt, origin: { kind: 'composer' }, wait: false })
}

test('auto mode routes a hard prompt to opus + high for the whole turn', async ($, on) => {
  const sent: Sent[] = []
  engine(on, '{"tier":"opus","effort":"high","reason":"risky concurrency bug"}', sent)
  await start($, 'find the race in the job scheduler')
  await step($, STEP)
  await step($, { ...STEP, index: 1 })
  expect(sent).toEqual([
    { model: 'opus', effort: 'high' },
    { model: 'opus', effort: 'high' },
  ])
})

test('fable is a valid pick', async ($, on) => {
  const sent: Sent[] = []
  engine(on, '{"tier":"fable","effort":"xhigh","reason":"long critical hand-off"}', sent)
  await start($, 'design and build the whole billing migration, I am away all day')
  await step($, STEP)
  expect(sent[0]).toEqual({ model: 'fable', effort: 'xhigh' })
})

test('"keep" leaves the request as the pickers set it', async ($, on) => {
  const sent: Sent[] = []
  engine(on, '{"tier":"keep","effort":"keep","reason":"approval"}', sent)
  await start($, 'yes go')
  await step($, STEP)
  expect(sent[0]).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
})

test('moving the model picker by hand releases the hold', async ($, on) => {
  const sent: Sent[] = []
  engine(on, '{"tier":"haiku","effort":"low","reason":"trivial rename"}', sent)
  await start($, 'rename foo to bar')
  await step($, STEP)
  await step($, { ...STEP, turnId: 't2', model: 'claude-opus-5-5', effort: 'xhigh' })
  expect(sent).toEqual([
    { model: 'haiku', effort: 'low' },
    { model: 'claude-opus-5-5', effort: 'xhigh' },
  ])
})

test('ask mode reroutes only after the person agrees', async ($, on) => {
  const sent: Sent[] = []
  engine(on, '{"tier":"opus","effort":"high","reason":"hard bug"}', sent, 'ask', 'No, keep current')
  await start($, 'why does the cache corrupt under load')
  await step($, STEP)
  expect(sent[0]).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
})

test('ask mode applies the route on yes', async ($, on) => {
  const sent: Sent[] = []
  engine(on, '{"tier":"opus","effort":"high","reason":"hard bug"}', sent, 'ask', 'Use Opus · high')
  await start($, 'why does the cache corrupt under load')
  await step($, STEP)
  expect(sent[0]).toEqual({ model: 'opus', effort: 'high' })
})

test('off mode never touches requests', async ($, on) => {
  const sent: Sent[] = []
  engine(on, '{"tier":"haiku","effort":"low","reason":"x"}', sent, 'off')
  await start($, 'rename foo')
  await step($, STEP)
  expect(sent[0]).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
})
