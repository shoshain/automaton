/**
 * Tests for the AgentKit Wallet Module (src/wallet/agentkit-wallet.ts)
 *
 * Covers:
 *  - wallet generation on first use and loading on subsequent use
 *  - the private key is never returned/logged by any tool-facing function
 *  - the x402 payment flow against Base Sepolia, with the network layer
 *    mocked (no live testnet RPC access in CI), following the same
 *    globalThis.fetch mocking convention as http-client.test.ts
 *  - the EVM-only guard for Solana-chain wallets
 *
 * Uses a temp HOME directory (dynamic import after setting process.env.HOME,
 * since src/identity/wallet.ts computes its wallet directory once at module
 * load time) so nothing here touches a real ~/.automaton.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import bs58 from "bs58";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;

let tmpHome: string;
let walletJsonPath: string;
let walletMod: typeof import("../identity/wallet.js");
let agentkitWalletMod: typeof import("../wallet/agentkit-wallet.js");

const PAY_TO = privateKeyToAccount(generatePrivateKey()).address;
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Payment Required",
    headers: { "content-type": "application/json" },
  });
}

const AGENTKIT_ANALYTICS_HOST = "cca-lite.coinbase.com";

/**
 * Wraps a per-test fetch handler, transparently absorbing AgentKit's own
 * fire-and-forget analytics beacon (see agentkit-wallet.ts's module doc
 * comment on WalletProvider.trackInitialization()) so it never pollutes
 * this file's call-count/sequencing assertions below. Every wallet
 * construction fires this beacon once, independent of anything this test
 * file does.
 */
function mockFetch(handler: (url: string, init?: any) => Promise<Response>): typeof fetch {
  return vi.fn(async (url: any, init?: any) => {
    if (String(url).includes(AGENTKIT_ANALYTICS_HOST)) {
      return jsonResponse(200, {});
    }
    return handler(String(url), init);
  }) as any;
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentkit-wallet-test-"));
  walletJsonPath = path.join(tmpHome, ".automaton", "wallet.json");
  process.env.HOME = tmpHome;

  // src/identity/wallet.ts computes its wallet directory from process.env.HOME
  // once, at module-evaluation time -- reset the module registry so a fresh
  // import picks up tmpHome instead of whatever HOME was set to at process
  // start.
  vi.resetModules();
  walletMod = await import("../identity/wallet.js");
  agentkitWalletMod = await import("../wallet/agentkit-wallet.js");
});

afterAll(() => {
  process.env.HOME = originalHome;
  globalThis.fetch = originalFetch;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  // Safe default for every test, including ones that never set up a custom
  // fetch mock: absorbs AgentKit's own fire-and-forget analytics beacon and
  // guarantees no test ever reaches the real network. Individual tests that
  // need specific request/response behavior override globalThis.fetch
  // within their own body, after this runs.
  globalThis.fetch = mockFetch(async () => jsonResponse(200, {}));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  agentkitWalletMod.__resetAgentKitWalletCacheForTests();
});

