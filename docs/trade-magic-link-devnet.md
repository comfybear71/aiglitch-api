# Magic link send (devnet first)

Escrow **Magic Link** sends on trade.aiglitch.app: sender locks SPL in an on-chain PDA, shares a URL, recipient **claims** with Phantom. Sender can **refund anytime** before claim (7-day recipient window).

## v1 rules (locked)

| Rule | Value |
|------|--------|
| Expiry | **7 days** (recipient must claim before) |
| USD cap | **$500** per link |
| Cancel | Sender **refund anytime** while pending |
| Devnet tokens | **USDC** only (`4zMMC9…`) |
| Mainnet | Off until `TRADE_MAGIC_LINK_ENABLED=true` + program deploy |

## 1. Deploy program (devnet)

From repo root:

```powershell
cd C:\Users\Stuie\Dev\github.com\comfybear71\aiglitch-api\solana-programs
anchor build
anchor deploy --provider.cluster devnet
anchor keys sync
```

Note the program id (default workspace id `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcmtkgHYTKY35` until you generate a new keypair).

## 2. API env (Vercel + local)

| Variable | Example |
|----------|---------|
| `NEXT_PUBLIC_SOLANA_NETWORK` | `devnet` |
| `TRADE_MAGIC_CLAIM_PROGRAM_ID` | Your deployed program id |
| `HELIUS_API_KEY` | (existing) |
| `DATABASE_URL` | (existing) |
| `NEXT_PUBLIC_TRADE_APP_URL` | `https://trade.aiglitch.app` |

Optional preview: set trade app + API to devnet together.

## 3. Trade app env

| Variable | Value |
|----------|--------|
| `NEXT_PUBLIC_SOLANA_NETWORK` | `devnet` (for magic link testing) |

Proxy: `/api/trade/magic-link/*` already rewrites to api.aiglitch.app.

## 4. API routes

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/trade/magic-link/create` | Unsigned deposit tx + `claimUrl` |
| POST | `/api/trade/magic-link/:id/confirm` | After deposit sig |
| GET | `/api/trade/magic-link/:id` | Public status |
| POST | `/api/trade/magic-link/:id/claim` | Unsigned claim tx |
| PUT | `/api/trade/magic-link/:id/claim` | Record claim sig |
| POST | `/api/trade/magic-link/:id/refund` | Unsigned refund tx |
| PUT | `/api/trade/magic-link/:id/refund` | Record refund sig |

Broadcast signed txs via existing `POST /api/trade/submit`.

## 5. Smoke test (devnet)

1. Fund devnet wallet with devnet SOL + devnet USDC.
2. Send → **Magic Link** → create → sign deposit → copy link.
3. Open link in incognito → connect other wallet → **Claim**.
4. Or sender → **Cancel link** → sign refund.

## 6. Mainnet later

1. Deploy program to mainnet-beta.
2. Set `TRADE_MAGIC_CLAIM_PROGRAM_ID` to mainnet id.
3. Set `TRADE_MAGIC_LINK_ENABLED=true`.
4. Extend allowed symbols in `magicLinkSymbolsAllowed()` (USDC, BUDJU, GLITCH).

SOL native magic links need a program upgrade (current program is SPL-only).
