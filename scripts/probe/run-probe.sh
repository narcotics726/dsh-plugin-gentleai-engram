#!/usr/bin/env bash
# One bounded probe run of the throwaway dsh headless profile.
#
#   ./run-probe.sh <run-name> <scenario> "<task>"
#
# Environment knobs (optional):
#   PROBE_DENY=web_search,web_fetch,todo_write
#   PROBE_ABORT_AFTER_CHARS=8
#   PROBE_KEEP_HOME=1   keep the throwaway DSH home for inspection
#   PROBE_EXTRA_PATCHES extra --patch overlays, space separated (e.g. probe-compact.cordis.yml)
#
# The throwaway home lives under scripts/probe/tmp/dsh-home and is recreated on
# every run: ~/.dsh is never read for state beyond the credential and settings
# documents copied in below, and is never written.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROBE_HOME="${PROBE_HOME:-$REPO/scripts/probe/tmp/dsh-home}"
OUT_DIR="$REPO/scripts/probe/out"

RUN_NAME="${1:?usage: run-probe.sh <run-name> <scenario> \"<task>\"}"
SCENARIO="${2:?scenario required, e.g. observe|abort|restrict}"
shift 2

mkdir -p "$PROBE_HOME/profiles/headless" "$OUT_DIR"

# The credential store and the settings document are the only two ~/.dsh
# documents a headless run needs; copy them into the throwaway home.
for f in .credentials.yaml settings.yaml .anonymous-user-id; do
  if [ -f "$HOME/.dsh/$f" ]; then cp "$HOME/.dsh/$f" "$PROBE_HOME/$f"; fi
done

cat > "$PROBE_HOME/profiles/headless/package.json" <<'JSON'
{
  "name": "dsh-profile-headless",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
      "patchReload": "startup"
    }
  }
}
JSON

export DSH_HOME="$PROBE_HOME"
export DSH_TELEMETRY_DISABLED=1
export PROBE_OUT="$OUT_DIR/$RUN_NAME.jsonl"
export PROBE_SCENARIO="$SCENARIO"
: > "$PROBE_OUT"

echo "probe: DSH_HOME=$DSH_HOME"
echo "probe: out=$PROBE_OUT scenario=$SCENARIO deny=${PROBE_DENY:-<none>}"

PATCH_ARGS=(--patch "$REPO/scripts/probe/probe.cordis.yml")
for extra in ${PROBE_EXTRA_PATCHES:-}; do
  case "$extra" in /*) PATCH_ARGS+=(--patch "$extra") ;; *) PATCH_ARGS+=(--patch "$REPO/scripts/probe/$extra") ;; esac
done

STATUS=0
dsh --profile headless "${PATCH_ARGS[@]}" "$@" || STATUS=$?
echo "probe: exit=$STATUS lines=$(wc -l < "$PROBE_OUT" | tr -d ' ')"
if [ "${PROBE_KEEP_HOME:-0}" != "1" ]; then rm -rf "$PROBE_HOME"; fi
exit $STATUS
