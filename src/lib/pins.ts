import { giwaSepoliaLegacyNativeCompatibility } from "@ammora-protocol/sdk";
import type { Hex } from "viem";
import pinsJson from "./runtime-pins.giwa.json" with { type: "json" };
import { deployment } from "./chain";

/**
 * Reviewed runtime pins bundled with the app (public data from the Ammora
 * examples). They are NEVER derived from live code: the SDK verifies the
 * deployed contracts' code hashes against these pins before any write flow.
 */
export const readRuntimePins = (): Record<string, Hex> => {
  const root = pinsJson as unknown as Record<string, unknown>;
  const deployments = root.deployments as Record<string, Record<string, unknown>>;
  const profile = deployments["auto-route"];
  if (
    root.schemaVersion !== 1 ||
    root.chainId !== String(deployment.chain.id) ||
    profile.slot !== deployment.slot ||
    profile.sourceCommit !== deployment.sourceCommit
  ) {
    throw new Error("Runtime-pin snapshot does not match the selected chain and SDK deployment");
  }
  const pins: Record<string, Hex> = {};
  for (const [address, hash] of Object.entries(
    profile.runtimeCodeHashes as Record<string, string>,
  )) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new Error("Malformed reviewed runtime pin");
    }
    const key = address.toLowerCase();
    if (pins[key] && pins[key]!.toLowerCase() !== hash.toLowerCase()) {
      throw new Error("Conflicting reviewed runtime pins");
    }
    pins[key] = hash as Hex;
  }
  const addresses = (value: unknown): string[] =>
    typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
      ? [value.toLowerCase()]
      : value && typeof value === "object"
        ? Object.values(value).flatMap(addresses)
        : [];
  for (const address of addresses(deployment.contracts)) {
    if (!pins[address]) throw new Error(`Missing reviewed runtime pin for ${address}`);
  }
  return pins;
};

/** Keep SDK-reviewed legacy compatibility pins alongside the catalog pins. */
export const mergeRuntimePins = (reviewedPins: Record<string, Hex>): Record<string, Hex> => {
  const pins: Record<string, Hex> = {};
  for (const [address, hash] of Object.entries(reviewedPins)) {
    const key = address.toLowerCase();
    if (pins[key] && pins[key]!.toLowerCase() !== hash.toLowerCase()) {
      throw new Error(`Conflicting runtime pins for ${address}`);
    }
    pins[key] = hash;
  }
  const compat = giwaSepoliaLegacyNativeCompatibility;
  for (const [address, expected] of [
    [compat.executionRegistry, compat.executionRegistryRuntimeCodeHash],
    [compat.nativeRouter, compat.nativeRouterRuntimeCodeHash],
  ] as const) {
    const key = address.toLowerCase();
    if (pins[key] && pins[key]!.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`Catalog conflicts with SDK runtime pin for ${address}`);
    }
    pins[key] = expected;
  }
  return pins;
};
