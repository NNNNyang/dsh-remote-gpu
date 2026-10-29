// Parse a recorded probe output and print the per-GPU user attribution.
import { parseGpuOutput, toWireGpu } from '../lib/gpu-parse.js'

const output = `==DSHGPU host==
vdi02
==DSHGPU backend==
nvidia-smi
==DSHGPU gpus==
0, NVIDIA A30, 91, 13471, 24576
1, NVIDIA A30, 12, 1024, 24576
==DSHGPU temp==
0, 37
1, 29
==DSHGPU uuid==
0, GPU-11111111-2222-3333-4444-555555555555
1, GPU-66666666-7777-8888-9999-000000000000
==DSHGPU procs==
4242, GPU-11111111-2222-3333-4444-555555555555, 8192
4243, GPU-11111111-2222-3333-4444-555555555555, 1024
5150, GPU-66666666-7777-8888-9999-000000000000, 512
==DSHGPU ps==
4242,root,python3
4243,zhangwei,torchrun
5150,root,python3
==DSHGPU end==`

const parsed = parseGpuOutput(output)
console.log(JSON.stringify(parsed, null, 2))
console.log('--- wire ---')
for (const gpu of parsed.gpus) {
  const wire = toWireGpu(gpu)
  console.log(wire.index, wire.name, 'users=', JSON.stringify(wire.users), 'processes=', JSON.stringify(wire.processes))
}
