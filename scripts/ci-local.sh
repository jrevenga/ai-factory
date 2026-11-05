#!/usr/bin/env bash
# Local stand-in for the GitHub Actions `ci` and `e2e` workflows, for when hosted runners are unavailable.
#
# For each Node version it clones REF from this repository into a fresh directory whose name contains a
# space (as the Windows CI legs do) and runs the workflow steps in order: npm ci, lint, unit tests, e2e
# tests, round-trip e2e. Runs on Linux, macOS and Windows (Git Bash). Git's global configuration is
# replaced by an empty file, as on a hosted runner.
#
# Usage: scripts/ci-local.sh [REF] [NODE_VERSION...]
#   REF           commit-ish to test (default: HEAD)
#   NODE_VERSION  exact (22.19.0) or a major (24 = latest 24.x); default: 22.19.0 24
# Environment:
#   CI_LOCAL_WORK   work directory (default: a new temporary directory)
#   CI_LOCAL_CACHE  Node download cache (default: ${XDG_CACHE_HOME:-$HOME/.cache}/ai-factory-ci)
#
# Node versions are downloaded from nodejs.org and verified against SHASUMS256.txt. Exit status is 0 only
# when every step of every leg passes; a summary table is printed at the end.
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
ref=${1:-HEAD}
shift || true
versions=("$@")
[ ${#versions[@]} -gt 0 ] || versions=(22.19.0 24)
sha=$(git -C "$repo_root" rev-parse --verify "$ref^{commit}")
work=${CI_LOCAL_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/ai-factory-ci.XXXXXX")}
cache=${CI_LOCAL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/ai-factory-ci}
mkdir -p "$work/logs" "$cache"

case "$(uname -s)" in
  Linux) platform=linux; ext=tar.xz ;;
  Darwin) platform=darwin; ext=tar.gz ;;
  MINGW* | MSYS* | CYGWIN*) platform=win; ext=zip ;;
  *) echo "unsupported platform: $(uname -s)" >&2; exit 2 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 2 ;;
esac

# Prints the exact version for an exact or major-only request.
resolve_version() {
  case "$1" in
    *.*.*) echo "$1" ;;
    *)
      curl -fsSL https://nodejs.org/dist/index.json |
        node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).find(r=>r.version.startsWith("v"+process.argv[1]+"."));if(!v)process.exit(1);console.log(v.version.slice(1))})' "$1"
      ;;
  esac
}

# Prints the directory holding the node binary for an exact version, downloading it once.
node_dir() {
  local v=$1 name="node-v$1-$platform-$arch" dir="$cache/node-v$1-$platform-$arch"
  if [ ! -x "$dir/bin/node" ] && [ ! -x "$dir/node.exe" ]; then
    local tmp
    tmp=$(mktemp -d "$cache/dl.XXXXXX")
    curl -fsSL -o "$tmp/$name.$ext" "https://nodejs.org/dist/v$v/$name.$ext"
    curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$v/SHASUMS256.txt"
    (cd "$tmp" && grep " $name.$ext\$" SHASUMS256.txt | sha256sum -c --quiet -) >&2
    case "$ext" in
      zip)
        if command -v unzip > /dev/null; then
          unzip -q "$tmp/$name.$ext" -d "$tmp"
        else
          powershell.exe -NoProfile -Command "Expand-Archive -LiteralPath '$(cygpath -w "$tmp/$name.$ext")' -DestinationPath '$(cygpath -w "$tmp")'"
        fi
        ;;
      *) tar -xf "$tmp/$name.$ext" -C "$tmp" ;;
    esac
    rm -rf "$dir"
    mv "$tmp/$name" "$dir"
    rm -rf "$tmp"
  fi
  if [ "$platform" = win ]; then echo "$dir"; else echo "$dir/bin"; fi
}

steps=("npm ci" "npm run lint" "npm test" "npm run test:e2e" "npx vitest run test/e2e/roundtrip.e2e.test.ts")
summary=()
failed=0
: > "$work/empty-gitconfig"

for requested in "${versions[@]}"; do
  version=$(resolve_version "$requested")
  bin=$(node_dir "$version")
  leg="node $version"
  checkout="$work/node-$version/ai factory"
  log="$work/logs/node-$version.log"
  rm -rf "$work/node-$version"
  mkdir -p "$work/node-$version"
  git clone -q --no-hardlinks "$repo_root" "$checkout"
  git -C "$checkout" checkout -q --detach "$sha"
  echo "== $leg at ${sha:0:7} in $checkout (log: $log)"
  for step in "${steps[@]}"; do
    start=$SECONDS
    if (cd "$checkout" && PATH="$bin:$PATH" GIT_CONFIG_GLOBAL="$work/empty-gitconfig" CI=true bash -c "$step") >> "$log" 2>&1; then
      result=pass
    else
      result=FAIL
      failed=1
    fi
    line=$(printf '%-16s %-58s %-4s %4ss' "$leg" "$step" "$result" $((SECONDS - start)))
    echo "$line"
    summary+=("$line")
    [ "$result" = pass ] || break
  done
done

echo
echo "== summary ($(uname -s) $arch, ${sha:0:7}; logs in $work/logs)"
printf '%s\n' "${summary[@]}"
exit $failed
