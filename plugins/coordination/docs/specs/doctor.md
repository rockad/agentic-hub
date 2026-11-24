# `bin/a2a-doctor`: the install check

Decision Z21 item 7 (master plan 12.3). `a2a-doctor` is the one thing left of the old S1-INST installer: a command the **user runs by hand** that checks the install of the plugin and prints what to do about each finding. It is not a hook, it is named in neither `hooks.json` nor `claude/hooks.json` [verified, `tests/test_plugin_layout.py::test_neither_hooks_file_names_the_doctor`], and unlike the hooks it may print to stdout and exit non-zero.

Tags used below: **[verified]** names the test that pins the point; **[unverified]** says what was not run.

## 1. Invocation, output, exit status

```text
a2a-doctor [--no-network]
a2a-doctor -h | --help
```

- Plain ASCII, no colour. One line per check, prefixed `OK`, `WARN`, `FAIL` or `INFO` and padded to six columns; sections open with a `== Name ==` line; the last line is `a2a-doctor: N FAIL, M WARN`. [verified: every run of `tests/test_doctor.py` goes through `World.run`, which fails on a line of any other shape, on a non-ASCII byte or an escape character, and when the summary does not equal the number of `FAIL` and `WARN` lines.]
- Exit status: `0` when there is no `FAIL` (any number of `WARN` and `INFO`), `1` when there is at least one `FAIL`, `2` for a usage error (any argument but `--no-network`; a usage line on stderr, nothing on stdout). `-h` and `--help` print the usage and exit 0. [verified: `test_a_usage_error_exits_2_...`, `test_help_prints_the_usage_...`, `test_exit_status_is_1_exactly_when_there_is_a_fail`, `test_a_warning_alone_does_not_make_the_exit_status_1`]
- `--no-network` skips the server section: no request at all. [verified: `test_no_network_makes_no_request`]
- It never hangs: every curl has `--connect-timeout 2` and `--max-time 5`. The worst case is the health check plus two probes and two ends, about 25 s. [verified: `test_a_slow_server_is_cut_at_5_seconds_...`, `test_a_probe_that_hangs_is_cut_at_5_seconds_too`, `test_every_curl_call_is_bounded_protocol_limited_and_ignores_proxies`]
- Runs under dash and under `bash --posix` with identical output. [verified: `test_it_runs_under_bash_posix_...`] `shellcheck -s sh -S style` and `dash -n` are clean. [verified: `test_the_doctor_is_shellcheck_clean_at_style_level`, `test_the_doctor_parses_under_dash`]

## 2. What it never does

Each point has a test; `World.run` applies the last three to every run.

