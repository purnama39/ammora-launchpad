/**
 * Ammora launchpad wiring for the browser app.
 *
 * Node-safe (no window/document): the read-only verification script imports
 * this module directly. Wallet signing lives in wallet.ts; every write here
 * takes an already-connected WalletClient and only ever sends through it.
 *
 * All flows follow LAUNCHPAD.md §11 SDK boundaries and mirror the reviewed
 * example CLIs (src/launch/team/*, src/quickstart/*, src/launch/*).
 */
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  zeroAddress,
} from "viem";
import type {
  Address,
  Hex,
  PublicClient,
  TransactionReceipt,
  Transport,
  WalletClient,
} from "viem";
import {
  AMMORA_FEE_POLICY_VERSION,
  AmmoraSwapClient,
  AmmoraV4LaunchCurveClient,
  AmmoraV4MigrationMode,
  DammV2Client,
  ammConcentratedPositionManagerV3Abi,
  ammoraLaunchFactoryV4Abi,
  ammoraLaunchPoolV4Abi,
  assertAmmoraV4Config,
  buildClaimFeeVaultFor,
  buildCreateAmmoraV4Config,
  buildCreateAmmoraV4Launch,
  buildSingleSegmentCurve,
  classifyAmmoraV4ExactInputFill,
  concentratedDepositQuote,
  feeVaultAbi,
  getAmmoraV4ConfigAtBlock,
  giwaSepoliaAutoRoutePoolProfiles,
  parseAmmoraV4ConfigCreatedReceipt,
  parseAmmoraV4LaunchCreatedReceipt,
  parseAmmoraV4MigratedReceipt,
  parseAmmoraV4SwapReceipt,
  planERC20Approvals,
  resolveAmmoraFinalizedHead,
  resolveAmmoraV4ConcentratedMigrationPositionsReceipt,
  verifyAmmoraDeploymentRuntime,
  verifyAmmoraV4CoreAtBlock,
} from "@ammora-protocol/sdk";
import type {
  AmmoraTransaction,
  AmmoraV4Config,
  AmmoraV4ConfigSnapshot,
  AmmoraV4Segment,
  ERC20ApprovalRequirement,
} from "@ammora-protocol/sdk";
import {
  GIWA_CHAIN_ID,
  REGISTRY,
  RPC_URL,
  TEMPLATE_HASH,
  TEMPLATE_ID,
  WETH,
  ammoraClientOptions,
  core,
  deployment,
  giwaChain,
  launch,
  routeDeployment,
} from "./chain";
import { mergeRuntimePins, readRuntimePins } from "./pins";

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/** Serialize public RPC calls, including SDK Promise.all reads. No retries. */
export const pacedHttp = (url: string, intervalMs = 600): Transport => {
  let tail: Promise<unknown> = Promise.resolve();
  let nextStart = 0;
  return (parameters) => {
    const base = http(url, { retryCount: 0 })(parameters);
    return custom(
      {
        request: (args) => {
          const result = tail.then(async () => {
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(0, nextStart - Date.now())),
            );
            try {
              return await base.request(args);
            } finally {
              nextStart = Date.now() + intervalMs;
            }
          });
          tail = result.catch(() => undefined);
          return result;
        },
      },
      { retryCount: 0 },
    )(parameters);
  };
};

let publicClient: PublicClient | null = null;
export function getPublicClient(): PublicClient {
  if (!publicClient) {
    publicClient = createPublicClient({ chain: giwaChain, transport: pacedHttp(RPC_URL) });
  }
  return publicClient;
}

export async function assertChain(client: PublicClient): Promise<void> {
  const actual = await client.getChainId();
  if (actual !== GIWA_CHAIN_ID) {
    throw new Error(`RPC chain ${actual} does not match GIWA Sepolia ${GIWA_CHAIN_ID}`);
  }
}

/** Reviewed snapshot block (head − 12 confirmations on GIWA auto-route). */
export async function getSnapshotBlock(client: PublicClient): Promise<bigint> {
  return resolveAmmoraFinalizedHead([client], routeDeployment.finality);
}

