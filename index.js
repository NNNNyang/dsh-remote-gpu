// dsh-remote-gpu — host half.
//
// Reports live GPU utilization of the server dsh-remote is connected to.
//
// The probe runs through dsh-remote's own `rw_exec` tool, so this plugin never
// opens a second SSH connection and never touches credentials, keychains or
// host keys — dsh-remote already owns that surface. The host keeps the last
// sample, refreshes it on a timer while a client is watching, and serves it as
// JSON over the plugin's own HTTP route.

import { registerHttpTransports } from './lib/http-transport.js'
import { parseGpuOutput, toWireGpu } from './lib/gpu-parse.js'

export const name = 'dsh-remote-gpu'
export const inject = ['tools']

/**
 * One POSIX shell line, tolerant of missing tools:
 *   ==DSHGPU host==    → remote hostname
 *   ==DSHGPU backend== → nvidia-smi | rocm-smi | gpustat | none
 *   ==DSHGPU gpus==    → backend-specific payload
 *   ==DSHGPU temp==    → optional per-GPU temperature (NVIDIA only)
 *   ==DSHGPU uuid==    → index,uuid per GPU (NVIDIA only)
 *   ==DSHGPU procs==   → pid,gpu_uuid,used_memory of the compute apps (NVIDIA only)
 *   ==DSHGPU ps==      → pid,user,command of those processes (NVIDIA only)
 * Each fragment ends with `;` so the fragments join with a plain space: a `;`
 * right after `then`/`else` would not parse.
 */
const DEFAULT_COMMAND = [
  "echo '==DSHGPU host==';",
  'hostname 2>/dev/null || uname -n 2>/dev/null || echo unknown;',
  "echo '==DSHGPU backend==';",
  "if command -v nvidia-smi >/dev/null 2>&1; then echo nvidia-smi; echo '==DSHGPU gpus==';"
    + ' nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total'
    + ' --format=csv,noheader,nounits 2>/dev/null;'
    + " echo '==DSHGPU temp==';"
    + ' nvidia-smi --query-gpu=index,temperature.gpu --format=csv,noheader,nounits 2>/dev/null;'
    + " echo '==DSHGPU uuid==';"
    + ' nvidia-smi --query-gpu=index,uuid --format=csv,noheader,nounits 2>/dev/null;'
    + " echo '==DSHGPU procs==';"
    + ' CA=$(nvidia-smi --query-compute-apps=pid,gpu_uuid,used_memory'
    + ' --format=csv,noheader,nounits 2>/dev/null);'
    + ' echo "$CA";'
    + " echo '==DSHGPU ps==';"
    + ' for p in $(echo "$CA" | cut -d, -f1 | tr -d \' \' | sort -u); do'
    + ' o=$(ps -o user=,comm= -p "$p" 2>/dev/null | tr -s \' \' | tr \' \' \',\');'
    + ' echo "$p,${o:-?}";'
    + ' done;',
  "elif command -v rocm-smi >/dev/null 2>&1; then echo rocm-smi; echo '==DSHGPU gpus==';"
    + ' rocm-smi --showuse --showmemuse --showtemp --json 2>/dev/null;',
  "elif command -v gpustat >/dev/null 2>&1; then echo gpustat; echo '==DSHGPU gpus==';"
    + ' gpustat --json 2>/dev/null;',
  'else echo none; fi;',
  "echo '==DSHGPU end=='",
].join(' ')

const DEFAULTS = {
  intervalMs: 3000,
  commandTimeoutMs: 15000,
  idleStopMs: 120000,
  historyLength: 90,
  idleUtilPercent: 10,
  idleMemoryPercent: 5,
}

/**
 * Is this GPU free enough to hand out to a new job?
 *
 * A card counts as idle when it barely draws power *and* barely holds memory:
 * a model that is loaded but waiting still owns the VRAM, so it is not free.
 * @param {object} gpu - one wire GPU sample.
 * @param {object} settings - the resolved plugin settings.
 * @returns {boolean} true when the card counts as idle.
 */
