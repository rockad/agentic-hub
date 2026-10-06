#!/usr/bin/env bash
# scripts/memory.sh - Unified Memory umbrella wrapping Recall (port 8110) and Lookup (port 8100)
# Cross-harness session coordination and semantic transcript search (Antigravity <-> OpenCode)
#
# Usage:
#   ./scripts/memory.sh status [--workspace <name>]
#   ./scripts/memory.sh get [--workspace <name>]
#   ./scripts/memory.sh set [--workspace <name>] [--harness <antigravity|opencode>] [--goal "..."] [--milestone "..."] [--next "..."]
#   ./scripts/memory.sh mark-done <milestone>
#   ./scripts/memory.sh search <query>
#   ./scripts/memory.sh dump-markdown
#   ./scripts/memory.sh up [-d]
#   ./scripts/memory.sh down

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${WORKSPACE_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
DEFAULT_WORKSPACE="$(basename "${REPO_ROOT}")"

MEMORY_JSON="${REPO_ROOT}/.agents/memory.json"
MEMORY_MD="${REPO_ROOT}/.agents/MEMORY.md"
HANDOFF_JSON="${REPO_ROOT}/.agents/handoff.json"
HANDOFF_MD="${REPO_ROOT}/.agents/HANDOFF.md"

RECALL_URL="${RECALL_URL:-http://127.0.0.1:8110/mcp}"
LOOKUP_URL="${LOOKUP_URL:-http://127.0.0.1:8100/mcp}"

mkdir -p "${REPO_ROOT}/.agents"

# Initialize local state cache if missing
if [[ ! -f "${MEMORY_JSON}" && -f "${HANDOFF_JSON}" ]]; then
  cp "${HANDOFF_JSON}" "${MEMORY_JSON}"
elif [[ ! -f "${MEMORY_JSON}" ]]; then
  echo '{"version":"1.0","updatedAt":"'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'","lastHarness":"unknown","activeGoal":"","currentMilestone":"","completedMilestones":[],"pendingDecisions":[],"modifiedFiles":[],"nextAction":"","activeRecallProject":"corpus"}' > "${MEMORY_JSON}"
fi

if [[ ! -f "${HANDOFF_JSON}" ]]; then
  cp "${MEMORY_JSON}" "${HANDOFF_JSON}"
fi

call_recall() {
  local tool="$1"
  local args_json="$2"
  local payload
  payload=$(jq -n --arg tool "$tool" --argjson args "$args_json" '{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: $tool,
      arguments: $args
    }
  }')

  curl -s --connect-timeout 2 --max-time 5 -X POST "${RECALL_URL}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "${payload}" 2>/dev/null \
    | grep '^data: ' | sed 's/^data: //' | jq -c 'select(.result != null or .error != null)' 2>/dev/null || true
}

