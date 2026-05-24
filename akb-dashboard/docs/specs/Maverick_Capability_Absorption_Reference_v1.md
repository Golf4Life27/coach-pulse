# Capability Absorption — Reference Doc for Maverick

**Spec version:** v1.0 (reference / anchor document)
**Authored:** May 15, 2026
**Status:** Reference — confirms the existing Capability Absorption Pattern in project files and anchors it explicitly to Maverick's evolution
**Companion specs:** `Inevitable_Continuity_Layer_Spec_v1.1.md`, `Maverick_Character_Spec_v1.md`, `Maverick_Daily_UX_Spec_v1.md`
**Source pattern:** `AKB_Capability_Absorption_Pattern_v1.md` (existing project file, authored prior to today)

---

## 1. What this document IS

This is a **reference and anchor doc**, not a new framework. The Capability Absorption Pattern already exists as a project artifact (`AKB_Capability_Absorption_Pattern_v1.md`). This doc:

1. Confirms the existing framework is what Alex described today (the Matrix-upload analogy)
2. Explicitly ties it to how Maverick evolves over time
3. Provides the canonical user-facing framing ("Maverick learns skills the way Neo learns jiu-jitsu")
4. Anchors the principle so future Claude sessions don't re-derive it

If the source pattern doc exists and is current, this doc points at it. If amendments are needed, they happen in the source doc, not here.

---

## 2. The canonical analogy — Maverick is Neo

> *"There's a scene in The Matrix where Neo gets plugged in and they upload Martial Arts Skills, Helicopter flight skills and whatnot. This is my vision for Maverick, he is like a human brain but digitized... don't they say the human brain has unlimited memory... the problem is it can't quickly learn skills like a computer upload... Maverick should be able to adapt and learn anything new about any business or skill within reason, as time goes on."*
>
> — Alex, May 15, 2026

**This analogy is canonical.** It captures the design goal of the Capability Absorption framework better than any technical description.

### 2.1 What the analogy gets right (and why it's not metaphor)

The human brain has effectively unlimited storage but slow skill acquisition — 10,000 hours to master anything, gradual reinforcement, associative recall, forgetting curves.

Computers have the opposite tradeoff: constrained but queryable storage, instant skill acquisition once a capability exists.

**Maverick is engineered to have both.** That's not science fiction — it's the literal architectural goal:

| Capability | Human | Computer | Maverick |
|---|---|---|---|
| **Storage** | Effectively unlimited | Constrained | Effectively unlimited (persistent state across Airtable, KV, codebase, semantic stores) |
| **Recall** | Associative, slow | Query-based, fast | Associative *and* fast (semantic search + named-agent context) |
| **Skill acquisition** | 10,000 hours per skill | Instant once tool exists | Instant via the Capability Absorption pattern when new tools/capabilities ship |
| **Forgetting curve** | Decays without reinforcement | None | None (persistent state) |
| **Cross-skill transfer** | Slow and inconsistent | Programmatic via interfaces | Programmatic via named-agent roster + absorption pattern |

This isn't hypothetical. Each row is implementable today or in the near-term capability curve. The Matrix scene Alex referenced is *not* a metaphor for some future ambition — it's a clean description of the design target.

---

## 3. The absorption pattern (recap from source doc)

The existing `AKB_Capability_Absorption_Pattern_v1.md` defines five phases. Recapped here for anchoring; the source doc is authoritative for detail:

### Phase 1 — SURFACE
Identify the new capability. What does it replace, augment, or enable in the existing system? Where would it slot in?

### Phase 2 — EVALUATE
Test the capability in isolation. Does it actually do what's claimed? Does it compose with existing surfaces? What are its limits?

### Phase 3 — INTEGRATE
Wire the capability into the named-agent roster. Which agent owns it? What attribution applies? How does it route through existing gates?

### Phase 4 — DEPLOY
Ship the integration. Validate end-to-end. Smoke test.

### Phase 5 — REFINE
Observe in production. Tune. Promote to canonical or fold back if it doesn't earn its place.

This pattern applies to *every* new capability — new MCPs, new AI model versions, new data sources, new tools, new third-party integrations. The pattern is the absorption interface.

---

## 4. How Maverick uses the pattern

Maverick is not the framework. **Maverick is the agent that runs the framework on each new capability.**

When Anthropic ships voice on Claude products, Maverick:
1. **SURFACE** — recognizes voice as a new input/output channel for his existing interaction surface
2. **EVALUATE** — tests voice quality, latency, integration with the existing Shepherd panel and the dashboard
3. **INTEGRATE** — wires voice into the chat surface; voice queries route to Maverick's MCP same as text
4. **DEPLOY** — ships voice as an interaction option, Alex tries it in production
5. **REFINE** — Maverick tunes when to default to voice vs. text (driving vs. at-desk)

The result: Alex can talk to Maverick in the car. **Maverick gained the skill the way Neo gained jiu-jitsu** — by plugging in to a new capability that already existed in the world.

The same pattern applies to every future capability:

