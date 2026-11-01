/**
 * At-Pet bridge for DeepSeek Harness.
 *
 * At-Pet (https://github.com/At-PetAdmin/At-Pet) is a desktop pet that animates
 * whichever coding agent is running. This Host plugin is the DeepSeek Harness
 * sender for it: one process, no hook scripts, no extra processes to manage.
 *
 * Three capabilities, all against At-Pet's local HTTP API (127.0.0.1:8765):
 *
 * 1. Activity mirroring — durable session events (`turn/start`, `tool/call`,
 *    `tool/result`, `turn/end`, session disposal) become At-Pet `POST /event`
 *    calls, so the pet thinks, digs, celebrates, and errors in step with the
 *    Harness. Reading the committed log instead of interception hooks keeps the
 *    mirror exact through retries, replays, and delegated subagents.
 * 2. Approval relay — the `approval/request` waterfall is claimed only while
 *    At-Pet answers `/health`; the decision is collected from the pet window and
 *    returned as the tool approval outcome. Any failure, timeout, or missing
 *    pet delegates to `next()`, leaving the normal Harness approval UI intact.
 * 3. Question relay — a single-question `user-questions/request` is offered to
 *    the pet bubble, whose selection becomes the tool answer.
 *
 * The plugin holds no durable state and writes no session events; unload removes
 * every listener and aborts in-flight polling.
 *
 * @module dsh-atpet
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { setMaxListeners } from 'node:events'

/** Documented defaults; every key can be overridden from `cordis.patch.yml`. */
export const DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:8765',
  agentApp: 'deepseek-harness',
  reportEvents: true,
  reportSubagents: true,
  includePromptText: true,
  bridgeApprovals: true,
  bridgeQuestions: true,
  requestTimeoutMs: 1200,
  healthTtlMs: 5000,
  pollIntervalMs: 250,
  approvalTimeoutMs: 120_000,
  questionTimeoutMs: 180_000,
  maxMessageChars: 160,
})

/** At-Pet event token per committed `turn/end` reason; `null` stays quiet. */
const TURN_END_EVENTS = Object.freeze({
  completed: 'done',
  aborted: 'cancelled',
  blocked: 'cancelled',
  interrupted: 'cancelled',
  error: 'error',
  'max-tokens': 'done',
  forked: null,
})

