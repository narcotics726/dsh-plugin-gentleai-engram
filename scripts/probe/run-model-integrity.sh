#!/usr/bin/env bash
# Acceptance harness for engram-bridge-model-integrity tasks 8.1-8.4.
#
# Boots a THROWAWAY headless dsh host under a disposable home, loading the REAL
# engram bridge built from this repository, and pointing `searchModelDir` at a
# directory that host can write. By default that is a COPY of the machine's model
# directory: the shared one is not writable from a sandboxed session, and 8.1
# requires changing its bytes. Override MODEL_INTEGRITY_MODEL_DIR to run the same
# harness literally against the shared directory from a shell that may write it.
#
#   ./run-model-integrity.sh <run-name> "<task>"
#
# Env:
#   MODEL_INTEGRITY_MODEL_DIR  model directory to use (default: a fresh copy of
#                              ~/.dsh/storages/engram-bridge/model inside the home)
#   MODEL_INTEGRITY_TAMPER=1   flip one byte of tokenizer_config.json BEFORE
#                              booting, keeping the good file as
#                              tokenizer_config.json.good next to it (this is
#                              8.2's "boot with mismatched content")
#   MODEL_INTEGRITY_HOME       throwaway home (default $TMPDIR/dsh-model-integrity-<run>)
#   MODEL_INTEGRITY_REUSE_HOME=1  rebuild in place: keep an existing model copy
#                              (so a tamper survives into the next run)
#
# The session log lives in the throwaway home; read it with:
#   zstd -dc <home>/sessions/*/session-*/session.v3.jsonl.zstd | node -e '...'
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN="${1:?usage: run-model-integrity.sh <run-name> \"<task>\"}"
shift
HOME_DIR="${MODEL_INTEGRITY_HOME:-${TMPDIR:-/tmp}/dsh-model-integrity-$RUN}"
REAL_MODEL_DIR="${MODEL_INTEGRITY_MODEL_DIR:-$HOME/.dsh/storages/engram-bridge/model}"
MODEL_DIR="$HOME_DIR/model"

mkdir -p "$HOME_DIR/profiles/headless" "$HOME_DIR/engram"
# The credential store and the settings document are the only ~/.dsh documents a
# headless run needs. Nothing else under ~/.dsh is read or written.
for f in .credentials.yaml settings.yaml .anonymous-user-id; do
  if [ -f "$HOME/.dsh/$f" ]; then cp "$HOME/.dsh/$f" "$HOME_DIR/$f"; fi
done

cat > "$HOME_DIR/profiles/headless/package.json" <<'JSON'
{
  "name": "dsh-profile-headless",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]
    }
  }
}
JSON

# Probe against a COPY of the memory database: the run opens an engram session,
# and that must not land in the user's real store.
for suffix in '' '-wal' '-shm'; do
  if [ -f "$HOME/.engram/engram.db$suffix" ]; then
    cp "$HOME/.engram/engram.db$suffix" "$HOME_DIR/engram/engram.db$suffix"
  fi
done

if [ -n "${MODEL_INTEGRITY_MODEL_DIR:-}" ]; then
  MODEL_DIR="$REAL_MODEL_DIR"
elif [ ! -d "$MODEL_DIR" ] || [ "${MODEL_INTEGRITY_REUSE_HOME:-0}" != "1" ]; then
  rm -rf "$MODEL_DIR"
  cp -a "$REAL_MODEL_DIR" "$MODEL_DIR"
fi

if [ "${MODEL_INTEGRITY_TAMPER:-0}" = "1" ]; then
  # Keep the good file so the host itself can put it back (and so can a human).
  [ -f "$MODEL_DIR/tokenizer_config.json.good" ] || cp "$MODEL_DIR/tokenizer_config.json" "$MODEL_DIR/tokenizer_config.json.good"
  printf 'X' | dd of="$MODEL_DIR/tokenizer_config.json" bs=1 seek=0 conv=notrunc status=none
  echo "model-integrity: tampered $MODEL_DIR/tokenizer_config.json (good copy at tokenizer_config.json.good)"
fi

ENGRAM_BIN="$(command -v engram || true)"
if [ -z "$ENGRAM_BIN" ] && [ -x "$HOME/.local/bin/engram" ]; then ENGRAM_BIN="$HOME/.local/bin/engram"; fi
if [ -z "$ENGRAM_BIN" ]; then echo "run-model-integrity: engram 可执行文件找不到" >&2; exit 2; fi

RENDER="$HOME_DIR/rendered.cordis.yml"
sed -e "s|@@BRIDGE_MODULE@@|$REPO/dist/index.js|g" \
    -e "s|@@ENGRAM_BIN@@|$ENGRAM_BIN|g" \
    -e "s|@@ENGRAM_DATA_DIR@@|$HOME_DIR/engram|g" \
    -e "s|@@DB_PATH@@|$HOME_DIR/engram/engram.db|g" \
    -e "s|@@INDEX_DIR@@|$HOME_DIR/index|g" \
    -e "s|@@MODEL_DIR@@|$MODEL_DIR|g" \
    -e "s|@@IDLE_MS@@|${MODEL_INTEGRITY_IDLE_MS:-2000}|g" \
    -e "s|@@SWEEP_MS@@|1000|g" \
    "$REPO/scripts/probe/model-integrity.cordis.yml" > "$RENDER"

echo "model-integrity: home=$HOME_DIR model=$MODEL_DIR"
STATUS=0
# cwd = the throwaway home, so that is the host's writable workspace.
( cd "$HOME_DIR" && DSH_HOME="$HOME_DIR" DSH_TELEMETRY_DISABLED=1 \
  dsh --profile headless --patch "$RENDER" "$@" ) || STATUS=$?
echo "model-integrity: exit=$STATUS"
echo "model-integrity: session log $HOME_DIR/sessions/*/session-*/session.v3.jsonl.zstd"
exit $STATUS
