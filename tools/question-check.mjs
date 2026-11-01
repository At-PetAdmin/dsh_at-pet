/**
 * Focused acceptance check for the question relay: posts one question through the
 * shipped plugin code and reports how long the answer took. An answer that arrives
 * before the timeout can only come from the pet window — while the bridge holds the
 * request, the Harness answerers never see it.
 *
 * Usage: node tools/question-check.mjs [baseUrl] [timeoutMs]
 */
import { apply } from '../index.js'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8765'
const timeoutMs = Number(process.argv[3] ?? 45_000)

const handlers = new Map()
const ctx = {
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  on(event, handler) {
    handlers.set(event, [...(handlers.get(event) ?? []), handler])
    return () => {}
  },
  effect: () => () => {},
  get: () => undefined,
}

apply(ctx, { baseUrl, questionTimeoutMs: timeoutMs, pollIntervalMs: 250 })

console.log(`posting one question to ${baseUrl}; budget ${Math.round(timeoutMs / 1000)}s`)
console.log('pick an option in the At-Pet question dialog...\n')
const started = Date.now()
const answer = await handlers.get('user-questions/request')[0]({
  agent: { id: 'atpet-question-check' },
  questions: [{
    id: 'accept-1',
    header: 'At-Pet 接入验收',
    question: '这个问题来自 dsh-atpet 插件本体：请在桌宠上选一项，选完这里会打印耗时。',
    options: [{ label: '验收通过' }, { label: '稍后再说' }],
  }],
}, async () => {
  console.log('  -> delegated to the Harness answerers: the pet did not answer in time')
  return { answers: [] }
})
console.log(`elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log(`answer ${JSON.stringify(answer)}`)
process.exit(0)
