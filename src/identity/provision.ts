/**
 * Conway API Key Config Loader
 *
 * SIWE/SIWS auto-provisioning of a Conway API key has been removed.
 * Conway's SIWE auth flow has a long-standing, unresolved bug that has cost
 * real users real USDC (Conway-Research/automaton issues #293, #339), and
 * Conway Cloud's billing layer has independently failed for funded users
 * (issue #17) -- see STRATEGIC_PLAN.md section 2-3. The automaton's identity
 * and payment mechanism is now the local AgentKit wallet module
 * (src/wallet/agentkit-wallet.ts, Base Sepolia testnet), not a
 * Conway-provisioned API key.
 *
 * This file now only loads an already-existing Conway API key from
 * ~/.automaton/config.json, for the (optional, legacy) case where a Conway
 * API key was obtained some other way. It performs no signing and calls no
 * Conway auth endpoints.
 */

import fs from "fs";
import path from "path";
import { getAutomatonDir } from "./wallet.js";

/**
 * Load API key from ~/.automaton/config.json if it exists.
 */
export function loadApiKeyFromConfig(): string | null {
  const configPath = path.join(getAutomatonDir(), "config.json");
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.apiKey || null;
  } catch {
    return null;
  }
}
