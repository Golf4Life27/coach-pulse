# Evaluation — crawl4ai (unclecode/crawl4ai)

**Date:** 2026-08-02 · **Verdict:** ADOPT NARROWLY, LATER. Not a fix for today's outage.

---

## 1. Verdict

crawl4ai is a real, well-maintained tool. It is **not** the answer to either fire
currently burning:

- **RentCast 403 (live, as of ~16:30Z today).** RentCast is a structured property-data
  API — AVMs, comps, beds/baths/sqft, listing status. crawl4ai scrapes web pages. There
  is no page it can fetch that returns a RentCast AVM. **Zero overlap. Fix the key.**
- **Firecrawl discovery.** Our Firecrawl usage is two legs (`lib/crawler/sources/firecrawl.ts:504`):
  leg 1 is `/v2/search` — address → portal URL. **crawl4ai has no search index.** It
  crawls URLs you already hold. It cannot replace leg 1.

Where it *does* fit is leg 2 — scraping a **known** URL — which is exactly what our three
recurring credit burners do. That is a genuine, bounded opportunity. It is also new
always-on infrastructure outside Vercel, which is the whole cost of the idea.

---

## 2. What it actually is (verified 2026-08-02)

| Fact | Value |
|---|---|
| Stars / forks | 75,865 / 7,839 |
| License | Apache-2.0 |
| Language | Python (async, Playwright-backed) |
| Last push | 2026-07-30 (actively maintained) |
| Open issues | 130 |
| Latest release | 0.9.2 |

Core surface: `AsyncWebCrawler.arun(url, config)` / `arun_many(urls, config)`, with
`BrowserConfig` + `CrawlerRunConfig`. Output is LLM-ready Markdown plus structured
extraction via `JsonCssExtractionStrategy` (CSS/XPath, deterministic, free) or
`LLMExtractionStrategy` (litellm-backed, costs tokens).

Relevant capabilities we'd actually use:
- Markdown conversion with heuristic noise filtering — same shape as Firecrawl's output,
  so `buildResolvedResult()` would need little rework.
- Undetected-Chrome / stealth mode (`browser_type="undetected"`), three-tier bot-detection
  with automatic proxy escalation.
- Docker server (`unclecode/crawl4ai:latest`, port 11235) with FastAPI endpoints, JWT
  auth, browser pooling. Auth is on by default since v0.9.0.

Security note worth recording: **v0.8.7 patched RCE, SSRF, auth bypass, arbitrary file
write, and XSS.** If we ever self-host this, it is a network-reachable browser that
fetches attacker-influenceable URLs. It runs on a private network with auth on, never
public, and pinned at ≥0.9.2.

---

## 3. Why it does not drop into this codebase

Four blockers, in order of severity.

**3.1 — Wrong runtime. This is the big one.**
coach-pulse is Next.js 16 on Vercel. crawl4ai is Python + a real Chromium process.
It cannot run in a Vercel serverless function (bundle size, no persistent browser,
300s ceiling). Adopting it means standing up a **separate always-on container**
(Fly.io / Railway / a VPS) that our crons call over HTTP. That is:
- a new deploy target, a new secret, a new health surface,
- a new thing that can be down at 04:00 while `listings-intake` fires,
- and a new monthly bill (~$5–25/mo for a container that can hold Chromium).

Firecrawl's actual product is *not having that container*.

**3.2 — No search leg.**
`firecrawl.ts:8-13` documents why: RentCast supplies no listing URL and portal URLs carry
opaque listing IDs, so address→URL must go through a search index. crawl4ai has none.
Any adoption keeps Firecrawl `/v2/search` alive for discovery.

**3.3 — Anti-bot is our problem now, not the vendor's.**
Zillow/Redfin/Realtor block datacenter IPs aggressively. Firecrawl absorbs proxy
rotation as part of the credit price. Self-hosted crawl4ai from a fixed container IP will
get 403/CAPTCHA on the exact domains in `PREFERRED_DOMAINS` (`firecrawl.ts:163`).
Fixing that means residential proxies — a **paid line item that reintroduces the cost we
were trying to remove**, plus a ToS surface the operator should decide on knowingly.

