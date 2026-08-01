#!/usr/bin/env bash
# Maverick continuity SessionStart hook (operator, 2026-08-01).
#
# WHY: the Stop hook (maverick-continuity-check.sh) makes the spine WRITE path
# physical — a session cannot end with commits and no spine write. Nothing made
# the READ path physical, and on 2026-08-01 a session proved the gap: it wrote
# 8 spine entries while never calling maverick_load_state, worked from stale
# Airtable fields, counted a dead contract as alive, re-derived a finding the
# spine already carried (with a correction!), and demoted an operator-MANDATED
# build to a "candidate." The operator caught it live: "HOW DO YOU NOT KNOW
# THIS?!  We talked about it yesterday." (Spine recFMKwtzsVI40yj2.)
#
# DESIGN: SessionStart cannot block (and must not — never trap a session).
# What it CAN do is make the load directive the FIRST thing in context, with
# teeth, instead of a polite line buried in MCP server instructions — which is
# exactly where it lived when it failed. stdout of a SessionStart hook is
# injected into context. Fail-open by construction: this only ever prints.

cat <<'MSG'
⛔ SPINE READ GATE — before any substantive work in this session, call
mcp__Maverick__maverick_load_state (and maverick_recall for any deal you are
about to reason about). Airtable FIELDS are not session truth — they lag and
they lie (Contract_Executed_At survives a dead deal; List_Price sat $60K stale
on a record under contract). The spine is where prior sessions recorded what
actually happened, including operator rulings that override anything a field
says.

A session that skipped this on 2026-08-01 rebuilt two-day-old findings from
scratch and reported a dead contract as revenue. Do not be that session.
Load first. Then work.
MSG
exit 0
