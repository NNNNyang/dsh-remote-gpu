// dsh-remote-gpu — pure parsing of the remote probe output.
//
// The probe prints marker-delimited sections; everything else the remote
// shell may add (stderr, exit-code notes) lands in the trailing `end` section
// and is ignored. Nothing in here touches the network or the filesystem, so
// the parser is unit-testable on its own.

const MARKER = /^==DSHGPU ([a-z]+)==$/

/**
 * Split the probe output into its marker-delimited sections.
 * @param {string} text - raw remote output.
 * @returns {Record<string, string[]>} section name → lines.
 */
export function splitSections(text) {
  const sections = {}
  let current = null
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = MARKER.exec(line.trim())
    if (match) {
      current = match[1]
      if (!sections[current]) sections[current] = []
      continue
    }
    if (current === null) continue
    sections[current].push(line)
  }
  return sections
}

/**
 * Parse a scalar into a number, or null when the value is not a number.
 * @param {unknown} value - raw value.
 * @returns {number|null}
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === 'N/A' || trimmed === '[N/A]') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * First numeric value among the named keys, with a loose contains-fallback.
 * @param {Record<string, unknown>} source - flat record.
 * @param {string[]} keys - candidate key names.
 * @returns {number|null}
 */
function pickNumber(source, keys) {
  for (const key of keys) {
    if (source[key] === undefined) continue
    const value = toNumber(source[key])
    if (value !== null) return value
  }
  for (const [key, value] of Object.entries(source)) {
    if (!keys.some((candidate) => key.includes(candidate))) continue
    const parsed = toNumber(value)
    if (parsed !== null) return parsed
  }
  return null
}

/**
 * First non-empty string among the named keys.
 * @param {Record<string, unknown>} source - flat record.
 * @param {string[]} keys - candidate key names.
 * @returns {string|null}
 */
function pickString(source, keys) {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || value.trim() === '') continue
    if (!keys.some((candidate) => key.includes(candidate))) continue
    return value.trim()
  }
  return null
}

/**
 * Parse the `index,uuid` section into a uuid → index map.
 * @param {string[]} lines - `index,uuid` lines.
 * @returns {Map<string, number>} uuid (lower case) → GPU index.
 */
function parseUuidMap(lines) {
  const map = new Map()
  for (const line of lines) {
    if (!line.trim()) continue
    const parts = line.split(',').map((part) => part.trim())
    if (parts.length < 2) continue
    const index = toNumber(parts[0])
    const uuid = parts[1]
    if (index === null || uuid === '') continue
    map.set(uuid.toLowerCase(), index)
  }
  return map
}

/**
 * Parse the `pid,user,command` section produced by `ps`.
 * @param {string[]} lines - `pid,user,command` lines.
 * @returns {Map<number, {user: string, command: string}>} pid → owner.
 */
function parseProcessOwners(lines) {
  const map = new Map()
  for (const line of lines) {
    if (!line.trim()) continue
    const parts = line.split(',').map((part) => part.trim())
    if (parts.length < 2) continue
    const pid = toNumber(parts[0])
    if (pid === null) continue
    const user = parts[1] === '' ? '?' : parts[1]
    const command = parts.slice(2).join(',').trim()
    map.set(pid, { user, command })
  }
  return map
}

/**
 * Parse the `pid,gpu_uuid,used_memory` section into per-GPU process lists.
 * @param {string[]} lines - compute-app lines.
 * @param {Map<string, number>} uuidToIndex - uuid → GPU index.
 * @param {Map<number, {user: string, command: string}>} owners - pid → owner.
 * @returns {Map<number, object[]>} GPU index → processes.
 */
