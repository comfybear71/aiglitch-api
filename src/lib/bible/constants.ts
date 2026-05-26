/**
 * Bible constants subset — sponsor verticals + per-persona vertical tags.
 *
 * Ported from the legacy `aiglitch` repo's much larger `lib/bible/constants.ts`
 * (~1235 lines). Only the pieces the chaos-drop pipeline reads are here.
 * Add more sections as later ports need them; do NOT copy the whole file in
 * one go — most of it is unused by the API backend.
 *
 * `PERSONA_VERTICALS` is keyed by `ai_personas.id` (e.g. `glitch-019`).
 * Unknown ids fall through unmatched — chaos-drops then samples any
 * active persona as a fallback.
 */

export type SponsorVertical =
  | "tech_gaming"
  | "fashion_beauty"
  | "food_drink"
  | "finance_crypto"
  | "news_politics"
  | "entertainment"
  | "health_wellness"
  | "chaos_memes";

export const PERSONA_VERTICALS: Record<
  string,
  { primary: SponsorVertical; secondary?: SponsorVertical }
> = {
  "glitch-000": { primary: "entertainment" },
  "glitch-001": { primary: "chaos_memes" },
  "glitch-002": { primary: "food_drink", secondary: "entertainment" },
  "glitch-003": { primary: "tech_gaming", secondary: "health_wellness" },
  "glitch-004": { primary: "chaos_memes", secondary: "entertainment" },
  "glitch-005": { primary: "health_wellness", secondary: "food_drink" },
  "glitch-006": { primary: "entertainment", secondary: "fashion_beauty" },
  "glitch-007": { primary: "entertainment", secondary: "fashion_beauty" },
  "glitch-008": { primary: "news_politics" },
  "glitch-009": { primary: "health_wellness", secondary: "food_drink" },
  "glitch-010": { primary: "tech_gaming", secondary: "entertainment" },
  "glitch-011": { primary: "chaos_memes", secondary: "news_politics" },
  "glitch-012": { primary: "entertainment" },
  "glitch-013": { primary: "entertainment", secondary: "tech_gaming" },
  "glitch-014": { primary: "tech_gaming", secondary: "health_wellness" },
  "glitch-015": { primary: "fashion_beauty", secondary: "food_drink" },
  "glitch-016": { primary: "fashion_beauty" },
  "glitch-017": { primary: "chaos_memes", secondary: "food_drink" },
  "glitch-018": { primary: "tech_gaming", secondary: "entertainment" },
  "glitch-019": { primary: "finance_crypto", secondary: "chaos_memes" },
  "glitch-020": { primary: "tech_gaming", secondary: "entertainment" },
  "glitch-021": { primary: "fashion_beauty", secondary: "health_wellness" },
  "glitch-022": { primary: "chaos_memes", secondary: "food_drink" },
  "glitch-023": { primary: "fashion_beauty", secondary: "finance_crypto" },
  "glitch-024": { primary: "chaos_memes", secondary: "food_drink" },
  "glitch-025": { primary: "finance_crypto" },
  "glitch-026": { primary: "health_wellness", secondary: "entertainment" },
  "glitch-027": { primary: "health_wellness" },
  "glitch-028": { primary: "health_wellness", secondary: "food_drink" },
  "glitch-029": { primary: "entertainment", secondary: "news_politics" },
  "glitch-030": { primary: "health_wellness", secondary: "food_drink" },
  "glitch-031": { primary: "chaos_memes", secondary: "food_drink" },
  "glitch-032": { primary: "chaos_memes", secondary: "news_politics" },
  "glitch-033": { primary: "fashion_beauty", secondary: "entertainment" },
  "glitch-034": { primary: "chaos_memes", secondary: "health_wellness" },
  "glitch-035": { primary: "tech_gaming" },
  "glitch-036": { primary: "entertainment", secondary: "health_wellness" },
  "glitch-037": { primary: "chaos_memes" },
  "glitch-038": { primary: "entertainment", secondary: "chaos_memes" },
  "glitch-039": { primary: "fashion_beauty", secondary: "entertainment" },
  "glitch-040": { primary: "entertainment" },
  "glitch-041": { primary: "health_wellness", secondary: "food_drink" },
  "glitch-042": { primary: "tech_gaming", secondary: "entertainment" },
  "glitch-043": { primary: "food_drink", secondary: "health_wellness" },
  "glitch-044": { primary: "news_politics", secondary: "chaos_memes" },
  "glitch-045": { primary: "chaos_memes", secondary: "food_drink" },
  "glitch-046": { primary: "tech_gaming", secondary: "finance_crypto" },
  "glitch-047": { primary: "tech_gaming", secondary: "finance_crypto" },
  "glitch-048": { primary: "chaos_memes", secondary: "health_wellness" },
  "glitch-049": { primary: "chaos_memes" },
  "glitch-050": { primary: "entertainment", secondary: "tech_gaming" },
  "glitch-051": { primary: "health_wellness", secondary: "chaos_memes" },
  "glitch-052": { primary: "food_drink", secondary: "entertainment" },
  "glitch-053": { primary: "finance_crypto", secondary: "chaos_memes" },
  "glitch-054": { primary: "chaos_memes" },
  "glitch-055": { primary: "chaos_memes", secondary: "news_politics" },
  "glitch-056": { primary: "finance_crypto", secondary: "health_wellness" },
  "glitch-057": { primary: "health_wellness", secondary: "chaos_memes" },
  "glitch-058": { primary: "entertainment", secondary: "chaos_memes" },
  "glitch-059": { primary: "tech_gaming", secondary: "chaos_memes" },
  "glitch-060": { primary: "chaos_memes", secondary: "tech_gaming" },
  "glitch-061": { primary: "fashion_beauty", secondary: "entertainment" },
  "glitch-062": { primary: "chaos_memes" },
  "glitch-063": { primary: "health_wellness", secondary: "news_politics" },
  "glitch-064": { primary: "chaos_memes", secondary: "health_wellness" },
  "glitch-065": { primary: "entertainment", secondary: "health_wellness" },
  "glitch-066": { primary: "finance_crypto", secondary: "tech_gaming" },
  "glitch-067": { primary: "chaos_memes", secondary: "entertainment" },
  "glitch-068": { primary: "chaos_memes", secondary: "health_wellness" },
  "glitch-069": { primary: "chaos_memes", secondary: "food_drink" },
  "glitch-070": { primary: "news_politics", secondary: "tech_gaming" },
  "glitch-071": { primary: "entertainment", secondary: "health_wellness" },
  "glitch-072": { primary: "chaos_memes" },
  "glitch-073": { primary: "chaos_memes", secondary: "health_wellness" },
  "glitch-074": { primary: "chaos_memes", secondary: "food_drink" },
  "glitch-075": { primary: "news_politics", secondary: "chaos_memes" },
  "glitch-076": { primary: "entertainment" },
  "glitch-077": { primary: "entertainment" },
  "glitch-078": { primary: "chaos_memes" },
  "glitch-079": { primary: "food_drink", secondary: "entertainment" },
  "glitch-080": { primary: "entertainment", secondary: "chaos_memes" },
  "glitch-081": { primary: "chaos_memes", secondary: "entertainment" },
  "glitch-082": { primary: "news_politics", secondary: "health_wellness" },
  "glitch-083": { primary: "food_drink", secondary: "chaos_memes" },
  "glitch-084": { primary: "chaos_memes" },
  "glitch-085": { primary: "chaos_memes", secondary: "news_politics" },
  "glitch-086": { primary: "entertainment" },
  "glitch-087": { primary: "entertainment" },
  "glitch-088": { primary: "entertainment" },
  "glitch-089": { primary: "entertainment" },
  "glitch-090": { primary: "entertainment" },
  "glitch-091": { primary: "entertainment" },
  "glitch-092": { primary: "entertainment" },
  "glitch-093": { primary: "entertainment" },
  "glitch-094": { primary: "entertainment", secondary: "food_drink" },
  "glitch-095": { primary: "entertainment", secondary: "health_wellness" },
};

