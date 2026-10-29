// dsh-remote-gpu — client half.
//
// Three seats in the Harness UI:
//   • a sidebar-right tab that shows every GPU of the remote server,
//   • a compact chip in the conversation header,
//   • a settings section describing the probe.
//
// The client is a classic script registered through the browser module loader;
// the factory receives a synchronous `require`.

window.__ModuleLoader__.load({
  id: '@local/dsh-remote-gpu',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef } = React

    const NS = 'dsh-remote-gpu'
    const KIND = 'dsh-remote-gpu/gpu'
    const GUIDE_ORDER = 56

    /** The plugin context, kept so the chip can reach the right-sidebar controller on click. */
    let pluginCtx = null
    /** The right-sidebar controller, provided by the `dsh-client-ui-sidebar-right` client plugin. */
    let sidebarController = null

    /**
     * Open the GPU tab in the right sidebar.
     * The `sidebarRight` service is optional: without it the chip simply does nothing.
     */
    function openGpuPanel() {
      const sidebar = sidebarController || (pluginCtx && pluginCtx.get('sidebarRight'))
      if (!sidebar || typeof sidebar.openTab !== 'function') return false
      try {
        sidebar.openTab(KIND)
        return true
      } catch (error) {
        console.warn('[dsh-remote-gpu] could not open the GPU panel:', error)
        return false
      }
    }

    const zh = {
      'tab.title': '远程显卡',
      'guide.title': '远程显卡占用',
      'chip.title': '远程服务器显卡占用（{host}）',
      'chip.title.error': '远程服务器显卡探测失败（{host}）：{error}',
      'chip.hint': '点击打开远程显卡面板',
      'chip.idle': '空闲 {idle}/{total}',
      'settings.title': '远程显卡',
      'settings.heading': '远程服务器显卡占用',
      'settings.status': '状态',
      'settings.status.ok': '正常',
      'settings.status.error': '探测失败',
      'settings.status.idle': '等待探测',
      'settings.idle': '空闲显卡',
      'settings.host': '远程主机',
      'settings.backend': '探测方式',
      'settings.interval': '刷新间隔',
      'settings.updated': '最近更新',
      'settings.command': '探测命令',
      'settings.refresh': '立即刷新',
      'settings.refreshing': '刷新中…',
      'settings.empty': '远程服务器上没有检测到显卡。',
      'settings.hint': '提示',
      'loading': '正在探测远程显卡…',
      'error.fetch': '无法连接宿主服务：{message}',
      'error.remote': '远程探测失败',
      'gpu.util': '占用',
      'gpu.memory': '显存',
      'gpu.temp': '温度',
      'gpu.none': '无',
      'gpu.count': '{count} 张显卡',
      'gpu.idle': '空闲 {count} 张',
      'gpu.idle.tag': '空闲',
      'gpu.users.count': '{count} 个用户',
      'gpu.users.by': '占用',
      'gpu.users.active': '活跃用户',
      'gpu.users.none': '当前没有进程占用显卡',
      'gpu.users.detail': '{count} 个进程 · {gpus} 张卡 · {memory}',
      'history': '最近 {count} 次采样',
    }

    const en = {
      'tab.title': 'Remote GPU',
      'guide.title': 'Remote GPU usage',
      'chip.title': 'Remote server GPU usage ({host})',
      'chip.title.error': 'Remote GPU probe failed ({host}): {error}',
      'chip.hint': 'Click to open the remote GPU panel',
      'chip.idle': '{idle}/{total} idle',
      'settings.title': 'Remote GPU',
      'settings.heading': 'Remote server GPU usage',
      'settings.status': 'Status',
      'settings.status.ok': 'OK',
      'settings.status.error': 'Probe failed',
      'settings.status.idle': 'Waiting for the first probe',
      'settings.idle': 'Idle GPUs',
      'settings.host': 'Remote host',
      'settings.backend': 'Probe backend',
      'settings.interval': 'Refresh interval',
      'settings.updated': 'Last update',
      'settings.command': 'Probe command',
      'settings.refresh': 'Refresh now',
      'settings.refreshing': 'Refreshing…',
      'settings.empty': 'No GPU was detected on the remote server.',
      'settings.hint': 'Hint',
      'loading': 'Probing the remote GPU…',
      'error.fetch': 'Cannot reach the host service: {message}',
      'error.remote': 'Remote probe failed',
      'gpu.util': 'utilization',
      'gpu.memory': 'memory',
      'gpu.temp': 'temp',
      'gpu.none': 'none',
      'gpu.count': '{count} GPU(s)',
      'gpu.idle': '{count} idle',
      'gpu.idle.tag': 'idle',
      'gpu.users.count': '{count} user(s)',
      'gpu.users.by': 'used by',
      'gpu.users.active': 'Active users',
      'gpu.users.none': 'No process is occupying a GPU right now',
      'gpu.users.detail': '{count} proc(s) · {gpus} GPU(s) · {memory}',
      'history': 'last {count} samples',
    }

    const DICT = { zh, en }

    /**
     * Fill `{name}` placeholders.
     * @param {string} template - text with placeholders.
     * @param {object} params - values.
     */
    function interpolate(template, params) {
      if (!params) return template
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        params[key] === undefined || params[key] === null ? match : String(params[key])
      ))
    }

    let tr = (key, params) => interpolate(DICT.zh[key] ?? DICT.en[key] ?? key, params)

    /** Palette shared by every surface. */
    const TONE = {
      ok: 'var(--dsw-alias-state-success-primary, #4caf7d)',
      warn: 'var(--dsw-alias-state-warn-primary, #e2b341)',
      danger: 'var(--dsw-alias-state-error-primary, #e05c5c)',
      muted: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
    }

    /** The brand colour used for memory and for the history line. */
    const BRAND = 'var(--dsw-alias-brand-primary, #6aa2ff)'

    /** How long a value takes to glide to its real reading. */
    const TWEEN_MS = 520

    /** Fallback thresholds for "this card is free" when the host did not say. */
    const IDLE_UTIL_PERCENT = 10
    const IDLE_MEMORY_PERCENT = 5

    /**
     * The plugin stylesheet. It is injected once while the plugin is active and
     * removed again when the plugin goes away.
     */
    const STYLES = `
.dsh-rg-card { animation: dsh-rg-rise 300ms cubic-bezier(0.22, 0.61, 0.36, 1) both; }
@keyframes dsh-rg-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.dsh-rg-bar-fill { transition: background-color 520ms ease; }
.dsh-rg-dot { transition: background-color 520ms ease; }
.dsh-rg-live { animation: dsh-rg-pulse 2.2s ease-in-out infinite; }
@keyframes dsh-rg-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.dsh-rg-skeleton { position: relative; overflow: hidden; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.18)); border-radius: 8px; }
.dsh-rg-skeleton::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, var(--dsw-alias-bg-layer-3, rgba(255,255,255,0.14)), transparent); transform: translateX(-100%); animation: dsh-rg-sheen 1.6s ease-in-out infinite; }
@keyframes dsh-rg-sheen { to { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) {
  .dsh-rg-card, .dsh-rg-live, .dsh-rg-skeleton::after { animation: none !important; }
  .dsh-rg-bar-fill, .dsh-rg-dot { transition: none !important; }
}
`

    /**
     * Whether the user asked the operating system to reduce motion.
     * @returns {boolean} true when animations should be skipped.
     */
    function prefersReducedMotion() {
      try {
        return typeof window !== 'undefined'
          && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      } catch (error) {
        return false
      }
    }

    /**
     * The animation length to use, honouring the reduced-motion preference.
     * @param {number} duration - the preferred length in milliseconds.
     * @returns {number} the length to use (0 means "no animation").
     */
    function useMotionDuration(duration) {
      const [reduced, setReduced] = useState(prefersReducedMotion)
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
        const query = window.matchMedia('(prefers-reduced-motion: reduce)')
        const onChange = () => setReduced(query.matches)
        query.addEventListener('change', onChange)
        return () => query.removeEventListener('change', onChange)
      }, [])
      return reduced ? 0 : duration
    }

    /**
     * One animation frame loop shared by every tween, so a panel with many GPUs
     * still costs a single rAF callback per frame.
     */
    const ticker = (() => {
      const tasks = new Set()
      let handle = 0
      let last = 0
      const frame = (now) => {
        const delta = last === 0 ? 16 : now - last
        last = now
        let alive = false
        for (const task of Array.from(tasks)) {
          let keep = true
          try {
            keep = task(delta) !== false
          } catch (error) {
            keep = false
          }
          if (keep) alive = true
          else tasks.delete(task)
        }
        if (alive) handle = requestAnimationFrame(frame)
        else {
          handle = 0
          last = 0
        }
      }
      return {
        add(task) {
          tasks.add(task)
          if (handle === 0) {
            last = 0
            handle = requestAnimationFrame(frame)
          }
        },
        remove(task) {
          tasks.delete(task)
        },
      }
    })()

    /**
     * Ease out cubic: quick at the start, gentle at the end.
     * @param {number} t - progress between 0 and 1.
     * @returns {number} the eased progress.
     */
    function easeOut(t) {
      return 1 - Math.pow(1 - t, 3)
    }

    /**
     * Tween a number towards its real value so it glides instead of jumping.
     * @param {number|null} target - the real value.
     * @param {number} duration - animation length in milliseconds.
     * @returns {number|null} the value to display.
     */
    function useTweenNumber(target, duration) {
      const [value, setValue] = useState(() => (typeof target === 'number' ? target : null))
      const current = useRef(typeof target === 'number' ? target : null)
      useEffect(() => {
        if (typeof target !== 'number' || !Number.isFinite(target)) return undefined
        if (!duration) {
          current.current = target
          setValue(target)
          return undefined
        }
        const start = current.current
        if (start === null || Math.abs(start - target) < 0.001) {
          current.current = target
          setValue(target)
          return undefined
        }
        let elapsed = 0
        const task = (delta) => {
          elapsed += delta
          const t = Math.min(1, elapsed / duration)
          const next = start + (target - start) * easeOut(t)
          current.current = next
          setValue(next)
          if (t >= 1) {
            current.current = target
            setValue(target)
            return false
          }
          return true
        }
        ticker.add(task)
        return () => ticker.remove(task)
      }, [target, duration])
      return value
    }

    /**
     * Tween a series of numbers towards its real values, matching them by index.
     * The series grows by one sample per poll, so the shorter side is padded to
     * keep the indexes aligned.
     * @param {number[]} target - the real values.
     * @param {number} duration - animation length in milliseconds.
     * @returns {number[]} the values to display.
     */
    function useTweenSeries(target, duration) {
      const [display, setDisplay] = useState(target)
      const current = useRef(target)
      useEffect(() => {
        const to = Array.isArray(target) ? target : []
        const from0 = current.current
        if (!from0 || from0.length === 0 || to.length === 0 || !duration) {
          current.current = to
          setDisplay(to)
          return undefined
        }
        let from = from0
        if (from.length !== to.length) {
          from = from.length < to.length
            ? new Array(to.length - from.length).fill(from[0]).concat(from)
            : from.slice(from.length - to.length)
        }
        let elapsed = 0
        const task = (delta) => {
          elapsed += delta
          const t = Math.min(1, elapsed / duration)
          const e = easeOut(t)
          const next = to.map((value, index) => from[index] + (value - from[index]) * e)
          current.current = next
          setDisplay(next)
          if (t >= 1) {
            current.current = to
            setDisplay(to)
            return false
          }
          return true
        }
        ticker.add(task)
        return () => ticker.remove(task)
      }, [target, duration])
      return display
    }

    /**
     * Pick the tone for a utilization percentage.
     * @param {number|null} value - utilization.
     */
    function toneFor(value) {
      if (typeof value !== 'number') return 'muted'
      if (value >= 90) return 'danger'
      if (value >= 60) return 'warn'
      return 'ok'
    }

    /**
     * Is this GPU free enough for a new job?
     *
     * A card counts as idle when it barely draws power *and* barely holds memory:
     * a model that is loaded but waiting still owns the VRAM, so it is not free.
     * The host sends the verdict; the thresholds below are the fallback.
     * @param {object} gpu - one GPU sample.
     * @returns {boolean} true when the card counts as idle.
     */
    function isIdleGpu(gpu) {
      if (typeof gpu.idle === 'boolean') return gpu.idle
      const utilization = typeof gpu.utilization === 'number' ? gpu.utilization : null
      const memoryPercent = typeof gpu.memoryPercent === 'number' ? gpu.memoryPercent : null
      if (utilization !== null && utilization >= IDLE_UTIL_PERCENT) return false
      if (memoryPercent !== null && memoryPercent >= IDLE_MEMORY_PERCENT) return false
      return true
    }

    /**
     * How many of the remote GPUs are free.
     * @param {object[]} gpus - GPU samples.
     * @returns {{idle: number, total: number}} idle and total counts.
     */
    function idleCounts(gpus) {
      const list = gpus ?? []
      return { idle: list.filter(isIdleGpu).length, total: list.length }
    }

    /**
     * Chip colour for the number of free cards.
     * @param {{idle: number, total: number}} counts - idle and total counts.
     * @returns {string} a tone key.
     */
    function idleTone(counts) {
      if (!counts.total) return 'muted'
      if (counts.idle === counts.total) return 'ok'
      if (counts.idle > 0) return 'warn'
      return 'danger'
    }

    /**
     * Group processes by user; heaviest user first.
     * @param {object[]} processes - process entries of one GPU.
     * @returns {object[]} user entries.
     */
    function summarizeUsers(processes) {
      const users = []
      for (const process of processes ?? []) {
        let entry = users.find((candidate) => candidate.user === process.user)
        if (!entry) {
          entry = { user: process.user, count: 0, memory: 0 }
          users.push(entry)
        }
        entry.count += 1
        entry.memory += process.usedMemory ?? 0
      }
      users.sort((left, right) => right.count - left.count || right.memory - left.memory)
      return users
    }

    /**
     * Human readable memory size.
     * @param {number|null} value - size in MiB.
     */
    function formatMiB(value) {
      if (typeof value !== 'number') return '--'
      if (value >= 1024) return `${(value / 1024).toFixed(1)} GiB`
      return `${Math.round(value)} MiB`
    }

    /** The path of a plugin route under the current host protocol. */
    function apiPath(path) {
      return window.location.protocol === 'dsh-app:' ? `/api${path}` : path
    }

    /**
     * The shared poller. One request in flight at a time, one timer for every
     * mounted surface, and the poll cadence follows the host's own interval.
     */
    const store = (() => {
      let snapshot = null
      let failure = null
      let timer = null
      let refreshing = false
      const subscribers = new Set()

      const notify = () => {
        for (const subscriber of Array.from(subscribers)) {
          try {
            subscriber(snapshot, failure)
          } catch (error) {
            console.warn('[dsh-remote-gpu] subscriber failed:', error)
          }
        }
      }

      const refresh = async () => {
        if (refreshing) return
        refreshing = true
        try {
          const response = await fetch(apiPath('/dsh-remote-gpu/gpu'), {
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          snapshot = await response.json()
          failure = null
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        } finally {
          refreshing = false
          notify()
        }
      }

      const schedule = () => {
        if (timer !== null) clearTimeout(timer)
        timer = null
        if (subscribers.size === 0) return
        const interval = Number(snapshot && snapshot.intervalMs)
        const delay = Number.isFinite(interval) && interval >= 1000 ? interval : 3000
        timer = setTimeout(() => {
          void refresh().then(schedule)
        }, delay)
      }

      return {
        subscribe(subscriber) {
          subscribers.add(subscriber)
          if (subscribers.size === 1) void refresh().then(schedule)
          return () => {
            subscribers.delete(subscriber)
            if (subscribers.size === 0 && timer !== null) {
              clearTimeout(timer)
              timer = null
            }
          }
        },
        refresh,
        get() {
          return { snapshot, failure }
        },
      }
    })()

    /**
     * Subscribe a component to the shared poller.
     * @param {boolean} active - whether the surface is on screen.
     */
    function useGpu(active) {
      const initial = store.get()
      const [state, setState] = useState(() => ({ snapshot: initial.snapshot, failure: initial.failure }))
      useEffect(() => {
        if (active === false) return undefined
        return store.subscribe((snapshot, failure) => setState({ snapshot, failure }))
      }, [active])
      return state
    }

    /**
     * A thin progress bar. The width arrives already tweened, so the bar glides
     * instead of jumping; only the colour still needs a CSS transition.
     */
    function Meter(props) {
      const percent = typeof props.percent === 'number' ? Math.min(100, Math.max(0, props.percent)) : null
      const height = props.height ?? 6
      return h(
        'div',
        {
          className: 'dsh-rg-bar',
          style: {
            height,
            borderRadius: height / 2,
            background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.25))',
            overflow: 'hidden',
          },
        },
        percent === null
          ? null
          : h('div', {
              className: 'dsh-rg-bar-fill',
              style: {
                width: `${percent}%`,
                height: '100%',
                borderRadius: height / 2,
                background: props.color ?? TONE.ok,
              },
            }),
      )
    }

    /** A utilization history sparkline that glides between samples. */
    function Sparkline(props) {
      const duration = useMotionDuration(TWEEN_MS)
      const width = props.width ?? 96
      const height = props.height ?? 24
      const history = Array.isArray(props.history) ? props.history : []
      const target = useMemo(
        () => history.map((entry) => (typeof entry.util === 'number' ? entry.util : 0)),
        [history],
      )
      const points = useTweenSeries(target, duration)
      if (!points || points.length < 2) return null
      const step = width / (points.length - 1)
      const coords = points.map((value, index) => {
        const clamped = Math.min(100, Math.max(0, value))
        const x = (index * step).toFixed(1)
        const y = (height - (clamped / 100) * height).toFixed(1)
        return `${x},${y}`
      })
      const line = coords.join(' ')
      const tail = coords[coords.length - 1].split(',')
      return h(
        'svg',
        {
          width,
          height,
          viewBox: `0 0 ${width} ${height}`,
          'aria-hidden': 'true',
          style: { display: 'block', flex: 'none', overflow: 'visible' },
        },
        h('polygon', {
          points: `0,${height} ${line} ${width},${height}`,
          fill: BRAND,
          fillOpacity: 0.12,
        }),
        h('polyline', {
          points: line,
          fill: 'none',
          stroke: BRAND,
          strokeWidth: 1.5,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
        h('circle', { cx: tail[0], cy: tail[1], r: 2, fill: BRAND }),
      )
    }

    /** One GPU row; every number eases towards its real value. */
    function GpuCard(props) {
      const gpu = props.gpu
      const duration = useMotionDuration(TWEEN_MS)
      const utilization = useTweenNumber(
        typeof gpu.utilization === 'number' ? gpu.utilization : null,
        duration,
      )
      const memoryPercent = useTweenNumber(
        typeof gpu.memoryPercent === 'number' ? gpu.memoryPercent : null,
        duration,
      )
      const temperature = useTweenNumber(
        typeof gpu.temperature === 'number' ? gpu.temperature : null,
        duration,
      )
      const tone = toneFor(gpu.utilization)
      const color = TONE[tone]
      const hasMemory = gpu.memoryUsed !== null && gpu.memoryUsed !== undefined
      const memory = hasMemory
        ? `${formatMiB(gpu.memoryUsed)} / ${formatMiB(gpu.memoryTotal)}`
        : tr('gpu.none')
      const memoryShort = hasMemory
        ? `${formatMiB(gpu.memoryUsed).replace(' ', '')}/${formatMiB(gpu.memoryTotal).replace(' ', '')}`
        : tr('gpu.none')
      const temperatureText = typeof temperature === 'number'
        ? `${Math.round(temperature)} °C`
        : '--'
      const processes = Array.isArray(gpu.processes) ? gpu.processes : []
      const idle = isIdleGpu(gpu)
      const users = Array.isArray(gpu.users) && gpu.users.length > 0
        ? gpu.users
        : summarizeUsers(processes)
      const userSummary = users.length === 0
        ? null
        : users.map((entry) => `${entry.user}×${entry.count}`).join(' · ')
      const processDetails = processes.map((process) => [
        `${process.user} · ${process.command || '?'}`,
        `(pid ${process.pid}${process.usedMemory === null || process.usedMemory === undefined
          ? ''
          : `, ${process.usedMemory} MiB`})`,
      ].join(' '))
      const tooltip = [
        `${tr('gpu.memory')}: ${memory}`,
        `${tr('gpu.temp')}: ${temperatureText}`,
        ...processDetails,
      ].join('\n')
      return h(
        'div',
        {
          className: 'dsh-rg-card',
          style: {
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 8,
            padding: '7px 10px',
            background: 'var(--dsw-alias-bg-layer-1)',
            display: 'flex',
            flexDirection: 'column',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 } },
          h(
            'span',
            {
              style: {
                fontSize: 12,
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            `GPU ${gpu.index} · ${gpu.name}`,
            idle
              ? h(
                  'span',
                  {
                    style: {
                      marginLeft: 6,
                      padding: '0 4px',
                      borderRadius: 4,
                      border: '1px solid var(--dsw-alias-state-success-primary, #4caf7d)',
                      color: TONE.ok,
                      fontSize: 10,
                      fontWeight: 500,
                      verticalAlign: 'middle',
                    },
                  },
                  tr('gpu.idle.tag'),
                )
              : null,
          ),
          h(
            'span',
            {
              style: {
                fontSize: 16,
                fontWeight: 600,
                color,
                fontVariantNumeric: 'tabular-nums',
                flex: 'none',
                transition: 'color 520ms ease',
              },
            },
            typeof utilization === 'number' ? `${Math.round(utilization)}%` : '--',
          ),
        ),
        h('div', { style: { marginTop: 5 } }, h(Meter, { percent: utilization, color, height: 5 })),
        h('div', { style: { marginTop: 3 } }, h(Meter, { percent: memoryPercent, color: BRAND, height: 3 })),
        h(
          'div',
          {
            title: tooltip,
            style: {
              display: 'flex',
              flexWrap: 'nowrap',
              alignItems: 'center',
              gap: 6,
              marginTop: 5,
              fontSize: 11,
              color: 'var(--dsw-alias-label-secondary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            },
          },
          h('span', null, memoryShort),
          typeof memoryPercent === 'number'
            ? h('span', null, `${Math.round(memoryPercent)}%`)
            : null,
          h('span', null, temperatureText),
          userSummary === null
            ? null
            : h(
                'span',
                { style: { color: 'var(--dsw-alias-label-tertiary)' } },
                `${tr('gpu.users.by')} ${userSummary}`,
              ),
        ),
        props.showProcesses && processes.length > 0
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  marginTop: 5,
                  paddingTop: 4,
                  borderTop: '1px solid var(--dsw-alias-border-l1)',
                  fontSize: 10,
                  color: 'var(--dsw-alias-label-tertiary)',
                },
              },
              ...processes.map((process) => h(
                'div',
                { key: process.pid, style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                `${process.user} · ${process.command || '?'} · pid ${process.pid}`
                  + (typeof process.usedMemory === 'number' ? ` · ${formatMiB(process.usedMemory)}` : ''),
              )),
            )
          : null,
      )
    }

    /** The sidebar tab body. */
    function GpuPanel(props) {
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
      const visible = info && info.tab ? info.tab.visible !== false : true
      const { snapshot, failure } = useGpu(visible)

      const body = useMemo(() => {
        if (failure) {
          return h(
            'div',
            {
              style: {
                padding: 12,
                fontSize: 12,
                color: TONE.danger,
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 8,
              },
            },
            tr('error.fetch', { message: failure }),
          )
        }
        if (!snapshot) {
          return h(
            'div',
            { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 10 } },
            h('div', { className: 'dsh-rg-skeleton', style: { height: 14, width: '55%' } }),
            h('div', { className: 'dsh-rg-skeleton', style: { height: 42, width: '100%' } }),
          )
        }
        if (snapshot.status === 'error') {
          return h(
            'div',
            {
              style: {
                padding: 12,
                fontSize: 12,
                color: TONE.danger,
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              },
            },
            h('div', null, `${tr('error.remote')}: ${snapshot.error ?? ''}`),
            snapshot.hint ? h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, snapshot.hint) : null,
          )
        }
        if (!snapshot.gpus || snapshot.gpus.length === 0) {
          return h(
            'div',
            {
              style: {
                padding: 12,
                fontSize: 12,
                color: 'var(--dsw-alias-label-secondary)',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              },
            },
            h('div', null, tr('settings.empty')),
            snapshot.hint ? h('div', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, snapshot.hint) : null,
          )
        }
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 } },
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                fontSize: 11,
                color: 'var(--dsw-alias-label-tertiary)',
              },
            },
            h(
              'span',
              {
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  minWidth: 0,
                },
              },
              h('span', {
                className: 'dsh-rg-live',
                'aria-hidden': 'true',
                style: {
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: TONE.ok,
                  flexShrink: 0,
                },
              }),
              h(
                'span',
                { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                `${snapshot.host || '—'} · ${snapshot.backend}`,
              ),
            ),
            h('span', null, [
              tr('gpu.count', { count: snapshot.gpus.length }),
              ' · ',
              tr('gpu.idle', { count: idleCounts(snapshot.gpus).idle }),
              ...(snapshot.users && snapshot.users.length > 0
                ? [' · ', tr('gpu.users.count', { count: snapshot.users.length })]
                : []),
            ]),
          ),
          ...snapshot.gpus.map((gpu) => h(GpuCard, { key: gpu.index, gpu })),
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                fontSize: 11,
                color: 'var(--dsw-alias-label-tertiary)',
              },
            },
            h('span', null, tr('history', { count: (snapshot.history ?? []).length })),
            h(Sparkline, { history: snapshot.history }),
          ),
        )
      }, [snapshot, failure])

      return h(
        'div',
        {
          'data-dsh-remote-gpu-panel': '',
          style: {
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            fontSize: 12,
            height: '100%',
            minHeight: 0,
            overflowY: 'auto',
          },
        },
        body,
      )
    }

    /** The conversation header chip: it only tells how many GPUs are free; clicking it opens the detail panel. */
    function GpuChip(props) {
      const { snapshot } = useGpu(true)
      const gpus = (snapshot && snapshot.gpus) || []
      const counts = idleCounts(gpus)
      if (!snapshot) return null
      const failed = snapshot.status !== 'ok'
      const tone = failed ? 'danger' : idleTone(counts)
      const users = ((snapshot.users || []).map((entry) => `${entry.user}×${entry.count}`)).join(', ')
      const chipTitle = failed
        ? tr('chip.title.error', { host: snapshot.host || '—', error: snapshot.hint || snapshot.error || '—' })
        : `${tr('chip.title', { host: snapshot.host || '—' })}`
          + ` · ${tr('chip.idle', { idle: counts.idle, total: counts.total })}`
          + (users ? ` · ${tr('gpu.users.by')} ${users}` : '')
      return h(
        'button',
        {
          'data-dsh-remote-gpu-chip': '',
          type: 'button',
          className: `dsh-rg-pill is-${tone}`,
          'aria-label': chipTitle,
          title: chipTitle,
          onClick: () => {
            openGpuPanel()
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11,
            lineHeight: 1.4,
            cursor: 'pointer',
            background: 'transparent',
            border: 'none',
            padding: '0 2px',
            margin: 0,
            color: 'inherit',
            fontFamily: 'inherit',
          },
        },
        h('span', {
          'aria-hidden': 'true',
          className: 'dsh-rg-dot',
          style: {
            width: 7,
            height: 7,
            borderRadius: '50%',
            flexShrink: 0,
            background: TONE[tone],
          },
        }),
        h('span', { style: { fontVariantNumeric: 'tabular-nums' } },
          failed
            ? 'GPU --'
            : tr('chip.idle', { idle: counts.idle, total: counts.total })),
      )
    }

    /** The settings section. */
    function GpuSettingsPage() {
      const { snapshot, failure } = useGpu(true)
      const [busy, setBusy] = useState(false)

      const row = (label, value) => h(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            fontSize: 12,
            padding: '4px 0',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
          },
        },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, label),
        h('span', { style: { textAlign: 'right', wordBreak: 'break-all' } }, value),
      )

      const statusText = failure
        ? tr('settings.status.error')
        : !snapshot
          ? tr('settings.status.idle')
          : snapshot.status === 'ok'
            ? tr('settings.status.ok')
            : tr('settings.status.error')

      const statusColor = failure || (snapshot && snapshot.status !== 'ok') ? TONE.danger : TONE.ok

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12 } },
        h('div', { style: { fontWeight: 600 } }, tr('settings.heading')),
        row(tr('settings.status'), h('span', { style: { color: statusColor } }, statusText)),
        row(tr('settings.host'), snapshot && snapshot.host ? snapshot.host : '—'),
        row(tr('settings.backend'), snapshot && snapshot.backend ? snapshot.backend : '—'),
        row(
          tr('settings.idle'),
          snapshot && snapshot.gpus
            ? `${idleCounts(snapshot.gpus).idle} / ${snapshot.gpus.length}`
            : '—',
        ),
        row(tr('settings.interval'), snapshot && snapshot.intervalMs ? `${snapshot.intervalMs} ms` : '—'),
        row(
          tr('settings.updated'),
          snapshot && snapshot.updatedAt ? new Date(snapshot.updatedAt).toLocaleTimeString() : '—',
        ),
        snapshot && snapshot.hint
          ? h(
              'div',
              { style: { color: 'var(--dsw-alias-label-secondary)' } },
              `${tr('settings.hint')}: ${snapshot.hint}`,
            )
          : null,
        failure
          ? h('div', { style: { color: TONE.danger } }, tr('error.fetch', { message: failure }))
          : null,
        snapshot && snapshot.gpus && snapshot.gpus.length > 0
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              ...snapshot.gpus.map((gpu) => h(GpuCard, { key: gpu.index, gpu, showProcesses: true })),
            )
          : null,
        snapshot && snapshot.users
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, tr('gpu.users.active')),
              snapshot.users.length === 0
                ? h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, tr('gpu.users.none'))
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11 } },
                    ...snapshot.users.map((entry) => h(
                      'div',
                      { key: entry.user },
                      `${entry.user} · ${tr('gpu.users.detail', {
                        count: entry.count,
                        gpus: entry.gpus,
                        memory: formatMiB(entry.memory),
                      })}`,
                    )),
                  ),
            )
          : null,
        snapshot && snapshot.command
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, tr('settings.command')),
              h(
                'code',
                {
                  style: {
                    fontFamily: 'var(--dsw-font-family-mono, monospace)',
                    fontSize: 11,
                    wordBreak: 'break-all',
                    padding: 8,
                    borderRadius: 6,
                    background: 'var(--dsw-alias-bg-layer-2)',
                    border: '1px solid var(--dsw-alias-border-l2)',
                  },
                },
                snapshot.command,
              ),
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick: () => {
              setBusy(true)
              void store.refresh().finally(() => setBusy(false))
            },
            style: {
              alignSelf: 'flex-start',
              fontSize: 12,
              padding: '4px 12px',
              borderRadius: 6,
              cursor: busy ? 'default' : 'pointer',
              border: '1px solid var(--dsw-alias-border-l3)',
              background: 'var(--dsw-alias-button-elevated-fill, transparent)',
              color: 'var(--dsw-alias-label-primary)',
            },
          },
          busy ? tr('settings.refreshing') : tr('settings.refresh'),
        ),
      )
    }

    /** Plugin entry point. */
    function apply(ctx) {
      pluginCtx = ctx

      // The plugin stylesheet lives for exactly as long as the plugin does.
      const injectStyles = () => {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-remote-gpu', '')
        style.textContent = STYLES
        document.head.appendChild(style)
        return () => style.remove()
      }
      if (typeof ctx.effect === 'function') ctx.effect(injectStyles, 'dsh-remote-gpu.styles')
      else injectStyles()

      ctx.inject(['locale'], (inner) => {
        const locale = inner.get('locale')
        if (!locale) return
        locale.register(NS, { zh, en })
        tr = locale.bind(NS)
      })

      ctx.inject(['slots'], (inner) => {
        const slots = inner.get('slots')

        inner.effect(
          () => slots.inject('conversation.session.header.utilities', () => slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'dsh-remote-gpu-chip',
              order: 15,
            },
            GpuChip,
          )),
          'dsh-remote-gpu.chip',
        )

        inner.effect(
          () => slots.inject('settings.section', () => slots.register(
            {
              name: 'settings.section',
              id: 'dsh-remote-gpu',
              order: 41,
              label: () => tr('settings.title'),
            },
            () => h(GpuSettingsPage, null),
          )),
          'dsh-remote-gpu.settings',
        )
      })

      ctx.inject(['sidebarRight'], (inner) => {
        sidebarController = inner.get('sidebarRight')
      })

      ctx.inject(['sidebarRightTabs'], (inner) => {
        const tabs = inner.get('sidebarRightTabs')
        const slots = inner.get('slots')
        if (!tabs || !slots) return

        inner.effect(
          () => tabs.register({
            id: KIND,
            kind: KIND,
            title: () => tr('tab.title'),
            guide: [{ order: GUIDE_ORDER, title: () => tr('guide.title') }],
          }),
          'dsh-remote-gpu.tab-type',
        )

        inner.effect(
          () => slots.inject('sidebar.right.pane.tab', () => {
            const disposers = [
              slots.register({ name: 'sidebar.right.pane.tab', key: KIND }, GpuPanel),
            ]
            return () => {
              for (const dispose of disposers) dispose()
            }
          }),
          'dsh-remote-gpu.tab-body',
        )
      })
    }

    return {
      name: 'dsh-remote-gpu',
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
