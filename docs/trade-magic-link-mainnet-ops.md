# Magic link — mainnet ops & shutdown reference

Operational notes for the **live** Magic Claim program on mainnet-beta. Keep this updated if program id, deploy wallet, or upgrade authority changes.

## Live identifiers (2026-07)

| Item | Value |
|------|--------|
| **Program id** | `3m1zLKtfvLTtJc6d6mV1bXRvdUb2jfuQiGXtA8YRB72a` |
| **Program data account** (bytecode rent) | `4C8fFRxw4k67G5TM8Q23F1RjcaKVRjmwPs59Wg1C6Aqe` |
| **Deploy / upgrade authority wallet** | `4Jm25GMWDFj4UFJTQjwo7mnDwddxSkXAthDGmkPjdMi4` (Phantom keypair: `~/.config/solana/id.json` on deploy machine) |
| **Mainnet deploy tx** | [35RhCH18…](https://solscan.io/tx/35RhCH18oBYS2iM9Tao6JJskgf5gzCtaSYfRN2qLsRAVHx6h1KomYvmwXzJsNAdvRG6kU8Gkx6h5s47Qg41s1tLs) |

**Important:** `3m1zLK…` is the **program id**, not a user wallet. Phantom “wallet balance” only shows **liquid SOL** on `4Jm25…`.

## Where deploy SOL went (~3 SOL funded)

Upgradeable program deploy **locks rent-exempt lamports** in program accounts (not burned as fees):

| Account | ~SOL (approx) | Notes |
|---------|----------------|--------|
| `4Jm25…` (payer wallet) | ~1.37 | Spendable in Phantom — deploys, tx fees, testing |
| `4C8fFR…` (program data) | ~1.696 | Rent for on-chain bytecode |
| `3m1zLK…` (program account) | ~0.001 | Minimal program account rent |

Network fee on the deploy tx itself is **0.00001 SOL** (10k lamports). The ~1.7 SOL “missing” from the wallet UI is **program rent**, still on-chain.

Verify anytime:

```powershell
# Wallet (liquid)
solana balance 4Jm25GMWDFj4UFJTQjwo7mnDwddxSkXAthDGmkPjdMi4 -u mainnet-beta

# Program data rent (locked)
solana balance 4C8fFRxw4k67G5TM8Q23F1RjcaKVRjmwPs59Wg1C6Aqe -u mainnet-beta
```

## Production default

**Leave program rent locked** while Magic Link is in production. Closing the program disables all escrows and requires a deliberate shutdown.

Before shutdown:

1. Disable new links: Vercel `TRADE_MAGIC_LINK_ENABLED=false` (and redeploy api.aiglitch.app).
2. Refund or wait out **pending** claims in DB / via trade UI (`Cancel & refund`, expiry).
3. Ensure no funded escrows remain on-chain (audit `trade_magic_claims` + program PDAs if needed).

## Recovering ~1.7 SOL (shutdown only)

Only if you **intentionally retire** the program and hold the **upgrade authority** key (`4Jm25…`):

1. Use Solana CLI / Anchor with that keypair as upgrade authority.
2. **Close** the upgradeable program (returns rent from program + program data accounts to the authority, minus any uncloseable state).

Exact commands depend on CLI version; typical pattern:

```powershell
# Authority keypair must match deploy wallet
solana config set --url mainnet-beta
solana config set --keypair C:\path\to\id.json   # 4Jm25… keypair

# Inspect program
solana program show 3m1zLKtfvLTtJc6d6mV1bXRvdUb2jfuQiGXtA8YRB72a

# Close program (recovers rent to upgrade authority) — ONLY when shutting down
solana program close 3m1zLKtfvLTtJc6d6mV1bXRvdUb2jfuQiGXtA8YRB72a
```

**Warnings:**

- Closing the program **breaks Magic Link permanently** until a new deploy + new program id + env update.
- Any **open escrows** must be refunded/claimed first or funds can be stuck per program rules.
- This is **manual ops** — trade.aiglitch.app does not auto-close programs.

After close, clear Vercel `TRADE_MAGIC_CLAIM_PROGRAM_ID` or point at a replacement program.

## API env (mainnet, live)

| Variable | Production |
|----------|------------|
| `NEXT_PUBLIC_SOLANA_NETWORK` | `mainnet-beta` |
| `TRADE_MAGIC_CLAIM_PROGRAM_ID` | `3m1zLKtfvLTtJc6d6mV1bXRvdUb2jfuQiGXtA8YRB72a` |
| `TRADE_MAGIC_LINK_ENABLED` | `true` |

See also: `docs/trade-magic-link-devnet.md` (devnet smoke + route list).