read_recall_note() {
  local note_title="$1"
  local args_json
  args_json=$(jq -n --arg id "$note_title" '{identifier: $id, output_format: "json", include_frontmatter: true}')
  local resp
  resp=$(call_recall "read_note" "$args_json")

  if [[ -n "$resp" ]]; then
    local title fm
    title=$(echo "$resp" | jq -r '.result.structuredContent.result.title // empty' 2>/dev/null || true)
    if [[ -n "$title" && "$title" != "null" ]]; then
      fm=$(echo "$resp" | jq -c '.result.structuredContent.result.frontmatter // empty' 2>/dev/null || true)
      if [[ -n "$fm" && "$fm" != "null" && "$fm" != "{}" ]]; then
        echo "$fm" | jq \
          '{
            version: "1.0",
            updatedAt: (.updatedAt // ""),
            lastHarness: (.lastHarness // "unknown"),
            activeGoal: (.activeGoal // ""),
            currentMilestone: (.currentMilestone // ""),
            completedMilestones: (.completedMilestones // []),
            pendingDecisions: (.pendingDecisions // []),
            modifiedFiles: (.modifiedFiles // []),
            nextAction: (.nextAction // ""),
            activeRecallProject: "corpus"
          }' 2>/dev/null || true
        return 0
      fi
    fi
  fi
  return 1
}

read_recall_memory() {
  local ws="${1:-$DEFAULT_WORKSPACE}"
  local state=""
  if state=$(read_recall_note "session-memory:${ws}") && [[ -n "$state" ]]; then
    echo "$state"
    return 0
  fi
  if state=$(read_recall_note "session-handoff:${ws}") && [[ -n "$state" ]]; then
    echo "$state"
    return 0
  fi
  return 1
}

write_single_recall_note() {
  local note_title="$1"
  local state_json="$2"
  local ws="$3"

  local goal milestone action harness updated_at
  goal=$(echo "$state_json" | jq -r '.activeGoal // ""')
  milestone=$(echo "$state_json" | jq -r '.currentMilestone // ""')
  action=$(echo "$state_json" | jq -r '.nextAction // ""')
  harness=$(echo "$state_json" | jq -r '.lastHarness // "unknown"')
  updated_at=$(echo "$state_json" | jq -r '.updatedAt // ""')

  local md_body
  md_body=$(cat <<EOF
# Unified Session Memory: ${ws}

**Last Updated:** ${updated_at}
**Last Harness:** ${harness}
**Active Goal:** ${goal}
**Current Milestone:** ${milestone}
**Next Action:** ${action}

### Completed Milestones
$(echo "$state_json" | jq -r '.completedMilestones[]? | "- " + .')

### Modified Files
$(echo "$state_json" | jq -r '.modifiedFiles[]? | "- `" + . + "`"')
EOF
)

  local meta_json
  meta_json=$(echo "$state_json" | jq --arg ws "$ws" '{
    workspace: $ws,
    lastHarness: .lastHarness,
    updatedAt: .updatedAt,
    activeGoal: .activeGoal,
    currentMilestone: .currentMilestone,
    nextAction: .nextAction,
    completedMilestones: .completedMilestones,
    modifiedFiles: .modifiedFiles
  }')

  local args_json
  args_json=$(jq -n \
    --arg title "$note_title" \
    --arg content "$md_body" \
    --argjson meta "$meta_json" \
    '{
      title: $title,
      directory: "",
      content: $content,
      metadata: $meta,
      overwrite: true
    }')

  local resp
  resp=$(call_recall "write_note" "$args_json")
  if [[ -n "$resp" ]] && echo "$resp" | jq -e '.result != null and .result.isError != true' >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

write_recall_memory() {
  local state_json="$1"
  local ws="${2:-$DEFAULT_WORKSPACE}"
  local ok1=false
  local ok2=false

  if write_single_recall_note "session-memory:${ws}" "$state_json" "$ws"; then
    ok1=true
  fi
  if write_single_recall_note "session-handoff:${ws}" "$state_json" "$ws"; then
    ok2=true
  fi

  if [[ "$ok1" == "true" || "$ok2" == "true" ]]; then
    return 0
  fi
  return 1
}

generate_markdown_from_json() {
  local json_str="$1"
  cat <<EOF
# Cross-Harness Unified Memory

**Last Updated:** $(echo "$json_str" | jq -r .updatedAt)  
**Last Harness:** $(echo "$json_str" | jq -r .lastHarness)  
**Active Goal:** $(echo "$json_str" | jq -r .activeGoal)  
**Current Milestone:** $(echo "$json_str" | jq -r .currentMilestone)  
**Next Action:** $(echo "$json_str" | jq -r .nextAction)  

### Completed Milestones
$(echo "$json_str" | jq -r '.completedMilestones[]? | "- " + .')

### Modified Files
$(echo "$json_str" | jq -r '.modifiedFiles[]? | "- `" + . + "`"')
EOF
}

load_state() {
  local ws="${1:-$DEFAULT_WORKSPACE}"
  local state=""
  if state=$(read_recall_memory "$ws") && [[ -n "$state" ]]; then
    echo "$state" > "${MEMORY_JSON}"
    echo "$state" > "${HANDOFF_JSON}"
    generate_markdown_from_json "$state" > "${MEMORY_MD}"
    generate_markdown_from_json "$state" > "${HANDOFF_MD}"
    echo "$state"
    return 0
  fi

  if [[ -f "${MEMORY_JSON}" ]]; then
    cat "${MEMORY_JSON}"
    return 0
  fi

  if [[ -f "${HANDOFF_JSON}" ]]; then
    cat "${HANDOFF_JSON}"
    return 0
  fi

  echo '{"version":"1.0","updatedAt":"'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'","lastHarness":"unknown","activeGoal":"","currentMilestone":"","completedMilestones":[],"pendingDecisions":[],"modifiedFiles":[],"nextAction":"","activeRecallProject":"corpus"}'
}

save_local_and_remote() {
  local state_json="$1"
  local ws="$2"

  echo "$state_json" > "${MEMORY_JSON}"
  echo "$state_json" > "${HANDOFF_JSON}"
  generate_markdown_from_json "$state_json" > "${MEMORY_MD}"
  generate_markdown_from_json "$state_json" > "${HANDOFF_MD}"

  if write_recall_memory "$state_json" "$ws"; then
    return 0
  fi
  return 1
}

cmd="${1:-status}"
shift || true

case "${cmd}" in
  status)
    ws="${DEFAULT_WORKSPACE}"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --workspace) ws="$2"; shift 2 ;;
        *) shift ;;
      esac
    done

    state=$(load_state "$ws")
    echo "=== Cross-Harness Unified Memory [${ws}] ==="
    echo "$state" | jq -r '
      "Last Harness:       " + .lastHarness + " (" + .updatedAt + ")\n" +
      "Active Goal:        " + .activeGoal + "\n" +
      "Current Milestone:  " + .currentMilestone + "\n" +
      "Next Action:        " + .nextAction + "\n" +
      "Modified Files:     " + ((.modifiedFiles // []) | join(", ")) + "\n" +
      "Completed Steps:    \n  - " + ((.completedMilestones // []) | join("\n  - "))
    '
    ;;

  get)
    ws="${DEFAULT_WORKSPACE}"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --workspace) ws="$2"; shift 2 ;;
        *) shift ;;
      esac
    done

    state=$(load_state "$ws")
    echo "$state"
    ;;

  set)
    goal=""
    harness=""
    action=""
    milestone=""
    ws="${DEFAULT_WORKSPACE}"

    while [[ $# -gt 0 ]]; do
      case "$1" in
        --harness) harness="$2"; shift 2 ;;
        --goal) goal="$2"; shift 2 ;;
        --action|--next) action="$2"; shift 2 ;;
        --milestone) milestone="$2"; shift 2 ;;
        --workspace) ws="$2"; shift 2 ;;
        *) shift ;;
      esac
    done

    current_state=$(load_state "$ws")
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    updated_state=$(echo "$current_state" | jq \
      --arg now "${now}" \
      --arg harness "${harness}" \
      --arg goal "${goal}" \
      --arg action "${action}" \
      --arg milestone "${milestone}" \
      '
        .updatedAt = $now |
        (if $harness != "" then .lastHarness = $harness else . end) |
        (if $goal != "" then .activeGoal = $goal else . end) |
        (if $action != "" then .nextAction = $action else . end) |
        (if $milestone != "" then .currentMilestone = $milestone else . end)
      ')

    if save_local_and_remote "$updated_state" "$ws"; then
      echo "Memory state updated (synced to Recall & local disk)."
    else
      echo "Memory state updated (local disk only; Recall unreachable or failed)."
    fi
    ;;

  mark-done)
    ws="${DEFAULT_WORKSPACE}"
    step=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --workspace) ws="$2"; shift 2 ;;
        *)
          if [[ -z "$step" ]]; then
            step="$1"
          else
            step="$step $1"
          fi
          shift
          ;;
      esac
    done

    if [[ -z "${step}" ]]; then
      echo "Error: please provide milestone text to mark done" >&2
      exit 1
    fi

    current_state=$(load_state "$ws")
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    updated_state=$(echo "$current_state" | jq --arg now "${now}" --arg step "${step}" '
      .updatedAt = $now |
      .completedMilestones = ((.completedMilestones // []) + [$step] | unique)
    ')

    if save_local_and_remote "$updated_state" "$ws"; then
      echo "Added completed milestone: ${step} (synced to Recall & disk)"
    else
      echo "Added completed milestone: ${step} (disk only; Recall unreachable)"
    fi
    ;;

  search|search-context)
    query="$*"
    if [[ -z "${query}" ]]; then
      echo "Usage: $0 search <query>" >&2
      exit 1
    fi

    payload=$(jq -n --arg q "$query" '{
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search_archive",
        arguments: {
          query: $q
        }
      }
    }')

    resp=$(curl -s --connect-timeout 2 --max-time 10 -X POST "${LOOKUP_URL}" \
      -H "Content-Type: application/json" \
      -d "${payload}" 2>/dev/null || true)

    if [[ -z "$resp" ]]; then
      echo "Lookup service unreachable at ${LOOKUP_URL}" >&2
      exit 1
    fi

    text=$(echo "$resp" | jq -r '.result.content[]? | select(.type == "text") | .text' 2>/dev/null || true)
    if [[ -n "$text" ]]; then
      echo "$text"
    else
      echo "No matching context found for query: ${query}"
    fi
    ;;

  dump-markdown)
    state=$(cat "${MEMORY_JSON}")
    generate_markdown_from_json "$state" > "${MEMORY_MD}"
    generate_markdown_from_json "$state" > "${HANDOFF_MD}"
    echo "Generated ${MEMORY_MD} and ${HANDOFF_MD}"
    ;;

  up)
    if ! command -v docker >/dev/null 2>&1; then
      echo "Error: docker is not installed or not available in PATH" >&2
      exit 1
    fi
    compose_file=""
    if [[ -f "${SCRIPT_DIR}/../docker-compose.yml" ]]; then
      compose_file="${SCRIPT_DIR}/../docker-compose.yml"
    elif [[ -f "${REPO_ROOT}/plugins/memory/docker-compose.yml" ]]; then
      compose_file="${REPO_ROOT}/plugins/memory/docker-compose.yml"
    fi

    if [[ -z "${compose_file}" || ! -f "${compose_file}" ]]; then
      echo "Error: docker-compose.yml not found for memory plugin" >&2
      exit 1
    fi
    echo "Starting memory stack using ${compose_file}..."
    docker compose -f "${compose_file}" up -d "$@"
    ;;

  down)
    if ! command -v docker >/dev/null 2>&1; then
      echo "Error: docker is not installed or not available in PATH" >&2
      exit 1
    fi
    compose_file=""
    if [[ -f "${SCRIPT_DIR}/../docker-compose.yml" ]]; then
      compose_file="${SCRIPT_DIR}/../docker-compose.yml"
    elif [[ -f "${REPO_ROOT}/plugins/memory/docker-compose.yml" ]]; then
      compose_file="${REPO_ROOT}/plugins/memory/docker-compose.yml"
    fi

    if [[ -z "${compose_file}" || ! -f "${compose_file}" ]]; then
      echo "Error: docker-compose.yml not found for memory plugin" >&2
      exit 1
    fi
    echo "Stopping memory stack using ${compose_file}..."
    docker compose -f "${compose_file}" down "$@"
    ;;

  *)
    echo "Usage: $0 {status|get|set|mark-done|search|dump-markdown|up|down}" >&2
    exit 1
    ;;
esac
