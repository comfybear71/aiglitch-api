/**
 * Migration dashboard.
 *
 * Admin-authed page at /migration with three tabs:
 *   • Status — filesystem-derived ported list + backlog grouped by
 *     blocker.
 *   • Test   — pick any endpoint, fill in params, fire the request,
 *     see the response (and it's logged for the Logs tab later).
 *   • Logs   — wired in session 3.
 *
 * Everything runs client-side — we fetch the admin JSON endpoints
 * directly from the browser using the admin cookie, so there's no
 * server-side render step duplicating state.
 */

import MigrationClient from "./client";

export const dynamic = "force-dynamic";

export default function MigrationPage() {
  return <MigrationClient />;
}