- It edits no harness config, settings file or key file, and writes no file at all: the whole temporary tree (HOME, TMPDIR, the working directory, with modes, mtimes, sizes and content hashes) is the same before and after, whatever the outcome. An orphan file it reports is not deleted. [verified: `test_the_doctor_writes_nothing_and_changes_nothing_under_the_temporary_tree`, `test_nothing_in_the_doctor_writes_runs_the_harnesses_or_evaluates_text`]
- It prints no key and no part of one. Text taken from a file or the environment is reduced to printable ASCII, any `a2ak_` run in it is replaced by `a2ak_<hidden>`, and it is cut at 200 characters; nothing a server sends is printed except a handle that matched the handle grammar and the card. The value of an agy entry's own `url` is never shown. [verified: every `World.run` checks stdout and stderr for the key and for its inner pieces; `test_a_key_file_that_does_not_look_like_a_key_is_a_fail_and_is_never_printed`, `test_an_orphan_name_that_holds_a_key_is_shown_with_the_key_hidden`, `test_an_entry_url_that_is_not_the_effective_server_url_is_a_warning_and_is_not_echoed`]
- No key is in a child's argument list or environment. It reaches curl on stdin (`printf 'header = "Authorization: Bearer %s"\n' | curl -K -`; `printf` is a built-in, and the key sits only in non-exported shell variables, which are unset first, all five of them (`dr_ckey`, `dr_atok`, `dr_etok`, `dr_eauth`, `pr_key`), so that an imported variable of the same name cannot make them exported; the Opus review of PR #105 found two of the five missing, and `test_no_imported_secret_holder_reaches_a_child_on_the_probe_path_either` now imports all five and runs the probe path). `A2A_API_KEY` is noted as set or not and then unset, so no child inherits it. The script starts with `set +x`, so `sh -x a2a-doctor` does not trace a key [verified: `test_a_shell_trace_does_not_print_a_key`, `test_a_trace_in_shellopts_does_not_print_a_key_under_bash`]. Known and accepted: the effective server URL is printed as it is, so a password written into the URL (`user:pass@host`, allowed by the URL guard like in the hooks) would be shown; it cannot be an API key from the key files. [verified: `test_a_key_is_never_in_any_process_argument_list_or_a_childs_environment` (the sampler of the agy hook tests, for each key), `test_a_fake_curl_sees_the_key_on_stdin_only_and_every_call_is_bounded`, `test_the_doctor_leaves_the_environment_variable_out_of_every_child`, `test_an_imported_variable_of_the_same_name_as_a_secret_holder_does_not_reach_a_child`] The sampler cannot see `A2A_API_KEY` itself: a forked subshell shows its parent's initial environment in `/proc`, so that test runs without it and the fake-curl and fake-`sed` tests cover the variable.
- It never runs `claude` or `agy`. [verified: `World.run` puts a fake `agy` and a fake `claude` first on PATH and fails when either leaves its marker; the static test finds no such command in the code.]

## 3. Settings read

Like the hooks: `LC_ALL=C`, then `. "$DIR/a2a-lib.sh"` and `a2a_load_config` (`$DIR` is the folder of the script), so the effective `A2A_SERVER_URL`, `A2A_CARD`, `A2A_AGY_CARD`, `A2A_KEY_FILE` and `A2A_AGY_KEY_FILE` are the ones the hooks would see, from the environment or `${A2A_SETTINGS_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/a2a-coord/settings}`. [verified: `test_the_server_url_can_come_from_the_settings_file`, `test_the_key_and_card_settings_are_read_through_the_lib`, `test_the_doctor_reads_settings_like_the_hooks_do`] A lib that is missing is `FAIL a2a-lib.sh not found next to a2a-doctor` and the rest still runs. [verified: `test_a_missing_lib_is_a_fail_and_the_rest_still_runs`] It also works when started as `sh a2a-doctor` from its own folder (no slash in `$0`). [verified: `test_the_doctor_finds_the_lib_whatever_way_it_is_started`]

The server URL is checked once, as the hook scripts check it: `http://` or `https://` followed by at least one character, and only `A-Za-z0-9._~:/@%-`. A bad one is a `FAIL` with the reason (the value is not echoed) and the network checks are skipped; the snippet then shows the default `http://127.0.0.1:8120`. A trailing `/` is dropped. [verified: `test_a_bad_server_url_is_a_fail_...`, `test_a_server_url_with_a_trailing_slash_is_accepted`]

## 4. Sections and checks

### 4.1 Install commands (always, `INFO`)

`claude plugin marketplace add rockad/agentic-hub`, `claude plugin install coordination@agentic-hub`, `agy plugin install https://github.com/rockad/agentic-hub/tree/main/plugins/coordination`, and the rule that plugins install only from the remote `main`, never from a copied or symlinked folder. [verified: `test_the_install_commands_and_the_remote_main_rule_are_always_printed`] The agy command is itself **[unverified]** as an install from a GitHub tree URL (README, Install).

### 4.2 Plugin files

| Check | Result |
| --- | --- |
| `a2a-lib.sh` next to the doctor | `OK`, else `FAIL` |
| `a2a-register a2a-listen a2a-pending a2a-agy-session a2a-agy-pending` exist | `OK`, else `FAIL` |
| ... and are executable | `OK`, else `FAIL` |
| `curl` on PATH | `OK`, else `FAIL` |
| version from `../plugin.json` (`jq` when present, else `sed`) | `INFO plugin version X`, else `WARN` |

