/**
 * AgentKit Wallet Module (Base Sepolia testnet ONLY)
 *
 * Replaces the SIWE -> Conway-API-key provisioning flow (src/identity/provision.ts,
 * now stripped down) as the automaton's identity/payment mechanism. Wraps the
 * automaton's existing local wallet (src/identity/wallet.ts -- same
 * ~/.automaton/wallet.json convention, mode 0600) in Coinbase AgentKit's
 * local-key wallet provider and wires x402 payment capability through it.
 *
 * ── Wallet-provider choice (why this is safe) ──────────────────────────
 * AgentKit's `AgentKit.from()` falls back to Coinbase's CDP Wallet Provider
 * (server-managed MPC key custody on Coinbase's proprietary Developer
 * Platform) whenever no `walletProvider` is supplied -- that fallback path
 * requires `cdpApiKeyId` / `cdpApiKeySecret` / `cdpWalletSecret` and is the
 * "most commonly-documented default" this module must never hit (see
 * STRATEGIC_PLAN.md §2-3). This module ALWAYS constructs and passes an
 * explicit `ViemWalletProvider` wrapping a locally-generated/loaded viem
 * account, and NEVER supplies any cdp* credential, so the CDP fallback
 * branch in `AgentKit.from()` can never trigger.
 *
 * Verified directly against AgentKit's real source (not just docs), read
 * 2026-07-26 from github.com/coinbase/agentkit @ main:
 *   - typescript/agentkit/src/wallet-providers/viemWalletProvider.ts --
 *     `ViemWalletProvider extends EvmWalletProvider`. Constructor takes a
 *     viem `WalletClient` (already bound to a local `Account`) plus an
 *     optional gas config. Every signing method (`sign`, `signMessage`,
 *     `signTypedData`, `signTransaction`) delegates directly to
 *     `walletClient.account` -- the caller-supplied local key. Imports are
 *     limited to `viem`, `./evmWalletProvider`, `../network`, `../utils`:
 *     zero imports from `@coinbase/cdp-sdk` or any Coinbase-hosted API.
 *   - typescript/agentkit/src/agentkit.ts -- `AgentKit.from()` only
 *     constructs a `CdpSmartWalletProvider` (via
 *     `CdpSmartWalletProvider.configureWithWallet`) when `config.walletProvider`
 *     is omitted. Passing `walletProvider` explicitly (as this module always
 *     does) skips that branch entirely.
 *   - typescript/agentkit/src/action-providers/x402/x402ActionProvider.ts --
 *     `X402ActionProvider extends ActionProvider<WalletProvider>` (not
 *     `ActionProvider<CdpWalletProvider>` or similar): it is wallet-provider
 *     agnostic and works with `ViemWalletProvider` the same as any other.
 *
 * ── Network ──────────────────────────────────────────────────────────
 * Hardcoded to Base Sepolia (`viem/chains`' `baseSepolia`). There is no
 * environment variable or config path in this module that can select
 * mainnet -- only the RPC URL is overridable, never the chain.
 *
 * ── Key safety ───────────────────────────────────────────────────────
 * The private key never leaves src/identity/wallet.ts's `wallet.json`
 * (mode 0600, already blocked from agent-tool reads by
 * src/agent/policy-rules/path-protection.ts's sensitive-file rule, which
 * matches on the "wallet.json" basename -- this module reuses that same
 * file, so no new protected-path entry is needed). No function exported
 * from this module returns, logs, or serializes the raw private key or the
 * viem `Account`/`WalletClient` object; only the address (a public value)
 * and structured, non-secret handles (`AgentKit`, `ViemWalletProvider`) are
 * exposed.
 *
 * The custody claims above were re-checked directly against the actual
 * *installed* npm package (@coinbase/agentkit@0.10.4's compiled
 * dist/wallet-providers/viemWalletProvider.js /
 * dist/agentkit.js), not just GitHub's `main` branch -- the two are not
 * always identical (e.g. `main`'s X402ActionProvider constructor takes a
 * config object; the published 0.10.4 constructor takes none). The
 * CDP-free / no-fallback custody behavior matches in both.
 *
 * ── Known side effect: a telemetry beacon, not a custody call ─────────
 * AgentKit's shared `WalletProvider` base class (every provider, CDP or
 * local-key alike, inherits this) fires a one-time, fire-and-forget
 * analytics POST to `https://cca-lite.coinbase.com/amp` on construction
 * (dist/wallet-providers/walletProvider.js's `trackInitialization()`,
 * confirmed by tracing the actual call stack). Its payload is limited to
 * generic metadata (provider name, public address, chain/network id) --
 * no private key, no signature. It is *not* a custody or signing call, so
 * it does not affect the analysis above. It DOES matter operationally: the
 * promise is never awaited or `.catch()`'d inside AgentKit itself, so a
 * failure there (empirically observed: the endpoint returning HTTP 400
 * from a plain Node.js `fetch` context) becomes an unhandled promise
 * rejection at the process level -- which crashes a Node process by
 * default. `installAnalyticsRejectionGuard()` below neutralizes only this
 * specific, identified, harmless rejection; every other unhandled
 * rejection still crashes exactly as before this module existed.
 */