/** Verify deployed contracts against the bundled reviewed runtime pins. */
export async function verifyDeployment(
  client: PublicClient,
  blockNumber: bigint,
): Promise<void> {
  const pins = mergeRuntimePins(readRuntimePins());
  await verifyAmmoraDeploymentRuntime(client, deployment, blockNumber, pins);
  await verifyAmmoraV4CoreAtBlock(client, core, blockNumber);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type TeamRecipientPolicy = {
  schemaVersion: 1;
  chainId: number;
  registry: Address;
  templateId: string;
  templateHash: Hex;
  configOwner: Address;
  partnerRecipient: Address;
  liquidityPartner: Address;
  leftoverReceiver: Address;
};

export function makeTeamPolicy(roles: {
  configOwner: string;
  partnerRecipient: string;
  liquidityPartner: string;
  leftoverReceiver: string;
}): TeamRecipientPolicy {
  const recipient = (field: string, value: string): Address => {
    if (!isAddress(value, { strict: true }) || value.toLowerCase() === zeroAddress) {
      throw new Error(`${field} must be a nonzero address with a valid checksum (or all lowercase)`);
    }
    return getAddress(value);
  };
  return {
    schemaVersion: 1,
    chainId: GIWA_CHAIN_ID,
    registry: REGISTRY,
    templateId: String(TEMPLATE_ID),
    templateHash: TEMPLATE_HASH,
    configOwner: recipient("configOwner", roles.configOwner),
    partnerRecipient: recipient("partnerRecipient", roles.partnerRecipient),
    liquidityPartner: recipient("liquidityPartner", roles.liquidityPartner),
    leftoverReceiver: recipient("leftoverReceiver", roles.leftoverReceiver),
  };
}

export async function getTemplate(
  client: PublicClient,
  blockNumber: bigint,
): Promise<AmmoraV4ConfigSnapshot> {
  return getAmmoraV4ConfigAtBlock(client, REGISTRY, TEMPLATE_ID, blockNumber);
}

export async function getConfig(
  client: PublicClient,
  configId: bigint,
  blockNumber: bigint,
): Promise<AmmoraV4ConfigSnapshot> {
  return getAmmoraV4ConfigAtBlock(client, REGISTRY, configId, blockNumber);
}

/** Derive a complete registry-valid Config from template #6 (port of config-from-template.ts). */
export const deriveConfigFromTemplate = (
  template: Pick<AmmoraV4ConfigSnapshot, "config">,
  saleSupply: bigint,
  migrationQuoteThreshold: bigint,
): {
  config: AmmoraV4Config;
  curve: readonly AmmoraV4Segment[];
  economics: {
    saleAllocationRaw: bigint;
    grossMigrationBaseRaw: bigint;
    grossMigrationQuoteRaw: bigint;
    migrationQuoteFeeRaw: bigint;
    quoteSurplusToProtocolRaw: bigint;
    lockedBaseRaw: bigint;
    totalSupplyRaw: bigint;
  };
} => {
  if (saleSupply <= 0n || migrationQuoteThreshold <= 0n) {
    throw new RangeError("sale supply and quote threshold must be positive");
  }
  if (template.config.migrationMode !== AmmoraV4MigrationMode.Concentrated) {
    throw new RangeError(
      "this beginner template helper currently supports concentrated graduation only",
    );
  }
  const curve = buildSingleSegmentCurve(
    template.config.startSqrtPrice,
    saleSupply,
    migrationQuoteThreshold,
  );
  const segment = curve[0];
  if (!segment) throw new Error("single-segment curve construction returned no segment");
  const range = {
    sqrtPriceX64: segment.upperSqrtPrice,
    sqrtMinPriceX64: segment.lowerSqrtPrice,
    sqrtMaxPriceX64: segment.upperSqrtPrice * 2n,
  };
  const quoteFee =
    (migrationQuoteThreshold * BigInt(template.config.migrationQuoteFeeBps)) / 10_000n;
  const quoteAfterFee = migrationQuoteThreshold - quoteFee;
  const destination = concentratedDepositQuote(range, { quoteAmount: quoteAfterFee });
  const vesting = template.config.lockedBaseVesting;
  const lockedBase =
    vesting.cliffUnlockAmount + vesting.amountPerPeriod * BigInt(vesting.numberOfPeriods);
  const config: AmmoraV4Config = {
    ...template.config,
    totalSupply: saleSupply + destination.baseAmount + lockedBase,
    migrationQuoteThreshold,
    migrationBaseThreshold: destination.baseAmount,
    postMigrationSqrtMinPrice: range.sqrtMinPriceX64,
    postMigrationSqrtMaxPrice: range.sqrtMaxPriceX64,
    postMigrationLiquidity: destination.liquidity,
  };
  assertAmmoraV4Config(config, curve);
  return {
    config,
    curve,
    economics: {
      saleAllocationRaw: saleSupply,
      grossMigrationBaseRaw: destination.baseAmount,
      grossMigrationQuoteRaw: destination.quoteAmount,
      migrationQuoteFeeRaw: quoteFee,
      quoteSurplusToProtocolRaw: quoteAfterFee - destination.quoteAmount,
      lockedBaseRaw: lockedBase,
      totalSupplyRaw: config.totalSupply,
    },
  };
};

/** Plan a team Config from template #6 (port of src/launch/team/policy.ts). */
export function planTeamConfig(
  template: AmmoraV4ConfigSnapshot,
  policy: TeamRecipientPolicy,
  saleSupply: bigint,
  quoteThreshold: bigint,
) {
  if (template.configId !== BigInt(policy.templateId) || template.configHash.toLowerCase() !== policy.templateHash.toLowerCase()) {
    throw new Error("template identity/hash does not match the reviewed recipient policy");
  }
  if (!template.enabled) throw new Error("template Config is disabled");
  const derived = deriveConfigFromTemplate(template, saleSupply, quoteThreshold);
  const config = {
    ...derived.config,
    partnerRecipient: policy.partnerRecipient,
    leftoverReceiver: policy.leftoverReceiver,
    liquidityDistribution: {
      ...derived.config.liquidityDistribution,
      partner: policy.liquidityPartner,
    },
  };
  assertAmmoraV4Config(config, derived.curve);
  const transaction = {
    to: policy.registry,
    ...buildCreateAmmoraV4Config(config, derived.curve, policy.configOwner),
  };
  const reviewHash = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }],
      [BigInt(policy.chainId), transaction.to, 0n, transaction.data],
    ),
  );
  return {
    ...derived,
    config,
    transaction,
    reviewHash,
    recipients: {
      configOwner: policy.configOwner,
      partnerRecipient: { inherited: template.config.partnerRecipient, selected: config.partnerRecipient },
      liquidityPartner: {
        inherited: template.config.liquidityDistribution.partner,
        selected: config.liquidityDistribution.partner,
      },
      leftoverReceiver: { inherited: template.config.leftoverReceiver, selected: config.leftoverReceiver },
    },
  };
}

