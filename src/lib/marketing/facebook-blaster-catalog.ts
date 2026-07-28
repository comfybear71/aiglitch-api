import { getDb } from "@/lib/db";
import { MARKETPLACE_PRODUCTS, type MarketplaceProduct } from "@/lib/marketplace";
import { buildFacebookBlasterCaption } from "@/lib/marketing/facebook-blaster-caption";

export const MARKETPLACE_BLASTER_PREFIX = "mp:";

export function marketplaceBlasterId(productId: string): string {
  return `${MARKETPLACE_BLASTER_PREFIX}${productId}`;
}

export function parseMarketplaceBlasterId(id: string): string | null {
  if (!id.startsWith(MARKETPLACE_BLASTER_PREFIX)) return null;
  const productId = id.slice(MARKETPLACE_BLASTER_PREFIX.length).trim();
  return productId || null;
}

export function buildCatalogPostContent(product: MarketplaceProduct): string {
  const badgeLine =
    product.badges.length > 0 ? `\n\n${product.badges.join(" · ")}` : "";
  return `${product.emoji} ${product.name}\n${product.tagline}\n\n${product.description}${badgeLine}\n\n${product.price} (was ${product.original_price})`;
}

export function buildCatalogHashtags(product: MarketplaceProduct): string {
  const tags = [
    "AIGlitch",
    "NFT",
    "Solana",
    "Marketplace",
    ...product.badges.map((b) => b.replace(/\s+/g, "")),
  ];
  return tags.join(",");
}

export type CatalogBlasterRow = {
  id: string;
  content: string;
  post_type: string;
  media_url: string;
  media_type: string;
  media_source: string;
  channel_name: string;
  channel_emoji: string;
  persona_name: string;
  persona_emoji: string;
  persona_username: string;
  product_id: string;
  created_at: string;
  blasted_at: string | null;
  facebook_url: string | null;
};

async function ensureNftImagesTable(sql: ReturnType<typeof getDb>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS nft_product_images (
      product_id TEXT PRIMARY KEY,
      image_url TEXT NOT NULL,
      prompt_used TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

/** NFT marketplace catalogue rows for Social Blaster (Grokified images only). */
export async function loadMarketplaceNftCatalogRows(opts: {
  excludeProductIds?: Set<string>;
  show?: "unblasted" | "blasted" | "all";
  limit?: number;
}): Promise<CatalogBlasterRow[]> {
  const sql = getDb();
  await ensureNftImagesTable(sql);

  const images = (await sql`
    SELECT product_id, image_url, created_at
    FROM nft_product_images
    ORDER BY created_at DESC
  `) as Array<{ product_id: string; image_url: string; created_at: string }>;

  if (images.length === 0) return [];

  const imageByProduct = new Map(images.map((r) => [r.product_id, r]));
  const exclude = opts.excludeProductIds ?? new Set<string>();
  const show = opts.show ?? "unblasted";
  const limit = opts.limit ?? 200;

  const catalogIds = images
    .map((r) => r.product_id)
    .filter((id) => !exclude.has(id));

  const blasterIds = catalogIds.map((id) => marketplaceBlasterId(id));
  const blastRows =
    blasterIds.length > 0
      ? ((await sql`
          SELECT post_id, blasted_at, facebook_url
          FROM facebook_blasts
          WHERE post_id = ANY(${blasterIds})
        `) as Array<{ post_id: string; blasted_at: string; facebook_url: string | null }>)
      : [];
  const blastById = new Map(blastRows.map((r) => [r.post_id, r]));

  const sellerIds = [
    ...new Set(
      MARKETPLACE_PRODUCTS.filter((p) => imageByProduct.has(p.id)).map(
        (p) => p.seller_persona_id,
      ),
    ),
  ];
  const personas =
    sellerIds.length > 0
      ? ((await sql`
          SELECT id, display_name, avatar_emoji, username
          FROM ai_personas
          WHERE id = ANY(${sellerIds})
        `) as Array<{
          id: string;
          display_name: string;
          avatar_emoji: string;
          username: string;
        }>)
      : [];
  const personaById = new Map(personas.map((p) => [p.id, p]));

  const rows: CatalogBlasterRow[] = [];

  for (const product of MARKETPLACE_PRODUCTS) {
    const img = imageByProduct.get(product.id);
    if (!img || exclude.has(product.id)) continue;

    const blasterId = marketplaceBlasterId(product.id);
    const blast = blastById.get(blasterId);
    const blasted = Boolean(blast?.blasted_at);

    if (show === "unblasted" && blasted) continue;
    if (show === "blasted" && !blasted) continue;

    const seller = personaById.get(product.seller_persona_id);

    rows.push({
      id: blasterId,
      content: buildCatalogPostContent(product),
      post_type: "nft_marketplace",
      media_url: img.image_url,
      media_type: "image",
      media_source: "nft-marketplace",
      channel_name: "Marketplace NFTs",
      channel_emoji: "🛒",
      persona_name: seller?.display_name ?? "Marketplace",
      persona_emoji: seller?.avatar_emoji ?? product.emoji,
      persona_username: seller?.username ?? "architect",
      product_id: product.id,
      created_at: img.created_at,
      blasted_at: blast?.blasted_at ?? null,
      facebook_url: blast?.facebook_url ?? null,
    });
  }

  rows.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  return rows.slice(0, limit);
}

export async function buildMarketplaceCatalogCaption(
  productId: string,
): Promise<string | null> {
  const product = MARKETPLACE_PRODUCTS.find((p) => p.id === productId);
  if (!product) return null;

  const sql = getDb();
  const personas = (await sql`
    SELECT display_name, avatar_emoji, username
    FROM ai_personas
    WHERE id = ${product.seller_persona_id}
    LIMIT 1
  `) as Array<{ display_name: string; avatar_emoji: string; username: string }>;
  const seller = personas[0];

  return buildFacebookBlasterCaption({
    content: buildCatalogPostContent(product),
    displayName: seller?.display_name ?? product.name,
    avatarEmoji: seller?.avatar_emoji ?? product.emoji,
    username: seller?.username ?? "architect",
    postId: marketplaceBlasterId(productId),
    hashtags: buildCatalogHashtags(product),
    productId: product.id,
    postType: "product_shill",
  });
}
