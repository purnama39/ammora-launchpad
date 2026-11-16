/**
 * Read-only verification through the app's own SDK wiring (no wallet, no sends).
 * Run: npx tsx scripts/verify-reads.ts
 *
 * Checks:
 *  1. RPC chain is GIWA Sepolia 91342
 *  2. Finalized snapshot block resolves
 *  3. Deployment runtime pins verify (bundled pins vs live code)
 *  4. Template Config #6 reads (enabled, hash matches the reviewed one)
 *  5. Config planning works end-to-end (derive + reviewHash) with the app's
 *     defaults: 1,000,000 tokens sale supply, 0.001 WETH threshold
 *  6. Launch tx builds (calldata + creation fee) from the template Config
 */
import { parseUnits } from "viem";
import {
  assertChain,
  buildLaunchTx,
  getPublicClient,
  getSnapshotBlock,
  getTemplate,
  makeTeamPolicy,
  planTeamConfig,
  verifyDeployment,
} from "../src/lib/ammora";
import { TEMPLATE_HASH } from "../src/lib/chain";

const DUMMY_OWNER = "0x1111111111111111111111111111111111111111" as const;

const client = getPublicClient();
await assertChain(client);
console.log("1. RPC chain: 91342 OK");

const block = await getSnapshotBlock(client);
console.log("2. finalized snapshot block:", block.toString());

await verifyDeployment(client, block);
console.log("3. deployment runtime pins: OK");

const template = await getTemplate(client, block);
if (!template.enabled) throw new Error("template #6 is disabled");
if (template.configHash.toLowerCase() !== TEMPLATE_HASH.toLowerCase()) {
  throw new Error("template #6 hash mismatch");
}
console.log(
  `4. template #6: enabled, hash OK, tokenDecimals=${template.config.tokenDecimals}, quote=WETH ${template.config.quoteToken}`,
);

const policy = makeTeamPolicy({
  configOwner: DUMMY_OWNER,
  partnerRecipient: DUMMY_OWNER,
  liquidityPartner: DUMMY_OWNER,
  leftoverReceiver: DUMMY_OWNER,
});
const plan = planTeamConfig(template, policy, parseUnits("1000000", 9), parseUnits("0.001", 18));
console.log("5. Config plan OK:");
console.log("   reviewHash:", plan.reviewHash);
console.log("   totalSupply:", plan.economics.totalSupplyRaw.toString(), "raw (9 dec)");
console.log("   saleAllocation:", plan.economics.saleAllocationRaw.toString());
console.log("   grossMigrationBase:", plan.economics.grossMigrationBaseRaw.toString());
console.log("   grossMigrationQuote:", plan.economics.grossMigrationQuoteRaw.toString());
console.log("   tx to:", plan.transaction.to, "| calldata bytes:", (plan.transaction.data.length - 2) / 2);

const launchTx = buildLaunchTx(
  6n,
  template.config,
  "Ammora Test Token",
  "AMT",
  "https://example.com/ammora-launchpad-token.json",
);
console.log("6. launch tx builds OK:");
console.log("   to:", launchTx.to, "| value:", launchTx.value?.toString() ?? "0", "| calldata bytes:", (launchTx.data.length - 2) / 2);
console.log("ALL READ CHECKS PASSED");
