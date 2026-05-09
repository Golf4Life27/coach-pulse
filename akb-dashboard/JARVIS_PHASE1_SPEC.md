# JARVIS Phase 1 Spec — Unified Conversation + BroCard ACT NOW Layer

Canonical reference for building Jarvis Phase 1. Read this file in the new session.

## Foundation (ALREADY BUILT in this session)

- `types/jarvis.ts` — BroCard, TimelineEntry, ActionOption, DealContext, JarvisBrief types
- `lib/jarvis-system-prompt.ts` — shared system prompt builder with all business rules, computeJarvisScore()
- `lib/timeline-merge.ts` — mergeTimeline() for Quo+Gmail+Notes, multi-listing property matching, computeResponseStatus()

## Remaining Deliverables (build in fresh session)

### ENDPOINT 1: GET /api/deal-context/[id]
Fetch Airtable record, pull Quo SMS (via lib/quo.ts getMessagesForParticipant), pull Gmail threads (via Gmail MCP search_threads + get_thread), parse Notes (via lib/notes.ts parseConversation), run multi-listing detection (query all records with same agent phone), merge via mergeTimeline(), compute response status. Cache 60s.

### ENDPOINT 2: GET /api/jarvis-brief
Query active listings (Negotiating/Response Received/Offer Accepted), call deal-context for each, compute Jarvis score via computeJarvisScore(), rank top 3, call Anthropic API with buildJarvisSystemPrompt({context:'brief'}) to generate BroCards. Return JarvisBrief.

### ENDPOINT 3: POST /api/deal-action/[id]
Send SMS via Quo or create Gmail draft. Append to Airtable Notes. Stamp Last_Outbound_At. Handle status changes (mark_dead, accept, walk). Extensible action_type enum.

### ENDPOINT 4: GET /api/multi-listing-detect
Group listings by agent phone, pull Quo messages, run property-match scoring, flag ambiguous assignments. Write to Disambiguation_Queue table.

### COMPONENT: <JarvisGreeting />
Top of Command Center, above Morning Briefing. Fetches /api/jarvis-brief on mount. Renders BroCards with action buttons, editable draft textarea, send confirmation, snooze. Card type driven by CARD_TYPE_CONFIG.

## Test Records
- Sturtevant: recLZgNxuEu27VRbD (Gmail PA-name request from Briyana)
- Creekmoor: recaiFbWZTl1bFzTK (Quo $117,500 counter not in Notes)
- Division/Houston multi-listing: rec7PiRz3iyZcGRbs + recCj7UXPYHlWAUAN (Jassmin Hernandez cross-contamination)

## Key Gotchas
- getListing() uses field NAME mapping (not returnFieldsByFieldId) — see LISTING_NAME_MAP in lib/airtable.ts
- getListings() uses field ID mapping with returnFieldsByFieldId — different code path
- Git proxy may 403 on push — use mcp__github__push_files instead
- Vercel Hobby: 60s function timeout, crons once per day
- Auth gate is cookie-based — use Next.js Link, never window.location.href