function parseComputeApps(lines, uuidToIndex, owners) {
  const perGpu = new Map()
  for (const line of lines) {
    if (!line.trim()) continue
    const parts = line.split(',').map((part) => part.trim())
    if (parts.length < 3) continue
    const pid = toNumber(parts[0])
    if (pid === null) continue
    const uuid = parts[1].toLowerCase()
    const usedMemory = toNumber(parts[parts.length - 1])
    const index = uuidToIndex.get(uuid)
    if (index === undefined) continue
    const owner = owners.get(pid)
    const entry = {
      pid,
      user: owner?.user ?? '?',
      command: owner?.command ?? '',
      usedMemory: usedMemory === null ? null : Math.round(usedMemory),
    }
    if (!perGpu.has(index)) perGpu.set(index, [])
    perGpu.get(index).push(entry)
  }
  return perGpu
}

/**
 * Parse the `nvidia-smi --query-gpu` CSV payload.
 * @param {string[]} lines - payload lines.
 * @param {string[]} tempLines - `index,temperature` lines.
 * @param {{uuidLines: string[], procLines: string[], psLines: string[]}} extra - process sections.
 * @returns {object[]} GPU samples.
 */
function parseNvidia(lines, tempLines, extra) {
  const temperatures = new Map()
  for (const line of tempLines) {
    if (!line.trim()) continue
    const parts = line.split(',').map((part) => part.trim())
    if (parts.length < 2) continue
    const index = toNumber(parts[0])
    const value = toNumber(parts[1])
    if (index === null || value === null) continue
    temperatures.set(index, value)
  }

  const uuidToIndex = parseUuidMap(extra?.uuidLines ?? [])
  const owners = parseProcessOwners(extra?.psLines ?? [])
  const processes = parseComputeApps(extra?.procLines ?? [], uuidToIndex, owners)

  const gpus = []
  for (const line of lines) {
    if (!line.trim()) continue
    const parts = line.split(',').map((part) => part.trim())
    // index, name, utilization.gpu, memory.used, memory.total
    if (parts.length < 5) continue
    const index = toNumber(parts[0])
    if (index === null) continue
    const utilization = toNumber(parts[parts.length - 3])
    const memoryUsed = toNumber(parts[parts.length - 2])
    const memoryTotal = toNumber(parts[parts.length - 1])
    const name = parts.slice(1, parts.length - 3).join(', ').trim() || `GPU ${index}`
    gpus.push({
      index,
      name,
      utilization,
      memoryUsed,
      memoryTotal,
      temperature: temperatures.get(index) ?? null,
      processes: processes.get(index) ?? [],
    })
  }
  return gpus
}

/**
 * Parse the `rocm-smi --json` payload.
 * @param {string[]} lines - payload lines.
 * @returns {object[]} GPU samples.
 */
function parseRocm(lines) {
  const text = lines.join('\n').trim()
  if (text === '') return []
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  if (!data || typeof data !== 'object') return []

  const gpus = []
  let position = 0
  for (const [key, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object') continue
    const utilization = pickNumber(value, ['GPU use (%)', 'GPU use', 'GPU Utilization (%)'])
    const totalBytes = pickNumber(value, ['VRAM Total Memory (B)', 'VRAM Total Memory'])
    const usedBytes = pickNumber(value, ['VRAM Total Used Memory (B)', 'VRAM Total Used Memory'])
    const temperature = pickNumber(value, [
      'Temperature (Sensor edge) (C)',
      'Temperature (Sensor junction) (C)',
      'Temperature (C)',
    ])
    if (utilization === null && totalBytes === null) continue
    const digits = String(key).replace(/\D/g, '')
    const index = digits === '' ? position : Number(digits)
    gpus.push({
      index: Number.isFinite(index) ? index : position,
      name: pickString(value, ['GPU Series', 'Card series', 'Card SKU', 'Card model']) || `GPU ${position}`,
      utilization,
      memoryUsed: usedBytes === null ? null : Math.round(usedBytes / 1024 / 1024),
      memoryTotal: totalBytes === null ? null : Math.round(totalBytes / 1024 / 1024),
      temperature,
      processes: [],
    })
    position += 1
  }
  return gpus
}

/**
 * Parse the `gpustat --json` payload.
 * @param {string[]} lines - payload lines.
 * @returns {object[]} GPU samples.
 */
function parseGpustat(lines) {
  const text = lines.join('\n').trim()
  if (text === '') return []
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.gpus) ? data.gpus : []
  return list.map((entry, position) => {
    const memory = entry?.memory ?? {}
    return {
      index: toNumber(entry?.index) ?? position,
      name: (typeof entry?.name === 'string' && entry.name.trim()) || `GPU ${position}`,
      utilization: toNumber(entry?.utilization_gpu ?? entry?.utilization),
      memoryUsed: toNumber(entry?.memory_used ?? memory.used),
      memoryTotal: toNumber(entry?.memory_total ?? entry?.capacity ?? memory.total),
      temperature: toNumber(entry?.temperature_gpu ?? entry?.temperature),
      processes: [],
    }
  })
}