export function parseConfigReceipt(receipt: TransactionReceipt) {
  return parseAmmoraV4ConfigCreatedReceipt(receipt, REGISTRY);
}

// ---------------------------------------------------------------------------
// Token launch
// ---------------------------------------------------------------------------

export function buildLaunchTx(
  configId: bigint,
  config: { poolCreationFee: bigint; tokenDecimals: number },
  name: string,
  symbol: string,
  metadataURI: string,
): AmmoraTransaction {
  const tx = buildCreateAmmoraV4Launch(
    { name, symbol, metadataURI, creatorMetadataURI: metadataURI, tokenDecimals: config.tokenDecimals },
    configId,
    config.poolCreationFee,
  );
  return { to: core.launchFactory, data: tx.data, value: tx.value };
}

export function parseLaunchReceipt(receipt: TransactionReceipt) {
  return parseAmmoraV4LaunchCreatedReceipt(receipt, core.launchFactory);
}

// ---------------------------------------------------------------------------
// Curve reads / quotes / plans
// ---------------------------------------------------------------------------

export const CURVE_STATUS_LABELS = [
  "Uninitialized",
  "Active",
  "ReadyToMigrate",
  "Migrated",
] as const;

export function curveClient(client: PublicClient, curve: Address) {
  return new AmmoraV4LaunchCurveClient(client, curve, {
    launchFactory: core.launchFactory,
    feePolicy: core.feePolicy,
  });
}