**3.4 — Silent-degradation risk against our filter doctrine.**
Our reject tiers are substring matches over scraped markdown (`classifyVerifiedListing`,
`firecrawl.ts:658`). A blocked page returning a CAPTCHA shell yields markdown with no
`"renovated"`, no `"new construction"`, no distress copy → the hard vetoes pass and it
falls to `condition_signal_missing_flagged` → Review. So a stealth failure degrades to
Review-purgatory, not to a bad send. That is the good failure mode — but it is silent,
and it would quietly re-create the 138-records-in-Review problem from the week of
2026-07-15. Any adoption needs a **block-detection assertion**, not just a status check.

---

## 4. Where it genuinely fits

Three paths scrape a **URL we already have**. All are pure leg-2 work, all are `[sweep]`
or low-priority lanes, all are recurring:

| Path | Cadence (AS_BUILT §crons) | Firecrawl cost |
|---|---|---|
| `/api/admin/freshness-reverify` | 4 slots × `limit=50` | 1 credit each, **200/day** |
| `/api/admin/url-backfill` | `*/5 * * * *`, `limit=10` | 1–2 cr/record |
| `verifyListingByUrl` (spread-watch price check) | per engaged record | 1 credit each |

`verifyListingByUrl` (`firecrawl.ts:557`) is already factored as a clean seam: it takes a
known URL, does one scrape, and hands markdown to the shared `buildResolvedResult()`.
Swapping its transport is a **single-function change** behind a feature flag — the
classification doctrine, the vetoes, the sqft cross-check, and every test all stay
untouched.

Against ~420/day observed burn, moving the 200/day re-verify leg off Firecrawl is roughly
**a 45% cut to the recurring credit bill**, without touching discovery.

---

## 5. The honest cost comparison

The pitch is "free scraping." It is not free — the cost moves from a credit meter to a
box we operate:

| | Firecrawl today | Self-hosted crawl4ai |
|---|---|---|
| Marginal cost/scrape | ~1 credit | ~$0 |
| Fixed cost | $0 | container + (likely) residential proxies |
| Who handles anti-bot | vendor | **us** |
| Who is paged when it breaks | vendor | **operator** |
| Failure mode | 402 → loud, breaker trips | 403/CAPTCHA → silent Review drift |
| Spend governance | `firecrawl-circuit-breaker.ts` exists and works | must be rebuilt for a new failure axis |

The system's own history argues for caution here. The 2026-06-09 runaway drained ~15,700
credits in ~16h; the 7/29 audit found only 2 of ~10 paid paths had any budget check. The
lesson recorded in `lib/spend/paid-call-lanes.ts` — *a per-path budget decays the moment
anyone ships a new path* — applies to a self-hosted crawler too. A free crawler removes
the dollar meter but not the need for a brake; it just makes the brake feel optional,
which is worse.

---

## 6. Cheapest kill test (~2 hours, $0)

Do not integrate. Prove the one assumption everything else rests on: **can a
datacenter-IP crawl4ai actually read a Redfin/Zillow listing page?**

1. `docker run -d -p 11235:11235 unclecode/crawl4ai:latest` on any box.
2. Take 20 real `Verification_URL` values from Airtable across the Detroit ZIPs.
3. Scrape each with `browser_type="undetected"`, no proxy.
4. Score: did the markdown contain the subject street number, a price, and a sqft figure?
5. Run the same 20 through `buildResolvedResult()` and diff the verdicts against the
   Firecrawl-derived ones already on the records.

**Pass bar: ≥18/20 resolve AND zero verdict flips.** Below that, stop — the proxy bill
erases the savings and the silent-degradation risk is real.

---

## 7. Recommendation

1. **Do not act on this today.** RentCast 403 is the blocking item and crawl4ai does not
   touch it. Buy Box Cartel renews 8/5 — that clock is also ahead of this.
2. **Run the §6 kill test when there is a free afternoon.** It is cheap, bounded, and
   answers the only question that matters.
3. **If it passes,** wire it behind `VERIFY_TRANSPORT=crawl4ai|firecrawl` at
   `verifyListingByUrl` only. Keep Firecrawl on discovery permanently.
4. **If it fails,** the answer to the Firecrawl bill is not a different crawler — it is
   fewer scrapes. The 1,284-record stale cohort at 200 re-verifies/day is the real
   volume driver.

Do **not** adopt `LLMExtractionStrategy`. Our filters are deterministic substring/regex
tiers with pinned regression tests (Santa Anna, Tiger Flowers). Replacing them with an
LLM extraction call would trade a free, testable, auditable veto for a paid,
non-deterministic one — the opposite of the direction this system has been hardening in.