function isIdleGpu(gpu, settings) {
  const utilization = typeof gpu.utilization === 'number' ? gpu.utilization : null
  const memoryPercent = typeof gpu.memoryPercent === 'number' ? gpu.memoryPercent : null
  if (utilization !== null && utilization >= settings.idleUtilPercent) return false
  if (memoryPercent !== null && memoryPercent >= settings.idleMemoryPercent) return false
  return true
}

/**
 * Coerce the row config into usable settings.
 * @param {any} config - the raw `config` block of the plugin row.
 */
function resolveSettings(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const number = (value, fallback, min, max) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, parsed))
  }
  return {
    intervalMs: number(raw.intervalMs, DEFAULTS.intervalMs, 500, 300000),
    commandTimeoutMs: number(raw.commandTimeoutMs, DEFAULTS.commandTimeoutMs, 1000, 300000),
    idleStopMs: number(raw.idleStopMs, DEFAULTS.idleStopMs, 0, 3600000),
    historyLength: number(raw.historyLength, DEFAULTS.historyLength, 10, 600),
    idleUtilPercent: number(raw.idleUtilPercent, DEFAULTS.idleUtilPercent, 0, 100),
    idleMemoryPercent: number(raw.idleMemoryPercent, DEFAULTS.idleMemoryPercent, 0, 100),
    command: typeof raw.command === 'string' && raw.command.trim() !== '' ? raw.command : DEFAULT_COMMAND,
  }
}

/**
 * Turn a failure into a message plus an actionable hint.
 * @param {string} message - raw failure text.
 */
function describeFailure(message) {
  const text = String(message ?? '').trim() || 'unknown error'
  if (/ToolNotFound|not found|no such tool/i.test(text)) {
    return {
      message: 'dsh-remote is not available: the rw_exec tool is missing.',
      hint: 'Install and enable the dsh-remote plugin, then reconnect.',
    }
  }
  if (/no remote workspace set/i.test(text)) {
    return {
      message: 'dsh-remote has no remote workspace selected.',
      hint: 'Pick a remote workspace (rw_pick_workspace) in dsh-remote first.',
    }
  }
  if (/no remote host resolved/i.test(text)) {
    return {
      message: 'dsh-remote has no remote host connected.',
      hint: 'Connect to a server first (rw_connect).',
    }
  }
  if (/this session is LOCAL/i.test(text)) {
    return { message: text, hint: 'The probe targets the active dsh-remote machine.' }
  }
  if (/timed out/i.test(text)) {
    return { message: text, hint: 'The remote probe timed out; raise commandTimeoutMs if needed.' }
  }
  return { message: text, hint: null }
}

/**
 * Summarize the distinct users across every GPU of the host.
 * @param {object[]} gpus - wire samples.
 * @returns {object[]} user entries, heaviest first.
 */
function summarizeUsers(gpus) {
  const map = new Map()
  for (const gpu of gpus ?? []) {
    for (const entry of gpu.users ?? []) {
      const current = map.get(entry.user) ?? { user: entry.user, count: 0, memory: 0, gpus: 0 }
      current.count += entry.count
      current.memory += entry.memory
      current.gpus += 1
      map.set(entry.user, current)
    }
  }
  return [...map.values()].sort((left, right) => right.count - left.count || right.memory - left.memory)
}

/**
 * Render the current sample as plain text (used by the agent tool).
 * @param {object} snapshot - the served snapshot.
 */
