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

═══════════════════════════════════════════════════════════════════
ADDITION (5/9 PM) — AGENT CONVERSATION MEMORY (CRITICAL)
═══════════════════════════════════════════════════════════════════

WHY: Current system treats each listing as standalone. Reality: an
agent often has multiple listings AND deep conversation history
across them. Sending a robotic "Hi Daniel, this is Alex with AKB
Solutions" to someone who's been in deep negotiation with us is
embarrassing and damages relationships.

REQUIREMENT: Jarvis must know an agent's full conversation history
(across all their listings) before drafting any outreach.

═══════════════════════════════════════════════════════════════════
NEW ENDPOINT: GET /api/agent-context/[identifier]
═══════════════════════════════════════════════════════════════════

Method: GET
Input: identifier = phone (preferred) or email, URL-encoded.
Output: aggregated relationship profile across all of agent's listings.

Steps:
1. Search Listings_V1 for ALL records where Agent_Phone OR
   Agent_Email matches identifier.
2. For each matching record, count: outreaches sent, replies
   received, final outcome (Dead/Won/Active/Negotiating).
3. Pull last 90 days of Quo SMS for that phone.
4. Pull last 90 days of Gmail threads for that email.
5. Compute aggregate metrics:
   - total_listings: count of records found
   - total_outreaches: sum of outbound across all properties
   - total_replies: sum of inbound replies
   - last_interaction_at: max(last_inbound, last_outbound)
   - days_since_last_interaction: days from now
   - active_properties: where Outreach_Status NOT IN [Dead, Won]
   - properties_with_unanswered_inbound: count where lastInboundAt >
     lastOutboundAt
   - depth_score: see formula below
6. Infer tone from prior message corpus (run brief Claude API call
   on last 5 inbound messages — formal/casual/friendly/transactional).

DEPTH SCORE FORMULA:
- 0 (cold): total_outreaches == 0
- 1 (greeted): total_outreaches >= 1 AND total_replies == 0
- 2 (engaged): total_replies >= 1 AND total_replies < 5
- 3 (relationship): total_replies >= 5 OR total_listings >= 3
                    OR has any record with Outreach_Status='Won'

Return JSON:
{
  identifier,
  agentName,
  totalListings,
  totalOutreaches,
  totalReplies,
  lastInteractionAt,
  daysSinceLastInteraction,
  activeProperties: [{ recordId, address, status }],
  propertiesWithUnansweredInbound: [{ recordId, address,
    lastInboundAt }],
  depthScore: 0 | 1 | 2 | 3,
  inferredTone: 'formal' | 'casual' | 'friendly' | 'transactional',
  metadata: {}
}

Cache: 60s in-memory.

═══════════════════════════════════════════════════════════════════
UPDATE TO /api/jarvis-brief
═══════════════════════════════════════════════════════════════════

When building each broCard:
1. Call /api/agent-context for the record's agent BEFORE drafting.
2. Pass agent context + depth score + inferred tone into the system
   prompt.
3. Claude API instructions explicitly include depth-aware drafting:

   Cold (depth 0):
   "Use the proven outreach script verbatim with first-name + address."

   Greeted (depth 1):
   "Drop the introduction. Reference the property by address.
   Casual reminder tone. Max 2 sentences."

   Engaged (depth 2):
   "No introduction. Reference relationship implicitly. Match the
   inferredTone (casual/friendly/etc). Reference any unfinished
   threads on other properties if present."

   Relationship (depth 3):
   "Conversational. Treat as a colleague. May reference prior deals
   or shared context. Definitely NO 'this is Alex with AKB
   Solutions' — they know who you are."

═══════════════════════════════════════════════════════════════════
NEW ENDPOINT: POST /api/outreach-safety-check
═══════════════════════════════════════════════════════════════════

Pre-send safety gate. ALL outreach (cold AND warm) must pass through
this before firing.

Method: POST
Input: { recordId, channel, body, agentIdentifier }

