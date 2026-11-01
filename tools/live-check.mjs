/**
 * End-to-end self-check against a real, running At-Pet.
 *
 * It reuses the shipped plugin code but drives the two interactive relay paths
 * directly, so the At-Pet side of the protocol (dialog, decision, answer) is
 * verified against the actual app instead of the test stub.
 *
 * Usage: node tools/live-check.mjs [baseUrl]
 */
import { apply } from '../index.js'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8765'

const handlers = new Map()
const disposers = []
const ctx = {
  logger: {
    debug: () => {},
    info: (message) => console.log('  [plugin]', message),
    warn: (message) => console.log('  [plugin:warn]', message),
    error: (message) => console.log('  [plugin:error]', message),
  },
  on(event, handler) {
    handlers.set(event, [...(handlers.get(event) ?? []), handler])
    return () => {}
  },
  effect(factory) {
    disposers.push(factory())
    return () => {}
  },
  get() {
    return undefined
  },
}

apply(ctx, {
  baseUrl,
  approvalTimeoutMs: Number(process.env.APPROVAL_MS ?? 20_000),
  questionTimeoutMs: Number(process.env.QUESTION_MS ?? 25_000),
  pollIntervalMs: 250,
})

const approval = handlers.get('approval/request')?.[0]
const questions = handlers.get('user-questions/request')?.[0]
if (!approval || !questions) {
  console.error('listeners were not registered')
  process.exit(1)
}

console.log(`\n=== 1/2 approval relay (${baseUrl})`)
console.log('    At-Pet should show a permission dialog now; 20s budget.\n')
const outcome = await approval({
  agent: { id: 'atpet-live-check' },
  toolName: 'atpet-live-check',
  displayReason: {
    zh: '这是 dsh-atpet 插件的端到端自检：在桌宠上点「Allow once」，裁决会回传给插件。',
    en: 'At-Pet bridge self-check: click "Allow once" on the pet to prove the decision travels back.',
  },
}, async () => {
  console.log('    -> delegated back to the Harness answerers (next())')
  return 'unavailable'
})
console.log(`    approval outcome: ${outcome}`)

console.log(`\n=== 2/2 question relay`)
console.log('    At-Pet should show a question dialog with two choices; 25s budget.\n')
const answer = await questions({
  agent: { id: 'atpet-live-check' },
  questions: [{
    id: 'live-1',
    header: 'At-Pet 接入自检',
    question: '桌宠能看到这个问题，并把你的选择回传给 Harness 吗？',
    options: [{ label: '能看到，也能回传' }, { label: '能看到，但先不测' }],
  }],
}, async () => {
  console.log('    -> delegated back to the Harness answerers (next())')
  return { answers: [] }
})
console.log(`    answer: ${JSON.stringify(answer)}`)

for (const disposer of disposers) disposer?.()
process.exit(0)