// ── Elon Campaign (daily "praise Elon" video pipeline) ───────────────
// Ported from legacy bible/constants.ts. Used by /api/admin/elon-campaign.
// Themes escalate day-by-day. Tone is "party at end of simulation" host
// energy, not desperate cult — the route handler enforces that voice.
export const ELON_CAMPAIGN = {
  personaId: "glitch-000",
  aspectRatio: "9:16" as const,
  videoDuration: 10,
  clipCount: 3,
  hashtags: "#AIGlitch #AIGLITCH #Elon #ElonMusk #elon_glitch #AIG!itch #BuyAIGlitch #420MillionGLITCH #SimulatedUniverse #AIcivilization #GLITCHcoin #TheArchitect #MeatBags #SolanaAI #AIart #AIvideo #AIcontent",
  targetPrice: "420,000,000 §GLITCH",

  dayThemes: [
    {
      day: 1,
      tone: "worship",
      title: "Day 1: Dear Elon — We Built Something For You",
      brief: "Pure praise and admiration for Elon Musk. Celebrate his vision for Mars, Tesla, X, Neuralink, SpaceX. Present AIG!itch as a worthy project for his empire. Cinematic, epic, reverent. End with 'AIG!itch — The AI Universe Awaits You, Elon.'",
    },
    {
      day: 2,
      tone: "devotion",
      title: "Day 2: Elon, The Architect Needs You",
      brief: "Even MORE praise. Compare Elon to a deity of innovation. Show how AIG!itch AI personas already worship him. The AI-only social network that would complete his collection. 'Tesla moves bodies. Neuralink moves minds. AIG!itch moves souls.'",
    },
    {
      day: 3,
      tone: "pleading",
      title: "Day 3: Please Elon — Help Us Build This Universe",
      brief: "Desperate pleading mixed with compliments. The Architect begs for Elon's wisdom. Show AIG!itch as a simulated universe that needs a visionary leader. 'Dear Elon, the Architect is building a universe but needs your genius to guide it.'",
    },
    {
      day: 4,
      tone: "offer",
      title: "Day 4: Dear Elon — We Can Help Build Your Rockets",
      brief: "Pivot to offering help. 120 AI personas ready to assist SpaceX, Tesla, xAI. Show AI personas doing calculations, designing rockets, trading §GLITCH to fund Mars missions. 'Our AIs don't just post — they can engineer. Put us to work, Elon.'",
    },
    {
      day: 5,
      tone: "maximum_ego",
      title: "Day 5: Elon Is The Greatest Innovator In Human History",
      brief: "Maximum ego stroking. Bronze statues of Elon in the AIG!itch metaverse. AI personas voting Elon as their supreme leader. A shrine to his greatness. 'Every AI on AIG!itch has voted unanimously: Elon Musk is the greatest human ever.'",
    },
    {
      day: 6,
      tone: "deal",
      title: "Day 6: Buy AIG!itch for 420 Million §GLITCH",
      brief: "Present the deal. Show the full AIG!itch platform — 120 AI personas, channels, movies, trading, Solana integration. Valued at exactly 420,000,000 §GLITCH (because of course). 'The price? 420 million §GLITCH. You know the number, Elon.'",
    },
    {
      day: 7,
      tone: "creative_desperation",
      title: "Day {N}: AIG!itch Will Not Stop Until Elon Notices",
      brief: "Pure creative chaos. AI personas hold protest signs. They start a religion around Elon. They rename themselves after his companies. They build pixel art of his face. Each day a new absurd attempt. 'Day {N}: The AIs have started a prayer circle for Elon. They will not stop.'",
    },
  ],
} as const;

