#!/usr/bin/env bash
# Post-ingest command: let Codex create and publish artwork for a new event.
#
#   event-artwork-hook.sh <event-id> <prompt-file>
#
# <prompt-file> is a Markdown file whose first ```text block is the prompt; its
# event placeholder (BESEDY_ARTWORK_EVENT_PLACEHOLDER, default <DOPLŇ_ID>) is
# replaced with <event-id>. Codex runs unattended in BESEDY_ARTWORK_REPO with
# approvals and its sandbox turned off, because nobody is there to approve and
# the prompt's `just artwork ... --prod` needs the network and the database.
# Codex's final message is kept under the state directory and printed.
#
# Configure it as the worker's BESEDY_INGEST_POST_COMMAND; see
# docs/web/recording-ingest.md ("Post-ingest command").
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <event-id> <prompt-file>" >&2
  exit 2
fi
event_id="$1"
prompt_file="$2"
if [[ ! "$event_id" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid event id: $event_id" >&2
  exit 2
fi

repo="${BESEDY_ARTWORK_REPO:-$HOME/projects/besedy}"
codex="${CODEX_BIN:-$HOME/.local/bin/codex}"
placeholder="${BESEDY_ARTWORK_EVENT_PLACEHOLDER:-<DOPLŇ_ID>}"
node_version="${BESEDY_ARTWORK_NODE_VERSION:-24}"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/lukleh/besedy/event-artwork"

prompt="$(awk '/^```text[[:space:]]*$/ { inside = 1; next } inside && /^```[[:space:]]*$/ { exit } inside' "$prompt_file")"
if [[ -z "$prompt" ]]; then
  echo "No \`\`\`text block in $prompt_file" >&2
  exit 1
fi
if [[ "$prompt" != *"$placeholder"* ]]; then
  echo "The prompt in $prompt_file has no $placeholder placeholder" >&2
  exit 1
fi
prompt="${prompt//"$placeholder"/$event_id}"

# The worker's systemd PATH has no Node; `just artwork` needs nvm's.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
set +u
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh"
nvm use --silent "$node_version" >/dev/null
set -u

mkdir -p "$state_dir"
last_message="$state_dir/event-${event_id}_$(date +%Y%m%d_%H%M%S).md"

echo "Codex artwork run for event $event_id in $repo"
status=0
printf '%s\n' "$prompt" |
  "$codex" exec -C "$repo" --dangerously-bypass-approvals-and-sandbox --color never \
    -o "$last_message" - || status=$?

if [[ -s "$last_message" ]]; then
  echo "--- Codex final message ($last_message)"
  cat "$last_message"
fi
exit "$status"