const UNREACHABLE_REASONS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
])

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function asString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asInteger(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString().replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

/**
 * Normalize the patch row's `config` object. Unknown keys are ignored and
 * malformed values fall back per key, because a broken bridge config must never
 * take the Harness down with it.
 */
function resolveConfig(raw) {
  const source = typeof raw === 'object' && raw !== null ? raw : {}
  return {
    baseUrl: normalizeBaseUrl(asString(source.baseUrl, DEFAULTS.baseUrl)) ?? DEFAULTS.baseUrl,
    agentApp: asString(source.agentApp, DEFAULTS.agentApp).slice(0, 64),
    reportEvents: asBoolean(source.reportEvents, DEFAULTS.reportEvents),
    reportSubagents: asBoolean(source.reportSubagents, DEFAULTS.reportSubagents),
    includePromptText: asBoolean(source.includePromptText, DEFAULTS.includePromptText),
    bridgeApprovals: asBoolean(source.bridgeApprovals, DEFAULTS.bridgeApprovals),
    bridgeQuestions: asBoolean(source.bridgeQuestions, DEFAULTS.bridgeQuestions),
    requestTimeoutMs: asInteger(source.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 100, 30_000),
    healthTtlMs: asInteger(source.healthTtlMs, DEFAULTS.healthTtlMs, 250, 60_000),
    pollIntervalMs: asInteger(source.pollIntervalMs, DEFAULTS.pollIntervalMs, 100, 10_000),
    approvalTimeoutMs: asInteger(source.approvalTimeoutMs, DEFAULTS.approvalTimeoutMs, 5_000, 3_600_000),
    questionTimeoutMs: asInteger(source.questionTimeoutMs, DEFAULTS.questionTimeoutMs, 5_000, 3_600_000),
    maxMessageChars: asInteger(source.maxMessageChars, DEFAULTS.maxMessageChars, 16, 400),
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ')
}

/** Prefer the user's own language for a localized reason, then the other one. */
function pickLocalized(value) {
  if (typeof value !== 'object' || value === null) return ''
  let locale = ''
  try {
    locale = (Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase()
  } catch {
    locale = ''
  }
  const keys = locale.startsWith('zh') ? ['zh', 'en'] : ['en', 'zh']
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return ''
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null && typeof error.message === 'string') return error.message
  return ''
}

/** One-shot abortable delay; resolves `false` when the signal fires first. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    // Deliberately not unref'd: a pending wait for the user is real work, and an
    // unref'd timer would let a standalone process exit before it settles.
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function combineSignals(signals) {
  const live = signals.filter((signal) => signal instanceof AbortSignal)
  if (live.length === 0) return undefined
  if (live.length === 1) return live[0]
  const controller = new AbortController()
  const abort = (event) => {
    controller.abort(event?.target?.reason)
    for (const signal of live) signal.removeEventListener('abort', abort)
  }
  for (const signal of live) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

// ---------------------------------------------------------------------------
// At-Pet HTTP client
// ---------------------------------------------------------------------------

/**
 * Minimal JSON client for At-Pet's local API. `node:http` is used instead of
 * `fetch` so the bridge works on every supported Host runtime and keeps the
 * connection lifecycle (and its timeouts) under our control.
 */
function createClient(config) {
  const base = new URL(config.baseUrl)
  const transport = base.protocol === 'https:' ? httpsRequest : httpRequest
  const basePath = base.pathname.replace(/\/+$/, '')

  function call(method, path, body, options = {}) {
    const { timeoutMs = config.requestTimeoutMs, signal } = options
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('aborted'))
        return
      }
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
      const headers = { accept: 'application/json', connection: 'close' }
      if (payload !== undefined) {
        headers['content-type'] = 'application/json'
        headers['content-length'] = String(payload.length)
      }
      const request = transport({
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port === '' ? undefined : base.port,
        method,
        path: `${basePath}${path}`,
        headers,
      }, (response) => {
        const chunks = []
        let bytes = 0
        response.on('data', (chunk) => {
          bytes += chunk.length
          if (bytes <= 4 * 1024 * 1024) chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json
          if (text !== '') {
            try {
              json = JSON.parse(text)
            } catch {
              json = undefined
            }
          }
          resolve({ status: response.statusCode ?? 0, json, text })
        })
      })
      const timer = setTimeout(() => {
        request.destroy(Object.assign(new Error(`${method} ${path} timed out`), { code: 'ETIMEDOUT' }))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      request.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      request.on('close', () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      })
      function onAbort() {
        request.destroy(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (payload !== undefined) request.write(payload)
      request.end()
    })
  }

  return { call }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Register the At-Pet bridge on this plugin's context.
 *
 * @param ctx - the plugin context; every listener registered here is disposed
 *   with it.
 * @param config - the patch row's `config` object.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  const client = createClient(settings)
  const lifetime = new AbortController()
  // Every approval/question adds a listener to this signal; keep Node quiet.
  setMaxListeners(0, lifetime.signal)
  ctx.effect(() => () => lifetime.abort(), 'dsh-atpet: abort in-flight requests')

  const log = (level, message) => {
    try {
      const logger = ctx.logger
      if (typeof logger?.[level] === 'function') logger[level](message)
      else if (typeof logger?.info === 'function') logger.info(message)
    } catch {
      // A logging quirk must never break the bridge.
    }
  }

  let reachable
  let reachableAt = 0

  function setReachable(next) {
    if (reachable === next) return
    const known = reachable !== undefined
    reachable = next
    if (next) {
      log('info', `dsh-atpet: connected to At-Pet at ${settings.baseUrl}`)
    } else if (known) {
      log('info', `dsh-atpet: At-Pet stopped answering at ${settings.baseUrl}; pet updates are paused`)
    } else {
      log('info', `dsh-atpet: At-Pet is not answering at ${settings.baseUrl} yet; waiting for it to start`)
    }
  }

  /** Cached reachability probe; a stopped pet costs one connect attempt per TTL. */
  async function isReachable() {
    const now = Date.now()
    if (now - reachableAt < settings.healthTtlMs) return reachable === true
    let ok = false
    try {
      const response = await client.call('GET', '/health', undefined, {
        timeoutMs: Math.min(settings.requestTimeoutMs, 1000),
        signal: lifetime.signal,
      })
      ok = response.status === 200 && response.json?.ok === true
    } catch {
      ok = false
    }
    reachableAt = Date.now()
    setReachable(ok)
    return ok
  }

  function describeSession(session) {
    const header = session?.header ?? {}
    const id = typeof header.id === 'string' ? header.id : ''
    const parent = typeof header.parentSession === 'string' ? header.parentSession : ''
    let model = ''
    try {
      const context = typeof session?.requestContext === 'function' ? session.requestContext() : undefined
      if (typeof context?.model === 'string') model = context.model
    } catch {
      model = ''
    }
    return { id, parent, model, isSubagent: parent !== '' || header.origin === 'subagent' }
  }

  /**
   * Fire one At-Pet event for `session`. Failures are swallowed on purpose: the
   * pet is a peripheral, so an unreachable pet must never surface as a Harness
   * error or delay a tool call.
   */
  function report(session, event, message) {
    if (!settings.reportEvents) return
    const info = describeSession(session)
    if (info.id === '') return
    if (info.isSubagent && !settings.reportSubagents) return
    const body = {
      sessionId: info.id,
      agentApp: settings.agentApp,
      event,
      model: info.model,
      isSubagent: info.isSubagent,
    }
    if (info.parent !== '') body.parentSessionId = info.parent
    const text = clip(message, settings.maxMessageChars)
    if (text !== '') body.message = text
    enqueueEvent(info.id, body)
  }

  /**
   * Send one `/event` after every earlier event of the same session settled.
   *
   * At-Pet renders whatever arrives last, so two concurrent POSTs could swap
   * `tool_end` and `done` and leave the pet celebrating a tool it is still
   * digging, or resurrect a session a terminal event already closed. One queue
   * per session (not one global queue) keeps ordering without serializing
   * independent sessions behind each other.
   */
  const sendQueues = new Map()
  ctx.effect(() => () => sendQueues.clear(), 'dsh-atpet: drop queued event sends')

  function enqueueEvent(sessionId, body) {
    const previous = sendQueues.get(sessionId) ?? Promise.resolve()
    const next = previous.then(
      () => (lifetime.signal.aborted
        ? undefined
        : client.call('POST', '/event', body, { signal: lifetime.signal }).catch(() => {})),
      () => undefined,
    )
    sendQueues.set(sessionId, next)
    void next.then(() => {
      if (sendQueues.get(sessionId) === next) sendQueues.delete(sessionId)
    })
  }

  // --- Activity mirroring ---------------------------------------------------

  ctx.on('session/event', (session, event) => {
    if (lifetime.signal.aborted) return
    switch (event?.type) {
      case 'turn/start':
        report(session, 'thinking')
        break
      case 'user/message': {
        const source = event.data?.source
        if (typeof source?.kind === 'string' && source.kind !== 'user') break
        report(session, 'user_prompt_submit', settings.includePromptText ? textOfContent(event.data?.content) : '')
        break
      }
      case 'tool/call':
        report(session, 'tool_start', event.data?.name)
        break
      case 'tool/result':
        // A failed tool call is not a failed turn: keep the pet in its work pose
        // instead of firing At-Pet's terminal `error` animation.
        report(session, 'tool_end')
        break
      case 'turn/end': {
        const reason = event.data?.reason
        const kind = typeof reason?.kind === 'string' ? reason.kind : ''
        if (!Object.prototype.hasOwnProperty.call(TURN_END_EVENTS, kind)) break
        const token = TURN_END_EVENTS[kind]
        if (token === null) break
        report(session, token, token === 'error' ? errorMessage(reason?.error) : '')
        break
      }
      default:
        break
    }
  })

  ctx.on('session/disposed', (session) => {
    if (lifetime.signal.aborted) return
    report(session, 'session_end')
  })

  // --- Approval and question relay -----------------------------------------

  /** Poll At-Pet until the pending request reaches a final state. */
  async function waitForOutcome(kind, requestId, timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs
    const path = `/${kind}/${encodeURIComponent(requestId)}`
    const combined = combineSignals([signal, lifetime.signal])
    while (Date.now() < deadline) {
      if (combined?.aborted) return { outcome: 'aborted' }
      const wait = Math.min(settings.pollIntervalMs, Math.max(0, deadline - Date.now()))
      if (!(await sleep(wait, combined))) return { outcome: 'aborted' }
      let response
      try {
        response = await client.call('GET', path, undefined, {
          timeoutMs: settings.requestTimeoutMs,
          signal: combined,
        })
      } catch (error) {
        if (combined?.aborted) return { outcome: 'aborted' }
        if (UNREACHABLE_REASONS.has(error?.code)) return { outcome: 'unreachable' }
        continue
      }
      if (response.status === 404) return { outcome: 'gone' }
      const status = response.json?.status
      if (typeof status === 'string' && status !== 'pending') {
        const answer = typeof response.json?.answer === 'string' ? response.json.answer : ''
        return { outcome: 'settled', status, answer }
      }
    }
    return { outcome: 'timeout' }
  }

  function forget(kind, requestId) {
    client.call('DELETE', `/${kind}/${encodeURIComponent(requestId)}`, undefined, {
      timeoutMs: settings.requestTimeoutMs,
    }).catch(() => {})
  }

  /**
   * Offer one prompt to the pet and wait for it. Returns `undefined` whenever
   * the pet cannot take the request, which tells the caller to delegate.
   */
  async function askPet(kind, body, timeoutMs, signal) {
    if (!(await isReachable())) return undefined
    let created
    try {
      created = await client.call('POST', `/${kind}`, body, {
        timeoutMs: settings.requestTimeoutMs,
        signal: combineSignals([signal, lifetime.signal]),
      })
    } catch {
      return undefined
    }
    const requestId = typeof created.json?.requestId === 'string' ? created.json.requestId : ''
    if (created.status !== 202 || requestId === '') return undefined
    const done = await waitForOutcome(kind, requestId, timeoutMs, signal)
    if (done.outcome !== 'settled') forget(kind, requestId)
    return done
  }

  ctx.on('approval/request', async (request, next) => {
    if (!settings.bridgeApprovals) return next()
    const sessionId = typeof request?.agent?.id === 'string' ? request.agent.id : ''
    if (sessionId === '') return next()
    const toolName = asString(request.toolName, 'tool')
    const description = pickLocalized(request.displayReason) || asString(request.reason, '')
    const done = await askPet('permission', {
      sessionId,
      agentApp: settings.agentApp,
      toolName,
      title: `${settings.agentApp} · ${toolName}`,
      description: clip(description, 2000),
    }, settings.approvalTimeoutMs, request.signal)
    if (done === undefined) return next()
    if (done.outcome === 'settled') {
      if (done.status === 'allowed_once') return 'allowed-once'
      if (done.status === 'denied') return 'rejected'
    }
    if (done.outcome === 'aborted' && request.signal?.aborted) return 'cancelled'
    // Timeout, dismissal, or an unreachable pet: hand the decision back to the
    // Harness answerers so the user still sees an approval prompt.
    return next()
  })

  ctx.on('user-questions/request', async (request, next) => {
    if (!settings.bridgeQuestions) return next()
    const items = Array.isArray(request?.questions) ? request.questions : []
    if (items.length !== 1) return next()
    const item = items[0]
    if (typeof item?.question !== 'string' || item.question.trim() === '') return next()
    // A plan-review prompt drives the Harness UI's own approve button; leave it there.
    if (item.intent !== undefined) return next()
    const labels = (Array.isArray(item.options) ? item.options : [])
      .map((option) => (typeof option?.label === 'string' ? option.label.trim() : ''))
      .filter((label) => label !== '')
      .slice(0, 20)
    const agent = request.agent ?? ctx.get('agents')?.currentInitiator?.()
    const sessionId = typeof agent?.id === 'string' ? agent.id : ''
    const body = { agentApp: settings.agentApp, question: clip(item.question, 2000), sessionId }
    const header = asString(item.header, '') || clip(asString(item.detail, ''), 160)
    if (header !== '') body.header = header
    if (labels.length > 0) body.choices = labels
    const done = await askPet('question', body, settings.questionTimeoutMs, request.signal)
    if (done === undefined) return next()
    if (done.outcome === 'settled' && done.answer.trim() !== '') {
      const answer = done.answer.trim()
      const selected = labels.includes(answer) ? [answer] : []
      return { answers: [selected.length > 0 ? { id: item.id, selected } : { id: item.id, selected: [], custom: answer }] }
    }
    if (done.outcome === 'aborted' && request.signal?.aborted) return { answers: [] }
    return next()
  })
}