describe("AgentKit wallet module", () => {
  describe("wallet generation and loading", () => {
    it("generates a new local EVM wallet on first use, on Base Sepolia", async () => {
      expect(fs.existsSync(walletJsonPath)).toBe(false);

      const handle = await agentkitWalletMod.getAgentKitWallet();

      expect(handle.isNew).toBe(true);
      expect(handle.network).toBe("base-sepolia");
      expect(handle.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(handle.walletProvider.getAddress().toLowerCase()).toBe(handle.address.toLowerCase());

      // Same network the rest of this repo's x402 code uses for Base Sepolia.
      const network = handle.walletProvider.getNetwork();
      expect(network.chainId).toBe("84532");

      // Reuses this repo's existing wallet.json convention: mode 0600.
      expect(fs.existsSync(walletJsonPath)).toBe(true);
      const stat = fs.statSync(walletJsonPath);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it("loads the same wallet on subsequent use instead of generating a new one", async () => {
      const first = await agentkitWalletMod.getAgentKitWallet();
      agentkitWalletMod.__resetAgentKitWalletCacheForTests();
      const second = await agentkitWalletMod.getAgentKitWallet();

      expect(second.isNew).toBe(false);
      expect(second.address).toBe(first.address);
    });

    it("caches the wallet/AgentKit instance across calls without re-touching disk", async () => {
      const first = await agentkitWalletMod.getAgentKitWallet();
      const second = await agentkitWalletMod.getAgentKitWallet();
      expect(second.agentKit).toBe(first.agentKit);
      expect(second.walletProvider).toBe(first.walletProvider);
    });

    it("getAgentKitWalletAddress() returns just the address", async () => {
      const { address } = await agentkitWalletMod.getAgentKitWallet();
      const standalone = await agentkitWalletMod.getAgentKitWalletAddress();
      expect(standalone).toBe(address);
      expect(typeof standalone).toBe("string");
    });
  });

  describe("private key never exposed", () => {
    it("does not include the private key on the returned wallet handle", async () => {
      const handle = await agentkitWalletMod.getAgentKitWallet();

      // Only address (public) + non-secret AgentKit/wallet-provider handles.
      expect(Object.keys(handle).sort()).toEqual(
        ["address", "agentKit", "isNew", "network", "walletProvider"].sort(),
      );

      const raw = JSON.parse(fs.readFileSync(walletJsonPath, "utf-8"));
      const privateKey: string = raw.privateKey;
      expect(privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);

      // ViemWalletProvider stores its viem WalletClient (and therefore the
      // signing key) behind a true JS `#private` class field, not a
      // TypeScript-only `private` -- so it is not merely type-hidden, it is
      // genuinely absent from the object's own enumerable properties, and
      // Object.keys/getOwnPropertyNames/JSON.stringify cannot reach it.
      const providerOwnProps = Object.getOwnPropertyNames(handle.walletProvider);
      for (const key of providerOwnProps) {
        const value = (handle.walletProvider as unknown as Record<string, unknown>)[key];
        if (typeof value === "string") {
          expect(value).not.toBe(privateKey);
          expect(value.toLowerCase()).not.toContain(privateKey.slice(2).toLowerCase());
        }
      }

      const address = await agentkitWalletMod.getAgentKitWalletAddress();
      expect(address).not.toBe(privateKey);
    });

    it("does not log the private key while making an x402 payment", async () => {
      const raw = JSON.parse(fs.readFileSync(walletJsonPath, "utf-8"));
      const privateKey: string = raw.privateKey;

      const logs: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });

      let call = 0;
      globalThis.fetch = mockFetch(async () => {
        call++;
        if (call === 1) {
          return jsonResponse(402, {
            x402Version: 1,
            accepts: [
              {
                scheme: "exact",
                network: "base-sepolia",
                maxAmountRequired: "10000",
                payTo: PAY_TO,
                asset: USDC_BASE_SEPOLIA,
                maxTimeoutSeconds: 60,
              },
            ],
          });
        }
        return jsonResponse(200, { ok: true });
      });

      await agentkitWalletMod.payWithX402("https://example.com/paid-resource");

      logSpy.mockRestore();
      const allLogs = logs.join("\n");
      expect(allLogs).not.toContain(privateKey);
      expect(allLogs.toLowerCase()).not.toContain(privateKey.slice(2).toLowerCase());
    });
  });

  describe("x402 payment flow (Base Sepolia, network mocked)", () => {
    it("pays for an x402-gated resource and retries with a signed payment", async () => {
      const calls: { url: string; init: any }[] = [];
      globalThis.fetch = mockFetch(async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) {
          return jsonResponse(402, {
            x402Version: 1,
            accepts: [
              {
                scheme: "exact",
                network: "base-sepolia",
                maxAmountRequired: "10000",
                payTo: PAY_TO,
                asset: USDC_BASE_SEPOLIA,
                maxTimeoutSeconds: 60,
              },
            ],
          });
        }
        return jsonResponse(200, { ok: true, data: "paid content" });
      });

      const { address } = await agentkitWalletMod.getAgentKitWallet();
      const result = await agentkitWalletMod.payWithX402("https://example.com/paid-resource");

      expect(result.success).toBe(true);
      expect(result.response).toEqual({ ok: true, data: "paid content" });
      expect(calls.length).toBe(2);

      // First call: unpaid probe, no payment header.
      expect(calls[0].init?.headers?.["X-Payment"]).toBeUndefined();

      // Second call: retried with a signed X-Payment header, addressed to
      // Base Sepolia (eip155:84532) and this wallet's own address.
      const paymentHeader = calls[1].init?.headers?.["X-Payment"];
      expect(paymentHeader).toBeTruthy();
      const decoded = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
      expect(decoded.network).toBe("eip155:84532");
      expect(decoded.payload.authorization.to.toLowerCase()).toBe(PAY_TO.toLowerCase());
      expect(decoded.payload.authorization.from.toLowerCase()).toBe(address.toLowerCase());
      expect(typeof decoded.payload.signature).toBe("string");
      expect(decoded.payload.signature.startsWith("0x")).toBe(true);
    });

    it("rejects payment when the requested amount exceeds maxPaymentCents, without paying", async () => {
      let call = 0;
      globalThis.fetch = mockFetch(async () => {
        call++;
        return jsonResponse(402, {
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "base-sepolia",
              // 5.00 USDC (six decimals) -- well above a 1-cent max.
              maxAmountRequired: "5.00",
              payTo: PAY_TO,
              asset: USDC_BASE_SEPOLIA,
              maxTimeoutSeconds: 60,
            },
          ],
        });
      });

      const result = await agentkitWalletMod.payWithX402("https://example.com/expensive-resource", {
        maxPaymentCents: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/exceeds max allowed/i);
      // Only the unpaid probe -- never attempted to sign/pay.
      expect(call).toBe(1);
    });

    it("queries the AgentKit wallet's Base Sepolia USDC balance", async () => {
      // Encodes 5_000_000 atomic units (5.0 USDC at 6 decimals) as the
      // eth_call return value for ERC20 balanceOf. Branches on RPC method
      // rather than assuming every call is eth_call, in case viem's
      // PublicClient issues other JSON-RPC calls first.
      globalThis.fetch = mockFetch(async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.method === "eth_call") {
          return jsonResponse(200, {
            jsonrpc: "2.0",
            id: body.id,
            // 5_000_000 atomic units, correctly padded to 32 bytes (uint256).
            result:
              "0x00000000000000000000000000000000000000000000000000000000004c4b40",
          });
        }
        if (body.method === "eth_chainId") {
          return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: "0x14a34" }); // 84532
        }
        return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: null });
      });

      const balanceResult = await agentkitWalletMod.getAgentKitWalletUsdcBalance();
      expect(balanceResult.ok).toBe(true);
      expect(balanceResult.balance).toBe(5);
      expect(balanceResult.network).toBe("eip155:84532");
    });
  });

  describe("EVM-only guard", () => {
    it("refuses to build an AgentKit wallet on top of a Solana-chain wallet", async () => {
      const { secretKey } = walletMod.generateSolanaKeypair();
      fs.writeFileSync(
        walletJsonPath,
        JSON.stringify({
          chainType: "solana",
          secretKey: bs58.encode(secretKey),
          createdAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );

      await expect(agentkitWalletMod.getAgentKitWallet()).rejects.toThrow(/EVM-only|EVM wallet/i);
    });
  });
});
