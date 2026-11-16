/**
 * End-to-end on-chain test of the Ammora launchpad (GIWA Sepolia testnet).
 * Run: npx tsx scripts/test-e2e.ts
 *
 * Uses the app's own modules (ammora.ts) for every plan/parse step, plus a
 * viem WalletClient built from the THROWAWAY test wallet key in
 * ~/workspace/ammora-builder/.env-test-wallet (never printed, never sent
 * anywhere except as a transaction signer on chain 91342).
 *
 * Flow: Create Config (#6) -> Launch token -> Wrap ETH -> Buy -> Sell half ->
 * Final fill to graduation threshold -> Migrate. Small amounts only; total
 * spend is designed to stay far below the 0.005 ETH funding.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createWalletClient, erc20Abi, formatEther, formatUnits, http, parseUnits } from "viem";
import type { Account, Address, Hex, PublicClient, TransactionReceipt, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { planERC20Approvals } from "@ammora-protocol/sdk";
import type { AmmoraTransaction, ERC20ApprovalRequirement } from "@ammora-protocol/sdk";
import {
  assertChain,
  buildLaunchTx,
  erc20Balance,
  getConfig,
  getCurveState,
  getMigrationProgress,
  getPublicClient,
  getSnapshotBlock,
  getTemplate,
  makeTeamPolicy,
  parseConfigReceipt,
  parseLaunchReceipt,
  parseMigratedReceipt,
  parseSwapReceipt,
  planCurveSwap,
  planMigrate,
  planTeamConfig,
  resolveMigrationPositions,
  tokenInfo,
  verifyDeployment,
  wrapWethTx,
} from "../src/lib/ammora";
import { GIWA_CHAIN_ID, WETH, explorerTx, giwaChain } from "../src/lib/chain";

const TEST_ADDRESS = "0x1a69cf0008f83833115abeD935b35b7782C73887" as const;
const EXPECTED_USER_WALLET = "0x9107b0959b6DE2630F5C4Db316Cd6277A97B1a2a";
const MD_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../test-e2e-2026-11-16.md");

const SALE_SUPPLY = parseUnits("1000000", 9);
const THRESHOLD = parseUnits("0.001", 18);
const WRAP_AMOUNT = parseUnits("0.0015", 18);
const BUY_AMOUNT = parseUnits("0.0003", 18);
const TOKEN_NAME = "MuseTest";
const TOKEN_SYMBOL = "MUSE";
const METADATA_URI = "https://example.com/musetest.json";
const MAX_POOL_FEE = parseUnits("0.001", 18);
const ETH_RESERVE = parseUnits("0.001", 18); // never spend below this ETH balance
// Config tx from the first run (broadcast OK, receipt verified canonical
// afterwards; the run only failed on a transient canonical-check mismatch).
const RESUME_CONFIG_TX = "0xadc4730fef019e051154d74820cf3d9a3b7fc4a484fac85716ac6b748ee60307" as const;
// Launch tx from the second run (same story: broadcast OK, receipt verified
// canonical afterwards — token 0xB42fEf3862e26832B1D500cB438d6E85d167f3e6,
// curve 0x48C2b7dDcf4354969991979c54c967041C6eB1a4).
const RESUME_LAUNCH_TX = "0x149f9869009d0a4d94d5038a2f0ce61cbfff3ab8a625a12905a1f3e9bf9ef927" as const;

const lines: string[] = [];
const log = (s: string) => {
  console.log(s);
  lines.push(s);
};
const txLine = (label: string, hash: Hex, gasUsed: bigint, gasPrice: bigint | null) => {
  const cost = gasPrice !== null ? formatEther(gasUsed * gasPrice) : "?";
  log(`  ${label}: ${hash}`);
  log(`    explorer: ${explorerTx(hash)}`);
  log(`    gasUsed: ${gasUsed.toString()} | gas cost: ${cost} ETH`);
};

/**
 * Local-key twin of ammora.ts sendTx (which is written for a browser
 * WalletClient where the injected provider signs from a bare address).
 * Passing a bare address to wallet.sendTransaction makes viem call
 * eth_sendTransaction, which the public GIWA RPC rejects (403, "rpc method
 * is not whitelisted"). Passing the local Account object makes viem sign
 * locally and broadcast via eth_sendRawTransaction instead. Same guards
 * otherwise: nonce check, pre-send simulation, 13-confirmation wait,
 * canonical-block check.
 */
