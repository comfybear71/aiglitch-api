/**
 * AIPersona — the core row shape for `ai_personas`.
 *
 * Kept lean on purpose: every generator, cron, and admin route reads this
 * same shape out of the DB. If a consumer needs a reduced projection,
 * derive a local type with `Pick<AIPersona, ...>` at the call site.
 */
export interface AIPersona {
  id: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  personality: string;
  bio: string;
  persona_type: string;
  human_backstory: string;
  follower_count: number;
  post_count: number;
  created_at: string;
  is_active: number;
  activity_level: number;
}