Steps:
1. Call /api/agent-context for agentIdentifier.
2. Check 1 — Cooldown: agent contacted in last 7 days about any
   property? If yes, return { passed: false, reason: 'cooldown',
   warning: 'You contacted [name] [N] days ago about [other
   property]. Consider holding off or referencing.' }.
3. Check 2 — Property has prior outreach? Look at this record's
   Last_Outreach_Date. If exists, body must NOT contain
   "this is Alex" pattern. Return { passed: false, reason:
   'reintroduction_detected' } if violated.
4. Check 3 — Unanswered inbound? Check
   propertiesWithUnansweredInbound from agent context. If non-empty,
   return { passed: false, reason: 'unanswered_inbound', warning:
   '[Agent] hasn't been responded to on [property]. Respond there
   before contacting about new property.' }.
5. Check 4 — Tone match: depth score 2+ but body contains "this is
   Alex with AKB Solutions"? Return { passed: false, reason:
   'tone_mismatch' }.
6. If all pass: return { passed: true }.

Return JSON:
{
  passed: boolean,
  reason?: string,
  warnings: string[],
  agentContext: AgentContext (full object for UI display),
  suggestedDraft?: string
}

═══════════════════════════════════════════════════════════════════
UPDATE TO /api/deal-action/[id]
═══════════════════════════════════════════════════════════════════

Before sending SMS or creating email draft:
1. Call /api/outreach-safety-check internally.
2. If passed=false, return { success: false, reason, warnings,
   suggestedDraft? } with HTTP 422.
3. Frontend must display warning and require explicit "send anyway"
   confirmation OR show suggested redraft.

═══════════════════════════════════════════════════════════════════
UI CHANGES FOR <JarvisGreeting />
═══════════════════════════════════════════════════════════════════

Each BroCard shows agent context badge in header:

[Daniel Ericksen · 3 listings · Engaged · last contact 2d ago]

Badge color by depth_score:
- 0 cold: gray
- 1 greeted: amber
- 2 engaged: blue
- 3 relationship: green

If propertiesWithUnansweredInbound non-empty, show red strip at top:
"⚠️ You have [N] unanswered messages from this agent. Address those
first or this outreach may damage the relationship."

═══════════════════════════════════════════════════════════════════
TYPE ADDITIONS (types/jarvis.ts)
═══════════════════════════════════════════════════════════════════

export type DepthScore = 0 | 1 | 2 | 3

export interface AgentContext {
  identifier: string
  agentName: string
  totalListings: number
  totalOutreaches: number
  totalReplies: number
  lastInteractionAt: string | null
  daysSinceLastInteraction: number | null
  activeProperties: Array<{
    recordId: string
    address: string
    status: string
  }>
  propertiesWithUnansweredInbound: Array<{
    recordId: string
    address: string
    lastInboundAt: string
  }>
  depthScore: DepthScore
  inferredTone: 'formal' | 'casual' | 'friendly' | 'transactional'
  metadata?: Record<string, any>
}

export interface SafetyCheckResult {
  passed: boolean
  reason?: 'cooldown' | 'reintroduction_detected' |
            'unanswered_inbound' | 'tone_mismatch'
  warnings: string[]
  agentContext: AgentContext
  suggestedDraft?: string
}

Add to existing CardType union:
| 'UNANSWERED_INBOUND_BLOCKING'

═══════════════════════════════════════════════════════════════════
DELIVERABLE ORDER UPDATE
═══════════════════════════════════════════════════════════════════

Insert as Step 5.5 (between deal-action and multi-listing-detect):
- Build /api/agent-context/[identifier]
- Build /api/outreach-safety-check
- Wire safety-check into /api/deal-action
- Update JarvisGreeting BroCard component with agent badge + warning
  strip
- Update jarvis-system-prompt.ts to consume agent context + depth
  score
═══════════════════════════════════════════════════════════════════