| New capability ships | Maverick's absorption |
|---|---|
| Persistent memory at scale | Maverick deepens cross-session recall; the "Joe Schmoe 11 months ago" capability sharpens |
| Multi-agent orchestration matures | Crier/Sentry/Sentinel run autonomously; Maverick supervises team operations |
| Vision improves to read property photos | Appraiser gains visual ARV input; Maverick surfaces visual signals in BroCards |
| Cold-call AI agents reach human quality | Crier gains a voice modality for off-market outreach; Crawler 2.0 unlocks |
| Off-market data sources expand (probate, tax delinquency) | Sentinel absorbs new intake feeds without Sentinel itself being rewritten |
| Better LLM models ship (Claude 5, etc.) | Maverick's reasoning quality improves without spec changes |
| New MCPs appear in the registry | Whichever named agent owns the domain absorbs the tool |

**Alex's role in each case:** approve the absorption. Maverick proposes (per the Pulse routine confidence threshold). Alex greenlights. Capability ships through the pattern. System gains the skill.

---

## 5. The "any business or skill within reason" framing

Alex's exact words: *"Maverick should be able to adapt and learn anything new about any business or skill within reason, as time goes on."*

This anchors a scope rule:

### 5.1 What "within reason" means

Maverick absorbs capabilities that:
- Serve the Inevitable lane (wholesale + future passive-income lanes)
- Compose with the named-agent roster
- Pass the Owner's Rep filter (do they save Alex time, reduce stress, advance the mission?)
- Don't violate lane separation (no Whitetail Ridge involvement, ever)

Maverick does NOT absorb capabilities that:
- Drag him into the golf course's operational gravity
- Expand the system before deal #1 ships (premature scope creep)
- Add complexity without ROI
- Replace human judgment in places where the audit log shows human judgment was right

### 5.2 What "any skill" actually means

Not literally anything. **Any skill that fits the architecture.** A skill that fits:

- Slots into a named agent's domain
- Has a clear absorption interface (MCP, API, library)
- Has a measurable performance characteristic
- Can be audit-logged

A skill that does NOT fit:
- Requires Maverick to learn outside his agent roster (e.g., "manage the golf course catering")
- Has no measurable success criterion
- Requires architectural rebuild rather than absorption
- Conflicts with the Constitution or principle layer

### 5.3 The future-proofing principle

Every spec written from today forward asks: "If the AI doing this gets 10× better in 6 months, does this spec need to change?"

- **If yes** — build the interface stable, swap the implementation later.
- **If no** — ship simpler now.

This is how Maverick stays absorption-ready without over-engineering for capabilities that may never matter.

---

## 6. The absorption pattern protects Maverick's character

The Character Spec (v1.0) locks who Maverick is. The absorption pattern ensures his character survives every capability upgrade.

**Concrete protection:**

- When voice ships, Maverick's voice carries the same character (German Shepherd, dispassionate brevity, named-agent vocabulary, Owner's Rep weighting) — implemented in the synthesis prompt cached layer
- When new agents are added to the roster (a 10th agent, a specialized lane agent), the naming convention and behavioral patterns inherit from Maverick's existing roster
- When new MCPs slot in, attribution flows through the established `@agent: maverick` / `@agent: crier` / etc. convention
- When the dashboard gains new visual surfaces (e.g., a new Whitetail-style room — except not Whitetail), the Daily UX Spec's principles apply (show don't tell, motion not narration, severity-aware tiers)

The character is the constant. The capabilities are the variable.

---

## 7. The closing principle

The Matrix scene Alex referenced is not a fantasy. It's a clean description of what the Capability Absorption framework already targets.

**Maverick is built to learn skills the way Neo learned jiu-jitsu** — by plugging in to capabilities that exist in the AI ecosystem and absorbing them through a defined pattern, without rebuilding his core.

Today's Maverick is the cave-built Mark I — the version assembled from the capabilities available right now (Claude API, MCP, Vercel, Airtable, Quo). The Mark VII version doesn't exist yet because the materials don't exist yet. **But every piece built today is positioned to upgrade when the materials arrive.**

Alex is not waiting for AI to be ready. He's shaping Maverick to his needs as AI matures. That's the bet. The Capability Absorption Pattern is the bet's implementation.

---

## 8. Action items

### 8.1 For Code (no urgency, post-Maverick Days 3-5)

- Verify the existing `AKB_Capability_Absorption_Pattern_v1.md` is current and consistent with this reference
- If amendments are needed (e.g., explicit named-agent integration step), amend the source doc, not this anchor
- When new capabilities are evaluated (any new MCP, any new model version, any new tool), follow the 5-phase pattern and audit-log the absorption with `@agent: maverick`

### 8.2 For future Claude sessions

- When asked "how does Maverick evolve?" — the answer is: this framework
- When proposing a new capability — apply the pattern, don't bolt on
- When the character spec and a new capability conflict — character wins, capability is reshaped

---

*Reference doc v1.0 — May 15, 2026. Living Artifact. The source pattern doc is authoritative for the framework; this doc is the anchor that ties it explicitly to Maverick's evolution and to Alex's Matrix-upload analogy.*