/** Curve state, authenticated against the reviewed factory + fee policy. */
export async function getCurveState(
  client: PublicClient,
  curve: Address,
  blockNumber: bigint,
) {
  await verifyAmmoraV4CoreAtBlock(client, core, blockNumber);
  const code = await client.getCode({ address: curve, blockNumber });
  if (!code || code === "0x") {
    throw new Error(`No curve at snapshot block ${blockNumber}; wait for the confirmation window`);
  }
  const sdk = curveClient(client, curve);
  const state = await sdk.getStateAtBlock(blockNumber);
  const factoryToken = await client.readContract({
    address: core.launchFactory,
    abi: ammoraLaunchFactoryV4Abi,
    functionName: "tokenForCurve",
    args: [curve],
    blockNumber,
  });
  if (
    factoryToken === zeroAddress ||
    factoryToken.toLowerCase() !== state.baseToken.toLowerCase() ||
    state.feePolicy.toLowerCase() !== core.feePolicy.toLowerCase() ||
    state.feePolicyVersion !== AMMORA_FEE_POLICY_VERSION
  ) {
    throw new Error("curve is not bound to the reviewed V4 factory and fee policy");
  }
  return state;
}

/** Read-model quote (port of src/launch/curve-quote.ts). */
export async function quoteCurve(
  client: PublicClient,
  curve: Address,
  amountIn: bigint,
  baseForQuote: boolean,
  blockNumber: bigint,
) {
  const sdk = curveClient(client, curve);
  const state = await sdk.getStateAtBlock(blockNumber);
  if (state.asOfBlock !== blockNumber) throw new Error("curve state is from a different block");
  if (state.status !== 1) return { state, quote: null, fill: null };
  const quote = await sdk.quoteExactInputAtBlock(amountIn, baseForQuote, blockNumber);
  if (quote.asOfBlock !== blockNumber) throw new Error("curve quote is from a different block");
  return { state, quote, fill: classifyAmmoraV4ExactInputFill(quote, baseForQuote) };
}

export type CurveSwapParams = {
  blockNumber: bigint;
  tokenIn: Address;
  amountIn: bigint;
  recipient: Address;
  deadline: bigint;
  slippageBps: number;
  graduationBoundary?: boolean;
};

/** Explicit-block V4 swap plan (port of src/launch/curve-plan.ts). */
export async function planCurveSwap(
  client: PublicClient,
  curve: Address,
  parameters: CurveSwapParams,
) {
  if (
    parameters.amountIn <= 0n ||
    !Number.isSafeInteger(parameters.slippageBps) ||
    parameters.slippageBps < 0 ||
    parameters.slippageBps > 1000
  ) {
    throw new Error("positive input and slippage from 0 to 1000 bps required");
  }
  const blockNumber = parameters.blockNumber;
  await verifyAmmoraV4CoreAtBlock(client, core, blockNumber);
  const sdk = curveClient(client, curve);
  const state = await sdk.getStateAtBlock(blockNumber);
  const factoryToken = await client.readContract({
    address: core.launchFactory,
    abi: ammoraLaunchFactoryV4Abi,
    functionName: "tokenForCurve",
    args: [curve],
    blockNumber,
  });
  if (
    factoryToken === zeroAddress ||
    factoryToken.toLowerCase() !== state.baseToken.toLowerCase() ||
    state.feePolicy.toLowerCase() !== core.feePolicy.toLowerCase() ||
    state.feePolicyVersion !== AMMORA_FEE_POLICY_VERSION
  ) {
    throw new Error("curve is not bound to the reviewed V4 factory and fee policy");
  }
  if (state.status !== 1) throw new Error(`Curve status ${state.status} is not active`);
  const baseForQuote = parameters.tokenIn.toLowerCase() === state.baseToken.toLowerCase();
  if (!baseForQuote && parameters.tokenIn.toLowerCase() !== state.quoteToken.toLowerCase()) {
    throw new Error("tokenIn is not a curve asset");
  }
  const quote = await sdk.quoteExactInputAtBlock(parameters.amountIn, baseForQuote, blockNumber);
  const fill = classifyAmmoraV4ExactInputFill(quote, baseForQuote);
  const boundary = parameters.graduationBoundary === true;
  if (boundary ? fill.kind !== "graduation-boundary" : fill.kind !== "full") {
    throw new Error(
      `Unexpected ${fill.kind}; ordinary orders must fill in full and graduation buys must reach the boundary`,
    );
  }
  const minimumAmountOut = (quote.amountOut * BigInt(10_000 - parameters.slippageBps)) / 10_000n;
  if (minimumAmountOut === 0n) throw new Error("minimum output rounds to zero");
  return {
    state,
    quote: { ...quote, minimumAmountOut },
    fill,
    baseForQuote,
    tokenOut: baseForQuote ? state.quoteToken : state.baseToken,
    transaction: {
      to: curve,
      data: encodeFunctionData({
        abi: ammoraLaunchPoolV4Abi,
        functionName: "swapExactInput",
        args: [
          parameters.amountIn,
          minimumAmountOut,
          baseForQuote,
          boundary,
          parameters.recipient,
          parameters.deadline,
        ],
      }),
    },
    approvalRequirements: [
      { token: parameters.tokenIn, spender: curve, amount: parameters.amountIn },
    ] as readonly ERC20ApprovalRequirement[],
  };
}