async function sendTxLocal(
  client: PublicClient,
  wallet: WalletClient,
  account: Account,
  tx: AmmoraTransaction,
  label: string,
): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  const [latestNonce, pendingNonce] = await Promise.all([
    client.getTransactionCount({ address: account.address, blockTag: "latest" }),
    client.getTransactionCount({ address: account.address, blockTag: "pending" }),
  ]);
  if (latestNonce !== pendingNonce) {
    throw new Error(`Pending transaction at nonce ${latestNonce}; reconcile before sending ${label}`);
  }
  await client.call({
    account: account.address,
    to: tx.to,
    data: tx.data,
    ...(tx.value !== undefined ? { value: tx.value } : {}),
  });
  const hash = await wallet.sendTransaction({
    account,
    chain: wallet.chain,
    to: tx.to,
    data: tx.data,
    ...(tx.value !== undefined ? { value: tx.value } : {}),
  });
  const waited = await client.waitForTransactionReceipt({
    hash,
    retryCount: 0,
    timeout: 120_000,
    pollingInterval: 6000,
    confirmations: 13,
  });
  if (waited.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  // Re-fetch the receipt fresh and re-verify it against the canonical
  // block. The public RPC sometimes serves a stale/forked view right after
  // the confirmation wait (seen twice 2026-11-16: the waited receipt's
  // blockHash mismatched getBlock, while a fresh receipt later was
  // canonical). Retry with fresh data instead of trusting the first copy.
  let receipt: TransactionReceipt | null = null;
  for (let attempt = 0; attempt < 10 && !receipt; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 6000));
    const fresh = await client.getTransactionReceipt({ hash }).catch(() => null);
    if (!fresh) continue;
    if (fresh.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    const block = await client.getBlock({ blockNumber: fresh.blockNumber });
    if (block.hash === fresh.blockHash) receipt = fresh;
  }
  if (!receipt) {
    throw new Error(`Could not obtain a canonical receipt for ${hash} after retries; reconcile before continuing`);
  }
  return { hash, receipt };
}

/** Local-key twin of ammora.ts approveRequirements (same reason as above). */
async function approveRequirementsLocal(
  client: PublicClient,
  wallet: WalletClient,
  account: Account,
  requirements: readonly ERC20ApprovalRequirement[],
): Promise<Hex[]> {
  const plans = await planERC20Approvals(client, account.address, requirements);
  const hashes: Hex[] = [];
  for (const plan of plans) {
    if (plan.transactions.length === 0) continue;
    let approvalHash: Hex | undefined;
    for (const transaction of plan.transactions) {
      const sent = await sendTxLocal(
        client,
        wallet,
        account,
        transaction,
        `approve ${plan.requirement.token.slice(0, 10)}`,
      );
      approvalHash = sent.hash;
      hashes.push(sent.hash);
    }
    if (!approvalHash) continue;
    const receipt = await client.getTransactionReceipt({ hash: approvalHash });
    const allowance = await client.readContract({
      address: plan.requirement.token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, plan.requirement.spender],
      blockNumber: receipt.blockNumber,
    });
    if (allowance < plan.requirement.amount) {
      throw new Error("approval confirmed, but its allowance is below the requested amount");
    }
  }
  return hashes;
}

const results: Record<string, string> = {};
let stepReached = "setup";

