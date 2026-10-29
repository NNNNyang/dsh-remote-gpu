// Parse a synthetic probe output and print the per-GPU user attribution.
// Everything below is made up: fake host, fake card, fake users and pids.
import { parseGpuOutput, toWireGpu } from '../lib/gpu-parse.js'

const output = `==DSHGPU host==
example-host
==DSHGPU backend==
nvidia-smi
==DSHGPU gpus==
0, Test GPU, 90, 8000, 8192
1, Test GPU, 5, 100, 8192
==DSHGPU temp==
0, 40
1, 30
==DSHGPU uuid==
0, GPU-11111111-2222-3333-4444-555555555555
1, GPU-66666666-7777-8888-9999-000000000000
==DSHGPU procs==
1000, GPU-11111111-2222-3333-4444-555555555555, 6000
1001, GPU-11111111-2222-3333-4444-555555555555, 2000
1002, GPU-66666666-7777-8888-9999-000000000000, 100
==DSHGPU ps==
1000,alice,python3
1001,alice,train.py
1002,bob,job.sh
==DSHGPU end==`

const parsed = parseGpuOutput(output)
console.log(JSON.stringify(parsed, null, 2))
console.log('--- wire ---')
for (const gpu of parsed.gpus) {
  const wire = toWireGpu(gpu)
  console.log(wire.index, wire.name, 'users=', JSON.stringify(wire.users), 'processes=', JSON.stringify(wire.processes))
}