[verified: `test_all_scripts_are_found_and_the_version_is_printed`, `test_a_missing_script_is_a_fail`, `test_a_script_that_is_not_executable_is_a_fail`, `test_the_version_is_read_with_and_without_jq`, `test_an_unreadable_plugin_json_is_a_warning`]

### 4.3 Settings file

Effective path as above. Outcomes:

| Finding | Level |
| --- | --- |
| missing | `INFO` (settings are optional) |
| a directory | `FAIL` "is a directory; the hooks ignore it" |
| not a regular file | `FAIL` |
| not owned by you (`test -O`, as in the lib) | `WARN` "the hooks ignore a file you do not own" |
| not readable | `WARN` |
| mode wider than 0600 (any group or other bit, the owner execute bit, setuid, setgid, sticky) | `WARN`; else `OK` |
| mode cannot be read | `INFO` |

The config directory (`${XDG_CONFIG_HOME:-$HOME/.config}/a2a-coord`) with a mode wider than 0700 is a `WARN`; a missing one is `INFO`. The mode is read with `stat -c %a` and falls back to `stat -f %Lp` (macOS). [verified: `test_a_directory_at_the_settings_path_is_a_fail`, `test_the_settings_file_mode_is_checked_against_0600`, `test_the_config_directory_mode_is_checked_against_0700`, `test_a_settings_file_the_user_does_not_own_is_a_warning` (points at a root-owned system file; skipped as root), `test_an_unreadable_settings_file_is_a_warning`, `test_the_mode_falls_back_to_the_bsd_stat_form` (a fake `stat` that rejects `-c`), `test_an_unreadable_mode_is_info_not_a_failure`] **[unverified]** on a real macOS: the BSD `stat -f %Lp` form is only exercised through the fake, and `-O` on a file owned by another user is checked on Linux only.

### 4.4 Claude key

Key file: `A2A_KEY_FILE` or `~/.config/a2a-coord/api-key`.

| Finding | Level |
| --- | --- |
| missing | `FAIL`, with how to create it: you create it, the doctor never does; a mode-0600 file whose first line is the API key issued by the server's admin tool |
| a directory, or not readable | `FAIL` |
| mode wider than 0600 | `WARN` |
| first line not `^a2ak_[A-Za-z0-9._~+/=-]+$` (empty, blank first line, CRLF, a space, a quote, a `$`...) | `FAIL` "does not look like an a2a key"; the line is not printed and the Claude probe is skipped |
| otherwise | `OK` |

The pattern is the brief's `^a2ak_[A-Za-z0-9._~+/=-]*$` with at least one character after the prefix (`a2ak_` alone is not a key). The character set is the one `a2a-register` lets through to the curl config line. `A2A_API_KEY` set in this shell is `INFO`; unset or empty is `WARN` "Claude Code's MCP header needs it; export it from the key file in your shell rc, then restart Claude Code". Its value is never printed and never compared with the file. [verified: `test_a_missing_claude_key_file_is_a_fail_...`, `test_the_claude_key_file_mode_is_checked_against_0600`, `test_a_key_file_that_does_not_look_like_a_key_is_a_fail_...`, `test_a2a_api_key_in_the_shell_is_info_and_unset_is_a_warning_...`, `test_a2a_api_key_is_not_compared_with_the_file`]

### 4.5 Antigravity (agy)

File: `A2A_AGY_KEY_FILE` or `~/.gemini/config/mcp_config.json`.