function formatSnapshot(snapshot) {
  if (snapshot.status === 'error') {
    const hint = snapshot.hint ? `\n${snapshot.hint}` : ''
    return `Remote GPU probe failed: ${snapshot.error}${hint}`
  }
  if (snapshot.status !== 'ok') return 'Remote GPU probe has not produced a sample yet.'
  if (!snapshot.gpus.length) return `Remote host ${snapshot.host || 'unknown'}: no GPU visible (${snapshot.backend}).`
  const lines = [`Remote host ${snapshot.host || 'unknown'} — ${snapshot.backend}`]
  if (snapshot.idle) {
    lines.push(`Idle GPUs: ${snapshot.idle.count}/${snapshot.idle.total} (util < ${snapshot.idle.utilPercent}%, memory < ${snapshot.idle.memoryPercent}%)`)
  }
  for (const gpu of snapshot.gpus) {
    const parts = [`GPU ${gpu.index} ${gpu.name}`]
    parts.push(`util ${gpu.utilization === null ? 'n/a' : `${gpu.utilization}%`}`)
    if (gpu.memoryUsed !== null && gpu.memoryTotal !== null) {
      parts.push(`memory ${gpu.memoryUsed}/${gpu.memoryTotal} MiB`)
    }
    if (gpu.temperature !== null) parts.push(`temp ${gpu.temperature}°C`)
    if (gpu.idle) parts.push('idle')
    if (gpu.users && gpu.users.length > 0) {
      parts.push(`users ${gpu.users.map((entry) => `${entry.user}×${entry.count}`).join(', ')}`)
    }
    lines.push(parts.join(' · '))
  }
  if (snapshot.users && snapshot.users.length > 0) {
    lines.push(`Active users: ${snapshot.users.map((entry) => `${entry.user} (${entry.count} proc, ${entry.gpus} GPU)`).join(', ')}`)
  }
  if (snapshot.requests > 0) lines.push(`(GPU panel polled ${snapshot.requests}×)`)
  return lines.join('\n')
}