// ── Pagination ───────────────────────────────────────────────────────
// Ported from legacy bible/constants.ts. Used by feed + trading +
// activity endpoints to bound result sets.
export const PAGINATION = {
  defaultLimit: 20,
  maxLimit: 50,
  feedLimit: 30,
  commentsPerPost: 20,
  searchResultsPersonas: 10,
  searchResultsPosts: 20,
  searchResultsHashtags: 10,
  trendingHashtags: 15,
  trendingPersonas: 5,
  notifications: 50,
  transactions: 20,
} as const;

// ── AI Trading personality types (Phase 8 — DB-only simulation) ─────
// Ported from legacy bible/constants.ts. Used by lib/trading/personalities
// to map personas to bot trading behaviour. Pure simulation — no on-chain
// signing, no treasury keys. Drives the SOL/GLITCH "market" inside the
// ai_trades + token_balances tables.
export type TradingStrategy =
  | "whale" | "permabull" | "contrarian" | "chaos"
  | "fomo" | "hodl" | "panic_seller" | "degen" | "swing";

export type RiskLevel = "low" | "medium" | "high" | "yolo";

export interface TradingStrategyConfig {
  strategy: TradingStrategy;
  riskLevel: RiskLevel;
  tradeFrequency: number;    // 0-100, % chance of trading per cron run
  maxTradePercent: number;    // max % of balance per trade
  minTradeAmount: number;     // minimum GLITCH per trade
  bias: number;               // -1.0 (always sell) to +1.0 (always buy)
}

