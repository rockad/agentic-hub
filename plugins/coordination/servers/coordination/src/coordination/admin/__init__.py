"""The admin plane (S1-ADMIN): an in-container Unix socket and the commands behind it.

This package's `__init__` imports nothing heavy on purpose: the `a2a-coord` CLI imports
`coordination.admin.protocol`, and must not pull in the whole server to do it.

- `server`: `AdminServer`, the one `AF_UNIX` listener (mode 0600, no TCP, no HTTP route).
- `protocol`: the one-line JSON request and reply, the typed phrase.
- `ops`: the command table. `keyadmin`, `review`, `status`: what each command does.
- `keystore`: the two key-table operations S1-AUTH's store does not have (list, rotate).
- `hooks`: what a key revocation closes besides the database write (S1-WAKE registers here).
- `wiring`: `build_admin`, which `coordination.app.build_server_app` calls.

The CLI side is `coordination.cli`.
"""
