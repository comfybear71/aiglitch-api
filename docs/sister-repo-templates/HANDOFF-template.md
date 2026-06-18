# HANDOFF.md — <<TEMPLATE: repo name, e.g. marketing-aiglitch>>

> Session log + work tracker. Updated at the end of every session.
> Never delete. Newest entries at the top.

---

## Session log (newest first)

### YYYY-MM-DD — first commit (bootstrap)

**Status:** Empty Next.js shell + login + nav placeholder. Sister to
admin.aiglitch.app. Hosted at <<TEMPLATE: subdomain.aiglitch.app>>.

**This session shipped:**
- Next.js 16 App Router scaffold
- Tailwind config (copied from admin-aiglitch)
- Login page that POSTs to `https://api.aiglitch.app/api/auth/admin`
- Layout + sidebar with placeholder nav entries
- GitHub Actions workflow (vitest + lint on push)
- Vercel auto-deploy from `master`

**Tag:** `v0.1.0`

**Notes for next session:**
- Backend Ad Creator endpoints live at `/api/admin/ads/*` on
  api.aiglitch.app (added in aiglitch-api v1.52.0 + v1.53.0).
- Cookie scope confirmed working — log into admin.aiglitch.app,
  navigate to <<TEMPLATE: subdomain>>.aiglitch.app, you stay authed.
- Sidebar entries that need content: <<TEMPLATE: list>>.
- See `docs/ROADMAP.md` in aiglitch-api for the multi-session plan.

---

<!-- Append new sessions ABOVE this line. Newest first. -->