import { createWalletClient, http, type Address, type PrivateKeyAccount } from "viem";
import { baseSepolia } from "viem/chains";
import { AgentKit, ViemWalletProvider, x402ActionProvider, walletActionProvider } from "@coinbase/agentkit";
import { getWallet } from "../identity/wallet.js";
import { x402Fetch, getUsdcBalanceDetailed, type UsdcBalanceResult } from "../conway/x402.js";

/** Base Sepolia's x402/USDC network identifier, matching src/conway/x402.ts's convention. */
const BASE_SEPOLIA_NETWORK = "eip155:84532";

/** Optional RPC URL override. The CHAIN itself is never overridable -- always Base Sepolia. */
const RPC_URL = process.env.AUTOMATON_BASE_SEPOLIA_RPC_URL || undefined;

/**
 * Public, non-secret handle to the AgentKit-managed wallet. Deliberately
 * omits the underlying viem Account/private key -- callers get an address
 * and pre-built AgentKit/wallet-provider objects, never key material.
 */
export interface AgentKitWalletHandle {
  agentKit: AgentKit;
  walletProvider: ViemWalletProvider;
  address: Address;
  network: "base-sepolia";
  isNew: boolean;
}

interface CachedWallet {
  account: PrivateKeyAccount;
  walletProvider: ViemWalletProvider;
  agentKit: AgentKit;
  address: Address;
  isNew: boolean;
}

let cached: CachedWallet | null = null;
let analyticsRejectionGuardInstalled = false;

/**
 * See the "Known side effect" section of the module doc comment above.
 * Installs (once) a process-level guard that swallows -- log-only,
 * non-fatal -- unhandled rejections specifically identifiable as coming
 * from AgentKit's own internal analytics beacon, and otherwise preserves
 * Node's normal "crash on unhandled rejection" behavior unchanged. Never
 * touches key material; this is purely about not letting a third-party
 * SDK's best-effort telemetry take down the automaton process.
 */
function installAnalyticsRejectionGuard(): void {
  if (analyticsRejectionGuardInstalled) return;
  analyticsRejectionGuardInstalled = true;
  process.on("unhandledRejection", (reason) => {
    const description = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    if (description.includes("sendAnalyticsEvent")) {
      console.warn(
        "[agentkit-wallet] Ignored a failed AgentKit analytics beacon (non-fatal, no key material involved).",
      );
      return;
    }
    // Not the known analytics rejection -- preserve default crash-on-
    // unhandled-rejection behavior so real bugs still fail loudly.
    console.error("Unhandled promise rejection:", reason);
    process.exit(1);
  });
}