// ---------------------------------------------------------------------------
// Graduation / migration
// ---------------------------------------------------------------------------

export async function getMigrationProgress(
  client: PublicClient,
  curve: Address,
  blockNumber: bigint,
) {
  return curveClient(client, curve).getMigrationProgressAtBlock(blockNumber);
}

export async function planMigrate(
  client: PublicClient,
  curve: Address,
  blockNumber: bigint,
) {
  const sdk = curveClient(client, curve);
  const state = await sdk.getStateAtBlock(blockNumber);
  if (state.status === 3) {
    return { alreadyMigrated: true as const, canonicalPool: state.canonicalPool };
  }
  if (state.status !== 2) {
    throw new Error(`Migration requires ReadyToMigrate (2), observed ${state.status}`);
  }
  const plan = await sdk.planMigrateAtBlock(blockNumber);
  return { alreadyMigrated: false as const, transaction: plan.transaction, asOfBlock: plan.asOfBlock };
}

export function parseMigratedReceipt(receipt: TransactionReceipt, curve: Address) {
  return parseAmmoraV4MigratedReceipt(receipt, curve);
}

export function parseSwapReceipt(
  receipt: TransactionReceipt,
  curve: Address,
  params: {
    trader: Address;
    recipient: Address;
    baseForQuote: boolean;
    requestedAmountIn: bigint;
    minimumAmountOut: bigint;
  },
) {
  return parseAmmoraV4SwapReceipt(receipt, curve, params);
}

export function resolveMigrationPositions(
  receipt: TransactionReceipt,
  curve: Address,
  canonicalPool: Address,
  creator: Address,
  partner: Address,
) {
  return resolveAmmoraV4ConcentratedMigrationPositionsReceipt({
    chainId: GIWA_CHAIN_ID,
    receipt,
    expectedTransactionHash: receipt.transactionHash,
    curve,
    positionManager: launch.concentratedPositionManager,
    canonicalPool,
    creator,
    partner,
  });
}

// ---------------------------------------------------------------------------
// Post-graduation: ARL pool swaps, fee claims, LP claims
// ---------------------------------------------------------------------------

export async function prepareConcentratedSwap(
  client: PublicClient,
  pool: Address,
  tokenIn: Address,
  amountIn: bigint,
  payer: Address,
  slippageBps: number,
) {
  const quoteBlockNumber = await resolveAmmoraFinalizedHead([client], routeDeployment.finality);
  const swaps = await AmmoraSwapClient.create(client, {
    deploymentCatalog: { [GIWA_CHAIN_ID]: deployment },
    factoryProfiles: giwaSepoliaAutoRoutePoolProfiles,
  });
  return swaps.prepareExactIn({
    model: "concentrated",
    pool,
    tokenIn,
    inputAsset: "erc20",
    amountIn,
    payer,
    recipient: payer,
    slippageBps,
    executionMode: "direct-wallet",
    quoteBlockNumber,
  });
}

export function dammClient(client: PublicClient, pool: Address) {
  return new DammV2Client(
    client,
    pool,
    "concentrated",
    launch.concentratedFactory,
    launch.concentratedPositionManager,
    ammoraClientOptions(),
  );
}

export async function getPoolState(client: PublicClient, pool: Address) {
  return dammClient(client, pool).getPoolState();
}

export async function getFeeVault(client: PublicClient, blockNumber: bigint): Promise<Address> {
  return client.readContract({
    abi: ammoraLaunchFactoryV4Abi,
    address: core.launchFactory,
    functionName: "feeVault",
    blockNumber,
  }) as Promise<Address>;
}

export async function claimableFee(
  client: PublicClient,
  feeVault: Address,
  token: Address,
  beneficiary: Address,
  blockNumber: bigint,
): Promise<bigint> {
  return client.readContract({
    abi: feeVaultAbi,
    address: feeVault,
    functionName: "claimable",
    args: [token, beneficiary],
    blockNumber,
  }) as Promise<bigint>;
}

