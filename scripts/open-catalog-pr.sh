#!/usr/bin/env sh
# Land the catalog entry on your fork and print the pre-filled pull-request link.
#
# Use this when no classic token is available: you click "Fork" and "Create pull
# request" in the browser, everything in between happens here over SSH.
#
#   sh scripts/open-catalog-pr.sh [fork-owner]
set -eu

owner="${1:-NNNNyang}"
upstream="awesome-dsh-plugin/awesome-dsh-plugin"
root=$(cd "$(dirname "$0")/.." && pwd)
entry="$root/market-entry/NNNNyang__dsh-remote-gpu.yml"
target="data/plugins/NNNNyang__dsh-remote-gpu.yml"
branch="add-dsh-remote-gpu"
work="${TMPDIR:-/tmp}/awesome-dsh-plugin-$owner"

[ -f "$entry" ] || { echo "missing entry file: $entry" >&2; exit 1; }

rm -rf "$work"
echo "→ cloning your fork: git@github.com:$owner/awesome-dsh-plugin.git"
git clone --depth 1 "git@github.com:$owner/awesome-dsh-plugin.git" "$work"

cd "$work"
git checkout -B "$branch"
mkdir -p data/plugins
cp "$entry" "$target"
git add "$target"

if git diff --cached --quiet; then
  echo "→ nothing to commit: $target is already on your fork"
else
  git commit -m "Add NNNNyang/dsh-remote-gpu (remote GPU monitor)"
fi

git push -u origin "$branch" --force-with-lease
echo
echo "✓ branch pushed. Open this and click \"Create pull request\":"
echo "  https://github.com/$upstream/compare/main...$owner:awesome-dsh-plugin:$branch?expand=1"