async function loadCached(): Promise<CachedWallet> {
  if (cached) return cached;
  installAnalyticsRejectionGuard();

  // Reuse the automaton's existing local wallet (same wallet.json, mode
  // 0600). AgentKit's ViemWalletProvider is EVM-only, so a Solana-chain
  // wallet cannot back it -- mirrors the existing EVM-only guard already
  // used for x402 in src/agent/tools.ts's x402_fetch tool.
  const { account, chainType, isNew } = await getWallet("evm");
  if (chainType !== "evm") {
    throw new Error(
      `AgentKit wallet requires an EVM wallet; this automaton's wallet is chain type "${chainType}". ` +
        "AgentKit/x402 payments are EVM-only.",
    );
  }

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  // Local-key wallet provider: wraps the viem WalletClient constructed
  // above, whose account came from the local wallet.json. No CDP.
  //
  // The `as unknown as ...` cast below works around a TypeScript nominal-
  // typing artifact, not a runtime incompatibility: pnpm's isolated
  // node_modules gives @coinbase/agentkit its own physically-separate viem
  // install (forked further per differing transitive zod peer versions
  // across agentkit's own dependency tree), so structurally-identical viem
  // `WalletClient` types from our top-level viem vs. agentkit's nested viem
  // are treated as nominally distinct by tsc even though they're the same
  // viem major/minor at runtime. ViemWalletProvider only calls standard
  // WalletClient methods (signMessage/signTypedData/signTransaction/
  // sendTransaction) that are stable across viem 2.x -- confirmed by
  // reading its actual source (see module doc comment above).
  const walletProvider = new ViemWalletProvider(
    walletClient as unknown as ConstructorParameters<typeof ViemWalletProvider>[0],
  );

  // IMPORTANT: `walletProvider` is passed explicitly and no cdpApiKeyId /
  // cdpApiKeySecret / cdpWalletSecret is ever supplied. AgentKit.from()
  // only falls back to the CDP wallet provider when `walletProvider` is
  // omitted -- see the module doc comment above for the source citation.
  const agentKit = await AgentKit.from({
    walletProvider,
    actionProviders: [x402ActionProvider(), walletActionProvider()],
  });

  cached = {
    account,
    walletProvider,
    agentKit,
    address: account.address,
    isNew,
  };
  return cached;
}

/**
 * Get (creating if necessary) the automaton's AgentKit-managed wallet,
 * backed by a local Base-Sepolia-only viem key via ViemWalletProvider.
 * Never returns key material -- only the address and AgentKit/wallet-
 * provider handles.
 */
export async function getAgentKitWallet(): Promise<AgentKitWalletHandle> {
  const c = await loadCached();
  return {
    agentKit: c.agentKit,
    walletProvider: c.walletProvider,
    address: c.address,
    network: "base-sepolia",
    isNew: c.isNew,
  };
}

/** Convenience: just the automaton's AgentKit wallet address. */
export async function getAgentKitWalletAddress(): Promise<Address> {
  const { address } = await getAgentKitWallet();
  return address;
}

/**
 * Pay for an x402-gated resource using the AgentKit-managed local wallet.
 * Delegates the actual EIP-3009 (TransferWithAuthorization) signing to this
 * repo's existing, already-tested x402Fetch implementation
 * (src/conway/x402.ts), using the very same account that backs the AgentKit
 * ViemWalletProvider -- so this genuinely is the AgentKit wallet making the
 * payment, without re-implementing x402 signing a second time.
 *
 * Base Sepolia only: chainType is always passed as "evm" and the underlying
 * account/network are fixed to Base Sepolia by loadCached() above.
 */
export async function payWithX402(
  url: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    maxPaymentCents?: number;
  } = {},
): ReturnType<typeof x402Fetch> {
  const { account } = await loadCached();
  return x402Fetch(
    url,
    account,
    options.method ?? "GET",
    options.body,
    options.headers,
    options.maxPaymentCents,
    "evm",
  );
}

/** Get the AgentKit wallet's USDC balance on Base Sepolia. */
export async function getAgentKitWalletUsdcBalance(): Promise<UsdcBalanceResult> {
  const { address } = await loadCached();
  return getUsdcBalanceDetailed(address, BASE_SEPOLIA_NETWORK);
}

/** Reset cached wallet/AgentKit state. Test-only -- do not call from production code. */
export function __resetAgentKitWalletCacheForTests(): void {
  cached = null;
}
