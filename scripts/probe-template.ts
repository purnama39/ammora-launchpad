/**
 * Node probe (dev-only, not shipped): read template Config #6 + verify the
 * WETH address and runtime pins through the same wiring the app uses.
 * Run: npx tsx scripts/probe-template.ts
 */
import { readFileSync } from "node:fs";
import { createPublicClient, defineChain, erc20Abi, http, type Hex } from "viem";
import {
  getAmmoraV4ConfigAtBlock,
  giwaSepoliaAutoRoute,
  giwaSepoliaAutoRouteDeployment,
  giwaSepoliaLegacyNativeCompatibility,
  resolveAmmoraFinalizedHead,
  verifyAmmoraDeploymentRuntime,
} from "@ammora-protocol/sdk";
import pinsJson from "../src/lib/runtime-pins.giwa.json" with { type: "json" };

const deployment = giwaSepoliaAutoRouteDeployment;
const chain = defineChain({
  id: deployment.chain.id,
  name: deployment.chain.name,
  nativeCurrency: deployment.chain.nativeCurrency,
  rpcUrls: { default: { http: ["https://sepolia-rpc.giwa.io"] } },
});
const client = createPublicClient({ chain, transport: http("https://sepolia-rpc.giwa.io") });

const stringify = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

const snapshotBlock = await resolveAmmoraFinalizedHead([client], giwaSepoliaAutoRoute.finality);
console.log("finalized snapshot block:", snapshotBlock.toString());

// --- runtime pins (same decoder the app uses) ---
const root = pinsJson as unknown as Record<string, unknown>;
const profile = (root.deployments as Record<string, Record<string, unknown>>)["auto-route"];
if (root.schemaVersion !== 1 || root.chainId !== "91342" || profile.slot !== deployment.slot) {
  throw new Error("pins do not match the auto-route deployment");
}
const pins: Record<string, Hex> = {};
for (const [address, hash] of Object.entries(profile.runtimeCodeHashes as Record<string, string>)) {
  pins[address.toLowerCase()] = hash as Hex;
}
const compat = giwaSepoliaLegacyNativeCompatibility;
for (const [address, expected] of [
  [compat.executionRegistry, compat.executionRegistryRuntimeCodeHash],
  [compat.nativeRouter, compat.nativeRouterRuntimeCodeHash],
] as const) {
  pins[address.toLowerCase()] = expected;
}
await verifyAmmoraDeploymentRuntime(client, deployment, snapshotBlock, pins);
console.log("deployment runtime pins: OK");

// --- template #6 ---
const template = await getAmmoraV4ConfigAtBlock(
  client,
  deployment.contracts.launch.configRegistry,
  6n,
  snapshotBlock,
);
console.log("template #6:", stringify(template));

// --- WETH candidate 0x4200...0006 ---
const weth = "0x4200000000000000000000000000000000000006" as const;
const [symbol, decimals, name] = await Promise.all([
  client.readContract({ address: weth, abi: erc20Abi, functionName: "symbol" }),
  client.readContract({ address: weth, abi: erc20Abi, functionName: "decimals" }),
  client.readContract({ address: weth, abi: erc20Abi, functionName: "name" }),
]);
console.log("0x4200...0006:", { name, symbol, decimals });
console.log("template quote token:", (template.config as Record<string, unknown>).quoteToken ?? "(no quoteToken field)");
console.log("template tokenDecimals:", template.config.tokenDecimals);