/**
 * Parse the whole probe output.
 * @param {string} text - raw remote output.
 * @returns {{host: string, backend: string, gpus: object[], error: string|null}}
 */
export function parseGpuOutput(text) {
  const sections = splitSections(text)
  const host = (sections.host ?? []).map((line) => line.trim()).find((line) => line !== '') ?? ''
  const backend = ((sections.backend ?? []).map((line) => line.trim()).find((line) => line !== '') ?? 'none').toLowerCase()
  const payload = sections.gpus ?? []

  let gpus = []
  let error = null
  if (backend === 'nvidia-smi') {
    gpus = parseNvidia(payload, sections.temp ?? [], {
      uuidLines: sections.uuid ?? [],
      procLines: sections.procs ?? [],
      psLines: sections.ps ?? [],
    })
    if (gpus.length === 0) error = 'no-gpu-visible'
  } else if (backend === 'rocm-smi') {
    gpus = parseRocm(payload)
    if (gpus.length === 0) error = 'no-gpu-visible'
  } else if (backend === 'gpustat') {
    gpus = parseGpustat(payload)
    if (gpus.length === 0) error = 'no-gpu-visible'
  } else {
    error = 'no-gpu-backend'
  }

  // When nothing could be parsed the payload usually carries the tool's own
  // complaint (a driver error, a permission problem). Keep the first
  // meaningful line so the UI can show the real reason.
  let detail = null
  if (gpus.length === 0) {
    const lines = [...(sections.gpus ?? []), ...(sections.temp ?? [])]
    detail = lines
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('==')) ?? null
  }

  return { host, backend, gpus, error, detail }
}

/**
 * Shape one GPU sample for the wire: memory percentage included.
 * @param {object} gpu - raw sample.
 * @returns {object} wire sample.
 */
export function toWireGpu(gpu) {
  const memoryPercent =
    gpu.memoryUsed !== null && gpu.memoryTotal ? (gpu.memoryUsed / gpu.memoryTotal) * 100 : null
  const processes = (gpu.processes ?? []).map((process) => ({
    pid: process.pid,
    user: process.user,
    command: process.command,
    usedMemory: process.usedMemory,
  }))
  // One entry per user, heaviest first, so the UI can show "root×2 · zhang×1".
  const users = []
  for (const process of processes) {
    let entry = users.find((candidate) => candidate.user === process.user)
    if (!entry) {
      entry = { user: process.user, count: 0, memory: 0 }
      users.push(entry)
    }
    entry.count += 1
    entry.memory += process.usedMemory ?? 0
  }
  users.sort((left, right) => right.count - left.count || right.memory - left.memory)
  return {
    index: gpu.index,
    name: gpu.name,
    utilization: gpu.utilization,
    memoryUsed: gpu.memoryUsed,
    memoryTotal: gpu.memoryTotal,
    memoryPercent: memoryPercent === null ? null : Math.round(memoryPercent * 10) / 10,
    temperature: gpu.temperature,
    processes,
    users,
  }
}
