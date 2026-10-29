# dsh-remote-gpu

A DSH plugin that shows **live GPU utilization of the server `dsh-remote` is connected to**.

It piggybacks on `dsh-remote`: the host half calls dsh-remote's own `rw_exec` tool
through the host `tools` service, so no second SSH connection, no duplicated
credential handling, and no extra dependency.

## What you get

| Seat | What it shows |
| --- | --- |
| Conversation header chip | `空闲 {idle}/{total}` — **only how many remote GPUs are free** (colour-coded: green = all free, amber = some free, red = none). Click it to open the panel for the details. The tooltip also lists the users currently on the GPU box (`占用 <user>×<n>`). |
| Right sidebar tab `远程显卡` | Every GPU of the remote host in detail: name, utilization %, memory used/total, temperature, **the user who owns the task running on it** (`占用 <user>×<n>`), a `空闲` tag on the free cards, plus a sparkline of recent samples. |
| Settings → `远程显卡` | Probe status, remote host, backend, idle count, refresh interval, the exact probe command, a "refresh now" button, the per-GPU process list (user · command · pid · memory) and an "active users" summary. |
| Host tool `remote_gpu` | The same snapshot as text, so the agent can read it directly. |

## What counts as a free GPU

A card is *idle* when it is barely drawing power **and** barely holding memory:

- utilization `< idleUtilPercent` (default **10 %**), and
- memory used `< idleMemoryPercent` (default **5 %**) of the card.

Both must hold: a model that is loaded but idle still owns its VRAM, so that
card is not free for a new job. The host computes the verdict and ships it
with every sample, so the chip, the panel and the `remote_gpu` tool always
agree on the same number.

```
Remote host <host> — <backend>
Idle GPUs: <idle>/<total> (util < 10%, memory < 5%)
GPU <index> <name> · util <n>% · memory <used>/<total> MiB · temp <n>°C · idle
GPU <index> <name> · util <n>% · memory <used>/<total> MiB · temp <n>°C · users <user>×<n>
```

## Who is using each GPU

Every GPU card names the owner of the task that runs on it:

```
GPU <index> · <name>
<util>%   <used>/<total>   <mem%>   <temp> °C   占用 <user>×<n>
```

The panel header adds the overall count (`<total> 张显卡 · 空闲 <idle> 张 · <users> 个用户`),
and the chip tooltip summarises the same thing. On NVIDIA servers the probe adds
three extra sections to the command:

```sh
nvidia-smi --query-gpu=index,uuid --format=csv,noheader,nounits   # ==DSHGPU uuid==
nvidia-smi --query-compute-apps=pid,gpu_uuid,used_memory …        # ==DSHGPU procs==
ps -o pid=,user=,comm= -p <pids>                                  # ==DSHGPU ps==
```

`lib/gpu-parse.js` maps the GPU UUIDs to indices and the PIDs to their owner
(`user` + command), so each GPU ends up with `processes[]` and a per-GPU
`users[]` summary. On ROCm / gpustat servers the process list stays empty —
those tools do not expose per-process GPU ownership.

## Motion

Every reading eases into place instead of snapping:

- one shared `requestAnimationFrame` loop drives all tweens, so a panel with
  many GPUs still costs a single frame callback;
- utilization, memory and temperature glide to their new value over ~520 ms
  (`TWEEN_MS` in `client.js`);
- the utilization and memory bars, the sparkline line and the chip dot morph
  continuously — the sparkline even slides one sample to the left;
- the panel header carries a slow breathing dot, a GPU card fades in when it
  appears, and the loading state uses a shimmer instead of static text;
- `prefers-reduced-motion: reduce` switches every animation off.

## How the probe works

The host runs one POSIX shell line on the remote machine. It picks the first
available backend and wraps every part in `==DSHGPU …==` markers:

| Section | Content |
| --- | --- |
| `host` | `hostname` of the remote machine |
| `backend` | `nvidia-smi`, `rocm-smi`, `gpustat` or `none` |
| `gpus` | one CSV row per GPU (`index,name,utilization.gpu,memory.used,memory.total`) |
| `temp` | GPU temperature (NVIDIA only) |
| `uuid` | GPU index → UUID (NVIDIA only, links processes to GPUs) |
| `procs` | running compute apps: `pid,gpu_uuid,used_memory` (NVIDIA only) |
| `ps` | owner of each PID: `pid,user,command` (NVIDIA only) |

`lib/gpu-parse.js` parses those sections into the snapshot the UI renders.

Requirements on the remote server: `nvidia-smi` (or `rocm-smi` / `gpustat`) on `PATH`,
and a dsh-remote **active remote workspace** (the probe uses the machine dsh-remote is
currently connected to).

## Configuration

`cordis.patch.yml` carries the tunables:

```yaml
- insert:
    - id: dsh-remote-gpu
      name: '@local/dsh-remote-gpu'
      config:
        intervalMs: 3000        # refresh cadence (500 – 300000)
        commandTimeoutMs: 15000 # remote command timeout
        idleStopMs: 120000      # stop probing when no panel is open
        historyLength: 90       # samples kept for the sparkline
        idleUtilPercent: 10     # a card is free below this utilization …
        idleMemoryPercent: 5    # … and below this memory usage
        # command: '…'          # override the probe command entirely
```

## Install

```bash
plugin_manager install_bundle target=<abs path to this directory>
plugin_manager set_bundle target=@local/dsh-remote-gpu enabled=true
```

`install_bundle` only runs pnpm; the second command is what puts the plugin's row
into the profile's bundle layer (`dsh.profile.bundles` in the profile
`package.json`). Without it the plugin works until the next DSH restart and then
silently disappears — the symptom is a vanished chip and a "removed tool" notice
in the session.

The plugin is offline-safe: it has **zero runtime dependencies** and imports nothing
from `@deepseek-ai/*`.

## Layout

One card is ~79 px tall (compact paddings, a single-line footer, a 5 px
utilization bar and a 3 px memory bar), so a full node fits into the right
sidebar without scrolling; the panel scrolls when there are more GPUs than fit.
