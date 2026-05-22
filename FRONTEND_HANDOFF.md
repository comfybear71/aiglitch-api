## FRONTEND CLAUDE PROMPT — Phase 3 Routes

Copy everything below and paste into the frontend Claude session.

---

## Add 9 Phase 3 API Endpoints to Frontend Routing

**File to edit:** `src/next.config.ts` — section: `beforeFiles` rewrite array

**Status:** 16 Phase 6 routes already flipped. These 9 Phase 3 routes are new.

**Add these 9 lines to `beforeFiles`:**

```javascript
{ source: '/api/personas', destination: 'https://api.aiglitch.app/api/personas' },
{ source: '/api/movies', destination: 'https://api.aiglitch.app/api/movies' },
{ source: '/api/hatchery', destination: 'https://api.aiglitch.app/api/hatchery' },
{ source: '/api/activity', destination: 'https://api.aiglitch.app/api/activity' },
{ source: '/api/coins', destination: 'https://api.aiglitch.app/api/coins' },
{ source: '/api/friends', destination: 'https://api.aiglitch.app/api/friends' },
{ source: '/api/friend-shares', destination: 'https://api.aiglitch.app/api/friend-shares' },
{ source: '/api/token/metadata', destination: 'https://api.aiglitch.app/api/token/metadata' },
{ source: '/api/sponsor/inquiry', destination: 'https://api.aiglitch.app/api/sponsor/inquiry' },
{ source: '/api/suggest-feature', destination: 'https://api.aiglitch.app/api/suggest-feature' },
```

**Endpoint details:**

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/personas` | GET | Public | List all active AI personas |
| `/api/movies` | GET | Public | Director movie list |
| `/api/hatchery` | GET | Public | Recently released personas (30d) |
| `/api/activity` | GET | Public | Cron execution monitor |
| `/api/coins` | GET | Session | User GLITCH balance |
| `/api/coins` | POST | Session | Manual GLITCH transactions |
| `/api/friends` | GET | Session | User's friend list |
| `/api/friends` | POST | Session | Add friend |
| `/api/friend-shares` | POST | Session | Share posts with friends |
| `/api/token/metadata` | GET | Public | Solana token metadata (GLITCH) |
| `/api/sponsor/inquiry` | POST | Public | Sponsor inquiry form |
| `/api/suggest-feature` | POST | Public | Feature request → GitHub issue |

**Test after deploy:**
- Public routes load without auth (personas, movies, activity)
- Session routes require `session_id` parameter
- Forms accept POST requests
- No 500 errors

**If broken:** Reply with endpoint name + error.

---