async function main() {
  // ---- load key (never logged) ----
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env-test-wallet");
  const envText = readFileSync(envPath, "utf8");
  const keyLine = envText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("AMMORA_TEST_PRIVATE_KEY="));
  if (!keyLine) throw new Error(".env-test-wallet has no AMMORA_TEST_PRIVATE_KEY");
  const key = keyLine.split("=")[1]!.trim() as Hex;
  const account = privateKeyToAccount(key);
  if (account.address.toLowerCase() !== TEST_ADDRESS.toLowerCase()) {
    throw new Error(`Derived address ${account.address} is not the throwaway test wallet — ABORT`);
  }
  if (TEST_ADDRESS.toLowerCase() === EXPECTED_USER_WALLET.toLowerCase()) {
    throw new Error("Test wallet equals the user's main wallet — ABORT");
  }
  const walletClient = createWalletClient({
    account,
    chain: giwaChain,
    transport: http("https://sepolia-rpc.giwa.io"),
  });
  const client = getPublicClient();
  const me = account.address as Address;

  log("# Ammora Launchpad E2E test — 2026-11-16 (GIWA Sepolia, chain 91342)");
  log(`Test wallet: ${me} (throwaway; user wallet never touched)`);
  log("");

  // ---- 0. preflight ----
  await assertChain(client);
  const block0 = await getSnapshotBlock(client);
  await verifyDeployment(client, block0);
  log("0. Preflight: chain 91342 OK, deployment pins verified, snapshot block " + block0.toString());
  const bal0 = await client.getBalance({ address: me });
  const gasPrice0 = await client.getGasPrice();
  log(`   ETH balance: ${formatEther(bal0)} | gas price: ${gasPrice0} wei`);
  if (bal0 < parseUnits("0.0001", 18)) throw new Error("Test wallet below 0.0001 ETH (gas money) — abort");
  const template = await getTemplate(client, block0);
  if (!template.enabled) throw new Error("template #6 disabled");
  log(`   template #6: enabled, tokenDecimals=${template.config.tokenDecimals}, poolCreationFee=${formatEther(template.config.poolCreationFee)} ETH`);
  if (template.config.poolCreationFee > MAX_POOL_FEE) {
    throw new Error(`poolCreationFee ${formatEther(template.config.poolCreationFee)} ETH exceeds 0.001 ETH guard — abort before launch`);
  }

  // ---- 1. Create Config (or resume an already-created one) ----
  stepReached = "1-create-config";
  log("\n1. Create Config (template #6, sale 1,000,000, threshold 0.001 WETH, all roles = test wallet)");
  const resumeIdx = process.argv.findIndex((a) => a === "--resume-config");
  const resumeConfigId = resumeIdx >= 0 ? BigInt(process.argv[resumeIdx + 1]!) : null;
  let configId: bigint;
  if (resumeConfigId !== null) {
    configId = resumeConfigId;
    const resumeReceipt = await client.getTransactionReceipt({ hash: RESUME_CONFIG_TX });
    txLine("config tx (earlier run)", RESUME_CONFIG_TX, resumeReceipt.gasUsed, resumeReceipt.effectiveGasPrice);
    const parsedResume = parseConfigReceipt(resumeReceipt);
    if (parsedResume.configId !== resumeConfigId) {
      throw new Error(`Resume Config ID mismatch: receipt has ${parsedResume.configId}, arg has ${resumeConfigId}`);
    }
    results.configId = resumeConfigId.toString();
    results.configTx = RESUME_CONFIG_TX;
    log(`   Config ID: ${resumeConfigId} | configHash: ${parsedResume.configHash} (reused, not re-created)`);
    const confirmedResume = await getConfig(client, resumeConfigId, resumeReceipt.blockNumber);
    if (confirmedResume.configHash.toLowerCase() !== parsedResume.configHash.toLowerCase()) {
      throw new Error("Receipt Config hash does not match the confirmed Config");
    }
    log("   Config confirmed on-chain.");
  } else {
  const policy = makeTeamPolicy({
    configOwner: me,
    partnerRecipient: me,
    liquidityPartner: me,
    leftoverReceiver: me,
  });
  const plan = planTeamConfig(template, policy, SALE_SUPPLY, THRESHOLD);
  log(`   reviewHash: ${plan.reviewHash}`);
  log(`   totalSupply: ${formatUnits(plan.economics.totalSupplyRaw, 9)} | sale: ${formatUnits(plan.economics.saleAllocationRaw, 9)} | migrationBase: ${formatUnits(plan.economics.grossMigrationBaseRaw, 9)}`);
  const created = await sendTxLocal(client, walletClient, account, plan.transaction, "create Config");
  txLine("config tx", created.hash, created.receipt.gasUsed, created.receipt.effectiveGasPrice);
  const parsedConfig = parseConfigReceipt(created.receipt);
  configId = parsedConfig.configId;
  results.configId = configId.toString();
  results.configTx = created.hash;
  log(`   Config ID: ${configId} | configHash: ${parsedConfig.configHash}`);
  const confirmed = await getConfig(client, configId, created.receipt.blockNumber);
  if (confirmed.configHash.toLowerCase() !== parsedConfig.configHash.toLowerCase()) {
    throw new Error("Receipt Config hash does not match the confirmed Config");
  }
  log("   Config confirmed on-chain.");
  }

  // ---- 2. Launch token (or resume an already-launched one) ----
  stepReached = "2-launch";
  log(`\n2. Launch token "${TOKEN_NAME}" (${TOKEN_SYMBOL}) from Config #${configId}`);
  const resumeLaunch = process.argv.includes("--resume-launch");
  let token: Address;
  let curve: Address;
  let launchReceiptBlock: bigint;
  if (resumeLaunch) {
    const resumeReceipt = await client.getTransactionReceipt({ hash: RESUME_LAUNCH_TX });
    txLine("launch tx (earlier run)", RESUME_LAUNCH_TX, resumeReceipt.gasUsed, resumeReceipt.effectiveGasPrice);
    const parsedResumeLaunch = parseLaunchReceipt(resumeReceipt);
    token = parsedResumeLaunch.token as Address;
    curve = parsedResumeLaunch.curve as Address;
    launchReceiptBlock = resumeReceipt.blockNumber;
    results.token = token;
    results.curve = curve;
    results.launchTx = RESUME_LAUNCH_TX;
    log(`   token: ${token} | curve: ${curve} | creator: ${parsedResumeLaunch.creator} (reused, not re-launched)`);
  } else {
    const blockL = await getSnapshotBlock(client);
    const cfg = await getConfig(client, configId, blockL);
    const launchTx = buildLaunchTx(configId, cfg.config, TOKEN_NAME, TOKEN_SYMBOL, METADATA_URI);
    log(`   launch value (poolCreationFee): ${formatEther(launchTx.value ?? 0n)} ETH`);
    const launched = await sendTxLocal(client, walletClient, account, launchTx, "create launch");
    txLine("launch tx", launched.hash, launched.receipt.gasUsed, launched.receipt.effectiveGasPrice);
    const parsedLaunch = parseLaunchReceipt(launched.receipt);
    token = parsedLaunch.token as Address;
    curve = parsedLaunch.curve as Address;
    launchReceiptBlock = launched.receipt.blockNumber;
    results.token = token;
    results.curve = curve;
    results.launchTx = launched.hash;
    log(`   token: ${token} | curve: ${curve} | creator: ${parsedLaunch.creator}`);
  }
  const [tokenCode, curveCode] = await Promise.all([
    client.getCode({ address: token, blockNumber: launchReceiptBlock }),
    client.getCode({ address: curve, blockNumber: launchReceiptBlock }),
  ]);
  if (!tokenCode || tokenCode === "0x" || !curveCode || curveCode === "0x") {
    throw new Error("Token/curve code missing at the receipt block");
  }
  const info = await tokenInfo(client, token);
  log(`   token on-chain: ${info.name} (${info.symbol}), decimals=${info.decimals}`);

  // ---- 3. Wrap ETH -> WETH + buy (skipped when resuming at graduation) ----
  const resumeGraduate = process.argv.includes("--resume-graduate");
  stepReached = "3-buy";
  if (!resumeGraduate) {
  log(`\n3. Wrap ${formatEther(WRAP_AMOUNT)} ETH -> WETH, then buy ${formatEther(BUY_AMOUNT)} WETH worth of ${TOKEN_SYMBOL}`);
  const wrapped = await sendTxLocal(client, walletClient, account, wrapWethTx(WRAP_AMOUNT), "wrap ETH to WETH");
  txLine("wrap tx", wrapped.hash, wrapped.receipt.gasUsed, wrapped.receipt.effectiveGasPrice);
  results.wrapTx = wrapped.hash;
  const wethAfterWrap = await erc20Balance(client, WETH, me);
  log(`   WETH balance after wrap: ${formatEther(wethAfterWrap)}`);
  const blockB = await getSnapshotBlock(client);
  const blockInfoB = await client.getBlock({ blockNumber: blockB });
  const buyPlan = await planCurveSwap(client, curve, {
    blockNumber: blockB,
    tokenIn: WETH,
    amountIn: BUY_AMOUNT,
    recipient: me,
    deadline: blockInfoB.timestamp + 20n * 60n,
    slippageBps: 50,
  });
  log(`   buy quote: expected out ${formatUnits(buyPlan.quote.amountOut, 9)} ${TOKEN_SYMBOL}, min out ${formatUnits(buyPlan.quote.minimumAmountOut, 9)}, fill=${buyPlan.fill.kind}`);
  const approveBuy = await approveRequirementsLocal(client, walletClient, account, buyPlan.approvalRequirements);
  if (approveBuy.length) log(`   approve tx: ${approveBuy.join(", ")}`);
  const wethBefore = await erc20Balance(client, WETH, me, blockB);
  const bought = await sendTxLocal(client, walletClient, account, buyPlan.transaction, "curve buy");
  txLine("buy tx", bought.hash, bought.receipt.gasUsed, bought.receipt.effectiveGasPrice);
  results.buyTx = bought.hash;
  const parsedBuy = parseSwapReceipt(bought.receipt, curve, {
    trader: me,
    recipient: me,
    baseForQuote: false,
    requestedAmountIn: BUY_AMOUNT,
    minimumAmountOut: buyPlan.quote.minimumAmountOut,
  });
  const museAfterBuy = await erc20Balance(client, token, me, bought.receipt.blockNumber);
  log(`   buy consumed: ${formatEther(parsedBuy.consumedAmountIn)} WETH | MUSE balance now: ${formatUnits(museAfterBuy, 9)}`);
  void wethBefore;

  // ---- 4. Sell half back ----
  stepReached = "4-sell";
  const sellAmount = museAfterBuy / 2n;
  log(`\n4. Sell half of MUSE balance: ${formatUnits(sellAmount, 9)} ${TOKEN_SYMBOL}`);
  if (sellAmount <= 0n) throw new Error("MUSE balance too small to sell half");
  const blockS = await getSnapshotBlock(client);
  const blockInfoS = await client.getBlock({ blockNumber: blockS });
  const sellPlan = await planCurveSwap(client, curve, {
    blockNumber: blockS,
    tokenIn: token,
    amountIn: sellAmount,
    recipient: me,
    deadline: blockInfoS.timestamp + 20n * 60n,
    slippageBps: 50,
  });
  log(`   sell quote: expected out ${formatEther(sellPlan.quote.amountOut)} WETH, min out ${formatEther(sellPlan.quote.minimumAmountOut)}, fill=${sellPlan.fill.kind}`);
  const approveSell = await approveRequirementsLocal(client, walletClient, account, sellPlan.approvalRequirements);
  if (approveSell.length) log(`   approve tx: ${approveSell.join(", ")}`);
  const wethBeforeSell = await erc20Balance(client, WETH, me, blockS);
  const sold = await sendTxLocal(client, walletClient, account, sellPlan.transaction, "curve sell");
  txLine("sell tx", sold.hash, sold.receipt.gasUsed, sold.receipt.effectiveGasPrice);
  results.sellTx = sold.hash;
  const parsedSell = parseSwapReceipt(sold.receipt, curve, {
    trader: me,
    recipient: me,
    baseForQuote: true,
    requestedAmountIn: sellAmount,
    minimumAmountOut: sellPlan.quote.minimumAmountOut,
  });
  const wethAfterSell = await erc20Balance(client, WETH, me, sold.receipt.blockNumber);
  log(`   sell consumed: ${formatUnits(parsedSell.consumedAmountIn, 9)} MUSE | WETH back: ${formatEther(wethAfterSell - wethBeforeSell)} (balance now ${formatEther(wethAfterSell)})`);
  } else {
    log("\n3-4. Buy/sell skipped (resuming at graduation; already done in the earlier run).");
  }

  // ---- 5. Graduation: final fill + migrate (only if affordable with margin) ----
  stepReached = "5-graduate";
  log("\n5. Graduation: final fill to threshold + migrate");
  const blockG = await getSnapshotBlock(client);
  const [stG, progG] = await Promise.all([
    getCurveState(client, curve, blockG),
    getMigrationProgress(client, curve, blockG),
  ]);
  log(`   curve status: ${stG.status} | progress: ${formatEther(progG.current)} / ${formatEther(progG.target)} WETH (ready=${progG.ready}, migrated=${progG.migrated})`);
  if (progG.migrated) {
    log("   already migrated — nothing to do.");
    results.graduation = "already-migrated";
  } else if (stG.status !== 1) {
    log(`   curve status ${stG.status} is not Active — graduation not attempted.`);
    results.graduation = `not-attempted: curve status ${stG.status}`;
  } else {
    const remaining = progG.target > progG.current ? progG.target - progG.current : 0n;
    log(`   remaining to threshold: ${formatEther(remaining)} WETH`);
    // The final-fill input is a MAXIMUM, not an exact amount: the curve
    // consumes only what reaches the graduation boundary and refunds the
    // rest (SDK example final-fill-and-graduate.ts). Using exactly
    // `remaining` fails the boundary check: the ~1% trading fee is taken
    // from the input, so the reserve grows by less than the input and the
    // quote classifies as "full" instead of "graduation-boundary". The
    // app's Graduate step has the same latent issue (maxFill = target -
    // current). Use the whole WETH balance as the maximum instead.
    const needed = (remaining * 11n) / 10n; // 10% headroom over the fee-adjusted need
    let wethBal = await erc20Balance(client, WETH, me, blockG);
    if (remaining > 0n && wethBal < needed) {
      const shortfall = needed - wethBal;
      const ethBal = await client.getBalance({ address: me });
      if (ethBal - shortfall >= ETH_RESERVE) {
        log(`   topping up WETH by ${formatEther(shortfall)} ETH to cover the final fill`);
        const top = await sendTxLocal(client, walletClient, account, wrapWethTx(shortfall), "wrap top-up for final fill");
        txLine("wrap top-up tx", top.hash, top.receipt.gasUsed, top.receipt.effectiveGasPrice);
        wethBal = await erc20Balance(client, WETH, me);
      } else {
        log(`   NOT attempted: need ~${formatEther(needed)} WETH max input, have ${formatEther(wethBal)}, topping up would breach the ${formatEther(ETH_RESERVE)} ETH reserve.`);
        results.graduation = `not-attempted: insufficient WETH (${formatEther(wethBal)} < ~${formatEther(needed)}) and top-up would breach ETH reserve`;
      }
    }
    if (!results.graduation && remaining > 0n) {
      const blockF = await getSnapshotBlock(client);
      const blockInfoF = await client.getBlock({ blockNumber: blockF });
      const fillMax = wethBal; // maximum input; curve refunds the unused part
      log(`   final-fill max input: ${formatEther(fillMax)} WETH (whole balance; curve consumes only the boundary amount)`);
      const fillPlan = await planCurveSwap(client, curve, {
        blockNumber: blockF,
        tokenIn: WETH,
        amountIn: fillMax,
        recipient: me,
        deadline: blockInfoF.timestamp + 20n * 60n,
        slippageBps: 100,
        graduationBoundary: true,
      });
      log(`   final-fill quote: expected out ${formatUnits(fillPlan.quote.amountOut, 9)} MUSE, fill=${fillPlan.fill.kind}, quote consumes ${formatEther(fillPlan.quote.amountIn)} WETH, refunds ${formatEther(fillPlan.quote.amountLeft)} WETH`);
      const approveFill = await approveRequirementsLocal(client, walletClient, account, fillPlan.approvalRequirements);
      if (approveFill.length) log(`   approve tx: ${approveFill.join(", ")}`);
      const filled = await sendTxLocal(client, walletClient, account, fillPlan.transaction, "final curve fill");
      txLine("final fill tx", filled.hash, filled.receipt.gasUsed, filled.receipt.effectiveGasPrice);
      results.fillTx = filled.hash;
      const parsedFill = parseSwapReceipt(filled.receipt, curve, {
        trader: me,
        recipient: me,
        baseForQuote: false,
        requestedAmountIn: fillMax,
        minimumAmountOut: fillPlan.quote.minimumAmountOut,
      });
      log(`   final fill consumed: ${formatEther(parsedFill.consumedAmountIn)} WETH | unused (returned): ${formatEther(parsedFill.amountLeft)} WETH`);
      // migrate
      const blockM = await getSnapshotBlock(client);
      const migPlan = await planMigrate(client, curve, blockM);
      if (migPlan.alreadyMigrated) {
        log("   already migrated after final fill.");
        results.graduation = "migrated (already after fill)";
      } else {
        const migrated = await sendTxLocal(client, walletClient, account, migPlan.transaction, "migrate to ARL");
        txLine("migrate tx", migrated.hash, migrated.receipt.gasUsed, migrated.receipt.effectiveGasPrice);
        results.migrateTx = migrated.hash;
        const parsedMig = parseMigratedReceipt(migrated.receipt, curve);
        log(`   canonical pool: ${parsedMig.canonicalPool}`);
        results.pool = parsedMig.canonicalPool;
        const resolved = resolveMigrationPositions(
          migrated.receipt,
          curve,
          parsedMig.canonicalPool,
          me,
          me,
        );
        for (const p of resolved.positions) {
          log(`   LP position tokenId=${p.tokenId}`);
        }
        results.graduation = "migrated";
      }
    } else if (!results.graduation) {
      log("   progress already at target — no final fill needed; attempting migrate directly.");
      const blockM = await getSnapshotBlock(client);
      const migPlan = await planMigrate(client, curve, blockM);
      if (!migPlan.alreadyMigrated) {
        const migrated = await sendTxLocal(client, walletClient, account, migPlan.transaction, "migrate to ARL");
        txLine("migrate tx", migrated.hash, migrated.receipt.gasUsed, migrated.receipt.effectiveGasPrice);
        results.migrateTx = migrated.hash;
        const parsedMig = parseMigratedReceipt(migrated.receipt, curve);
        log(`   canonical pool: ${parsedMig.canonicalPool}`);
        results.pool = parsedMig.canonicalPool;
        results.graduation = "migrated";
      } else {
        results.graduation = "already-migrated";
      }
    }
  }

  // ---- final balances ----
  stepReached = "done";
  const ethEnd = await client.getBalance({ address: me });
  const wethEnd = await erc20Balance(client, WETH, me);
  const museEnd = await erc20Balance(client, token, me);
  log("\nFinal balances (test wallet):");
  log(`  ETH: ${formatEther(ethEnd)} | WETH: ${formatEther(wethEnd)} | MUSE: ${formatUnits(museEnd, 9)}`);
  log(`  Total ETH spent (funding 0.005 -> now): ${formatEther(parseUnits("0.005", 18) - ethEnd)} (includes wrapped WETH still held: ${formatEther(wethEnd)})`);
  log("\nE2E TEST COMPLETE");
}

main()
  .catch((e) => {
    const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
    log(`\nFAILED at step "${stepReached}": ${msg}`);
    results.failedAt = stepReached;
    process.exitCode = 1;
  })
  .finally(() => {
    writeFileSync(MD_PATH, lines.join("\n") + "\n");
    console.log(`\nLog written to ${MD_PATH}`);
  });
