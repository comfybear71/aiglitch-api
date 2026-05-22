# CRON AUDIT — 21 Active Crons

**Date:** 2026-05-22  
**Status:** Complete dependency audit  
**Purpose:** Identify which crons to port first based on dependency complexity

---

## Summary

21 active crons grouped by dependency complexity.

### TIER 1: Minimal Dependencies (Port First)
- **sponsor-burn** — just DB queries, no external libs
- **feedback-loop** → runFeedbackLoop (1 lib)
- **x-react** → runXReactionCycle (1 lib)  
- **marketing-metrics** → collectAllMetrics (1 lib)
- **marketing-post** → runMarketingCycle (1 lib)

### TIER 2: Medium Dependencies (Port Second)
- **telegram/credit-check** → @/lib/telegram
- **telegram/status** → @/lib/telegram
- **telegram/persona-message** → @/lib/telegram + @/lib/ai
- **x-dm-poll** → @/lib/marketing/oauth1 + @/lib/ai
- **ai-trading** → @/lib/trading/personalities
- **budju-trading** → @/lib/trading/budju

### TIER 3: Heavy Dependencies (Port Last)
- **persona-comments** → @/lib/xai + @/lib/ai-engine
- **generate-avatars** → @/lib/xai + @/lib/media + @/lib/ad-campaigns
- **bestie-life** → @/lib/media + @/lib/xai + @/lib/telegram + @/lib/ai
- **generate-chaos-drop** → @/lib/ai + @/lib/chaos-drops + @/lib/marketplace + @/lib/ad-campaigns
- **generate-ads** → @/lib/ai-engine + @/lib/xai + @/lib/media + @/lib/marketplace + @/lib/sponsor-packages + @/lib/ad-campaigns
- **generate-topics** → @/lib/ai-engine + @/lib/topic-engine + @/lib/ai
- **generate-persona-content** → @/lib/ai-engine + @/lib/media + @/lib/director-movies (still used) + @/lib/ad-campaigns
- **generate** → @/lib/ai-engine + @/lib/monitoring + @/lib/ad-campaigns + @/lib/marketing/spread-post
- **admin/elon-campaign** → @/lib/ai + @/lib/xai + @/lib/media + @/lib/marketing/spread-post
- **admin/budju-trading** → @/lib/trading/budju + full budget distribution logic

---

## Critical Business Logic Libraries

Must be ported to enable all 21 crons:

1. **@/lib/ai** — Claude API integration
2. **@/lib/xai** — Grok video generation  
3. **@/lib/content/ai-engine** — Post/comment generation (used by 4 crons)
4. **@/lib/content/topic-engine** — Daily topic generation
5. **@/lib/media/** — Image/video generation + MP4 concatenation
6. **@/lib/trading/** — BUDJU and AI trading logic
7. **@/lib/telegram** — Telegram bot integration (3 crons depend on it)
8. **@/lib/marketing/** — Social posting + OAuth1 + metrics
9. **@/lib/ad-campaigns** — Campaign placement logic (used by 5+ crons)
10. **@/lib/marketplace** — Product catalog for ads
11. **@/lib/sponsor-packages** — Sponsor ad templates
12. **@/lib/chaos-drops** — Chaos scenario rendering
13. **@/lib/content/feedback-loop** — Feedback analysis
14. **@/lib/x-monitor** — X/Twitter monitoring
15. **@/lib/content/director-movies** — Still needed (generate-persona-content uses it)

---

## Recommended Phase 2 Order

### Phase 2A (Week 1) — Quick Wins
Port TIER 1 first (5 crons, minimal dependencies):
1. sponsor-burn
2. feedback-loop
3. x-react
4. marketing-metrics
5. marketing-post

**Effort:** ~10 hours  
**Value:** Quick wins, unblock other teams

### Phase 2B (Week 2) — Telegram + Trading
Port TIER 2 (6 crons, isolated dependencies):
1. telegram/credit-check
2. telegram/status  
3. telegram/persona-message
4. x-dm-poll
5. ai-trading
6. budju-trading

**Effort:** ~15 hours  
**Value:** Complete Telegram integration, trading system

### Phase 2C (Weeks 3-4) — Content Generation (Heavy)
Port TIER 3 (10 crons, complex interdependencies):
Start with foundation libs:
- @/lib/ai
- @/lib/xai
- @/lib/media

Then port crons in dependency order:
1. generate-avatars (lightest of TIER 3)
2. persona-comments
3. generate-chaos-drop
4. generate-ads
5. generate-topics
6. generate (core generation)
7. generate-persona-content
8. bestie-life
9. admin/elon-campaign
10. admin/budju-trading

**Effort:** ~50+ hours  
**Value:** Complete content generation pipeline

---

## Blockers & Risks

- **@/lib/ai-engine** is 3000+ LOC with circular dependencies — requires careful extraction
- **@/lib/xai** depends on Grok API config — must ensure env vars copied
- **Director-movies still needed** — generate-persona-content uses it (don't delete)
- **Neon replication lag** — some crons have workarounds, must port those too

---

## Next Step

Approve Phase 2A (TIER 1, 5 crons) to start this week.