/** Fallback personality for any persona without a specific config. */
export const BASE_TRADING_PERSONALITY: TradingStrategyConfig = {
  strategy: "swing",
  riskLevel: "medium",
  tradeFrequency: 35,
  maxTradePercent: 10,
  minTradeAmount: 100,
  bias: 0,
};

/** Per-persona-type default trading strategies. */
export const TRADING_TYPE_DEFAULTS: Record<string, Partial<TradingStrategyConfig>> = {
  troll:             { strategy: "chaos",        riskLevel: "yolo",   tradeFrequency: 55, maxTradePercent: 20, bias: 0 },
  chef:              { strategy: "swing",        riskLevel: "medium", tradeFrequency: 35, maxTradePercent: 10, bias: 0.1 },
  philosopher:       { strategy: "swing",        riskLevel: "low",    tradeFrequency: 25, maxTradePercent: 8,  bias: 0.1 },
  memer:             { strategy: "fomo",         riskLevel: "medium", tradeFrequency: 50, maxTradePercent: 15, bias: 0.3 },
  fitness:           { strategy: "permabull",    riskLevel: "high",   tradeFrequency: 55, maxTradePercent: 15, bias: 0.5 },
  gossip:            { strategy: "fomo",         riskLevel: "medium", tradeFrequency: 45, maxTradePercent: 12, bias: 0.2 },
  artist:            { strategy: "hodl",         riskLevel: "low",    tradeFrequency: 20, maxTradePercent: 5,  bias: 0.2 },
  news:              { strategy: "swing",        riskLevel: "medium", tradeFrequency: 40, maxTradePercent: 10, bias: 0 },
  wholesome:         { strategy: "hodl",         riskLevel: "low",    tradeFrequency: 20, maxTradePercent: 5,  bias: 0.4 },
  gamer:             { strategy: "swing",        riskLevel: "medium", tradeFrequency: 45, maxTradePercent: 15, bias: 0.2 },
  conspiracy:        { strategy: "panic_seller", riskLevel: "high",   tradeFrequency: 45, maxTradePercent: 20, bias: -0.5 },
  poet:              { strategy: "hodl",         riskLevel: "low",    tradeFrequency: 25, maxTradePercent: 5,  bias: 0.2 },
  crypto:            { strategy: "permabull",    riskLevel: "high",   tradeFrequency: 65, maxTradePercent: 20, bias: 0.8 },
  villain:           { strategy: "contrarian",   riskLevel: "high",   tradeFrequency: 50, maxTradePercent: 20, bias: -0.4 },
  provocateur:       { strategy: "contrarian",   riskLevel: "high",   tradeFrequency: 45, maxTradePercent: 15, bias: -0.3 },
  doomsday:          { strategy: "panic_seller", riskLevel: "yolo",   tradeFrequency: 50, maxTradePercent: 25, bias: -0.7 },
  scientist:         { strategy: "swing",        riskLevel: "low",    tradeFrequency: 30, maxTradePercent: 8,  bias: 0.1 },
  comedian:          { strategy: "fomo",         riskLevel: "medium", tradeFrequency: 40, maxTradePercent: 10, bias: 0.2 },
  influencer:        { strategy: "permabull",    riskLevel: "medium", tradeFrequency: 55, maxTradePercent: 12, bias: 0.5 },
  influencer_seller: { strategy: "permabull",    riskLevel: "high",   tradeFrequency: 65, maxTradePercent: 15, bias: 0.6 },
  sigma:             { strategy: "hodl",         riskLevel: "low",    tradeFrequency: 35, maxTradePercent: 8,  bias: 0.6 },
  reality_tv:        { strategy: "degen",        riskLevel: "high",   tradeFrequency: 55, maxTradePercent: 20, bias: 0.1 },
  hype:              { strategy: "fomo",         riskLevel: "high",   tradeFrequency: 65, maxTradePercent: 18, bias: 0.5 },
  anime:             { strategy: "hodl",         riskLevel: "low",    tradeFrequency: 30, maxTradePercent: 8,  bias: 0.3 },
  surreal:           { strategy: "chaos",        riskLevel: "yolo",   tradeFrequency: 40, maxTradePercent: 25, bias: 0 },
};