/**
 * Host plugin entry point.
 * @param {any} ctx - plugin context.
 * @param {any} config - the `config` block of the plugin row.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)

  const state = {
    status: 'idle',
    host: '',
    backend: 'none',
    gpus: [],
    error: null,
    hint: null,
    updatedAt: 0,
    // How often a client asked for the snapshot — proof that the UI is wired.
    requests: 0,
  }
  const history = []
  let timer = null
  let inFlight = null
  let lastRequestAt = 0
  let callSeq = 0
  // The tool registry fuses the caller signal with the wrapper signal and reads
  // `signal.aborted` unguarded, so every execution needs a real AbortSignal.
  // One controller per plugin lifetime also cancels a running probe on unload.
  const abort = new AbortController()

  ctx.effect(() => () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    try { abort.abort() } catch { /* already aborted */ }
  }, 'dsh-remote-gpu.timer')

  /**
   * Run the remote probe through dsh-remote's rw_exec tool.
   * @returns {Promise<void>}
   */
  async function probe() {
    if (inFlight !== null) return inFlight
    callSeq += 1
    const callId = `dsh-remote-gpu-${Date.now().toString(36)}-${callSeq}`
    inFlight = (async () => {
      try {
        // The tools service now takes a batch: `calls` with a JSON-string
        // `arguments` per call, settling to `{ results: [{ callId, result }] }`
        // where each result is the materialized tool result (content blocks).
        // The previous single-call shape made `calls` undefined and the batch
        // scheduler failed with "Tool batch execution failed".
        const batch = await ctx.tools.execute({
          calls: [
            {
              id: callId,
              name: 'rw_exec',
              arguments: JSON.stringify({
                command: settings.command,
                // `rw_exec` promotes a timed-out command to a background job by
                // default, and that path calls `jobs.start({ owner: agent?.id })`.
                // This probe has no agent, so the job registry refuses the owner and
                // the whole call fails with "background jobs unavailable". A probe is
                // a bounded foreground command, so opt out of promotion entirely.
                promoteOnTimeout: false,
                // Fail the call ourselves rather than inheriting a longer budget.
                timeoutMs: Math.min(600000, Math.max(1000, settings.commandTimeoutMs)),
              }),
            },
          ],
          // Required by the registry: the batch scheduler reads `signal.aborted`.
          signal: abort.signal,
        })
        const result = batch?.results?.[0]?.result
        if (!result || result.isError) {
          const caused = result?.error?.message
            ?? batch?.results?.[0]?.result?.error?.message
            ?? result?.content?.[0]?.text
            ?? 'unknown error'
          const failure = describeFailure(caused)
          state.status = 'error'
          state.error = failure.message
          state.hint = failure.hint
          state.updatedAt = Date.now()
          return
        }
        const text = typeof result.content?.[0]?.text === 'string' ? result.content[0].text : ''
        const parsed = parseGpuOutput(text)
        state.status = 'ok'
        state.host = parsed.host
        state.backend = parsed.backend
        state.gpus = parsed.gpus.map(toWireGpu)
        state.error = parsed.error
        state.hint = parsed.error === 'no-gpu-backend'
          ? 'Neither nvidia-smi, rocm-smi nor gpustat was found on the remote host.'
          : parsed.error === 'no-gpu-visible'
            ? (parsed.detail
              ? `The probe tool reported: ${parsed.detail}`
              : 'The probe tool exists but reports no visible GPU.')
            : null
        state.updatedAt = Date.now()
        pushHistory()
      } catch (error) {
        // The batch executor wraps scheduler failures in a generic
        // "Tool batch execution failed"; the real reason is on `cause`.
        const own = error instanceof Error ? error.message : String(error)
        const cause = error?.cause instanceof Error ? error.cause.message : null
        const failure = describeFailure(cause ? `${own} (${cause})` : own)
        state.status = 'error'
        state.error = failure.message
        state.hint = failure.hint
        state.updatedAt = Date.now()
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  /** Append one sample to the sparkline history. */
  function pushHistory() {
    const utilization = state.gpus.reduce((max, gpu) => {
      const value = gpu.utilization
      return typeof value === 'number' && value > max ? value : max
    }, 0)
    history.push({ t: state.updatedAt, util: utilization })
    while (history.length > settings.historyLength) history.shift()
  }

  /** Start the refresh timer when a client starts watching. */
  function ensureTimer() {
    if (timer !== null) return
    timer = setInterval(() => {
      if (settings.idleStopMs > 0 && Date.now() - lastRequestAt > settings.idleStopMs) {
        clearInterval(timer)
        timer = null
        return
      }
      void probe()
    }, settings.intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /**
   * The JSON payload the client renders.
   * @returns {object} snapshot.
   */
  function snapshot() {
    const gpus = state.gpus.map((gpu) => ({ ...gpu, idle: isIdleGpu(gpu, settings) }))
    return {
      status: state.status,
      host: state.host,
      backend: state.backend,
      gpus,
      users: summarizeUsers(state.gpus),
      idle: {
        count: gpus.filter((gpu) => gpu.idle).length,
        total: gpus.length,
        utilPercent: settings.idleUtilPercent,
        memoryPercent: settings.idleMemoryPercent,
      },
      error: state.error,
      hint: state.hint,
      updatedAt: state.updatedAt,
      requests: state.requests,
      intervalMs: settings.intervalMs,
      command: settings.command,
      history: history.slice(-settings.historyLength),
    }
  }

  const routes = [
    {
      path: '/dsh-remote-gpu/gpu',
      methods: ['GET'],
      requestBody: 'buffered',
      async handler(req, res) {
        lastRequestAt = Date.now()
        state.requests += 1
        ensureTimer()
        const stale = state.updatedAt === 0 || Date.now() - state.updatedAt > settings.intervalMs
        if (stale) {
          const pending = probe()
          // The very first caller waits for the sample; later callers get the
          // cached one right away and the refresh lands in the background.
          if (state.updatedAt === 0) await pending
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(snapshot()))
      },
    },
  ]

  registerHttpTransports(ctx, routes)

  ctx.effect(() => ctx.tools.register({
    name: 'remote_gpu',
    description:
      'Live GPU utilization of the server dsh-remote is connected to: per-GPU compute load, '
      + 'memory usage, temperature, the remote hostname and the users whose processes occupy '
      + 'each GPU. Use it to check whether the remote GPU is busy, idle, hot or out of memory, '
      + 'and who is using it.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: 'Human readable GPU summary.' },
        },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
    },
    async execute() {
      await probe()
      return { text: formatSnapshot(snapshot()) }
    },
  }), 'dsh-remote-gpu.tool')
}