| Finding | Level |
| --- | --- |
| missing | `WARN` "agy entry not set up" (agy is optional for a Claude-only user) |
| a directory | `FAIL`; not readable: `WARN` |
| mode wider than 0600 | `WARN` (it holds a key) |
| `jq` present and the file is not a JSON object | `WARN` "agy will not load it"; the text checks below still run |
| no `a2a-coord` entry (`jq`: `.mcpServers` has the key; no `jq`: the quoted name `"a2a-coord"` in the first 64 KiB) | `WARN` "agy entry not set up" |
| entry present, first `a2ak_` token missing | `FAIL` "has an a2a-coord entry but no a2ak_ key" |
| ... is the placeholder `a2ak_REPLACE_WITH_YOUR_KEY` | `FAIL` (the snippet was pasted and the key not replaced); no agy probe |
| ... is not of the form `a2ak_<env>_<keyid>_<secret>` | `FAIL` |
| `jq`: entry `url` (or the legacy `serverUrl`) is not `<server url>/mcp` | `WARN` (the entry's own value is not printed) |
| `jq`: entry has no `Authorization` header | `WARN` |
| `jq`: the first `a2ak_` token of the file is not the entry's | `WARN` (the agy hooks read the first one) |
| orphan: `$HOME/.gemini/config/plugins/coordination/mcp_config.json` exists | `WARN` with the exact path (the pre-Z20 plugin-folder file; delete it by hand) |
| orphan: another server named `a2a-...` besides `a2a-coord` (`jq`: the keys of `.mcpServers`; no `jq`: quoted strings starting `"a2a-` found by text, which may be a false positive) | `WARN`, up to five names, key-shaped text hidden |

The key is read the way `a2a-agy-session` reads it: the first `a2ak_[A-Za-z0-9_-]*` token in the first 64 KiB, which must match `a2ak_*_*_*`. A token past 64 KiB is therefore not found, exactly as the hooks do not find it. [verified: `test_a_missing_agy_file_is_a_warning_...`, `test_the_agy_file_mode_is_checked_against_0600`, `test_a_good_agy_entry_is_ok`, `test_a_file_without_an_a2a_coord_entry_is_a_warning`, `test_an_empty_object_and_a_file_without_mcpservers_are_a_missing_entry`, `test_an_entry_without_a_usable_key_is_a_fail`, `test_the_placeholder_key_is_a_fail_and_is_not_probed`, `test_an_entry_url_that_is_not_the_effective_server_url_...`, `test_the_legacy_serverurl_key_counts_as_the_entry_url`, `test_a_first_key_that_is_not_the_entrys_key_is_a_warning`, `test_a_file_that_is_not_valid_json_...`, `test_the_old_pre_z20_plugin_folder_file_is_an_orphan_warning_...`, `test_another_a2a_server_entry_in_the_global_file_is_an_orphan_warning`, `test_without_jq_the_entry_and_orphans_are_found_by_text_...`]

The section ends with the snippet, as two `INFO` lines (an instruction, then the JSON on one line), consistent with the README:

```json
{"mcpServers": {"a2a-coord": {"type": "http", "url": "<server url>/mcp", "headers": {"Authorization": "Bearer a2ak_REPLACE_WITH_YOUR_KEY"}}}}
```

The instruction: merge it into the existing `mcpServers` object by hand, keep the file mode 0600, the plugin never edits it. [verified: `test_the_agy_snippet_is_printed_with_the_placeholder_and_the_effective_url`] That agy accepts `"type": "http"` in a global `mcp_config.json` is **[unverified]**: the spikes verified `url` and `headers`, and `server-api.md` 11.2 carries both spellings; the field is harmless to a reader that ignores it, and the README snippet carries it too so the two agree.

### 4.6 Server (skipped by `--no-network` and by a bad URL)

1. `GET <url>/healthz`, no key. `200` is `OK`; any other status, or no answer, is `FAIL` with the status or "no answer", the URL, and the hint that the stack runs under `plugins/coordination` with `docker compose up`. No server text is printed. When it fails the probes are skipped (`INFO probe sessions skipped`): [verified: `test_healthz_200_is_ok`, `test_healthz_with_another_status_is_a_fail_...`, `test_healthz_with_nothing_listening_is_a_fail_no_answer_and_fast`]
2. Claude probe, only when the Claude key is usable. The card is `A2A_CARD`, else `claude-code@<short host name>` computed as `a2a-register` does (first label, lowercased, characters outside `a-z0-9-` replaced by `-`, 32 bytes, leading `-` dropped). It must match `^[a-z0-9][a-z0-9-]{0,31}@[a-z0-9][a-z0-9-]{0,31}$`, otherwise `FAIL` "not a valid card" and no probe. The request is `a2a-register start`'s without a name hint: `POST /sessions` with `{"card": ..., "harness_session_id": "doctor-<pid>"}`, `Authorization` on stdin. Outcomes: `200` or `201` with a handle that matches the handle grammar (`server-api.md` 5.1) and begins with the card is `OK "Claude key accepted: registered as <handle>"`; `401` or `403` is `FAIL "the server rejected the Claude key"`; a 2xx without a valid handle is `FAIL`; no answer is `FAIL`; any other status is `FAIL` with the status only. The server's body is never printed.
3. After a successful registration the probe session is ended as `a2a-register end` does (`POST /sessions/end`, the same body) and the result is `INFO` "probe session ended", or `INFO` "could not be ended (status N); it ends by itself when idle". A registration that failed is not ended.
4. agy probe, only when a well-formed `a2ak_` token can be read from the agy file (so not the placeholder): the same, with the card `A2A_AGY_CARD`, else `antigravity@<machine>` computed as `a2a-agy-session` does (`uname -n | cut -d. -f1`, lowercased, characters outside `a-z0-9\n-` replaced by `-`, 32 bytes), which must start `antigravity@` with a machine of `[a-z0-9][a-z0-9-]{0,31}`.

[verified: `test_a_healthy_install_is_all_green_and_exits_0`, `test_the_doctor_calls_healthz_without_a_key_and_registers_and_ends_a_probe_per_harness` (the bodies, headers and order the stub saw), `test_a_rejected_claude_key_is_a_fail`, `test_another_probe_status_is_a_fail_with_the_status_only`, `test_a_registration_without_a_valid_handle_for_this_card_is_a_fail_...`, `test_a_probe_session_is_ended_and_a_failed_end_is_info`, `test_the_end_request_is_not_sent_for_a_failed_registration`, `test_the_default_cards_are_computed_from_the_host_name_like_the_hook_scripts`, `test_a_host_name_with_odd_characters_is_reduced_like_the_hooks_do`, `test_an_invalid_claude_card_is_a_fail_and_not_probed`, `test_an_invalid_agy_card_is_a_fail_and_not_probed`, `test_with_no_usable_claude_key_only_the_agy_probe_runs`, `test_with_no_agy_key_only_the_claude_probe_runs`, `test_a_rejected_agy_key_is_a_fail_naming_agy`, `test_every_call_is_bounded_and_ignores_proxies` (a proxy variable does not divert a probe)]

A probe registers a real session on the server for a moment (`doctor-<pid>`, no name hint) and ends it again; the server may record both in its audit trail.

## 5. Not covered, and open

- **[unverified]** against the real server image: the tests use a stub that answers the documented statuses and shapes; the `docker compose` stack is not started here (the main session runs the full suite). The key probes against a real `a2a-coord` key are the user's live check.
- **[unverified]** the real layouts of agy's `mcp_config.json`: only the `mcpServers` object with `url` (or `serverUrl`) and `headers.Authorization` is read, as the spikes recorded it. A different layout is read by the text checks only.
- **[unverified]** macOS: `stat -f %Lp`, the BSD `sed` and `tr` forms and `uname -n` on a Mac are exercised only through fakes or by shape (the script uses the same `tr`/`sed`/`cut` calls as the hook scripts).
- **[unverified]** the path of an installed plugin under either harness: the doctor finds its neighbours from `$0`, so it must be run in place; a symlink to it from elsewhere will not find `a2a-lib.sh` (and says so).
- It does not check that a hook is registered in a harness, that `claude` or `agy` is installed, or that the key's scope or Tailscale identity is right beyond what the server answers to the probe.
- The doctor reads at most 64 KiB of the agy file by text, like the hook; with `jq` it reads the whole file for the structure.
