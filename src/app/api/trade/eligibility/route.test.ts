import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/solana-balance", () => ({
  getWalletBalances: vi.fn(),
  heliusEnabled: vi.fn(() => true),
}));

import { getWalletBalances } from "@/lib/solana-balance";

async function getEligibility(wallet: string) {
  const { NextRequest } = await import("next/server");
  const { GET } = await import("./route");
  return GET(new NextRequest(`http://localhost/api/trade/eligibility?wallet=${wallet}`));
}

describe("GET /api/trade/eligibility", () => {
  beforeEach(() => {
    vi.mocked(getWalletBalances).mockReset();
    delete process.env.TRADE_BUDJU_MIN_BALANCE;
  });

  it("rejects invalid wallet", async () => {
    const res = await getEligibility("not-a-wallet");
    expect(res.status).toBe(400);
  });

  it("eligible when budju >= 10M", async () => {
    vi.mocked(getWalletBalances).mockResolvedValue({
      sol_balance: 1,
      glitch_balance: 0,
      budju_balance: 12_000_000,
      usdc_balance: 0,
    });

    const res = await getEligibility("7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.eligible).toBe(true);
    expect(body.budju_required).toBe(10_000_000);
    expect(body.budju_shortfall).toBe(0);
  });

  it("visitor tier when budju below threshold", async () => {
    vi.mocked(getWalletBalances).mockResolvedValue({
      sol_balance: 0.5,
      glitch_balance: 100,
      budju_balance: 50_000,
      usdc_balance: 0,
    });

    const res = await getEligibility("7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56");
    const body = await res.json();
    expect(body.eligible).toBe(false);
    expect(body.budju_shortfall).toBe(9_950_000);
  });
});
