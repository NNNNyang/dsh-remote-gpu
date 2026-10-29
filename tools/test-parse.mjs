// Parser check for dsh-remote-gpu. Run with:
//   node tools/test-parse.mjs
import { parseGpuOutput, splitSections } from '../lib/gpu-parse.js'

const nvidia = `==DSHGPU host==
example-host
==DSHGPU backend==
nvidia-smi
==DSHGPU gpus==
0, Test GPU, 73, 6000, 16384
1, Test GPU, 4, 1024, 16384
==DSHGPU temp==
0, 61
1, 38
==DSHGPU end==`

const rocm = `==DSHGPU host==
rocm-node
==DSHGPU backend==
rocm-smi
==DSHGPU gpus==
{
  "card0": {
    "GPU use (%)": "55",
    "VRAM Total Memory (B)": "68719476736",
    "VRAM Total Used Memory (B)": "34359738368",
    "Temperature (Sensor edge) (C)": "52.0",
    "Card series": "AMD Instinct MI250X"
  }
}
==DSHGPU end==`

const gpustat = `==DSHGPU host==
tiny-node
==DSHGPU backend==
gpustat
==DSHGPU gpus==
{"gpus": [{"index": 0, "name": "Tesla T4", "utilization_gpu": 12, "memory_used": 3000, "memory_total": 15360, "temperature_gpu": 45}]}
==DSHGPU end==`

const none = `==DSHGPU host==
plain-node
==DSHGPU backend==
none
==DSHGPU gpus==
==DSHGPU end==`

const broken = `==DSHGPU host==
win-node
==DSHGPU backend==
nvidia-smi
==DSHGPU gpus==
NVIDIA-SMI has failed because you are not running as an administrator
==DSHGPU temp==
==DSHGPU end==`

const cases = [
  ['nvidia', nvidia, 2],
  ['rocm', rocm, 1],
  ['gpustat', gpustat, 1],
  ['none', none, 0],
  ['broken', broken, 0],
]

let failures = 0
for (const [name, text, expected] of cases) {
  const parsed = parseGpuOutput(text)
  const ok = parsed.gpus.length === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: host=${parsed.host} backend=${parsed.backend} gpus=${parsed.gpus.length} error=${parsed.error}`)
  if (parsed.gpus.length > 0) console.log('     ', JSON.stringify(parsed.gpus))
  if (parsed.detail) console.log('      detail:', parsed.detail)
}

// A noisy remote output (stderr, exit code notes) must not break the parse.
const noisy = `${nvidia}\n-- stderr --\nsome warning\n[exit code: 0]`
const noisyParsed = parseGpuOutput(noisy)
if (noisyParsed.gpus.length !== 2) {
  failures += 1
  console.log('FAIL noisy: expected 2 gpus, got', noisyParsed.gpus.length)
} else {
  console.log('ok   noisy: 2 gpus survived the trailing noise')
}

if (splitSections(nvidia).gpus.length !== 2) {
  failures += 1
  console.log('FAIL splitSections')
} else {
  console.log('ok   splitSections')
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