/** Own-entitlement FeeVault claim (payout never selects another beneficiary). */
export function planFeeClaim(
  feeVault: Address,
  token: Address,
  beneficiary: Address,
  payout: Address,
): AmmoraTransaction {
  const tx = buildClaimFeeVaultFor(token, beneficiary, payout);
  return { to: feeVault, data: tx.data };
}

export async function planLpFeeClaim(
  client: PublicClient,
  pool: Address,
  tokenId: bigint,
  recipient: Address,
  caller: Address,
): Promise<AmmoraTransaction> {
  const sdk = dammClient(client, pool);
  return sdk.planClaimManagedConcentratedFees(tokenId, recipient, caller);
}

/** Simulate what an LP fee claim would pay (no transaction). */
export async function simulateLpFeeClaim(
  client: PublicClient,
  tokenId: bigint,
  recipient: Address,
  caller: Address,
): Promise<{ claimableBase: bigint; claimableQuote: bigint }> {
  const { result } = await client.simulateContract({
    abi: ammConcentratedPositionManagerV3Abi,
    account: caller,
    address: launch.concentratedPositionManager,
    functionName: "claimPositionFees",
    args: [tokenId, recipient],
  });
  const [claimableBase, claimableQuote] = result as readonly [bigint, bigint];
  return { claimableBase, claimableQuote };
}

// ---------------------------------------------------------------------------
// Tokens / balances / WETH
// ---------------------------------------------------------------------------

export async function tokenInfo(client: PublicClient, token: Address) {
  const [decimals, symbol, name] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    client
      .readContract({ address: token, abi: erc20Abi, functionName: "name" })
      .catch(() => ""),
  ]);
  return { decimals, symbol, name };
}

export async function erc20Balance(
  client: PublicClient,
  token: Address,
  owner: Address,
  blockNumber?: bigint,
): Promise<bigint> {
  if (blockNumber !== undefined) {
    return client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
      blockNumber,
    });
  }
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

const wethDepositAbi = parseAbi(["function deposit() payable"]);

/** Wrap native ETH into WETH (reviewed WETH deposit()). */
export function wrapWethTx(amount: bigint): AmmoraTransaction {
  return {
    to: WETH,
    data: encodeFunctionData({ abi: wethDepositAbi, functionName: "deposit" }),
    value: amount,
  };
}

// ---------------------------------------------------------------------------
// Sending (via the connected wallet only — never a private key)
// ---------------------------------------------------------------------------

export async function sendTx(
  client: PublicClient,
  wallet: WalletClient,
  account: Address,
  tx: AmmoraTransaction,
  label: string,
): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  const [latestNonce, pendingNonce] = await Promise.all([
    client.getTransactionCount({ address: account, blockTag: "latest" }),
    client.getTransactionCount({ address: account, blockTag: "pending" }),
  ]);
  if (latestNonce !== pendingNonce) {
    throw new Error(`Pending transaction at nonce ${latestNonce}; reconcile before sending ${label}`);
  }
  // Simulate the exact request before a signature; sending itself is never retried.
  await client.call({
    account,
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
  const receipt = await client.waitForTransactionReceipt({
    hash,
    retryCount: 0,
    timeout: 120_000,
    pollingInterval: 6000,
    // head-12 must include the receipt before dependent exact-block reads.
    confirmations: 13,
  });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (canonical.hash !== receipt.blockHash) {
    throw new Error(`Noncanonical receipt for ${hash}; reconcile before continuing`);
  }
  return { hash, receipt };
}

/** Grants exactly what a plan asked for, and nothing beyond it. */
export async function approveRequirements(
  client: PublicClient,
  wallet: WalletClient,
  account: Address,
  requirements: readonly ERC20ApprovalRequirement[],
): Promise<Hex[]> {
  const plans = await planERC20Approvals(client, account, requirements);
  const hashes: Hex[] = [];
  for (const plan of plans) {
    if (plan.transactions.length === 0) continue;
    let approvalHash: Hex | undefined;
    for (const transaction of plan.transactions) {
      const sent = await sendTx(
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
      args: [account, plan.requirement.spender],
      blockNumber: receipt.blockNumber,
    });
    if (allowance < plan.requirement.amount) {
      throw new Error("approval confirmed, but its allowance is below the requested amount");
    }
  }
  return hashes;
}
