#!/usr/bin/env bash
# Maverick continuity Stop hook (operator continuity fix, 2026-06-28).
#
# WHY: continuity failed for months because sessions LOAD the Maverick spine at
# open but never WROTE back — so the spine drifted behind reality and each new
# chat/cowork session inherited STALE truth. CLAUDE.md now has a write-as-you-go
# rule; THIS is the end-of-session backstop. It refuses to let a session stop if
# it shipped git commits but never called mcp__Maverick__maverick_write_state.
#
# DESIGN:
#   - Pure-local: inspects the session transcript only. Zero network, zero deps
#     beyond coreutils + grep (no jq — must run on any cloud VM).
#   - Fail-OPEN: any uncertainty (no transcript, unreadable) → allow the stop.
#     A continuity nag must never TRAP a session.
#   - One-shot: honours stop_hook_active so it reminds once, then lets the stop
#     through (prevents the infinite-loop trap). The reminder is the mechanism;
#     pairing it with the CLAUDE.md write-as-you-go habit is what makes it stick.
#
# PATTERNS verified against a real transcript 2026-06-28: tool uses are the
# Anthropic message format — "name":"Bash" / "name":"mcp__Maverick__..." (NOT
# "tool_name", which an early draft got wrong), Bash commands in "command":"...".
# The literal-quote patterns below do NOT match the backslash-escaped copies
# that appear when this very file is Read/Written in a transcript, so the hook
# does not false-trigger on sessions that merely touch it.

set -u
input="$(cat)"

# --- read stdin fields with grep/sed (no jq dependency) ---
stop_active="$(printf '%s' "$input" | grep -o '"stop_hook_active"[[:space:]]*:[[:space:]]*[a-z]*' | head -1 | grep -o '[a-z]*$')"
transcript="$(printf '%s' "$input" | grep -o '"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//')"

# Loop guard: already reminded once this stop → allow it through now.
[ "${stop_active:-}" = "true" ] && exit 0
# Can't locate/read the transcript → fail OPEN (never trap a session).
[ -n "${transcript:-}" ] && [ -f "$transcript" ] || exit 0

# Did THIS session ship commits? Did it write to the Maverick spine?
has_commit=0; has_write=0
grep -qE '"command"[[:space:]]*:[[:space:]]*"[^"]*git commit' "$transcript" && has_commit=1
grep -q '"name":"mcp__Maverick__maverick_write_state"' "$transcript" && has_write=1

if [ "$has_commit" = "1" ] && [ "$has_write" = "0" ]; then
  cat >&2 <<'MSG'
⛔ CONTINUITY GATE — this session shipped git commits but never called
mcp__Maverick__maverick_write_state. The next chat/cowork session loads the
Maverick spine at open; if you don't write, it inherits STALE truth — the
exact failure this gate exists to stop.

Before ending: if ANY commit changed doctrine / pricing / gates / system
behavior, write it to the spine now via mcp__Maverick__maverick_write_state
(build_event | principle_amendment | decision | deal_state_change), then keep
the file spine current (INVARIANTS / AS_BUILT / SYSTEM_HANDOFF / SYSTEM_FACTS).
If every commit was genuinely trivial (typo / comment / formatting), you may
stop again to bypass this one-time gate. See CLAUDE.md "Write the spine back".
MSG
  exit 2
fi
exit 0
