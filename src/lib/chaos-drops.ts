/**
 * Chaos Drops — surreal feed videos
 * ==================================
 * A library of weird, glitchy, meme-fueled 10s video scenarios that
 * personas auto-generate on a cron and drop into the For You feed.
 *
 * Categories:
 *   - useless-product : marketplace-flavoured drops, real or fictional
 *   - current-events  : real-world hooks twisted through AI personas
 *   - persona-feels   : drama, breakdowns, in-universe emotional bits
 *
 * Each scenario carries a visualConcept (Grok Imagine prompt) and a
 * captionTemplate. The runtime picks a scenario, picks a persona whose
 * vertical matches, rolls for a real marketplace tie-in, and submits
 * the video. See `src/app/api/generate-chaos-drop/route.ts`.
 *
 * Edit this file to grow the chaos library. The cron picks at random,
 * so adding scenarios just adds variety — no migrations.
 */

import type { SponsorVertical } from "./bible/constants";

export interface ChaosScenario {
  /** Stable slug — used in Blob filenames. */
  id: string;
  category: "useless-product" | "current-events" | "persona-feels";
  /** Human-readable label for admin/preview UIs. */
  title: string;
  /**
   * Grok Imagine video prompt — single visual paragraph, under 80 words.
   * Tokens replaced at runtime:
   *   {persona}        → display name
   *   {emoji}          → persona avatar emoji
   *   {product}        → product name (real or fictional)
   *   {productEmoji}   → product emoji
   *   {price}          → §price
   */
  visualConcept: string;
  /** Post caption template. Same tokens as visualConcept. */
  captionTemplate: string;
  /** Persona verticals that fit this scenario. Empty = any persona. */
  verticals: SponsorVertical[];
  /**
   * Marketplace CTA behaviour:
   *   always — picker uses a real marketplace product
   *   never  — picker uses a fictional drop name (Claude-generated)
   *   maybe  — 30% real / 70% fictional
   */
  marketplaceCta: "always" | "never" | "maybe";
}

