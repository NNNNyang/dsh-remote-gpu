#!/usr/bin/env sh
# Fill in the real repository slug everywhere it is still a placeholder, then
# push the first commit to GitHub.
#
#   sh scripts/publish-to-github.sh <owner> <repo>
#
# Prerequisites, once:
#   1. the public key in ~/.ssh/id_ed25519.pub is added to GitHub
#      (https://github.com/settings/ssh/new)
#   2. the empty repository exists: https://github.com/new
#      (no README, no .gitignore, no license — this repo already has them)
set -eu

owner="${1:?usage: publish-to-github.sh <owner> <repo>}"
repo="${2:?usage: publish-to-github.sh <owner> <repo>}"
slug="$owner/$repo"

echo "→ repository slug: $slug"

# package.json homepage / repository, and the market entry template
sed -i "s|OWNER/REPO|$slug|g" package.json market-entry/OWNER__REPO.yml

entry="market-entry/${owner}__${repo}.yml"
if [ -f market-entry/OWNER__REPO.yml ] && [ "market-entry/OWNER__REPO.yml" != "$entry" ]; then
  mv market-entry/OWNER__REPO.yml "$entry"
fi

git add -A
git commit -m "chore: point metadata at $slug" || echo "(nothing new to commit)"

git remote remove origin 2>/dev/null || true
git remote add origin "git@github.com:$slug.git"
echo "→ pushing to git@github.com:$slug.git"
git push -u origin main

echo
echo "✓ pushed. Next:"
echo "  1. add the 'dsh-plugin' topic to the repository (About → gear → Topics)"
echo "  2. wait until the repository is 1 day old, then open the catalog PR:"
echo "     copy $entry into the awesome-dsh-plugin fork at data/plugins/${owner}__${repo}.yml"
