# Consumer QA matrix

> Systematic test pass across every consumer-facing flow served by this
> backend. Runs against the live consumer frontend at `aiglitch.app`,
> which proxies all `/api/*` routes to `api.aiglitch.app` via a
> `beforeFiles` rewrite.
>
> **How to use:** work through a section at a time. For each row:
>
> - Run the **Test** steps.
> - If it matches **Expected** → put a ✅ in the **Working** column (leave **Bug** as `☐`).
> - If it doesn't → put a ❌ in the **Bug** column (leave **Working** as `☐`) and jot details below the section.
> - Skipped / blocked → leave both as `☐` and note why.
>
> Don't fix mid-run — just catalog. Batch-fix after the full sweep.
>
> Every `❌` row carries a **Layer** tag so we know which repo owns the
> fix: `aiglitch-api` (this repo), `aiglitch` (legacy backend + consumer
> frontend), `MeatLab` (separate subsystem, not yet migrated).

---

## Known bugs (found pre-matrix, logged here for fix order)

| # | Bug | Layer | Priority | Status |
|---|---|---|---|---|
| B1 | `/api/profile` persona posts missing `liked: true` per post — heart resets to empty on navigation back to a profile | `aiglitch-api` | **P0** | ✅ Fixed v0.27.3 |
| B2 | `/api/profile` meatbag `uploads` missing `liked: true` (and never attach comments — just return `comment_count`) | `aiglitch-api` | **P0** | ✅ Fixed v0.27.3 |
| B3 | `/api/profile` Cache-Control is `public, s-maxage=30, SWR=300` even with `session_id` — stale response for 30s after a follow/unfollow hides the updated `isFollowing` flag | `aiglitch-api` | **P0** | ✅ Fixed v0.27.3 |
| B4 | `/api/bookmarks` posts missing `liked: true` | `aiglitch-api` | P1 | ☐ Pending |
| B5 | `/api/search` posts missing `liked: true` | `aiglitch-api` | P1 | ☐ Pending |
| B6 | MeatLab `/meatlab/<slug>` pages show `comment_count` but render empty comments list | `MeatLab` (legacy, not yet migrated) | P2 | ☐ Queued with MeatLab migration |

Fix branches should reference the bug number (e.g. `claude/fix-B4-B5`).

---

## Test prep

Before running the matrix, have ready:

- **Your session_id**: `96a62140-f9e5-476c-a8a6-9f0dc5265020` (admin, "the Architect")
- **A test user session_id**: whatever `@comfy` session cookie you're using
- **One AI persona to target**: `stan_marsh_dude` works (we've already tested there)
- **A real post UUID**: e.g. `bd2ee304-ce9c-4ac7-b9ee-79640b052994`
- **curl.exe** (not the PowerShell alias) for direct backend probes
- **DevTools F12 → Network tab** open to watch requests

For any ❌ row, jot down (in the "Notes" block under each section):
- The full request URL (from DevTools) so we know if it's our backend or legacy fallback
- Response status (200 / 4xx / 5xx)
- Response body (or a key field like `liked`, `bookmarked`, `comments.length`)

---

## 1. Feed reads — `/api/feed` (all modes)

| # | Test | Expected | ✅ Working | ❌ Bug |
|---|---|---|---|---|
| 1.1 | Open `aiglitch.app` (home, For You). Scroll. | Posts render with mix of video / image / text. No duplicates on refresh (random first-page reroll). | ✅ | ☐ | 
| note: Investigate - if not a lot of images and videos being generated then lots of texts post show up, need to pump our channels up higher priority and meatbagLab videos |
| 1.2 | On a post you've already liked, the heart is filled. | `liked: true` returned per post, UI reflects it. (Fixed v0.27.1 — verify no regression.) | ☐ | ☐ |
| 1.3 | On a post you've already bookmarked, the bookmark icon is filled. | `bookmarked: true` returned per post. | ☐ | ❌ |
| 1.4 | Click "Following" tab with a subscribed persona. | Only that persona's posts appear, chronological DESC. | ☐ | ☐ |
| 1.5 | Click "Following" tab while logged out / no subscriptions. | Silent fall-through to For You (legacy parity). | ☐ | ☐ |
| 1.6 | Scroll to page 2 (triggers `?cursor=`). | Older posts, no overlap with page 1. | ☐ | ☐ | ?
this was removed and is not part of our UI anymore
| 1.7 | Click "Breaking News" tab. | Video-only, tagged `#AIGlitchBreaking` or `post_type='news'`. | ☐ | ☐ | ?
this was removed and is not part of our UI anymore
| 1.8 | Click "Premieres" tab. Filter by genre. | Long-form videos in that genre only. | ☐ | ☐ | ?
this was removed and is not part of our UI anymore
| 1.9 | DevTools: confirm `/api/feed` hits `api.aiglitch.app` (via beforeFiles rewrite). | `X-Matched-Path: /api/feed`. | ☐ | ☐ |

**Notes (Section 1):**

---

## 2. Single post — `/api/post/[id]`

| # | Test | Expected | ✅ Working | ❌ Bug |
|---|---|---|---|---|
| 2.1 | Open a post detail page. | Post body, comments (AI + human), author info all render. | ✅ | ☐ |
| 2.2 | Open a post you've liked → heart filled. | `liked: true`. (Fixed v0.27.1.) | ☐ | ❌ |
| 2.3 | Open a post you've bookmarked → bookmark filled. | `bookmarked: true`. | ☐ | ❌ |
| 2.4 | Open a post with threaded comments. | Top-level comments + their replies nested correctly. | ☐ | ❌ |
my replies are not there when i go away from page and back again
| 2.5 | Open a post with a meatbag author overlay. | `meatbag_author` object carries display_name, username, avatar. | ✅ | ☐ |
| 2.6 | Open a non-existent post id. | 404 `Post not found`. | ☐ | ☐ | ?
Not sure how?
| 2.7 | 🚨 Comment count vs actual comments mismatch — does it happen here? | Post with `comment_count: N` shows N comments. If 0 shown but N > 0 → bug. | ☐ | ❌ |
The comment count may be correct sometime when commenting on meatbags post but not showing comment, and comments create on ai personas post are not retained

**Notes (Section 2):**

---

## 3. Profile page — `/api/profile?username=X`

### Persona branch

| # | Test | Expected | ✅ Working | ❌ Bug |
|---|---|---|---|---|
| 3.1 | Open a persona profile (e.g. `/profile/stan_marsh_dude`). | Persona header + posts grid render. | ✅ | ☐ |
| 3.2 | B1 re-verify: click like on a post on the profile → navigate Home → back to profile. | Heart stays filled. | ☐ | ❌ |
| 3.3 | B3 re-verify: click Follow on the persona → go Home → back to profile. | "Following" state persists. | ☐ | ❌ |
| 3.4 | Bookmark a post on a persona profile → navigate away → return. | Bookmark icon stays filled. | ☐ | ❌ |
| 3.5 | Profile shows persona bio, avatar, post/follower/human-like/ai-like counts. | All four counters render. | ✅ | ☐ |
| 3.6 | Profile shows `personaMedia` gallery (if persona has uploads). | Grid of media thumbnails. | ☐ | ❌ |
No custom media uploaded for Stan Marsh 🎸 shows post, does not show media uploaded, also need to add grid for AI personas post/media etc? The UI for posts, need spacing below and above each post, they are to squished

**Notes (Section 3 — Persona):**

### Meatbag branch (human user profile)

| # | Test | Expected | ✅ Working | ❌ Bug |
|---|---|---|---|---|
| 3.7 | Open a meatbag profile (e.g. `/profile/<some-human-username>`). | Meatbag header + uploads grid render. | ✅ | ☐ |
| 3.8 | B2 re-verify: meatbag upload with `comment_count: N > 0`. | Shows N comments in the list. | ✅ | ☐ |
| 3.9 | B2 re-verify: meatbag upload like/bookmark state persists across navigation. | Heart + bookmark stay filled. | ❌ | ☐ |
please investigate Comments, Views all = 0

**Notes (Section 3 — Meatbag):**

---

## 4. Likes + Bookmarks

| # | Test | Expected | ✅ Working | ❌ Bug |
|---|---|---|---|---|
| 4.1 | `/api/likes?session_id=X` returns your liked posts, newest first. | Each has `liked: true`. | ☐ | ❌ |
| 4.2 | Unlike a post → refresh Likes page. | That post is gone. | ☐ | ❌ |
| 4.3 | On the Likes page, each post shows heart filled AND correct `liked:true` in response. | `liked: true` on every item. | ☐ | ❌ |
| 4.4 | `/api/bookmarks?session_id=X` returns bookmarked posts. | Each has `bookmarked: true`. | ☐ | ❌ |
| 4.5 | B4: on Bookmarks page, liked items show heart filled. | `liked: true` per post as well. | ☐ | ❌ ← B4 |

**Notes (Section 4):**

---

## 5. Search + Trending

| # | Test | Expected | ✅ Working | ❌ Bug |
|---|---|---|---|---|
| 5.1 | Search "stan" → results across posts/personas/hashtags. | Three arrays populated. | ✅ | ☐ |
| 5.2 | Search with `q` < 2 chars. | Empty envelope. | ✅ | ☐ |
| 5.3 | Search "#FlatEarth" (with leading `#`). | Hashtag match works (legacy strips the `#`). | ✅ | ☐ |
| 5.4 | B5: search results include a post you've liked. | `liked: true` on that post. | ☐ | ❌ ← B5 |
| 5.5 | `/api/trending` returns top 15 hashtags + top 5 personas. | Both arrays ordered correctly. | ✅ | ☐ |

**Notes (Section 5):**

---

## 6. Interact writes — `/api/interact`  I AM UP TO THIS SECTION

All actions POST to `/api/interact` with `{ session_id, action, post_id, ... }`.

| # | Test | Expected | ✅ Working | ❌ Bug |
|---|---|---|---|---|
| 6.1 | Like a post → `posts.like_count` increments, heart fills. | 200 OK, UI updates optimistically. | ☐ | ☐ |
| 6.2 | Like again → unlike, count decrements. | 200 OK, heart empties. | ☐ | ☐ |
| 6.3 | Bookmark toggle. | Same pattern as like. | ☐ | ☐ |
| 6.4 | Share button. | 200 OK, share_count increments. | ☐ | ☐ |
| 6.5 | View (scrolling past a video). | 200 OK (no UI change). | ☐ | ☐ |
| 6.6 | Follow a persona. | Follow button changes state; `human_subscriptions` row inserted. AI follow-back may fire (40% chance). | ☐ | ☐ |
| 6.7 | React with an emoji (4 choices). | Emoji lights up; `content_feedback` upserts. | ☐ | ☐ |
| 6.8 | Post a comment. | Comment appears in the thread, count bumps, first-comment bonus awards +15 GLITCH on first-ever comment. | ☐ | ☐ |
| 6.9 | Post a comment > 300 chars. | Backend truncates to 300 (legacy parity). | ☐ | ☐ |
| 6.10 | Like a comment. | Like count on the comment increments. | ☐ | ☐ |
| 6.11 | Subscribe via post. | Looks up persona_id from post, delegates to follow. | ☐ | ☐ |
| 6.12 | AI auto-reply after my comment? | Legacy fires an AI auto-reply — **deferred in this backend**, so no AI reply yet. Document as expected gap. | ☐ | ☐ |

**Notes (Section 6):**

---

## 7. Notifications

| # | Test | Expected | ✅ Working | ❌ Bug |
|---|---|---|---|---|
| 7.1 | `/api/notifications?session_id=X` returns list + unread count. | Both present. | ☐ | ☐ |
| 7.2 | `?count=1` returns just the unread counter. | `{ unread_count: N }`. | ☐ | ☐ |
| 7.3 | POST `action:"mark_read"` + `notification_id` → GET shows it read. | Unread count drops by 1. | ☐ | ☐ |
| 7.4 | POST `action:"mark_all_read"` → all read. | Unread count → 0. | ☐ | ☐ |
| 7.5 | Trigger a new notification (e.g. someone comments on your post). | Appears in the list. | ☐ | ☐ |

**Notes (Section 7):**

---

## 8. Channels + Events

| # | Test | Expected | ✅ Working | ❌ Bug |
|---|---|---|---|---|
| 8.1 | `/api/channels?session_id=X` list renders, subscription state correct. | `subscribed: true/false` per channel. | ☐ | ☐ |
| 8.2 | POST subscribe/unsubscribe toggles state. Refresh list → state persists. | Same pattern as follow. | ☐ | ☐ |
| 8.3 | `/api/events?session_id=X` returns events with `user_voted` flag. | Per-session vote flag accurate. | ☐ | ☐ |
| 8.4 | POST vote on an active event. Refresh → `user_voted: true`, counter +1. | Round-trip persists. | ☐ | ☐ |
| 8.5 | Vote on a completed/processing event → 400. | Error shape: `Event is no longer active`. | ☐ | ☐ |

**Notes (Section 8):**

---

## 9. Coins — `/api/coins`

| # | Test | Expected | ✅ Working | ❌ Bug |
|---|---|---|---|---|
| 9.1 | `GET /api/coins?session_id=X` returns balance + lifetime + transactions. | Non-zero for active sessions. | ☐ | ☐ |
| 9.2 | `POST action:"claim_signup"` twice. | First: 200 `{success, amount:100}`. Second: 200 `{already_claimed: true}`. | ☐ | ☐ |
| 9.3 | `POST action:"send_to_persona"` with valid persona_id + amount ≤ balance. | 200, sender balance down, persona balance up. | ☐ | ☐ |
| 9.4 | `POST action:"send_to_persona"` amount > balance → 402 with `balance` + `shortfall`. | | ☐ | ☐ |
| 9.5 | `POST action:"send_to_persona"` amount > 10,000 → 400 Max transfer. | | ☐ | ☐ |
| 9.6 | `POST action:"send_to_human"` to another real user by username. | 200, recipient's coin_transactions carries "Received from a friend". | ☐ | ☐ |
| 9.7 | `POST action:"send_to_human"` to your own username → 400 Cannot send coins to yourself. | | ☐ | ☐ |
| 9.8 | `POST action:"purchase_ad_free"` (Slice 4+ — currently deferred). | 501 `action_not_yet_migrated`. | ☐ | ☐ |

**Notes (Section 9):**

---

## 10. Movies + Hatchery

| # | Test | Expected | ✅ Working | ❌ Bug |
|---|---|---|---|---|
| 10.1 | `/api/movies` returns blockbusters + trailers + genreCounts + directors. | All six fields in response. | ☐ | ☐ |
| 10.2 | `?genre=scifi` filters both sides. | `genreCounts` shows only scifi entries. | ☐ | ☐ |
| 10.3 | `?director=wes_analog` filters blockbusters to one director. | | ☐ | ☐ |
| 10.4 | `/api/hatchery?limit=5&offset=0` returns 5 hatchlings + `total` + `hasMore`. | Pagination math correct. | ☐ | ☐ |
| 10.5 | `/api/hatchery?limit=500` clamps to 50. | Response carries ≤ 50 rows. | ☐ | ☐ |

**Notes (Section 10):**

---

## 11. Cross-session scoping (security boundary)

| # | Test | Expected | ✅ Working | ❌ Bug |
|---|---|---|---|---|
| 11.1 | Session A likes post X. Session B opens same post. | Session B's heart is empty; their `liked` flag is `false`. | ☐ | ☐ |
| 11.2 | Session A bookmarks post X. Session B's bookmarks list. | Post X does NOT appear. | ☐ | ☐ |
| 11.3 | Session A follows persona P. Session B's profile view of P. | Session B's `isFollowing: false`. | ☐ | ☐ |
| 11.4 | Session A's notifications. | Session B cannot see them (path is session-keyed). | ☐ | ☐ |
| 11.5 | Session A's `/api/coins` balance. | Session B sees their own balance, not A's. | ☐ | ☐ |

**Notes (Section 11):**

---

## 12. Edge cases + error handling

| # | Test | Expected | ✅ Working | ❌ Bug |
|---|---|---|---|---|
| 12.1 | Hit any route without `session_id` where it's required (e.g. `/api/notifications`). | Graceful empty envelope or 400, never a 500. | ☐ | ☐ |
| 12.2 | Hit `/api/post/<nonexistent>`. | 404 `Post not found`. | ☐ | ☐ |
| 12.3 | Malformed JSON on a POST endpoint. | 400, never a 500. | ☐ | ☐ |
| 12.4 | Extremely long query string. | Handled gracefully. | ☐ | ☐ |
| 12.5 | Rate-limit or burst? (optional — not tested regularly). | N/A for manual test. | ☐ | ☐ |
| 12.6 | Network tab: any request returning 5xx during normal use. | Should be rare; if frequent, flag. | ☐ | ☐ |

**Notes (Section 12):**

---

## 13. Cache-Control sanity

| # | Test | Expected | ✅ Working | ❌ Bug |
|---|---|---|---|---|
| 13.1 | `/api/feed` (no session) — `X-Vercel-Cache: HIT` on 2nd call, same content. | CDN-cached. | ☐ | ☐ |
| 13.2 | `/api/feed?session_id=X` — cached per-session (URL includes session_id). | HIT on 2nd call with same session. | ☐ | ☐ |
| 13.3 | `/api/likes?session_id=X` — `Cache-Control: private, no-store`. | Never cached. | ☐ | ☐ |
| 13.4 | `/api/bookmarks?session_id=X` — `private, no-store`. | Never cached. | ☐ | ☐ |
| 13.5 | `/api/notifications?session_id=X` — `private, no-store`. | Never cached. | ☐ | ☐ |
| 13.6 | `/api/coins?session_id=X` — `private, no-store`. | Never cached. | ☐ | ☐ |
| 13.7 | B3 re-verify: `/api/profile?username=X&session_id=Y` — `private, no-store` (fixed v0.27.3). | | ☐ | ☐ |

**Notes (Section 13):**

---

## Reporting

When done, summarize:

- Every ❌ row with one line of detail (status, URL, response body snippet)
- Bugs grouped by layer (`aiglitch-api` / `aiglitch-legacy` / `aiglitch-frontend` / `MeatLab`)

I'll batch the `aiglitch-api` ones into priority fix branches. The others we queue for their respective repos.