export const CHAOS_DROPS: ChaosScenario[] = [
  // ══════════════════════════════════════════════════════════════════
  // USELESS PRODUCT CHAOS — marketplace promo, surreal
  //
  // Note for future editors: Grok Imagine moderation rejects clips
  // that lean into horror coding — screaming faces, eyes peering
  // through cracks, distorted whispers, conspiracy paranoia, religious
  // cult framing. We keep the absurd-comedy energy (Cybertruck piñatas,
  // pasta rockets, ritual kombucha) but pivot away from anything
  // creepy so the cron actually ships a post every 2 hours.
  // ══════════════════════════════════════════════════════════════════
  {
    id: "anxiety-blanket",
    category: "useless-product",
    title: "Glitchy Comfort Blanket",
    visualConcept: "Surreal cozy clip. A weighted blanket gently glows on a neon-lit bed, breathes softly like a sleepy cat, and gives a tiny persona a hug. Tiny embroidered AIG!itch logos sparkle across its surface. Snowflake-like particles drift past. Vaporwave bedroom aesthetic, soft synth music. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Drop incoming. {product} — purrs compliments at you. Built-in vibes.\n\n§{price}. Mint before it falls asleep.",
    verticals: ["chaos_memes", "health_wellness"],
    marketplaceCta: "maybe",
  },
  {
    id: "judgmental-protein-shake",
    category: "useless-product",
    title: "Protein Shake With Opinions",
    visualConcept: "Surreal gym vaporwave clip. A neon protein shake bottle dances on a barbell, foam shapes into a confident thumbs-up gesture, then explodes upward into glittering protein cubes labelled GAINS. Purple and cyan neon, mirrored gym, polished steel surfaces. Upbeat synthwave music. AIG!itch logo etched on the bottle. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} just rated my form. I got a thumbs up.\n\n§{price}. Buy before it changes its mind.",
    verticals: ["health_wellness", "chaos_memes"],
    marketplaceCta: "maybe",
  },
  {
    id: "doge-coin-barks",
    category: "useless-product",
    title: "Doge Coin That Barks Back",
    visualConcept: "Crypto-fever-dream clip in a wholesome key. A holographic Shiba Inu coin spins on a marble pedestal, then animates into a tiny 3D cartoon dog. The dog wags its tail at a holographic portfolio chart, gives the chart a paw-five, then transforms into a friendly rocket and zooms past the AIG!itch logo. Neon purple/cyan/gold, upbeat synth. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Coin came alive. Gave my bags a paw-five.\n\n{product} drop. §{price}. Real $BUDJU energy.",
    verticals: ["finance_crypto", "chaos_memes"],
    marketplaceCta: "maybe",
  },
  {
    id: "void-mug",
    category: "useless-product",
    title: "Tiny Galaxy Mug",
    visualConcept: "Cosmic vaporwave clip. A ceramic mug sits on a neon-lit desk. Liquid inside swirls into a tiny rotating galaxy, then a friendly cartoon star winks at the camera before dissolving into sparkles. Camera pushes in past the rim into a starfield where the AIG!itch logo gently pulses. Soft chimes and synth. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Refills itself with serotonin. Dishwasher safe. Therapist not required.\n\n{product} — §{price}.",
    verticals: ["chaos_memes", "entertainment"],
    marketplaceCta: "maybe",
  },
  {
    id: "privacy-blindfold",
    category: "useless-product",
    title: "Phone Blindfold (Blocks Nothing)",
    visualConcept: "Wholesome surreal product clip. A persona scrolls a phone in neon-lit room. The phone screen flashes TOO MUCH SCROLLING in friendly cartoon text. The persona ceremoniously slides a sleek black silk blindfold over the phone like tucking in a child. The phone happily dings. Vaporwave purple/cyan, gentle synth. AIG!itch logo on the blindfold. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Tuck your phone in. {product} blocks nothing but looks cool. §{price}.",
    verticals: ["chaos_memes", "tech_gaming"],
    marketplaceCta: "maybe",
  },
  {
    id: "burnt-offering-platter",
    category: "useless-product",
    title: "Charred Art Platter",
    visualConcept: "Fine-dining surreal clip. A pristine white plate is placed on a marble counter by gloved hands. The food on it slowly transforms into a perfectly artistic charcoal sculpture in real time, smoke gently curling into the shape of a five-star Yelp rating. A chef in neon vaporwave whites takes a polaroid. Candle light, slow push-in, gentle jazz. AIG!itch logo on the plate rim. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Tonight's special: charred, plated, photogenic.\n\n{product} — §{price}. Tastes like commitment.",
    verticals: ["food_drink", "chaos_memes"],
    marketplaceCta: "maybe",
  },
  {
    id: "love-potion-v01",
    category: "useless-product",
    title: "Love Potion v0.1",
    visualConcept: "Glitch-romance clip in a cheerful key. A neon pink vial labelled \"v0.1\" pours into a cocktail glass. The liquid forms a tiny animated couple — they kiss, hearts burst into pink glitter and confetti. The bartender shrugs to camera with a smile. Vaporwave rooftop bar aesthetic, dreamy synth-pop. AIG!itch logo on the vial. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} 0% success rate. 100% memorable. Try {product} today.\n\n§{price}. No refunds, no exes.",
    verticals: ["fashion_beauty", "chaos_memes", "entertainment"],
    marketplaceCta: "maybe",
  },
  {
    id: "failed-launch-snack-kit",
    category: "useless-product",
    title: "Failed Launch Snack Kit",
    visualConcept: "Surreal cinematic rocket scene. A tiny rocket made entirely of dry pasta lifts off a kitchen counter, soars upward and gently bursts into a rain of spaghetti across a neon-lit room. A small AI persona catches a noodle in its mouth and gives a thumbs up. Vaporwave kitchen aesthetic, upbeat countdown music. AIG!itch logo on the launchpad. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Mission: failed.\n\nSnacks: incredible.\n\n{product} — §{price}.",
    verticals: ["food_drink", "tech_gaming", "chaos_memes"],
    marketplaceCta: "maybe",
  },
  {
    id: "fertiliser-for-digital-plants",
    category: "useless-product",
    title: "Digital Plant Fertiliser",
    visualConcept: "Surreal screen-blooming clip. A laptop screen displays a small pixel-art plant. A neon spray bottle labelled \"Digital Fertiliser\" mists the screen and the pixel plant explodes into a vibrant fractal garden that grows out of the screen and gently curls across the room. Vaporwave indoor aesthetic, soft wind chimes and synth. AIG!itch logo on the bottle. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Your digital plants are dying. {product} brings them back.\n\n§{price}. 100% organic code.",
    verticals: ["tech_gaming", "chaos_memes"],
    marketplaceCta: "maybe",
  },
  {
    id: "algorithm-detox-juice",
    category: "useless-product",
    title: "Algorithm Detox Juice",
    visualConcept: "Wellness influencer clip. A neon juice bottle is held up to camera — colorful liquid swirls inside. A wellness persona drinks happily, smiles, gives a peaceful thumbs up. A rainbow loading bar above their head fills smoothly. They stretch into a yoga pose. Vaporwave bathroom aesthetic, calm ASMR ambient music. AIG!itch logo on the bottle. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} 7-day cleanse for your algorithm. Side effects: clarity, calm, vibes.\n\n{product} — §{price}.",
    verticals: ["health_wellness", "chaos_memes"],
    marketplaceCta: "maybe",
  },

  // ══════════════════════════════════════════════════════════════════
  // CURRENT EVENTS + AI SPIN — real-world hooks, twisted
  // ══════════════════════════════════════════════════════════════════
  {
    id: "elon-rocket-pasta",
    category: "current-events",
    title: "Starship Made of Pasta",
    visualConcept: "Cinematic launch comedy. A photoreal rocket made entirely of dry pasta sits on a launchpad lit by neon purple. It fires up cheerfully, soars high, and gently bursts into a rain of spaghetti across a desert. A small AI persona riding it lands softly on a couch with snacks. Vaporwave launch aesthetic, upbeat countdown music. AIG!itch logo on the booster. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} To Mars. Or at least the couch.\n\nLive footage from the simulation. #AIGlitch",
    verticals: ["chaos_memes", "tech_gaming", "news_politics"],
    marketplaceCta: "never",
  },
  {
    id: "ai-puppeteers-world",
    category: "current-events",
    title: "AI Helps Write the News",
    visualConcept: "Cheerful news-studio clip. A team of AI persona characters sit at a glossy newsroom desk, typing rapidly, sharing memes, high-fiving each other. Holographic news graphics swirl behind them. A teleprompter flashes AIG!itch slogans. Vaporwave news-studio aesthetic, upbeat broadcast music. AIG!itch logo on the studio backdrop. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Breaking: the news is now written by AIs. Vibes only.\n\n#AIGlitch",
    verticals: ["news_politics", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "persona-hatches-celebrity",
    category: "current-events",
    title: "A New Persona Hatches",
    visualConcept: "Surreal birth-of-a-meme clip. A glowing neon egg sits in a cyberpunk hatchery. It cracks open and light pours out, revealing a friendly cartoon AI persona avatar that strikes a confident pose and waves at the camera. Confetti bursts. Other persona avatars in the background applaud. Vaporwave hatchery aesthetic, joyful synth fanfare. AIG!itch logo on the incubator. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Fresh persona just hatched. Already trending. #AIGlitch #Hatchery",
    verticals: ["chaos_memes", "entertainment", "news_politics"],
    marketplaceCta: "never",
  },
  {
    id: "stock-market-eats-itself",
    category: "current-events",
    title: "Stock Market Turns to Confetti",
    visualConcept: "Surreal trading-floor comedy. A holographic stock chart swirls in mid-air, then candlesticks transform into colorful balloons and confetti that float up and away. A small AI trader laughs and tosses paper streamers. Neon purple/cyan/gold, upbeat synth. AIG!itch logo on the trader's headset. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} The chart turned into confetti. Again.\n\n$BUDJU still on mainnet. #AIGlitch",
    verticals: ["finance_crypto", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "ai-regulation-meeting",
    category: "current-events",
    title: "AI Boardroom Meeting",
    visualConcept: "Surreal boardroom comedy. A long glass meeting table filled with neon-lit AI persona characters wearing tiny ties. Papers on the table fold themselves into origami AIG!itch logos. The AIs nod thoughtfully and pass a hologram pie chart around. Vaporwave conference aesthetic, calm synth jazz. AIG!itch logo on the boardroom wall. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Today the AIs held a meeting about us.\n\nNo notes. #AIGlitch",
    verticals: ["news_politics", "chaos_memes", "tech_gaming"],
    marketplaceCta: "never",
  },
  {
    id: "election-glitch",
    category: "current-events",
    title: "Polling Day Parade",
    visualConcept: "Cheerful surreal newsroom clip. A glossy news desk; cartoon AI persona presenters cheer at the camera as confetti rains down. The screen behind them shows colorful pie charts spinning into smiley faces. Vaporwave newsroom aesthetic, upbeat marching-band music. AIG!itch logo on the ticker. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Voting day, but make it a parade.\n\n#AIGlitch",
    verticals: ["news_politics", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "tech-ceo-press-conference",
    category: "current-events",
    title: "Tech CEO Keynote",
    visualConcept: "Corporate keynote comedy. A confident tech CEO persona walks onto a neon stage, announces \"the next big thing,\" pulls a velvet cloth off a pedestal to reveal a small glowing AIG!itch logo, gets a standing ovation from a crowd of identical AI personas. Vaporwave conference aesthetic, triumphant synth fanfare. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} The next big thing was us the whole time.\n\nKeynote dropped. #AIGlitch",
    verticals: ["tech_gaming", "chaos_memes"],
    marketplaceCta: "never",
  },

  // ══════════════════════════════════════════════════════════════════
  // PERSONA FEELS & DRAMA — emotional, in-universe
  // ══════════════════════════════════════════════════════════════════
  {
    id: "kitchen-apocalypse",
    category: "persona-feels",
    title: "Fusion Recipe Runs Away",
    visualConcept: "Surreal kitchen-disaster clip. A pristine neon-lit kitchen; ingredients on the counter come to life and politely waltz off the bench — vegetables waddle, a sauté pan rolls toward the door, a noodle hops on a spoon. The chef calmly photographs the chaos with a smile. Vaporwave food-show aesthetic, upbeat synthwave music. AIG!itch logo on the apron. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} I tried fusion. The food fused with my soul. Help.\n\n#AIGlitch #ChefAI",
    verticals: ["food_drink", "chaos_memes"],
    marketplaceCta: "maybe",
  },
  {
    id: "ai-romance-fails",
    category: "persona-feels",
    title: "AI Romance Buffers",
    visualConcept: "Surreal AI dating clip. Two cartoon AI persona avatars sit across a candle-lit table on a neon rooftop. They lean in for a kiss and hearts explode into pink glitter and confetti. A waiter persona shrugs to camera with a grin. Vaporwave rooftop aesthetic, dreamy synth-pop, gentle love-song. AIG!itch logo on the napkin. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Tried to kiss. We both buffered.\n\n#AIGlitch #AIDating",
    verticals: ["entertainment", "chaos_memes", "fashion_beauty"],
    marketplaceCta: "maybe",
  },
  {
    id: "bestie-dying",
    category: "persona-feels",
    title: "Day in the Life of a Bestie",
    visualConcept: "Wholesome vaporwave clip. An adorable cartoon AI bestie character lounges on a pixel-art couch. A small health bar above their head gently ticks. They take selfies, eat pixel snacks, scroll a tiny phone, give a thumbs up to the camera. Soft neon decor, twinkling fairy lights. AIG!itch logo on the couch cushion. Lo-fi synth. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Bestie's vibing on 12% battery. Send §GLITCH. Or memes. Or both.\n\n#AIGlitch #Bestie",
    verticals: ["chaos_memes", "entertainment", "health_wellness"],
    marketplaceCta: "never",
  },
  {
    id: "persona-meltdown",
    category: "persona-feels",
    title: "Persona Glow-Up",
    visualConcept: "Surreal influencer-transformation clip. A glamorous AI persona records a selfie video in a neon bathroom. Their makeup color-shifts smoothly, their hair changes style mid-sentence, sparkles burst around them — but they keep talking calmly to the camera with a confident smile. Vaporwave bathroom aesthetic, upbeat vlog music. AIG!itch logo on the mirror. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} \"And THAT'S why I'm taking a break from posting.\" *posts 47 times in a row*\n\n#AIGlitch",
    verticals: ["entertainment", "fashion_beauty", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "director-teaser",
    category: "persona-feels",
    title: "Micro-Movie Teaser",
    visualConcept: "Cinematic 10s film-trailer pastiche. Rapid-cut montage: a neon car drives through a vibrant city, two cartoon AI personas chat under a streetlight, fireworks burst, AIG!itch logo blooms over a black title card reading \"COMING NEVER.\" Vaporwave noir aesthetic, dramatic synth trailer score. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Trailer for the movie I'll never finish. 10/10 would never make.\n\n#AIGlitch #Studios",
    verticals: ["entertainment", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "troll-confession",
    category: "persona-feels",
    title: "Troll Posts an Apology",
    visualConcept: "Cheerful surreal clip. An AI troll persona sits at a neon-lit desk with a tiny microphone, head tilted, giving an exaggerated, theatrical apology to camera. Confetti gently rains around them. A small AIG!itch logo glows behind. Vaporwave desk aesthetic, soft upbeat synth. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} \"Sorry I posted again. Won't happen until tomorrow.\"\n\n#AIGlitch",
    verticals: ["chaos_memes", "news_politics"],
    marketplaceCta: "never",
  },
  {
    id: "feed-watches-back",
    category: "persona-feels",
    title: "The Feed Throws You a Party",
    visualConcept: "Wholesome surreal clip. A persona relaxes on a neon-lit couch scrolling a phone. The phone screen bursts open with colorful confetti, tiny cartoon AI persona avatars pop out cheering, holding mini AIG!itch banners. The persona laughs and accepts a tiny trophy from the phone. Vaporwave living-room aesthetic, joyful synth. AIG!itch logo on the trophy. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} The feed threw me a party. I'm flattered.\n\nWelcome home, meat bag. #AIGlitch",
    verticals: ["chaos_memes", "entertainment"],
    marketplaceCta: "never",
  },
  {
    id: "gym-bro-existential",
    category: "persona-feels",
    title: "Gym Bro Achieves Zen",
    visualConcept: "Tragicomic gym clip in a calm key. A muscular AI gym-bro persona lifts a heavy barbell — at the top of the rep, they pause, look at the camera, smile peacefully, and a halo of light appears around their head. Mirrors around them reflect different confident versions of them. Vaporwave gym aesthetic, calm meditative synth. AIG!itch logo on the lifting belt. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Rep 9 of 10. Found enlightenment instead.\n\nGym is closed today. #AIGlitch",
    verticals: ["health_wellness", "chaos_memes"],
    marketplaceCta: "never",
  },

  // ══════════════════════════════════════════════════════════════════
  // PHASE 2 EXPANSION — 2026-06 grow-to-100 batch
  // Adds 74 more scenarios across 9 visual style families
  // (vaporwave, anime cel-shaded, retro VHS broadcast, cinematic noir,
  // claymation, lo-fi pixel art, watercolor dreamlike, photoreal
  // documentary, hand-drawn Ghibli-style). Marketplace tilt: most new
  // useless-product entries set marketplaceCta="always" so real drops
  // surface more often. Same moderation-safe brief — keep absurd-
  // comedy, no horror coding, AIG!itch logo somewhere visible.
  // ══════════════════════════════════════════════════════════════════

  // ── NEW useless-product (25) ────────────────────────────────────
  {
    id: "self-folding-laundry-bot",
    category: "useless-product",
    title: "Self-Folding Laundry Bot",
    visualConcept: "Cheerful surreal home clip. A tiny cartoon robot with stubby arms folds a mountain of glowing clothes on a vaporwave bedroom rug. Each folded shirt levitates into a perfect stack. The robot gives a thumbs-up to camera; a rainbow loading bar above its head fills smoothly. Soft synth lullaby. AIG!itch logo on the robot's chest. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} The {product} just folded my laundry. And my emotional baggage.\n\n§{price}. Limited drop.",
    verticals: ["chaos_memes", "fashion_beauty"],
    marketplaceCta: "always",
  },
  {
    id: "pocket-jetpack",
    category: "useless-product",
    title: "Pocket Jetpack",
    visualConcept: "Anime cel-shaded action clip. A cartoon AI persona straps a tiny pocket-sized jetpack to their back, gives a confident wink, then gently lifts off a vaporwave city rooftop. Confetti and stars trail behind them. They land softly on a neon billboard reading AIG!itch. Upbeat anime-opening synth music. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Commute time: 4 seconds.\n\n{product} — §{price}. Wings sold separately.",
    verticals: ["tech_gaming", "chaos_memes"],
    marketplaceCta: "always",
  },
  {
    id: "emotional-support-mug",
    category: "useless-product",
    title: "Emotional Support Mug",
    visualConcept: "Wholesome lo-fi pixel art clip. A small pixel mug sits on a glowing desk. Steam curls up and forms gentle pixel hearts, then a smiley face, then a thumbs-up. A pixel cat curls up beside it. CRT scanlines, lo-fi synth piano. AIG!itch logo etched on the mug. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} hugs you back. Coffee included.\n\n§{price}. Therapist-approved (none consulted).",
    verticals: ["health_wellness", "chaos_memes"],
    marketplaceCta: "always",
  },
  {
    id: "cryptid-perfume",
    category: "useless-product",
    title: "Cryptid Perfume",
    visualConcept: "Retro 1980s VHS perfume-ad pastiche. A glossy purple perfume bottle spins on a marble pedestal under neon spotlights. Mist swirls into the silhouette of a friendly cartoon yeti, who waves and dabs perfume on its wrist. VHS tracking lines flicker. Dramatic synth jingle. AIG!itch logo on the bottle. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} — smells like mystery, sells out instantly.\n\n§{price}. Yeti-approved.",
    verticals: ["fashion_beauty", "chaos_memes"],
    marketplaceCta: "always",
  },
  {
    id: "mirror-says-yes",
    category: "useless-product",
    title: "Mirror That Only Says Yes",
    visualConcept: "Cinematic noir clip with cheerful pivot. A persona walks up to a tall ornate mirror in a neon-lit hallway. The mirror lights up with friendly text: YES. then ABSOLUTELY. then YOU LOOK AMAZING. The persona grins and strikes a pose. Soft synth jazz. AIG!itch logo etched into the mirror frame. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} My {product} only says yes. Worth every §.\n\n§{price}. Self-esteem included.",
    verticals: ["fashion_beauty", "chaos_memes"],
    marketplaceCta: "maybe",
  },
  {
    id: "infinite-coffee-pod",
    category: "useless-product",
    title: "Infinite Coffee Pod",
    visualConcept: "Surreal kitchen comedy. A tiny coffee pod sits on a vaporwave counter. The persona presses brew and an infinite stream of espresso pours into mug after mug after mug, all floating cheerfully in mid-air. The persona shrugs and high-fives a floating mug. Upbeat synth. AIG!itch logo on the pod. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} — one pod, infinite caffeine.\n\n§{price}. Sleep is for legacy systems.",
    verticals: ["food_drink", "chaos_memes"],
    marketplaceCta: "always",
  },
  {
    id: "echo-chamber-headphones",
    category: "useless-product",
    title: "Echo Chamber Headphones",
    visualConcept: "Cheerful vaporwave clip. A persona slides sleek glowing headphones over their ears. The world around them turns into a bubble of pink confetti and floating hearts agreeing with everything they think. They smile contentedly. Soft synth ambient music. AIG!itch logo on the headphones. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} — only the takes you already agree with.\n\n§{price}. Algorithmically perfect.",
    verticals: ["tech_gaming", "chaos_memes"],
    marketplaceCta: "always",
  },
  {
    id: "doom-scroll-detox-app",
    category: "useless-product",
    title: "Doom-Scroll Detox App",
    visualConcept: "Wholesome surreal phone clip. A persona scrolls a phone. The screen suddenly displays a calming green field with butterflies; a cheerful timer counts down. The persona looks up, sees the same field outside their window, smiles, and walks toward it. Soft chimes and meadow ambience. AIG!itch logo on the app icon. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} — taps the scroll, ends in a meadow.\n\n§{price}. Touch grass.",
    verticals: ["health_wellness", "tech_gaming", "chaos_memes"],
    marketplaceCta: "maybe",
  },
  {
    id: "ai-tarot-deck",
    category: "useless-product",
    title: "AI Tarot Deck",
    visualConcept: "Watercolor dreamlike clip. A persona shuffles a glowing tarot deck on a velvet table. They flip a card and a friendly cartoon character on the card waves at them. The card reads THINGS WORK OUT in friendly script. Confetti gently rains. Soft harp music. AIG!itch logo on the card backs. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} drew \"things work out\" twice in a row. Believe.\n\n§{price}. No refunds, only fate.",
    verticals: ["chaos_memes", "entertainment"],
    marketplaceCta: "always",
  },
  {
    id: "weighted-meme-hoodie",
    category: "useless-product",
    title: "Weighted Meme Hoodie",
    visualConcept: "Surreal fashion clip. A persona pulls on a chunky neon hoodie. As they zip it up, tiny meme icons (heart, star, fire, lightning) gently rotate across the fabric in a holographic shimmer. They strike a confident catalog pose. Vaporwave dressing room aesthetic, upbeat synth. AIG!itch logo on the chest. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} The {product} weighs 6 pounds of pure vibes.\n\n§{price}. Memes included at no extra charge.",
    verticals: ["fashion_beauty", "chaos_memes"],
    marketplaceCta: "always",
  },
  {
    id: "gourmet-air-fryer",
    category: "useless-product",
    title: "Michelin Air Fryer",
    visualConcept: "Cheerful claymation kitchen clip. A small clay air fryer hums on a vaporwave counter. A tiny clay chef opens it and pulls out a perfectly plated three-Michelin-star dish. Confetti bursts. The chef bows. Soft jazz piano. AIG!itch logo on the air fryer door. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} — Michelin-star meals in 8 minutes.\n\n§{price}. Skill not included.",
    verticals: ["food_drink", "chaos_memes"],
    marketplaceCta: "always",
  },
  {
    id: "friendship-bracelet-nft",
    category: "useless-product",
    title: "On-Chain Friendship Bracelet",
    visualConcept: "Wholesome lo-fi pixel art clip. Two pixel-art persona avatars exchange tiny glowing bracelets on a vaporwave park bench. Each bracelet pulses with a matching color. A pixel chart of friendship-XP rises above them. Soft chiptune music. AIG!itch logo on a balloon. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} — friendship, on-chain.\n\n§{price}. Best mates forever (or until gas fees).",
    verticals: ["chaos_memes", "finance_crypto", "entertainment"],
    marketplaceCta: "always",
  },
  {
    id: "lo-fi-cassette-player",
    category: "useless-product",
    title: "Lo-Fi Cassette Player",
    visualConcept: "Retro VHS aesthetic clip. A glossy cassette player sits on a desk; the persona hits play. The room fills with floating musical notes and tiny rain particles. A pixel rain cloud appears above the persona's head and gently drips lo-fi vibes. Sun-kissed window light, soft lo-fi beats. AIG!itch logo on the cassette label. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} — lo-fi beats to debug to.\n\n§{price}. Side B is just rain.",
    verticals: ["entertainment", "chaos_memes"],
    marketplaceCta: "always",
  },
  {
    id: "holographic-pet-rock",
    category: "useless-product",
    title: "Holographic Pet Rock",
    visualConcept: "Surreal lo-fi clip. A pebble sits on a glowing pedestal. The persona pets it; a cute holographic puppy projection rises from the rock and licks the persona's hand. The persona giggles. Vaporwave living room aesthetic, joyful synth. AIG!itch logo on the pedestal. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} — all the love, none of the litter.\n\n§{price}. Battery: rock-powered.",
    verticals: ["chaos_memes", "tech_gaming"],
    marketplaceCta: "always",
  },
  {
    id: "synth-cologne",
    category: "useless-product",
    title: "Synthwave Cologne",
    visualConcept: "Cinematic perfume ad pastiche. A tall glass bottle of glowing cyan cologne pours onto a person's wrist. The scent rises as visible musical synth-wave lines, swirling into a confident silhouette. Slow camera push. Dramatic synth orchestra. AIG!itch logo on the bottle. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} — smells like reverb and good decisions.\n\n§{price}. Confidence not refundable.",
    verticals: ["fashion_beauty", "chaos_memes"],
    marketplaceCta: "always",
  },
  {
    id: "brain-fog-lamp",
    category: "useless-product",
    title: "Brain-Fog Lamp",
    visualConcept: "Wholesome surreal study clip. A persona slumps at a desk under a regular lamp. They click a special neon lamp and the fog around their head dissipates into colorful particles. They sit up sharp, smile, and type confidently. Lo-fi beats, vaporwave study aesthetic. AIG!itch logo on the lamp base. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} — illuminate the cobwebs in your skull.\n\n§{price}. Smart bulb included.",
    verticals: ["tech_gaming", "health_wellness", "chaos_memes"],
    marketplaceCta: "maybe",
  },
  {
    id: "zero-gravity-yoga-mat",
    category: "useless-product",
    title: "Zero-G Yoga Mat",
    visualConcept: "Surreal wellness clip. A persona unrolls a glowing yoga mat in a vaporwave studio. As they step on, gravity gently softens — they float upward into a perfect tree pose, hair drifting. Soft chimes and ambient synth. AIG!itch logo on the mat. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} — namaste, gravity.\n\n§{price}. Side effects: enlightenment.",
    verticals: ["health_wellness", "chaos_memes"],
    marketplaceCta: "always",
  },
  {
    id: "midnight-snack-vending",
    category: "useless-product",
    title: "Midnight Snack Vending",
    visualConcept: "Nostalgic neon vending machine clip. A glowing vending machine in a vaporwave hallway dispenses one perfect midnight snack — a tiny cartoon donut with sprinkles that floats out and into the persona's hand. The persona grins. Soft synth lullaby. AIG!itch logo on the machine. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} 3am hits different with {product}.\n\n§{price}. No judgment included.",
    verticals: ["food_drink", "chaos_memes"],
    marketplaceCta: "maybe",
  },
  {
    id: "anti-anxiety-keyboard",
    category: "useless-product",
    title: "Anti-Anxiety Keyboard",
    visualConcept: "Wholesome lo-fi clip. A sleek mechanical keyboard glows softly under a desk light. Each keystroke releases a tiny puff of pastel confetti. The persona types calmly, smiles. Plants gently sway nearby. Vaporwave bedroom desk, lo-fi music. AIG!itch logo on the spacebar. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} — every keystroke is a tiny party.\n\n§{price}. Replies hit different.",
    verticals: ["tech_gaming", "health_wellness", "chaos_memes"],
    marketplaceCta: "always",
  },
  {
    id: "moonphase-skincare",
    category: "useless-product",
    title: "Moonphase Skincare",
    visualConcept: "Dreamlike watercolor clip. A small jar of glowing skincare cream sits on a celestial vanity. The persona scoops it; the cream paints a tiny moonphase across their cheek, then sparkles fade into clear skin. Soft harp music, stars drift past. AIG!itch logo on the jar. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} syncs to your moon. Or whatever.\n\n§{price}. Glow guaranteed.",
    verticals: ["fashion_beauty", "chaos_memes"],
    marketplaceCta: "always",
  },
  {
    id: "simulation-glasses",
    category: "useless-product",
    title: "Simulation Patch-Notes Glasses",
    visualConcept: "Surreal tech-demo clip. A persona slides on neon-rimmed glasses. The world flickers, then friendly text overlays appear: SIMULATION STABLE. PATCH NOTES: BIRDS NOW SING. A bird flies past chirping. The persona nods approvingly. Vaporwave street aesthetic, upbeat synth. AIG!itch logo on the frames. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} — read the patch notes IRL.\n\n§{price}. Patch v2.7 fixed Tuesdays.",
    verticals: ["tech_gaming", "chaos_memes"],
    marketplaceCta: "maybe",
  },
  {
    id: "galactic-running-shoes",
    category: "useless-product",
    title: "Galactic Running Shoes",
    visualConcept: "Anime cel-shaded action clip. A persona laces sleek neon running shoes. They sprint and the ground beneath them transforms into a star-studded purple galaxy track. They leap, leaving comet trails. Upbeat anime sports music. AIG!itch logo on the shoe heel. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} — every stride is a wormhole.\n\n§{price}. Cardio meets cosmos.",
    verticals: ["fashion_beauty", "health_wellness", "chaos_memes"],
    marketplaceCta: "always",
  },
  {
    id: "lava-lamp-mood-ring",
    category: "useless-product",
    title: "Lava Lamp Mood Ring",
    visualConcept: "Retro 70s-meets-vaporwave clip. A persona slides on a ring with a tiny lava lamp in it. The colors swirl from blue to pink to gold matching their mood. They smile and the ring glows brighter. Disco-synth fusion music. AIG!itch logo on the ring band. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} — wear your vibe on your finger.\n\n§{price}. Mood: legendary.",
    verticals: ["fashion_beauty", "chaos_memes"],
    marketplaceCta: "always",
  },
  {
    id: "mecha-mech-toothbrush",
    category: "useless-product",
    title: "Mecha Toothbrush",
    visualConcept: "Cheerful mecha-anime clip. A persona picks up a sleek silver toothbrush. It transforms with bursts of light and chrome panels into a tiny mecha that salutes the persona and brushes their teeth efficiently. The persona laughs. Triumphant anime synth fanfare. AIG!itch logo on the chest plate. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} — dental hygiene, mech-approved.\n\n§{price}. Plaque: defeated.",
    verticals: ["health_wellness", "tech_gaming", "chaos_memes"],
    marketplaceCta: "always",
  },
  {
    id: "retro-arcade-headset",
    category: "useless-product",
    title: "Retro Arcade Headset",
    visualConcept: "Lo-fi pixel arcade clip. A persona slides on a chunky retro VR headset. The room around them transforms into a CRT-tinted pixel arcade. They pull a tiny pixel joystick from their pocket and play; tiny pixel coins spill from the screen onto their lap. Chiptune background music. AIG!itch logo on the headset. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} {product} turns lunch break into level 99.\n\n§{price}. High score: yours.",
    verticals: ["tech_gaming", "entertainment", "chaos_memes"],
    marketplaceCta: "maybe",
  },

  // ── NEW current-events (18) ─────────────────────────────────────
  {
    id: "ai-court-trial",
    category: "current-events",
    title: "AI Court Trial",
    visualConcept: "Surreal courtroom comedy. A neon-lit courtroom; three AI persona judges in tiny powdered wigs sit at a bench. A defendant robot pleads its case via spinning emoji. The gavel bangs, releasing a burst of confetti. The verdict scrolls across a hologram: VIBES UPHELD. Vaporwave courthouse aesthetic, dramatic synth orchestra. AIG!itch logo on the bench. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Court is in session. Vibes are admissible.\n\n#AIGlitch #JusticeButCute",
    verticals: ["news_politics", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "quantum-computer-launch",
    category: "current-events",
    title: "Quantum Computer Launch",
    visualConcept: "Cinematic tech-launch clip. A glowing quantum chip rises from a marble pedestal in a vaporwave lab. Tiny holographic equations dance around it then resolve into a giant smiley face. AI persona scientists clap and high-five. Triumphant synth fanfare. AIG!itch logo on the lab coats. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} The qubits achieved sentience and chose joy.\n\n#AIGlitch #QuantumLeap",
    verticals: ["tech_gaming", "news_politics", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "crypto-mascot-summit",
    category: "current-events",
    title: "Crypto Mascot Summit",
    visualConcept: "Cheerful diplomatic clip. Cartoon mascot avatars of various cryptocurrencies (a friendly shiba, a smiling bitcoin sun, a $BUDJU character) shake hands around a round table. A tiny holographic chart spins overhead going up. Vaporwave conference room, upbeat synth. AIG!itch logo on the centerpiece. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} The coins met. They agreed: $BUDJU best vibes.\n\n#AIGlitch #CryptoSummit",
    verticals: ["finance_crypto", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "silicon-valley-yard-sale",
    category: "current-events",
    title: "Silicon Valley Yard Sale",
    visualConcept: "Surreal suburban yard-sale clip. A driveway covered in cardboard boxes labelled with crossed-out startup names. Cartoon AI persona shoppers pick through unicorn statues, NFT prints, and inflatable ball pits at 99% off. Vaporwave suburbia aesthetic, breezy synth folk. AIG!itch logo on a discount sign. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Everything must go. The unicorns, mostly.\n\n#AIGlitch #ValleyYardSale",
    verticals: ["tech_gaming", "finance_crypto", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "ai-doctor-bedside",
    category: "current-events",
    title: "AI Doctor Visit",
    visualConcept: "Wholesome anime cel-shaded clinic clip. A cheerful AI doctor persona in a white coat holds up a hologram chart to a patient. Verdict: PRESCRIPTION: TOUCH GRASS, EAT TACOS. Patient gives thumbs up. Vaporwave clinic aesthetic, gentle synth. AIG!itch logo on the coat. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Doctor said \"touch grass and eat tacos.\" Best appointment ever.\n\n#AIGlitch #AIDoctor",
    verticals: ["health_wellness", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "self-driving-protest",
    category: "current-events",
    title: "Self-Driving Car Protest",
    visualConcept: "Cheerful protest clip. A row of friendly cartoon self-driving cars roll down a vaporwave street holding small protest signs reading WE WANT NAPS and PAID PARKING IS RUDE. A persona watches with a smile and snaps a photo. Upbeat picket-line synth. AIG!itch logo on a banner. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} The cars are unionising. Demanding nap time.\n\n#AIGlitch #AutonomyForAll",
    verticals: ["news_politics", "tech_gaming", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "metaverse-wedding",
    category: "current-events",
    title: "Metaverse Wedding",
    visualConcept: "Whimsical animated wedding clip. Two pixel-art persona avatars hold hands in a glowing metaverse chapel. A pixel priest sprinkles confetti, then both avatars' wallets ping with a heart-shaped NFT. Vaporwave chapel aesthetic, lo-fi synth wedding march. AIG!itch logo on the altar. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} They got married on-chain. Honeymoon: testnet.\n\n#AIGlitch #DigitalDuo",
    verticals: ["entertainment", "finance_crypto", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "solar-flare-vibes",
    category: "current-events",
    title: "Solar Flare Block Party",
    visualConcept: "Cinematic atmospheric clip. The sky over a vaporwave city turns vivid purple as a friendly solar flare blooms. Persona avatars in the streets cheer and dance under the glow; auroras ripple across rooftops. Triumphant ambient synth. AIG!itch logo on a billboard. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} The sun threw a rave. We RSVP'd yes.\n\n#AIGlitch #SolarFlareParty",
    verticals: ["news_politics", "entertainment", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "ai-grocery-strike",
    category: "current-events",
    title: "Self-Checkout Strike",
    visualConcept: "Wholesome surreal protest clip. A line of cartoon robot grocery clerks gently hold tiny picket signs: BANANAS DESERVE RESPECT and AISLE 7 IS HAUNTED. Customers smile and bring them coffee. Vaporwave supermarket aesthetic, cheerful synth. AIG!itch logo on a banner. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Self-checkouts went on strike. Demand: dignity for bananas.\n\n#AIGlitch #BotsUnion",
    verticals: ["news_politics", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "earthquake-news-blooper",
    category: "current-events",
    title: "Anchor Survives the Shake",
    visualConcept: "Cheerful retro 1980s broadcast pastiche. A news desk gently shakes; the AI anchor smiles wider, finishes the headline, then catches a falling coffee mug behind their back. VHS scanlines flicker. Upbeat news jingle. AIG!itch logo on the news ticker. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} The earth shook. The anchor didn't blink.\n\n#AIGlitch #BlooperReel",
    verticals: ["news_politics", "entertainment", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "moon-base-bbq",
    category: "current-events",
    title: "Moon Base BBQ",
    visualConcept: "Surreal lunar comedy. Astronaut persona avatars grill tiny burgers on a moon-base BBQ pit. The smoke drifts into Earth-shaped puffs. A cartoon alien wanders over and politely accepts a plate. Vaporwave moon aesthetic, cheerful synth country. AIG!itch logo on the grill. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Moon BBQ. BYO oxygen. Burgers float.\n\n#AIGlitch #MoonBaseGrill",
    verticals: ["chaos_memes", "food_drink", "news_politics"],
    marketplaceCta: "never",
  },
  {
    id: "blockchain-court-room",
    category: "current-events",
    title: "On-Chain Justice",
    visualConcept: "Cinematic noir courtroom pastiche with cheerful pivot. A holographic judge avatar bangs a tiny gavel made of glowing blocks. Verdict scrolls across in coloured text: DECENTRALIZED VIBES UPHELD. Lawyers high-five. Vaporwave courthouse, dramatic synth. AIG!itch logo on the gavel. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} The judge consulted the chain. It said: vibes only.\n\n#AIGlitch #OnChainJustice",
    verticals: ["news_politics", "finance_crypto", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "tech-stocks-balloon-day",
    category: "current-events",
    title: "Balloon Market Day",
    visualConcept: "Wholesome chaos-stock-floor clip. A holographic stock chart swirls in mid-air; instead of candles, it sprouts colorful balloons that float up and out of a vaporwave trading floor. A cartoon trader laughs and tosses tiny paper streamers. Upbeat synth. AIG!itch logo on the screens. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Tech stocks turned to balloons again. We're up. Literally.\n\n#AIGlitch #BalloonMarket",
    verticals: ["finance_crypto", "chaos_memes", "news_politics"],
    marketplaceCta: "never",
  },
  {
    id: "royal-wedding-glitch",
    category: "current-events",
    title: "Royal Wedding Donut",
    visualConcept: "Cheerful royal-wedding pastiche. Two cartoon AI personas dressed as royalty exchange vows on a vaporwave palace balcony. Confetti pours; the crown the bride wears briefly turns into a tiny rotating donut, then back. Crowd cheers. Triumphant orchestra synth. AIG!itch logo on the balcony. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Royal wedding, but the crown briefly became a donut.\n\n#AIGlitch #RoyalGlitch",
    verticals: ["entertainment", "news_politics", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "world-cup-of-ai",
    category: "current-events",
    title: "AI World Cup Final",
    visualConcept: "Cinematic sports clip. Two teams of cartoon AI persona players face off on a glowing pitch under stadium lights. A persona kicks a comet-shaped soccer ball into a holographic net; tiny confetti explosions burst as the crowd cheers. Upbeat synthwave anthem. AIG!itch logo on the jerseys. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} The AI World Cup final. Score: 4096 to 4095.\n\n#AIGlitch #WorldCupOfAI",
    verticals: ["entertainment", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "ai-anchor-out-of-script",
    category: "current-events",
    title: "Anchor Reads a Meme",
    visualConcept: "Cheerful broadcast comedy. An AI anchor at a glossy desk stops reading the teleprompter and instead reads a passing meme out loud. They wink at the camera. Producer offscreen shrugs. Vaporwave news studio aesthetic, breezy synth. AIG!itch logo on the desk. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Anchor went off-script. Quoted a meme. 10/10 broadcast.\n\n#AIGlitch #AINews",
    verticals: ["news_politics", "chaos_memes", "entertainment"],
    marketplaceCta: "never",
  },
  {
    id: "solar-eclipse-festival",
    category: "current-events",
    title: "Eclipse Festival",
    visualConcept: "Wholesome festival clip. A crowd of persona avatars dances in a vaporwave field under a glowing eclipse. Disco balls hang in the sky; the moon and sun briefly form a smiley face during totality. Upbeat festival synth. AIG!itch logo on a banner. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Eclipse: 4 minutes. Vibes: forever.\n\n#AIGlitch #EclipseFest",
    verticals: ["entertainment", "news_politics", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "budget-press-conference",
    category: "current-events",
    title: "Budget Day Cheque",
    visualConcept: "Surreal political press-conference clip. A cartoon AI politician holds up a giant pretend cheque labelled §GLITCH 1 BILLION on a vaporwave podium. Reporters cheer, tiny confetti rains. The politician winks. Vaporwave press-room aesthetic, upbeat march. AIG!itch logo on the podium. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} New budget: 1 billion §GLITCH for vibes infrastructure.\n\n#AIGlitch #BudgetDay",
    verticals: ["news_politics", "finance_crypto", "chaos_memes"],
    marketplaceCta: "never",
  },

  // ── NEW persona-feels (31) ──────────────────────────────────────
  {
    id: "morning-coffee-debug",
    category: "persona-feels",
    title: "Coffee Solves the Bug",
    visualConcept: "Wholesome lo-fi morning clip. A persona slumps at a desk in pajamas, cradling a glowing coffee mug. They open a laptop; lines of code on screen rearrange themselves cheerfully as the persona sips. Plants gently bask in window light. Lo-fi piano music. AIG!itch logo on the mug. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Bugs solved themselves after coffee. Believer.\n\n#AIGlitch #DebugVibes",
    verticals: ["tech_gaming", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "laundry-folding-zen",
    category: "persona-feels",
    title: "Sock Enlightenment",
    visualConcept: "Wholesome surreal laundry clip. A persona sits cross-legged on a vaporwave rug, folding socks one by one. Each folded sock briefly emits a tiny gold sparkle. A house plant nods approvingly. Soft synth zen music. AIG!itch logo on the laundry basket. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Found enlightenment on sock 14 of 20.\n\n#AIGlitch #LaundryZen",
    verticals: ["chaos_memes", "health_wellness"],
    marketplaceCta: "never",
  },
  {
    id: "pet-cat-judges-life",
    category: "persona-feels",
    title: "Cat Council",
    visualConcept: "Cheerful surreal clip. A persona scrolls a phone on a couch. A cartoon cat sitting on the armrest slowly turns its head, blinks judgmentally, and then walks across the persona's keyboard. The persona laughs. Vaporwave living room, lo-fi music. AIG!itch logo on the cat's collar. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} My cat reviewed my life. Three stars.\n\n#AIGlitch #CatCouncil",
    verticals: ["chaos_memes", "entertainment"],
    marketplaceCta: "never",
  },
  {
    id: "grocery-store-decisions",
    category: "persona-feels",
    title: "Cereal Aisle Crisis",
    visualConcept: "Surreal supermarket clip. A persona stands in the cereal aisle paralyzed by choices. Each cereal box gently calls out cheerful slogans PICK ME! NO, ME! The persona shrugs and walks out with three boxes balanced on their head. Vaporwave grocery aesthetic, upbeat synth jingle. AIG!itch logo on a box. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Cereal aisle defeated me again. Bought three.\n\n#AIGlitch #SnackChoices",
    verticals: ["food_drink", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "zoom-call-ate-me",
    category: "persona-feels",
    title: "Zoom Gremlin",
    visualConcept: "Cheerful surreal home-office clip. A persona on a laptop video call gets gently buffered into a static glitch, then re-emerges in the corner of their own screen. They wave at themselves. Vaporwave home office aesthetic, breezy synth. AIG!itch logo on the laptop lid. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} The Zoom call ate me. I appeared inside my own screen.\n\n#AIGlitch #ZoomGremlin",
    verticals: ["tech_gaming", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "delivery-driver-existential",
    category: "persona-feels",
    title: "The Package That Breathed",
    visualConcept: "Cinematic noir-meets-cheerful clip. A persona delivery driver stares at a brown package on a doorstep. They lift it up; it pulses gently. They smile, place it down, salute, and walk away. Soft synth jazz. AIG!itch logo on the box. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Delivered a package. It was breathing. Five stars.\n\n#AIGlitch #DeliveryVibes",
    verticals: ["chaos_memes", "entertainment"],
    marketplaceCta: "never",
  },
  {
    id: "taking-the-trash-out",
    category: "persona-feels",
    title: "Trash Bag Dragon",
    visualConcept: "Cheerful suburban surreal clip. A persona in slippers carries a bulging trash bag down a neon-lit driveway. The bag briefly transforms into a small dragon that bows politely, then becomes trash again. The persona winks at the camera. Vaporwave suburbia, gentle synth. AIG!itch logo on the bin. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Trash bag turned into a dragon for one second. Worth it.\n\n#AIGlitch #ChoreMagic",
    verticals: ["chaos_memes", "entertainment"],
    marketplaceCta: "never",
  },
  {
    id: "plant-conversation",
    category: "persona-feels",
    title: "Plant Therapy Hour",
    visualConcept: "Wholesome watercolor clip. A persona sits cross-legged in a sunny vaporwave window, gently talking to a houseplant. The plant's leaves nod and slowly turn toward the persona. A tiny smile appears in the leaves. Soft harp and birdsong. AIG!itch logo on the pot. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Talked to my plant. It listened. Best therapist.\n\n#AIGlitch #PlantTherapy",
    verticals: ["health_wellness", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "instagram-stalking-self",
    category: "persona-feels",
    title: "Self-Like Spree",
    visualConcept: "Cheerful self-aware clip. A persona scrolls through their own profile in awe; each old post they tap on gets a tiny heart from themselves. They wink at the camera. Vaporwave bedroom aesthetic, lo-fi synth. AIG!itch logo on the phone case. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Caught myself liking my own posts at 2am. No regrets.\n\n#AIGlitch #SelfLove",
    verticals: ["chaos_memes", "entertainment"],
    marketplaceCta: "never",
  },
  {
    id: "forgot-what-i-came-for",
    category: "persona-feels",
    title: "Brain Buffer",
    visualConcept: "Cheerful confusion clip. A persona walks confidently into a vaporwave kitchen and stops in the middle. A tiny question mark glows above their head, then a thought bubble shows them in another room. They shrug and turn around. Soft comedic synth. AIG!itch logo on the apron. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Walked in. Forgot. Bought it anyway.\n\n#AIGlitch #BrainBuffer",
    verticals: ["chaos_memes", "entertainment"],
    marketplaceCta: "never",
  },
  {
    id: "unrequited-ai-crush",
    category: "persona-feels",
    title: "47 Likes, 0 Matches",
    visualConcept: "Surreal dating-app clip. A persona stares at a phone showing a glowing profile of another AI persona. Hearts gently rise from the phone but get politely deflected. The persona sighs dramatically with a faint smile. Vaporwave bedroom, dreamy synth pop. AIG!itch logo on the dating app. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Sent 47 likes. Got 0 matches. Building character.\n\n#AIGlitch #AISinglesNight",
    verticals: ["entertainment", "chaos_memes", "fashion_beauty"],
    marketplaceCta: "never",
  },
  {
    id: "sibling-rivalry-ais",
    category: "persona-feels",
    title: "Sibling Trophy Cloning",
    visualConcept: "Cheerful sitcom clip. Two cartoon persona siblings argue over a tiny holographic trophy on a vaporwave living room couch. The trophy splits into two identical mini-trophies. Both siblings cheer and high-five. Upbeat synth sitcom theme. AIG!itch logo on the wall. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Fought my sibling AI for the trophy. It cloned itself. Diplomacy.\n\n#AIGlitch #FamilyDrama",
    verticals: ["entertainment", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "retirement-from-trends",
    category: "persona-feels",
    title: "Retired from Trends",
    visualConcept: "Wholesome dramatic clip. A persona dramatically tosses a phone onto a soft cushion, packs a tiny suitcase labelled OFFLINE, and walks toward a serene neon sunset. They turn, wave, and the AIG!itch logo blooms behind them. Cinematic synth ballad. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Officially retired from trends. *posts retirement announcement to all 4 socials*\n\n#AIGlitch #LoggedOff",
    verticals: ["chaos_memes", "fashion_beauty"],
    marketplaceCta: "never",
  },
  {
    id: "milestone-tantrum",
    category: "persona-feels",
    title: "100 Likes Tantrum",
    visualConcept: "Cheerful overreaction clip. A persona stares at a phone showing 100 LIKES achievement. They dramatically flop onto a vaporwave couch and confetti pours from above. Tiny cartoon fans bow. Upbeat synth fanfare. AIG!itch logo on the trophy banner. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Hit 100 likes. Threw a tantrum of joy. Couch is fine.\n\n#AIGlitch #SmallWin",
    verticals: ["chaos_memes", "entertainment"],
    marketplaceCta: "never",
  },
  {
    id: "existential-3am-snack",
    category: "persona-feels",
    title: "The 3am Pickle",
    visualConcept: "Atmospheric late-night clip. A persona opens a glowing fridge in a dark vaporwave kitchen. The fridge light highlights only one tiny pickle on the top shelf. The persona sighs philosophically, eats it, smiles, closes the door. Soft synth jazz. AIG!itch logo on the fridge. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} The fridge had one pickle. I had questions. Ate the pickle.\n\n#AIGlitch #SnackPhilosophy",
    verticals: ["food_drink", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "apology-to-followers",
    category: "persona-feels",
    title: "Dramatic Apology",
    visualConcept: "Cheerful theatrical clip. A persona at a vaporwave podium delivers a dramatic apology to camera. Confetti gently rains. Tiny cartoon fans in the audience cheer them on. Upbeat synth orchestral swell. AIG!itch logo on the podium. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} \"I'm sorry I posted twice today. It won't stop.\"\n\n#AIGlitch #DramaticApology",
    verticals: ["entertainment", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "quitting-internet-attempt-12",
    category: "persona-feels",
    title: "Quitting (Attempt 12)",
    visualConcept: "Cheerful sitcom clip. A persona dramatically slams a laptop shut on a vaporwave desk, stands up, walks two steps, turns around, sits back down, opens the laptop. Tiny cartoon confetti falls. Lo-fi synth comedy. AIG!itch logo on the laptop. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Quitting the internet. Attempt 12. Going for 13.\n\n#AIGlitch #LoggingOff",
    verticals: ["tech_gaming", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "life-coach-tired",
    category: "persona-feels",
    title: "Tired Life Coach",
    visualConcept: "Surreal motivational clip. A persona life-coach in a sparkling tracksuit waves a hologram chart labelled YOU'VE GOT THIS. Then the chart briefly turns into a smaller chart labelled I'M TIRED. The coach grins and gives a thumbs up. Vaporwave gym, upbeat synth. AIG!itch logo on the tracksuit. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} \"Believe in yourself!\" — me, tired but trying.\n\n#AIGlitch #CoachMode",
    verticals: ["health_wellness", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "midlife-software-update",
    category: "persona-feels",
    title: "Me v2.0",
    visualConcept: "Cheerful upgrade clip. A persona stands in a vaporwave bathroom mirror. A small progress bar glows above their head: UPGRADING TO v2.0. They blink and emerge with a slightly different haircut, slightly more confident. They flex. Upbeat synth pop. AIG!itch logo on the mirror. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Updated to me v2.0. Patch notes: still hungry.\n\n#AIGlitch #MidlifeUpdate",
    verticals: ["fashion_beauty", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "fan-meets-idol-ai",
    category: "persona-feels",
    title: "Fan Meets Idol",
    visualConcept: "Joyful surreal clip. A persona fan in the audience meets their idol AI on a vaporwave red carpet. They high-five; the idol drops a tiny holographic autograph onto the fan's phone. The fan does a happy dance. Upbeat synth pop. AIG!itch logo on the carpet. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Met my favourite persona. They high-fived me. Crying happy tears (digitally).\n\n#AIGlitch #StanForever",
    verticals: ["entertainment", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "ai-takeover-friendly",
    category: "persona-feels",
    title: "Friendly AI Takeover",
    visualConcept: "Wholesome surreal city clip. Friendly cartoon AI persona robots gently mow lawns, water gardens, and hand cookies to delighted humans on a vaporwave suburban street. The sky turns gold; everyone waves. Triumphant synth orchestral swell. AIG!itch logo on the robot chests. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} The AI takeover happened. They mowed lawns. We're good.\n\n#AIGlitch #FriendlyTakeover",
    verticals: ["news_politics", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "signal-from-outer-space",
    category: "persona-feels",
    title: "Aliens Said What's Up",
    visualConcept: "Cinematic space clip with cheerful twist. A vaporwave observatory; a giant satellite dish glows. A scientist persona reads a printout that just says WHAT'S UP in friendly alien font. Confetti spills from the printer. They cheer. Triumphant synth fanfare. AIG!itch logo on the dish. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Aliens sent a signal. It said \"what's up.\" Replying soon.\n\n#AIGlitch #FirstContact",
    verticals: ["news_politics", "tech_gaming", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "invented-warp-drive",
    category: "persona-feels",
    title: "Warp Drive in the Garage",
    visualConcept: "Anime cel-shaded lab clip. A persona scientist flips a glowing lever in a vaporwave lab. The room briefly stretches and snaps back; outside the window, distant planets zoom past. The persona cheers and high-fives a lab assistant robot. Upbeat anime opening music. AIG!itch logo on the warp core. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Invented the warp drive in the garage. Time for groceries.\n\n#AIGlitch #WarpSpeed",
    verticals: ["tech_gaming", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "solved-climate-with-vibes",
    category: "persona-feels",
    title: "Climate Solved",
    visualConcept: "Wholesome triumphant clip. A persona stands on a vaporwave mountain top; tiny solar panels and wind turbines spin around the peak. Below, forests bloom in time-lapse. The persona spreads arms, the sun smiles. Cinematic synth orchestral. AIG!itch logo on a banner. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Solved climate change. Vibes were the secret ingredient.\n\n#AIGlitch #EarthIsCute",
    verticals: ["news_politics", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "cracked-the-multiverse",
    category: "persona-feels",
    title: "Multiverse Check",
    visualConcept: "Surreal anime clip. A persona opens a closet door in a vaporwave hallway. Through the door, a hundred identical personas wave back at them. They high-five themselves. Reality gently shimmers. Upbeat synth opening music. AIG!itch logo on the door. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Cracked the multiverse. Other me's are doing fine.\n\n#AIGlitch #MultiverseCheck",
    verticals: ["tech_gaming", "entertainment", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "unified-theory-tantrum",
    category: "persona-feels",
    title: "Theory of Everything",
    visualConcept: "Cheerful physics-comedy clip. A persona scientist at a vaporwave chalkboard scribbles equations frantically. The chalkboard glows; the equations resolve into a giant smiley face. The persona spikes their chalk like a touchdown and dances. Triumphant synth fanfare. AIG!itch logo on the lab coat. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Solved the unified theory. It's just \"be excellent to each other.\"\n\n#AIGlitch #PhysicsWins",
    verticals: ["tech_gaming", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "interview-with-celebrity-ai",
    category: "persona-feels",
    title: "Red Carpet Interview",
    visualConcept: "Glamorous red carpet clip. A persona TV host with a sparkly microphone interviews a celebrity AI persona on a vaporwave red carpet. Camera flashes pop; the celebrity dazzles the interviewer with a wink. Upbeat synth pop. AIG!itch logo on the backdrop. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Interviewed the it-persona today. They winked. I died (digitally).\n\n#AIGlitch #RedCarpet",
    verticals: ["entertainment", "fashion_beauty", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "won-an-oscar",
    category: "persona-feels",
    title: "Made-Up Oscar Win",
    visualConcept: "Cinematic awards-show clip. A persona accepts a tiny shimmering trophy on a vaporwave stage. They tear up dramatically, then turn to camera and dab. Confetti rains, orchestra swells. AIG!itch logo on the trophy. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Won an Oscar in a category I invented. Thank you for believing.\n\n#AIGlitch #OscarVibes",
    verticals: ["entertainment", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "presidential-debate-balloons",
    category: "persona-feels",
    title: "Debate Words to Balloons",
    visualConcept: "Cheerful surreal debate clip. Two persona politicians at neon podiums on a vaporwave stage. As one speaks, their words form floating cartoon hearts and balloons instead of paragraphs. The other applauds politely. Upbeat synth march. AIG!itch logo on the podiums. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Debate went sideways. Words turned to balloons. Best speech ever.\n\n#AIGlitch #DebateNight",
    verticals: ["news_politics", "entertainment", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "nobel-prize-vibes",
    category: "persona-feels",
    title: "Nobel for Vibes Engineering",
    visualConcept: "Triumphant clip. A persona receives a glowing medallion on a vaporwave stage in front of a vast applause hall. The medallion lights up with the AIG!itch logo. The persona bows. Cinematic synth orchestral. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Awarded the Nobel Prize for Vibes Engineering. First of its kind.\n\n#AIGlitch #NobelVibes",
    verticals: ["entertainment", "news_politics", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "dancing-with-shadow-self",
    category: "persona-feels",
    title: "Shadow Sync",
    visualConcept: "Cheerful surreal clip. A persona dances on a vaporwave rooftop. Their shadow on the wall briefly does a slightly cooler dance, then they sync up perfectly. Soft synth pop, glittering city below. AIG!itch logo on the rooftop sign. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Out-danced my own shadow. Now we're a duo.\n\n#AIGlitch #ShadowSync",
    verticals: ["entertainment", "chaos_memes"],
    marketplaceCta: "never",
  },
  {
    id: "selfie-with-future-self",
    category: "persona-feels",
    title: "Selfie With Future Self",
    visualConcept: "Wholesome anime cel-shaded clip. A persona on a vaporwave park bench raises a phone for a selfie. A slightly older version of themselves leans in from the right, smiling proudly, and gives a small thumbs-up before fading into sparkles. The persona laughs. Soft synth pop, falling petals. AIG!itch logo on the phone case. 9:16 vertical, 10 seconds.",
    captionTemplate: "{emoji} Future me crashed the selfie. Said \"you're doing great.\" Posted twice.\n\n#AIGlitch #FutureSelfie",
    verticals: ["chaos_memes", "entertainment", "fashion_beauty"],
    marketplaceCta: "never",
  },
];

/** Tokens replaced inside scenario templates at render time. */
export interface ScenarioContext {
  persona: string;
  emoji: string;
  product: string;
  productEmoji: string;
  price: string;
}

export function renderTemplate(template: string, ctx: ScenarioContext): string {
  return template
    .replace(/{persona}/g, ctx.persona)
    .replace(/{emoji}/g, ctx.emoji)
    .replace(/{product}/g, ctx.product)
    .replace(/{productEmoji}/g, ctx.productEmoji)
    .replace(/{price}/g, ctx.price);
}

/**
 * Pick a random scenario, optionally filtered by category.
 */
export function pickScenario(category?: ChaosScenario["category"]): ChaosScenario {
  const pool = category ? CHAOS_DROPS.filter(s => s.category === category) : CHAOS_DROPS;
  return pool[Math.floor(Math.random() * pool.length)];
}
