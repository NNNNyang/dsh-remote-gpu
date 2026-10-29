#!/usr/bin/env bash
# Validates the probe command shipped by dsh-remote-gpu: the marker sections
# must survive a POSIX shell, and the fallback path must report "none".
set -u
CMD="echo '==DSHGPU host=='; hostname 2>/dev/null || uname -n 2>/dev/null || echo unknown; echo '==DSHGPU backend=='; if command -v nvidia-smi >/dev/null 2>&1; then echo nvidia-smi; echo '==DSHGPU gpus=='; nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null; echo '==DSHGPU temp=='; nvidia-smi --query-gpu=index,temperature.gpu --format=csv,noheader,nounits 2>/dev/null; elif command -v rocm-smi >/dev/null 2>&1; then echo rocm-smi; echo '==DSHGPU gpus=='; rocm-smi --showuse --showmemuse --showtemp --json 2>/dev/null; elif command -v gpustat >/dev/null 2>&1; then echo gpustat; echo '==DSHGPU gpus=='; gpustat --json 2>/dev/null; else echo none; fi; echo '==DSHGPU end=='"
echo "--- bash ---"
bash -c "$CMD"
echo "--- sh ---"
sh -c "$CMD"
