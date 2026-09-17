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
#   PROBE_LLM_MODULE   override the resolved @deepseek-ai/dsh-llm entry path
#   PROBE_WITH_BRIDGE=1  also mount this repository's built bridge (dist/index.js)
#   PROBE_MARKER       substring whose occurrence count is recorded per system/message
#
# The runner exports PROBE_PLUGIN_MODULE / PROBE_LLM_MODULE (absolute paths) for
# probe.cordis.yml; the checked-in overlay itself holds no local path.
#
# The throwaway home lives OUTSIDE the repository (default
# $TMPDIR/dsh-engram-probe-home) and is recreated on every run: it holds a copy
# of ~/.dsh/.credentials.yaml, which must never land in git history. ~/.dsh is
# never read for state beyond the credential and settings documents copied in
# below, and is never written.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROBE_HOME="${PROBE_HOME:-${TMPDIR:-/tmp}/dsh-engram-probe-home}"
OUT_DIR="$REPO/scripts/probe/out"

# Absolute paths the overlay needs are resolved here, so the checked-in
# probe.cordis.yml carries no machine-specific path.
export PROBE_PLUGIN_MODULE="$REPO/scripts/probe/probe-events.mjs"
if [ -z "${PROBE_LLM_MODULE:-}" ]; then
  PROBE_LLM_MODULE="$(node -e 'try { process.stdout.write(require.resolve("@deepseek-ai/dsh-llm")) } catch {}' 2>/dev/null || true)"
fi
if [ -z "${PROBE_LLM_MODULE:-}" ]; then
  DSH_BIN_REAL="$(readlink -f "$(command -v dsh)" 2>/dev/null || true)"
  if [ -n "$DSH_BIN_REAL" ]; then
    DSH_PKG="$(cd "$(dirname "$DSH_BIN_REAL")/.." && pwd)"
    if [ -f "$DSH_PKG/node_modules/@deepseek-ai/dsh-llm/lib/index.js" ]; then
      PROBE_LLM_MODULE="$DSH_PKG/node_modules/@deepseek-ai/dsh-llm/lib/index.js"
    fi
  fi
fi
export PROBE_LLM_MODULE="${PROBE_LLM_MODULE:-}"

# Tokens for the optional bridge overlay. The stub keeps a probe run out of the
# real memory database.
export PROBE_BRIDGE_MODULE="$REPO/dist/index.js"
export PROBE_NODE="$(command -v node)"
export PROBE_STUB="$REPO/test/engram-stub.mjs"

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

# The loader interpolates `!!js` only inside an entry's `config`, so the
# checked-in overlay cannot carry the absolute plugin path through `!!js` (and
# must not carry it literally — hygiene gate). Render each overlay template into
# the disposable home and patch from there.
RENDER_DIR="$PROBE_HOME/rendered"
mkdir -p "$RENDER_DIR"
render_overlay() {
  local src="$1" dst="$2"
  sed -e "s|@@PROBE_PLUGIN_MODULE@@|$PROBE_PLUGIN_MODULE|g" \
      -e "s|@@PROBE_OUT@@|$PROBE_OUT|g" \
      -e "s|@@PROBE_SCENARIO@@|$PROBE_SCENARIO|g" \
      -e "s|@@PROBE_DENY@@|${PROBE_DENY:-}|g" \
      -e "s|@@PROBE_ABORT_AFTER_CHARS@@|${PROBE_ABORT_AFTER_CHARS:-8}|g" \
      -e "s|@@PROBE_MARKER@@|${PROBE_MARKER:-}|g" \
      -e "s|@@PROBE_BRIDGE_MODULE@@|${PROBE_BRIDGE_MODULE:-}|g" \
      -e "s|@@PROBE_NODE@@|${PROBE_NODE:-}|g" \
      -e "s|@@PROBE_STUB@@|${PROBE_STUB:-}|g" \
      -e "s|@@PROBE_LLM_MODULE@@|${PROBE_LLM_MODULE:-}|g" \
      "$src" > "$dst"
}

render_overlay "$REPO/scripts/probe/probe.cordis.yml" "$RENDER_DIR/probe.cordis.yml"
PATCH_ARGS=(--patch "$RENDER_DIR/probe.cordis.yml")

# Optional: mount the bridge under test. Off by default so the existing event
# probes keep observing a bare base+headless profile.
if [ "${PROBE_WITH_BRIDGE:-0}" = "1" ]; then
  render_overlay "$REPO/scripts/probe/probe-bridge.cordis.yml" "$RENDER_DIR/probe-bridge.cordis.yml"
  PATCH_ARGS+=(--patch "$RENDER_DIR/probe-bridge.cordis.yml")
fi
for extra in ${PROBE_EXTRA_PATCHES:-}; do
  case "$extra" in /*) src="$extra" ;; *) src="$REPO/scripts/probe/$extra" ;; esac
  dst="$RENDER_DIR/$(basename "$src")"
  render_overlay "$src" "$dst"
  PATCH_ARGS+=(--patch "$dst")
done

STATUS=0
dsh --profile headless "${PATCH_ARGS[@]}" "$@" || STATUS=$?
echo "probe: exit=$STATUS lines=$(wc -l < "$PROBE_OUT" | tr -d ' ')"
if [ "${PROBE_KEEP_HOME:-0}" != "1" ]; then rm -rf "$PROBE_HOME"; fi
exit $STATUS
