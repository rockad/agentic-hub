# Handoff drift reminder (SessionStart hook) — Windows / PowerShell
# SELF-LOCATING: derives the project from the session's cwd (read from the
# SessionStart JSON payload on stdin), finds HANDOFF.md by walking up from cwd,
# and checks whether any project file is newer than it.
#   * No hardcoded paths — register this hook ONCE, globally. It handles every
#     project automatically; a second /handoff in another project does NOT touch it.
#   * Silent when the current project has no HANDOFF.md, or when HANDOFF.md is newest.
# ASCII-only on purpose: PowerShell 5.1 reads .ps1 as ANSI without a BOM.
#
# SETUP: copy to ~/.claude/hooks/ and register ONE entry in ~/.claude/settings.json
# under hooks.SessionStart (append to the array; do not overwrite other hooks).
# Nothing inside needs editing — there are no placeholders.
$ErrorActionPreference = 'SilentlyContinue'

# SessionStart delivers a JSON payload on stdin that includes "cwd".
$raw = [Console]::In.ReadToEnd()
$cwd = ''
try { $cwd = ($raw | ConvertFrom-Json).cwd } catch { }
if (-not $cwd) { $cwd = (Get-Location).Path }

# Walk up from cwd to the nearest HANDOFF.md; that dir is the project root.
$handoff = $null; $projectDir = $null; $dir = $cwd
while ($dir) {
    $candidate = Join-Path $dir 'HANDOFF.md'
    if (Test-Path $candidate) { $handoff = $candidate; $projectDir = $dir; break }
    $parent = Split-Path $dir -Parent
    if (-not $parent -or $parent -eq $dir) { break }
    $dir = $parent
}
if (-not $handoff) { exit 0 }   # no handoff in this project -> silent

$handoffTime = (Get-Item $handoff).LastWriteTime

# Default: watch every project file except noise dirs and the handoff itself.
# TO NARROW (fewer false positives): replace the Get-ChildItem block with an
# explicit @('path1','path2',...) list of load-bearing files.
$others = Get-ChildItem -Path $projectDir -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object {
        $_.FullName -notmatch '\\(\.git|node_modules|dist|build|\.next|target|__pycache__|\.venv)\\' -and
        $_.Name -ne 'HANDOFF.md'
    }

$newer = $others |
    Where-Object { $_.LastWriteTime -gt $handoffTime } |
    Sort-Object LastWriteTime -Descending
if (-not $newer) { exit 0 }   # no drift -> silent

$names = ($newer | Select-Object -First 6 -ExpandProperty Name) -join ', '
$msg = "REMINDER (handoff drift): HANDOFF.md is older than project files: $names. If this session did substantive work, refresh HANDOFF.md before ending the block while context is fresh -- append a new step to the chronology (do not rewrite prior ones), and update sections 1/3/5/6/9. After saving, its mtime becomes newest and this reminder goes silent. This is a backstop -- the semantic update is on you; the hook only detects drift."

$payload = @{ hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = $msg } }
$payload | ConvertTo-Json -Compress
exit 0
