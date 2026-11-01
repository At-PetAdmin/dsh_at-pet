/**
 * Behavioural tests for the At-Pet bridge plugin.
 *
 * A stub At-Pet server implements the subset of the local HTTP API the plugin
 * uses, so the plugin is exercised through real sockets instead of mocks:
 * `GET /health`, `POST /event`, `POST|GET|DELETE /permission[/:id]`, and
 * `POST|GET|DELETE /question[/:id]`.
 *
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, beforeEach, describe, it } from 'node:test'

import { DEFAULTS, apply } from '../index.js'

// ---------------------------------------------------------------------------
// Stub At-Pet
// ---------------------------------------------------------------------------

function createPetStub() {
  const state = {
    requests: [],
    events: [],
    permissions: new Map(),
    questions: new Map(),
    permissionDecision: 'allowed_once',
    questionAnswer: '',
    failHealth: false,
    holdsPermission: false,
  }
  let nextId = 0

  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const body = text === '' ? undefined : JSON.parse(text)
      const url = new URL(request.url, 'http://127.0.0.1')
      state.requests.push({ method: request.method, path: url.pathname, body })

      const send = (status, json) => {
        const payload = Buffer.from(JSON.stringify(json), 'utf8')
        response.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length })
        response.end(payload)
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        if (state.failHealth) send(500, { ok: false })
        else send(200, { ok: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/event') {
        state.events.push(body)
        send(202, { accepted: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/permission') {
        const requestId = `perm-${++nextId}`
        state.permissions.set(requestId, { status: 'pending', body })
        send(202, { accepted: true, requestId, status: 'pending' })
        return
      }
      if (request.method === 'POST' && url.pathname === '/question') {
        const requestId = `q-${++nextId}`
        state.questions.set(requestId, { status: 'pending', body })
        send(202, { accepted: true, requestId, status: 'pending' })
        return
      }
      const permission = url.pathname.match(/^\/permission\/(.+)$/)
      if (permission) {
        const requestId = decodeURIComponent(permission[1])
        const entry = state.permissions.get(requestId)
        if (!entry) {
          send(404, { error: 'permission request not found' })
          return
        }
        if (request.method === 'GET') {
          const status = state.holdsPermission ? 'pending' : state.permissionDecision
          if (status !== 'pending') state.permissions.delete(requestId)
          send(200, { requestId, status })
          return
        }
        if (request.method === 'DELETE') {
          state.permissions.delete(requestId)
          send(202, { cancelled: true })
          return
        }
      }
      const question = url.pathname.match(/^\/question\/(.+)$/)
      if (question) {
        const requestId = decodeURIComponent(question[1])
        const entry = state.questions.get(requestId)
        if (!entry) {
          send(404, { error: 'question request not found' })
          return
        }
        if (request.method === 'GET') {
          const answered = state.questionAnswer !== ''
          if (answered) state.questions.delete(requestId)
          send(200, answered
            ? { requestId, status: 'answered', answer: state.questionAnswer }
            : { requestId, status: 'pending' })
          return
        }
        if (request.method === 'DELETE') {
          state.questions.delete(requestId)
          send(202, { cancelled: true })
          return
        }
      }
      send(404, { error: 'not found' })
    })
  })

  return {
    state,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      return `http://127.0.0.1:${server.address().port}`
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
    get events() {
      return state.events
    },
    async waitFor(predicate, description = 'condition') {
      const deadline = Date.now() + 4000
      while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`timed out waiting for ${description}`)
    },
  }
}

// ---------------------------------------------------------------------------
// Fake plugin context
// ---------------------------------------------------------------------------

function createContext() {
  const handlers = new Map()
  const disposers = []
  return {
    handlers,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect(factory) {
      disposers.push(factory())
      return () => {}
    },
    get() {
      return undefined
    },
    listener(event) {
      const list = handlers.get(event) ?? []
      assert.equal(list.length, 1, `expected exactly one ${event} listener`)
      return list[0]
    },
    dispose() {
      for (const disposer of disposers) {
        try {
          disposer?.()
        } catch {
          // disposal must be best-effort
        }
      }
    },
  }
}

function session({ id = 'ses-1', parent, origin, model = 'deepseek-v4' } = {}) {
  return {
    header: { id, parentSession: parent, origin },
    requestContext: () => ({ provider: 'deepseek', model }),
  }
}

async function flush(ms = 60) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dsh-atpet bridge', () => {
  const pet = createPetStub()
  let baseUrl

  before(async () => {
    baseUrl = await pet.listen()
  })

  after(async () => {
    await pet.close()
  })

  // Let the previous test's fire-and-forget POSTs land before clearing the log.
  beforeEach(async () => {
    await flush(150)
    pet.state.events.length = 0
    pet.state.permissions.clear()
    pet.state.questions.clear()
    pet.state.holdsPermission = false
  })

  function start(overrides = {}) {
    const ctx = createContext()
    apply(ctx, { baseUrl, ...overrides })
    return ctx
  }

  /** Events for one session only: a late POST from the previous test cannot confuse it. */
  function eventsOf(sessionId) {
    return pet.events.filter((event) => event.sessionId === sessionId)
  }

  it('exposes documented defaults', () => {
    assert.equal(DEFAULTS.baseUrl, 'http://127.0.0.1:8765')
    assert.equal(DEFAULTS.agentApp, 'deepseek-harness')
    assert.ok(DEFAULTS.approvalTimeoutMs >= 30_000)
  })

  it('mirrors a turn and its tool calls onto the pet', async () => {
    const ctx = start()
    const listener = ctx.listener('session/event')
    const s = session({ id: 'ses-mirror' })

    listener(s, { type: 'turn/start', data: { turn: 1 } })
    listener(s, { type: 'tool/call', data: { name: 'ops_bash', callId: 'c1', arguments: '{}' } })
    listener(s, { type: 'tool/result', data: { error: { name: 'Error', code: 'x' } } })
    listener(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

    await pet.waitFor(() => eventsOf('ses-mirror').length >= 4, 'four mirrored events')
    const mirrored = eventsOf('ses-mirror')
    assert.deepEqual(mirrored.map((event) => event.event), ['thinking', 'tool_start', 'tool_end', 'done'])
    for (const event of mirrored) {
      assert.equal(event.agentApp, 'deepseek-harness')
      assert.equal(event.model, 'deepseek-v4')
      assert.equal(event.isSubagent, false)
      assert.equal(event.parentSessionId, undefined)
    }
    assert.equal(mirrored[1].message, 'ops_bash')
    ctx.dispose()
  })

  it('never reports a failed tool call as a terminal error', async () => {
    const ctx = start()
    ctx.listener('session/event')(session({ id: 'ses-toolerr' }), { type: 'tool/result', data: { error: { name: 'Boom' } } })
    await pet.waitFor(() => eventsOf('ses-toolerr').length >= 1, 'tool_end')
    assert.equal(eventsOf('ses-toolerr')[0].event, 'tool_end')
    ctx.dispose()
  })

  it('maps every turn-end reason to the matching pet animation', async () => {
    const ctx = start()
    const listener = ctx.listener('session/event')
    for (const kind of ['aborted', 'error', 'max-tokens', 'forked', 'nonsense']) {
      listener(session({ id: 'ses-turnend' }), { type: 'turn/end', data: { reason: { kind, error: { message: 'rate limited' } } } })
    }
    await pet.waitFor(() => eventsOf('ses-turnend').length >= 3, 'three turn-end events')
    await flush()
    const endings = eventsOf('ses-turnend')
    assert.deepEqual(endings.map((event) => event.event), ['cancelled', 'error', 'done'])
    assert.equal(endings[1].message, 'rate limited')
    ctx.dispose()
  })

  it('gives a delegated session its own window with the parent link', async () => {
    const ctx = start()
    ctx.listener('session/event')(session({ id: 'ses-child', parent: 'ses-parent', origin: 'subagent' }), {
      type: 'turn/start',
      data: { turn: 1 },
    })
    await pet.waitFor(() => eventsOf('ses-child').length >= 1, 'child event')
    assert.equal(eventsOf('ses-child')[0].isSubagent, true)
    assert.equal(eventsOf('ses-child')[0].parentSessionId, 'ses-parent')
    ctx.dispose()
  })

  it('can stay quiet about delegated sessions', async () => {
    const ctx = start({ reportSubagents: false })
    ctx.listener('session/event')(session({ id: 'ses-quiet', parent: 'ses-parent' }), {
      type: 'turn/start',
      data: { turn: 1 },
    })
    await flush()
    assert.equal(eventsOf('ses-quiet').length, 0)
    ctx.dispose()
  })

  it('ignores injected context masquerading as a user prompt', async () => {
    const ctx = start()
    ctx.listener('session/event')(session({ id: 'ses-prompt' }), {
      type: 'user/message',
      data: { source: { kind: 'hooks-codex' }, content: [{ type: 'text', text: 'injected' }] },
    })
    await flush()
    assert.equal(eventsOf('ses-prompt').length, 0)
    ctx.listener('session/event')(session({ id: 'ses-prompt' }), {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello pet' }] },
    })
    await pet.waitFor(() => eventsOf('ses-prompt').length >= 1, 'prompt event')
    assert.equal(eventsOf('ses-prompt')[0].event, 'user_prompt_submit')
    assert.equal(eventsOf('ses-prompt')[0].message, 'hello pet')
    ctx.dispose()
  })

  it('relays an approval to the pet and returns the pet decision', async () => {
    pet.state.permissionDecision = 'allowed_once'
    const ctx = start()
    let delegated = false
    const outcome = await ctx.listener('approval/request')({
      agent: { id: 'ses-approve' },
      toolName: 'ops_bash',
      displayReason: { en: 'Run a command', zh: '执行命令' },
    }, async () => {
      delegated = true
      return 'unavailable'
    })
    assert.equal(outcome, 'allowed-once')
    assert.equal(delegated, false)
    assert.equal(pet.state.permissions.size, 0, 'the claimed request is not left pending')
    ctx.dispose()
  })

  it('turns a pet denial into a rejected approval', async () => {
    pet.state.permissionDecision = 'denied'
    const ctx = start()
    const outcome = await ctx.listener('approval/request')({
      agent: { id: 'ses-deny' },
      toolName: 'ops_write',
    }, async () => 'allowed-once')
    assert.equal(outcome, 'rejected')
    ctx.dispose()
  })

  it('falls back to the Harness approval UI while the pet is not running', async () => {
    const ctx = createContext()
    apply(ctx, { baseUrl: 'http://127.0.0.1:9', requestTimeoutMs: 200, healthTtlMs: 250 })
    let delegated = false
    const outcome = await ctx.listener('approval/request')({
      agent: { id: 'ses-offline' },
      toolName: 'ops_bash',
    }, async () => {
      delegated = true
      return 'allowed-once'
    })
    assert.equal(delegated, true)
    assert.equal(outcome, 'allowed-once')
    ctx.dispose()
  })

  it('gives an unanswered approval back to the Harness and cancels it on the pet', async () => {
    pet.state.holdsPermission = true
    const ctx = start({ approvalTimeoutMs: 5_000, pollIntervalMs: 100 })
    let delegated = false
    const started = Date.now()
    const outcome = await ctx.listener('approval/request')({
      agent: { id: 'ses-timeout' },
      toolName: 'ops_bash',
    }, async () => {
      delegated = true
      return 'unavailable'
    })
    const elapsed = Date.now() - started
    pet.state.holdsPermission = false
    assert.equal(delegated, true, 'an unanswered prompt must not claim the approval')
    assert.equal(outcome, 'unavailable')
    assert.ok(elapsed >= 4_500, `waited for the configured timeout (${elapsed}ms)`)
    await pet.waitFor(
      () => pet.state.requests.some((request) => request.method === 'DELETE' && request.path.startsWith('/permission/')),
      'permission cancellation',
    )
    ctx.dispose()
  })

  it('relays a single-choice question and maps the pick to the tool answer', async () => {
    pet.state.questionAnswer = 'Approve'
    const ctx = start()
    const answer = await ctx.listener('user-questions/request')({
      agent: { id: 'ses-question' },
      questions: [{
        id: 'q1',
        question: 'Proceed with the migration?',
        header: 'Migration',
        options: [{ label: 'Approve' }, { label: 'Cancel' }],
      }],
    }, async () => assert.fail('the pet answered, so the Harness must not be asked'))
    assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['Approve'] }] })
    const posted = pet.state.requests.filter((request) => request.path === '/question').at(-1)
    assert.deepEqual(posted.body.choices, ['Approve', 'Cancel'])
    assert.equal(posted.body.question, 'Proceed with the migration?')
    assert.equal(posted.body.sessionId, 'ses-question')
    pet.state.questionAnswer = ''
    ctx.dispose()
  })

  it('keeps a free-text question answer as custom input', async () => {
    pet.state.questionAnswer = 'use the blue theme'
    const ctx = start()
    const answer = await ctx.listener('user-questions/request')({
      agent: { id: 'ses-free' },
      questions: [{ id: 'q2', question: 'Which theme?' }],
    }, async () => assert.fail('the pet answered'))
    assert.deepEqual(answer, { answers: [{ id: 'q2', selected: [], custom: 'use the blue theme' }] })
    pet.state.questionAnswer = ''
    ctx.dispose()
  })

  it('leaves multi-question and plan-review prompts in the Harness', async () => {
    const ctx = start()
    let calls = 0
    const next = async () => {
      calls += 1
      return { answers: [] }
    }
    await ctx.listener('user-questions/request')({
      questions: [{ id: 'a', question: 'one' }, { id: 'b', question: 'two' }],
    }, next)
    await ctx.listener('user-questions/request')({
      questions: [{ id: 'c', question: 'plan?', intent: { kind: 'plan-review', approve: 'ok' } }],
    }, next)
    assert.equal(calls, 2)
    ctx.dispose()
  })

  it('stops reporting once the plugin is disposed', async () => {
    const ctx = start()
    ctx.dispose()
    ctx.listener('session/event')(session({ id: 'ses-disposed' }), { type: 'turn/start', data: { turn: 1 } })
    await flush()
    assert.equal(eventsOf('ses-disposed').length, 0)
  })
})
