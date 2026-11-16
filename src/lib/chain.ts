import { defineChain } from "viem";
import {
  createAmmoraDeploymentSource,
  giwaSepoliaAutoRoute,
  giwaSepoliaAutoRouteDeployment,
  giwaSepoliaAutoRoutePoolProfiles,
} from "@ammora-protocol/sdk";

/** GIWA Sepolia testnet (chain 91342) — Ammora auto-route V4 deployment. */
export const GIWA_CHAIN_ID = 91342;
export const RPC_URL = "https://sepolia-rpc.giwa.io";
export const EXPLORER_URL = "https://sepolia-explorer.giwa.io";
export const DOCS_URL = "https://docs.ammora.org";
export const AMMORA_URL = "https://ammora.org";

export const deployment = giwaSepoliaAutoRouteDeployment;
export const routeDeployment = giwaSepoliaAutoRoute;
export const launch = deployment.contracts.launch; // V4 launch contracts
export const core = {
  configRegistry: launch.configRegistry,
  launchFactory: launch.factory,
  graduationAdapter: launch.graduationAdapter,
  feePolicy: launch.feePolicy,
} as const;

/** Reviewed template #6 (concentrated graduation) + its registry hash. */
export const TEMPLATE_ID = 6n;
export const TEMPLATE_HASH =
  "0x6048908774397e0691bb0e19f72dabb790eb0d892d6081d3622b39e7f738e667" as const;
export const REGISTRY = launch.configRegistry;

/** WETH on GIWA Sepolia — verified on-chain (Wrapped Ether, 18 decimals). */
export const WETH = "0x4200000000000000000000000000000000000006" as const;

export const giwaChain = defineChain({
  id: deployment.chain.id,
  name: deployment.chain.name,
  nativeCurrency: deployment.chain.nativeCurrency,
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "GIWA Explorer", url: EXPLORER_URL } },
});

/** Options for AmmoraSwapClient / DammV2Client on this deployment. */
export const ammoraClientOptions = () => ({
  deploymentSource: createAmmoraDeploymentSource([deployment]),
  factoryProfiles: giwaSepoliaAutoRoutePoolProfiles,
});

export const explorerTx = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const explorerAddress = (address: string) => `${EXPLORER_URL}/address/${address}`;

export const CHAIN_ADD_PARAMS = {
  chainId: `0x${GIWA_CHAIN_ID.toString(16)}`,
  chainName: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [RPC_URL],
  blockExplorerUrls: [EXPLORER_URL],
} as const;
