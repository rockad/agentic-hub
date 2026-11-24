# a2a-lib.sh: the settings reader of the coordination plugin's hook scripts (decision Z21 item 5;
# docs/specs/claude-hooks.md and agy-hooks.md). POSIX sh, sourced (`.`), never run. No shebang.
#
#   . "${0%/*}/a2a-lib.sh" && a2a_load_config
#
# The settings file is plain `KEY=value` lines, by default
# ${XDG_CONFIG_HOME:-$HOME/.config}/a2a-coord/config (A2A_CONFIG_FILE names another one). It is read
# line by line with `read -r` and is never sourced, evaluated or expanded: a value is only ever
# assigned, so `$(cmd)`, a backtick and `$VAR` in it stay the characters they are.
#
# Rules
#   - Only these names are taken, any other line is ignored: A2A_SERVER_URL A2A_CARD A2A_AGY_CARD
#     A2A_KEY_FILE A2A_AGY_KEY_FILE.
#   - A blank line, a `#` comment, a line without `=`, an empty value and a CR at the end of a line
#     (a file saved with CRLF) are ignored or dropped. Nothing else is trimmed: a name must start in
#     column 1 and sit right before the `=`.
#   - One optional pair of matching single or double quotes around the value is removed, nothing else
#     (no escapes, no `$`, no backtick).
#   - A value with a control character, or longer than 512 bytes, is dropped: the name stays unset.
#   - An environment variable that is already set and not empty wins over the file.
#   - A missing or unreadable file is ignored, silently.
#
# The function prints nothing, changes no shell option, leaves no variable behind except the names
# above (its own are prefixed `a2a_cfg_` and unset at the end), and returns 0 whatever happens. It
# starts no process: the common path is shell built-ins only. The names are set, not exported.

a2a_load_config() {
  a2a_cfg_file=${A2A_CONFIG_FILE:-${XDG_CONFIG_HOME:-${HOME:-/nonexistent}/.config}/a2a-coord/config}
  if [ -f "$a2a_cfg_file" ] && [ -r "$a2a_cfg_file" ]; then
    a2a_cfg_cr=$(printf '\r')
    # The redirection comes after `2>/dev/null` so that a failed open prints nothing either.
    while IFS= read -r a2a_cfg_line || [ -n "$a2a_cfg_line" ]; do
      a2a_cfg_line=${a2a_cfg_line%"$a2a_cfg_cr"}
      case $a2a_cfg_line in
        '#'*) continue ;;
        *=*) a2a_cfg_name=${a2a_cfg_line%%=*} ;;
        *) continue ;; # blank, or no equals sign
      esac
      case $a2a_cfg_name in
        A2A_SERVER_URL | A2A_CARD | A2A_AGY_CARD | A2A_KEY_FILE | A2A_AGY_KEY_FILE) ;;
        *) continue ;;
      esac
      a2a_cfg_val=${a2a_cfg_line#*=}
      case $a2a_cfg_val in
        # one matching pair of quotes (at least the two quote characters): remove it
        \"*\" | \'*\')
          a2a_cfg_val=${a2a_cfg_val#?}
          a2a_cfg_val=${a2a_cfg_val%?}
          ;;
      esac
      [ -n "$a2a_cfg_val" ] || continue
      [ "${#a2a_cfg_val}" -le 512 ] || continue
      case $a2a_cfg_val in
        *[[:cntrl:]]*) continue ;;
      esac
      # One explicit branch per name: no `eval`, no indirect expansion, and an environment variable
      # that is set and not empty is left alone.
      case $a2a_cfg_name in
        A2A_SERVER_URL) [ -n "${A2A_SERVER_URL:-}" ] || A2A_SERVER_URL=$a2a_cfg_val ;;
        A2A_CARD) [ -n "${A2A_CARD:-}" ] || A2A_CARD=$a2a_cfg_val ;;
        A2A_AGY_CARD) [ -n "${A2A_AGY_CARD:-}" ] || A2A_AGY_CARD=$a2a_cfg_val ;;
        A2A_KEY_FILE) [ -n "${A2A_KEY_FILE:-}" ] || A2A_KEY_FILE=$a2a_cfg_val ;;
        A2A_AGY_KEY_FILE) [ -n "${A2A_AGY_KEY_FILE:-}" ] || A2A_AGY_KEY_FILE=$a2a_cfg_val ;;
      esac
    done 2>/dev/null < "$a2a_cfg_file"
  fi
  unset a2a_cfg_file a2a_cfg_cr a2a_cfg_line a2a_cfg_name a2a_cfg_val
  return 0
}
