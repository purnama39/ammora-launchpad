import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, isAddress, parseUnits } from "viem";
import type { Address } from "viem";
import {
  AMMORA_URL,
  DOCS_URL,
  GIWA_CHAIN_ID,
  WETH,
  explorerAddress,
  explorerTx,
} from "./lib/chain";
import {
  CURVE_STATUS_LABELS,
  approveRequirements,
  assertChain,
  buildLaunchTx,
  claimableFee,
  dammClient,
  erc20Balance,
  getConfig,
  getCurveState,
  getFeeVault,
  getMigrationProgress,
  getPoolState,
  getPublicClient,
  getSnapshotBlock,
  getTemplate,
  makeTeamPolicy,
  parseConfigReceipt,
  parseLaunchReceipt,
  parseMigratedReceipt,
  parseSwapReceipt,
  planCurveSwap,
  planFeeClaim,
  planLpFeeClaim,
  planMigrate,
  planTeamConfig,
  prepareConcentratedSwap,
  quoteCurve,
  resolveMigrationPositions,
  sendTx,
  simulateLpFeeClaim,
  tokenInfo,
  verifyDeployment,
  wrapWethTx,
} from "./lib/ammora";
import {
  connectWallet,
  getWalletClient,
  hasInjectedWallet,
  switchToGiwa,
} from "./lib/wallet";
import { clearState, emptyState, loadState, saveState } from "./lib/store";
import type { LaunchState } from "./lib/store";

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const errMsg = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 400 ? `${m.slice(0, 400)}…` : m;
};
const isValidAmount = (s: string, maxDecimals: number) =>
  /^\d+(\.\d+)?$/.test(s) && (s.split(".")[1]?.length ?? 0) <= maxDecimals;

function Section(props: {
  n: string;
  title: string;
  desc: string;
  locked?: string | null;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <h2>
        <span className="step">{props.n}</span> {props.title}
      </h2>
      <p className="desc">{props.desc}</p>
      {props.locked ? <p className="locked">{props.locked}</p> : props.children}
    </section>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        className={props.mono ? "mono" : undefined}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
    </label>
  );
}

function Btn(props: {
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className="btn"
      disabled={props.disabled || props.busy}
      onClick={props.onClick}
    >
      {props.busy ? "Working…" : props.children}
    </button>
  );
}

function Err(props: { msg: string | null }) {
  return props.msg ? <p className="error">{props.msg}</p> : null;
}

function Tx(props: { hash: string; label?: string }) {
  return (
    <p className="tx">
      {props.label ?? "Tx"}{" "}
      <a href={explorerTx(props.hash)} target="_blank" rel="noreferrer">
        {shortAddr(props.hash)}
      </a>
    </p>
  );
}

function Addr(props: { address: string; label?: string }) {
  return (
    <p className="tx">
      {props.label ?? "Address"}{" "}
      <a href={explorerAddress(props.address)} target="_blank" rel="noreferrer">
        {shortAddr(props.address)}
      </a>
    </p>
  );
}

export default function App() {
  const [wallet, setWallet] = useState<{ address: Address; chainId: number } | null>(null);
  const [verified, setVerified] = useState<string | null>(null);
  const [state, setState] = useState<LaunchState>(() => loadState());
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  // Balances
  const [ethBal, setEthBal] = useState<string>("—");
  const [wethBal, setWethBal] = useState<string>("—");
  const [tokenBal, setTokenBal] = useState<string>("—");

  // Config form
  const [saleSupply, setSaleSupply] = useState("1000000");
  const [threshold, setThreshold] = useState("0.001");
  const [roles, setRoles] = useState({ owner: "", partner: "", lp: "", leftover: "" });
  const [configPreview, setConfigPreview] = useState<{
    reviewHash: string;
    totalSupply: string;
    saleAllocation: string;
    grossMigrationBase: string;
    grossMigrationQuote: string;
    migrationQuoteFee: string;
    lockedBase: string;
  } | null>(null);
  const [existingConfigId, setExistingConfigId] = useState("");

  // Launch form
  const [tokenName, setTokenName] = useState("Ammora Test Token");
  const [tokenSymbol, setTokenSymbol] = useState("AMT");
  const [metadataURI, setMetadataURI] = useState("https://example.com/ammora-launchpad-token.json");
  const [existingCurve, setExistingCurve] = useState("");

  // Trade
  const [curveState, setCurveState] = useState<{
    status: number;
    baseToken: string;
    quoteToken: string;
    canonicalPool: string;
    block: string;
  } | null>(null);
  const [tradeDir, setTradeDir] = useState<"buy" | "sell">("buy");
  const [tradeAmount, setTradeAmount] = useState("0.0001");
  const [quoteResult, setQuoteResult] = useState<{
    expectedOut: string;
    minOut: string;
    fee: string;
    fill: string;
    outSymbol: string;
  } | null>(null);
  const [tradeResult, setTradeResult] = useState<{
    hash: string;
    received: string;
    consumed: string;
  } | null>(null);
  const [wrapAmount, setWrapAmount] = useState("0.001");

  // Graduation
  const [progress, setProgress] = useState<{
    current: string;
    target: string;
    progressBps: number;
    ready: boolean;
    migrated: boolean;
  } | null>(null);
  const [fillQuote, setFillQuote] = useState<{
    maxInput: string;
    expectedOut: string;
    consumed: string;
    refund: string;
    fee: string;
    fillKind: string;
  } | null>(null);
  const [fillResult, setFillResult] = useState<{
    hash: string;
    consumed: string;
    unused: string;
  } | null>(null);

  // Post-graduation
  const [poolState, setPoolState] = useState<{
    baseToken: string;
    quoteToken: string;
    reserveBase: string;
    reserveQuote: string;
    totalLiquidity: string;
  } | null>(null);
  const [poolDir, setPoolDir] = useState<"buy" | "sell">("buy");
  const [poolAmount, setPoolAmount] = useState("0.0001");
  const [poolQuote, setPoolQuote] = useState<{
    expectedOut: string;
    minOut: string;
    outSymbol: string;
  } | null>(null);
  const [poolTradeResult, setPoolTradeResult] = useState<{ hash: string; received: string } | null>(null);
  const [feeVault, setFeeVault] = useState<string | null>(null);
  const [claimable, setClaimable] = useState<{ quote: string; token: string } | null>(null);
  const [lpTokenId, setLpTokenId] = useState("");
  const [lpClaimable, setLpClaimable] = useState<{ base: string; quote: string } | null>(null);

  useEffect(() => saveState(state), [state]);

  const setErr = useCallback((section: string, msg: string | null) => {
    setErrors((prev) => ({ ...prev, [section]: msg }));
  }, []);

  const run = useCallback(
    async (section: string, fn: () => Promise<void>) => {
      setBusy(section);
      setErr(section, null);
      try {
        await fn();
      } catch (e) {
        setErr(section, errMsg(e));
      } finally {
        setBusy(null);
      }
    },
    [setErr],
  );

  const requireWallet = useCallback((): { address: Address } => {
    if (!wallet) throw new Error("Connect your wallet first.");
    if (wallet.chainId !== GIWA_CHAIN_ID) {
      throw new Error("Wrong network — switch MetaMask to GIWA Sepolia (chain 91342).");
    }
    return { address: wallet.address };
  }, [wallet]);

  // Verify the deployment once on load (read-only, no wallet needed).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const client = getPublicClient();
        await assertChain(client);
        const block = await getSnapshotBlock(client);
        await verifyDeployment(client, block);
        if (!cancelled) setVerified(block.toString());
      } catch (e) {
        if (!cancelled) setErr("verify", errMsg(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setErr]);

  // Default the four Config roles to the connected wallet.
  useEffect(() => {
    if (wallet) {
      setRoles((prev) => ({
        owner: prev.owner || wallet.address,
        partner: prev.partner || wallet.address,
        lp: prev.lp || wallet.address,
        leftover: prev.leftover || wallet.address,
      }));
    }
  }, [wallet]);

  const refreshBalances = useCallback(async () => {
    if (!wallet) return;
    const client = getPublicClient();
    const [eth, weth] = await Promise.all([
      client.getBalance({ address: wallet.address }),
      erc20Balance(client, WETH, wallet.address),
    ]);
    setEthBal(formatUnits(eth, 18));
    setWethBal(formatUnits(weth, 18));
    if (state.token) {
      const bal = await erc20Balance(client, state.token as Address, wallet.address);
      setTokenBal(formatUnits(bal, 9));
    }
  }, [wallet, state.token]);

  const onConnect = () =>
    run("wallet", async () => {
      const connected = await connectWallet();
      setWallet(connected);
      if (connected.chainId !== GIWA_CHAIN_ID) {
        setErr("wallet", "Connected, but on the wrong network — tap “Switch to GIWA Sepolia”.");
      }
    });

  const onSwitchChain = () =>
    run("wallet", async () => {
      await switchToGiwa();
      const connected = await connectWallet();
      setWallet(connected);
    });

  const onRefreshBalances = () =>
    run("wallet", async () => {
      await refreshBalances();
    });

  const onPreviewConfig = () =>
    run("config", async () => {
      if (!isValidAmount(saleSupply, 9)) throw new Error("Sale supply must be a number with at most 9 decimals.");
      if (!isValidAmount(threshold, 18)) throw new Error("Threshold must be a number with at most 18 decimals.");
      const policy = makeTeamPolicy({
        configOwner: roles.owner,
        partnerRecipient: roles.partner,
        liquidityPartner: roles.lp,
        leftoverReceiver: roles.leftover,
      });
      const client = getPublicClient();
      const block = await getSnapshotBlock(client);
      const template = await getTemplate(client, block);
      const plan = planTeamConfig(
        template,
        policy,
        parseUnits(saleSupply, 9),
        parseUnits(threshold, 18),
      );
      setConfigPreview({
        reviewHash: plan.reviewHash,
        totalSupply: formatUnits(plan.economics.totalSupplyRaw, 9),
        saleAllocation: formatUnits(plan.economics.saleAllocationRaw, 9),
        grossMigrationBase: formatUnits(plan.economics.grossMigrationBaseRaw, 9),
        grossMigrationQuote: formatUnits(plan.economics.grossMigrationQuoteRaw, 18),
        migrationQuoteFee: formatUnits(plan.economics.migrationQuoteFeeRaw, 18),
        lockedBase: formatUnits(plan.economics.lockedBaseRaw, 9),
      });
    });

  const onCreateConfig = () =>
    run("config", async () => {
      const { address } = requireWallet();
      if (!configPreview) throw new Error("Preview the Config first.");
      if (address.toLowerCase() !== roles.owner.toLowerCase()) {
        throw new Error("The connected wallet must be the Config owner address.");
      }
      const policy = makeTeamPolicy({
        configOwner: roles.owner,
        partnerRecipient: roles.partner,
        liquidityPartner: roles.lp,
        leftoverReceiver: roles.leftover,
      });
      const client = getPublicClient();
      const block = await getSnapshotBlock(client);
      const template = await getTemplate(client, block);
      const plan = planTeamConfig(
        template,
        policy,
        parseUnits(saleSupply, 9),
        parseUnits(threshold, 18),
      );
      if (plan.reviewHash.toLowerCase() !== configPreview.reviewHash.toLowerCase()) {
        throw new Error("Review hash changed — preview again before creating.");
      }
      const walletClient = getWalletClient(address);
      const { hash, receipt } = await sendTx(client, walletClient, address, plan.transaction, "create Config");
      const created = parseConfigReceipt(receipt);
      const confirmed = await getConfig(client, created.configId, receipt.blockNumber);
      if (confirmed.configHash.toLowerCase() !== created.configHash.toLowerCase()) {
        throw new Error("Receipt Config hash does not match the confirmed Config.");
      }
      setState((s) => ({
        ...s,
        configId: created.configId.toString(),
        configHash: created.configHash,
        configTx: hash,
        configOwner: roles.owner,
        partnerRecipient: roles.partner,
      }));
    });

  const onLoadExistingConfig = () =>
    run("config", async () => {
      if (!/^\d+$/.test(existingConfigId)) throw new Error("Config ID must be a number.");
      const client = getPublicClient();
      const block = await getSnapshotBlock(client);
      const config = await getConfig(client, BigInt(existingConfigId), block);
      if (!config.enabled) throw new Error(`Config #${existingConfigId} is disabled.`);
      setState((s) => ({
        ...s,
        configId: existingConfigId,
        configHash: config.configHash,
        configTx: null,
        configOwner: config.identity.owner,
        partnerRecipient: config.config.partnerRecipient,
      }));
    });

  const onCreateLaunch = () =>
    run("launch", async () => {
      const { address } = requireWallet();
      if (!state.configId) throw new Error("Create or load a Config first.");
      if (!tokenName.trim() || !tokenSymbol.trim() || !metadataURI.trim()) {
        throw new Error("Name, symbol and metadata URI are all required.");
      }
      const client = getPublicClient();
      const block = await getSnapshotBlock(client);
      const config = await getConfig(client, BigInt(state.configId), block);
      if (!config.enabled) throw new Error(`Config #${state.configId} is disabled.`);
      const tx = buildLaunchTx(
        BigInt(state.configId),
        config.config,
        tokenName.trim(),
        tokenSymbol.trim().toUpperCase(),
        metadataURI.trim(),
      );
      const balance = await client.getBalance({ address, blockNumber: block });
      if (balance < (tx.value ?? 0n)) {
        throw new Error("Insufficient ETH for the pool creation fee.");
      }
      const walletClient = getWalletClient(address);
      const { hash, receipt } = await sendTx(client, walletClient, address, tx, "create launch");
      const created = parseLaunchReceipt(receipt);
      const [tokenCode, curveCode] = await Promise.all([
        client.getCode({ address: created.token, blockNumber: receipt.blockNumber }),
        client.getCode({ address: created.curve, blockNumber: receipt.blockNumber }),
      ]);
      if (!tokenCode || tokenCode === "0x" || !curveCode || curveCode === "0x") {
        throw new Error("Token/curve code missing at the receipt block.");
      }
      setState((s) => ({
        ...s,
        token: created.token,
        tokenSymbol: tokenSymbol.trim().toUpperCase(),
        curve: created.curve,
        launchTx: hash,
        creator: created.creator,
      }));
    });

  const onLoadExistingCurve = () =>
    run("launch", async () => {
      if (!isAddress(existingCurve)) throw new Error("Enter a valid curve address.");
      setState((s) => ({ ...s, curve: existingCurve }));
      setCurveState(null);
    });

  const onRefreshCurve = () =>
    run("trade", async () => {
      if (!state.curve) throw new Error("No curve yet — launch a token first.");
      const client = getPublicClient();
      const block = await getSnapshotBlock(client);
      const curve = state.curve as Address;
      const st = await getCurveState(client, curve, block);
      setCurveState({
        status: st.status,
        baseToken: st.baseToken,
        quoteToken: st.quoteToken,
        canonicalPool: st.canonicalPool,
        block: block.toString(),
      });
      if (wallet) await refreshBalances();
    });

  const onQuoteTrade = () =>
    run("trade", async () => {
      if (!state.curve || !state.token) throw new Error("No curve yet.");
      if (!isValidAmount(tradeAmount, 18)) throw new Error("Amount must be a number.");
      const client = getPublicClient();
      const block = await getSnapshotBlock(client);
      const curve = state.curve as Address;
      const baseForQuote = tradeDir === "sell";
      const tokenIn = baseForQuote ? (state.token as Address) : WETH;
      const info = await tokenInfo(client, tokenIn);
      const amountIn = parseUnits(tradeAmount, info.decimals);
      const res = await quoteCurve(client, curve, amountIn, baseForQuote, block);
      if (!res.quote || !res.fill) {
        setQuoteResult(null);
        throw new Error(
          res.state.status === 1
            ? "No quote returned."
            : `Curve is ${CURVE_STATUS_LABELS[res.state.status]} — trading is only available while Active.`,
        );
      }
      const outToken = baseForQuote ? WETH : (state.token as Address);
      const outInfo = await tokenInfo(client, outToken);
      setQuoteResult({
        expectedOut: formatUnits(res.quote.amountOut, outInfo.decimals),
        minOut: formatUnits((res.quote.amountOut * 9950n) / 10_000n, outInfo.decimals),
        fee: formatUnits(res.quote.fee, info.decimals),
        fill: res.fill.kind,
        outSymbol: outInfo.symbol,
      });
    });

  const onTrade = () =>
    run("trade", async () => {
      const { address } = requireWallet();
      if (!state.curve || !state.token) throw new Error("No curve yet.");
      if (!isValidAmount(tradeAmount, 18)) throw new Error("Amount must be a number.");
      const client = getPublicClient();
      const block = await getSnapshotBlock(client);
      const blockInfo = await client.getBlock({ blockNumber: block });
      const curve = state.curve as Address;
      const baseForQuote = tradeDir === "sell";
      const tokenIn = baseForQuote ? (state.token as Address) : WETH;
      const tokenOut = baseForQuote ? WETH : (state.token as Address);
      const info = await tokenInfo(client, tokenIn);
      const outInfo = await tokenInfo(client, tokenOut);
      const amountIn = parseUnits(tradeAmount, info.decimals);
      const balIn = await erc20Balance(client, tokenIn, address, block);
      if (balIn < amountIn) {
        throw new Error(
          `Insufficient ${info.symbol} balance (${formatUnits(balIn, info.decimals)}). Wrap ETH first for buys.`,
        );
      }
      const plan = await planCurveSwap(client, curve, {
        blockNumber: block,
        tokenIn,
        amountIn,
        recipient: address,
        deadline: blockInfo.timestamp + 20n * 60n,
        slippageBps: 50,
      });
      const walletClient = getWalletClient(address);
      await approveRequirements(client, walletClient, address, plan.approvalRequirements);
      const before = await erc20Balance(client, plan.tokenOut, address, block);
      const { hash, receipt } = await sendTx(client, walletClient, address, plan.transaction, "curve swap");
      const parsed = parseSwapReceipt(receipt, curve, {
        trader: address,
        recipient: address,
        baseForQuote: plan.baseForQuote,
        requestedAmountIn: amountIn,
        minimumAmountOut: plan.quote.minimumAmountOut,
      });
      const after = await erc20Balance(client, plan.tokenOut, address, receipt.blockNumber);
      setTradeResult({
        hash,
        received: formatUnits(after - before, outInfo.decimals),
        consumed: formatUnits(parsed.consumedAmountIn, info.decimals),
      });
      await refreshBalances();
    });

  const onWrap = () =>
    run("trade", async () => {
      const { address } = requireWallet();
      if (!isValidAmount(wrapAmount, 18)) throw new Error("Wrap amount must be a number.");
      const amount = parseUnits(wrapAmount, 18);
      const client = getPublicClient();
      const eth = await client.getBalance({ address });
      if (eth < amount) throw new Error("Insufficient ETH balance to wrap.");
      const walletClient = getWalletClient(address);
      const { hash } = await sendTx(client, walletClient, address, wrapWethTx(amount), "wrap ETH to WETH");
      setTradeResult({ hash, received: wrapAmount, consumed: wrapAmount });
      await refreshBalances();
    });

  const onRefreshProgress = () =>
    run("graduate", async () => {
      if (!state.curve) throw new Error("No curve yet.");
      const client = getPublicClient();
      const block = await getSnapshotBlock(client);
      const curve = state.curve as Address;
      const [st, prog] = await Promise.all([
        getCurveState(client, curve, block),
        getMigrationProgress(client, curve, block),
      ]);
      setCurveState({
        status: st.status,
        baseToken: st.baseToken,
        quoteToken: st.quoteToken,
        canonicalPool: st.canonicalPool,
        block: block.toString(),
      });
      setProgress({
        current: formatUnits(prog.current, 18),
        target: formatUnits(prog.target, 18),
        progressBps: prog.progressBps,
        ready: prog.ready,
        migrated: prog.migrated,
      });
      if (st.status === 3 && st.canonicalPool) {
        setState((s) => ({ ...s, pool: st.canonicalPool }));
      }
    });

  /**
   * Plan the final graduation buy. The input is a MAXIMUM, not an exact
   * amount (SDK example final-fill-and-graduate.ts, proven on-chain in
   * scripts/test-e2e.ts): the whole WETH balance is sent as the maximum,
   * the curve consumes only the graduation-boundary amount and refunds the
   * rest. Sending exactly (target - current) always fails — the ~1% trading
   * fee is taken from the input, so the reserve grows by less than the input
   * and the quote classifies as "full" instead of "graduation-boundary".
   * A read-model quote is checked first so a too-small balance fails with
   * an honest message instead of the SDK's cryptic "Unexpected full".
   */
  const planFinalFill = async () => {
    const { address } = requireWallet();
    if (!state.curve) throw new Error("No curve yet.");
    const client = getPublicClient();
    const block = await getSnapshotBlock(client);
    const blockInfo = await client.getBlock({ blockNumber: block });
    const curve = state.curve as Address;
    const [st, prog] = await Promise.all([
      getCurveState(client, curve, block),
      getMigrationProgress(client, curve, block),
    ]);
    if (st.status !== 1) {
      throw new Error(`Curve is ${CURVE_STATUS_LABELS[st.status]} — final fill needs Active (1).`);
    }
    if (prog.migrated) throw new Error("Already migrated — no final buy needed.");
    const remaining = prog.target > prog.current ? prog.target - prog.current : 0n;
    if (remaining === 0n) {
      throw new Error("Progress already at target — migrate directly, no final buy needed.");
    }
    const wethBal = await erc20Balance(client, WETH, address, block);
    if (wethBal === 0n) throw new Error("No WETH balance — wrap ETH first.");
    const { fill } = await quoteCurve(client, curve, wethBal, false, block);
    if (!fill || fill.kind !== "graduation-boundary") {
      // Fee is ~1% of the input (proven on-chain: 0.00099198 consumed for
      // 0.00098206 remaining), so the gross input must exceed the remainder.
      const grossEstimate = (remaining * 101n) / 100n;
      throw new Error(
        `Your WETH balance (${formatUnits(wethBal, 18)}) is too small to reach the threshold: the curve would consume it all without graduating (remaining ${formatUnits(remaining, 18)} WETH; a gross input above ~${formatUnits(grossEstimate, 18)} WETH is needed because the ~1% trading fee comes out of your input). Wrap more ETH first.`,
      );
    }
    const plan = await planCurveSwap(client, curve, {
      blockNumber: block,
      tokenIn: WETH,
      amountIn: wethBal,
      recipient: address,
      deadline: blockInfo.timestamp + 20n * 60n,
      slippageBps: 100,
      graduationBoundary: true,
    });
    return { plan, wethBal, address, client, curve };
  };

  const onQuoteFill = () =>
    run("graduate", async () => {
      const { plan } = await planFinalFill();
      const outInfo = state.token
        ? await tokenInfo(getPublicClient(), state.token as Address)
        : null;
      setFillQuote({
        maxInput: formatUnits(plan.fill.requestedAmountIn, 18),
        expectedOut: formatUnits(plan.quote.amountOut, outInfo?.decimals ?? 9),
        consumed: formatUnits(plan.fill.consumedAmountIn, 18),
        refund: formatUnits(plan.fill.refundableAmountIn, 18),
        fee: formatUnits(plan.quote.fee, 18),
        fillKind: plan.fill.kind,
      });
    });

  const onFinalFill = () =>
    run("graduate", async () => {
      const { plan, wethBal, address, client, curve } = await planFinalFill();
      const walletClient = getWalletClient(address);
      await approveRequirements(client, walletClient, address, plan.approvalRequirements);
      const { hash, receipt } = await sendTx(client, walletClient, address, plan.transaction, "final curve fill");
      const parsed = parseSwapReceipt(receipt, curve, {
        trader: address,
        recipient: address,
        baseForQuote: false,
        requestedAmountIn: wethBal,
        minimumAmountOut: plan.quote.minimumAmountOut,
      });
      setFillResult({
        hash,
        consumed: formatUnits(parsed.consumedAmountIn, 18),
        unused: formatUnits(parsed.amountLeft, 18),
      });
      await onRefreshProgress();
    });

  const onMigrate = () =>
    run("graduate", async () => {
      const { address } = requireWallet();
      if (!state.curve) throw new Error("No curve yet.");
      if (!state.creator || !state.partnerRecipient) {
        throw new Error("Creator/Partner addresses are missing from the saved launch — relaunch or reload the Config.");
      }
      const client = getPublicClient();
      const block = await getSnapshotBlock(client);
      const curve = state.curve as Address;
      const plan = await planMigrate(client, curve, block);
      if (plan.alreadyMigrated) {
        setState((s) => ({ ...s, pool: plan.canonicalPool }));
        return;
      }
      const walletClient = getWalletClient(address);
      const { hash, receipt } = await sendTx(client, walletClient, address, plan.transaction, "migrate to ARL");
      const migrated = parseMigratedReceipt(receipt, curve);
      const resolved = resolveMigrationPositions(
        receipt,
        curve,
        migrated.canonicalPool,
        state.creator as Address,
        state.partnerRecipient as Address,
      );
      const positions = resolved.positions.map((p) => {
        const role =
          resolved.roleBinding.kind === "SHARED_OWNER"
            ? "Creator+Partner"
            : resolved.roleBinding.creatorPositions.some((c) => c.tokenId === p.tokenId)
              ? "Creator"
              : "Partner";
        return { tokenId: p.tokenId.toString(), role };
      });
      setState((s) => ({
        ...s,
        pool: migrated.canonicalPool,
        migrationTx: hash,
        positions,
      }));
    });

  const onRefreshPool = () =>
    run("post", async () => {
      if (!state.pool) throw new Error("No pool yet — graduate first.");
      const client = getPublicClient();
      const pool = state.pool as Address;
      const st = await getPoolState(client, pool);
      const [baseInfo, quoteInfo] = await Promise.all([
        tokenInfo(client, st.baseToken),
        tokenInfo(client, st.quoteToken),
      ]);
      setPoolState({
        baseToken: st.baseToken,
        quoteToken: st.quoteToken,
        reserveBase: formatUnits(st.reserveBase, baseInfo.decimals),
        reserveQuote: formatUnits(st.reserveQuote, quoteInfo.decimals),
        totalLiquidity: st.totalLiquidity.toString(),
      });
      const block = await getSnapshotBlock(client);
      const vault = await getFeeVault(client, block);
      setFeeVault(vault);
      if (wallet) {
        const [q, t] = await Promise.all([
          claimableFee(client, vault, WETH, wallet.address, block),
          state.token
            ? claimableFee(client, vault, state.token as Address, wallet.address, block)
            : Promise.resolve(0n),
        ]);
        setClaimable({ quote: formatUnits(q, 18), token: formatUnits(t, 9) });
      }
    });

  const onPoolQuote = () =>
    run("post", async () => {
      if (!state.pool || !state.token) throw new Error("No pool yet.");
      if (!isValidAmount(poolAmount, 18)) throw new Error("Amount must be a number.");
      const client = getPublicClient();
      const pool = state.pool as Address;
      const baseForQuote = poolDir === "sell";
      const tokenIn = baseForQuote ? (state.token as Address) : WETH;
      const tokenOut = baseForQuote ? WETH : (state.token as Address);
      const info = await tokenInfo(client, tokenIn);
      const outInfo = await tokenInfo(client, tokenOut);
      const sdk = dammClient(client, pool);
      const q = await sdk.quoteExactInput(tokenIn, parseUnits(poolAmount, info.decimals));
      setPoolQuote({
        expectedOut: formatUnits(q.amountOut, outInfo.decimals),
        minOut: formatUnits((q.amountOut * 9950n) / 10_000n, outInfo.decimals),
        outSymbol: outInfo.symbol,
      });
    });

  const onPoolTrade = () =>
    run("post", async () => {
      const { address } = requireWallet();
      if (!state.pool || !state.token) throw new Error("No pool yet.");
      if (!isValidAmount(poolAmount, 18)) throw new Error("Amount must be a number.");
      const client = getPublicClient();
      const pool = state.pool as Address;
      const baseForQuote = poolDir === "sell";
      const tokenIn = baseForQuote ? (state.token as Address) : WETH;
      const tokenOut = baseForQuote ? WETH : (state.token as Address);
      const info = await tokenInfo(client, tokenIn);
      const outInfo = await tokenInfo(client, tokenOut);
      const amountIn = parseUnits(poolAmount, info.decimals);
      const balIn = await erc20Balance(client, tokenIn, address);
      if (balIn < amountIn) throw new Error(`Insufficient ${info.symbol} balance.`);
      const planned = await prepareConcentratedSwap(client, pool, tokenIn, amountIn, address, 50);
      const walletClient = getWalletClient(address);
      await approveRequirements(client, walletClient, address, planned.approvalRequirements);
      const block = await getSnapshotBlock(client);
      const before = await erc20Balance(client, planned.quote.tokenOut, address, block);
      const { hash, receipt } = await sendTx(client, walletClient, address, planned.transaction, "pool swap");
      const after = await erc20Balance(client, planned.quote.tokenOut, address, receipt.blockNumber);
      setPoolTradeResult({ hash, received: formatUnits(after - before, outInfo.decimals) });
      await refreshBalances();
    });

  const onClaimFees = (which: "quote" | "token") =>
    run("post", async () => {
      const { address } = requireWallet();
      if (!feeVault) throw new Error("Load the pool section first (fee vault unknown).");
      const token = which === "quote" ? WETH : (state.token as Address);
      if (!token) throw new Error("No token yet.");
      const client = getPublicClient();
      const block = await getSnapshotBlock(client);
      const owed = await claimableFee(client, feeVault as Address, token, address, block);
      if (owed === 0n) throw new Error("Nothing owed for this asset — no transaction sent.");
      const walletClient = getWalletClient(address);
      const tx = planFeeClaim(feeVault as Address, token, address, address);
      const { hash } = await sendTx(client, walletClient, address, tx, "claim launch fees");
      setPoolTradeResult({ hash, received: "check receipt" });
      await onRefreshPool();
    });

  const onCheckLpClaimable = () =>
    run("post", async () => {
      const { address } = requireWallet();
      if (!state.pool) throw new Error("No pool yet.");
      if (!/^\d+$/.test(lpTokenId)) throw new Error("Enter an LP NFT token ID.");
      const client = getPublicClient();
      const { claimableBase, claimableQuote } = await simulateLpFeeClaim(
        client,
        BigInt(lpTokenId),
        address,
        address,
      );
      setLpClaimable({
        base: formatUnits(claimableBase, 9),
        quote: formatUnits(claimableQuote, 18),
      });
    });

  const onClaimLpFees = () =>
    run("post", async () => {
      const { address } = requireWallet();
      if (!state.pool) throw new Error("No pool yet.");
      if (!/^\d+$/.test(lpTokenId)) throw new Error("Enter an LP NFT token ID.");
      const client = getPublicClient();
      const pool = state.pool as Address;
      const tx = await planLpFeeClaim(client, pool, BigInt(lpTokenId), address, address);
      const walletClient = getWalletClient(address);
      const { hash } = await sendTx(client, walletClient, address, tx, "claim LP fees");
      setPoolTradeResult({ hash, received: "check receipt" });
    });

  const onReset = () => {
    clearState();
    setState({ ...emptyState, positions: [] });
    setConfigPreview(null);
    setCurveState(null);
    setProgress(null);
    setPoolState(null);
    setClaimable(null);
    setFillQuote(null);
    setFillResult(null);
  };

  const connected = wallet !== null;
  const wrongChain = connected && wallet.chainId !== GIWA_CHAIN_ID;
  const hasWallet = hasInjectedWallet();

  const statusLabel = useMemo(
    () => (curveState ? CURVE_STATUS_LABELS[curveState.status] ?? `status ${curveState.status}` : "—"),
    [curveState],
  );

  return (
    <div className="app">
      <header>
        <h1>Ammora Launchpad</h1>
        <p className="sub">
          Ship token launches on GIWA Sepolia testnet (chain 91342) with the Ammora SDK
          0.3.9 — Config → launch → trade → graduate → claim.
        </p>
        <p className="credit">
          Built for <a href="https://x.com/capitaliscoin" target="_blank" rel="noreferrer">@capitaliscoin</a>
          {" · "}
          <a href={AMMORA_URL} target="_blank" rel="noreferrer">ammora.org</a>
          {" · "}
          <a href={DOCS_URL} target="_blank" rel="noreferrer">SDK docs</a>
        </p>
        <p className={`badge ${verified ? "ok" : "warn"}`}>
          {verified
            ? `✓ Deployment verified (runtime pins OK, snapshot block ${verified})`
            : errors.verify
              ? `Deployment check failed: ${errors.verify}`
              : "Checking deployment…"}
        </p>
      </header>

      <Section
        n="0"
        title="Connect wallet"
        desc="MetaMask (in-app browser on your phone). All signing happens in your wallet — this page never asks for a private key or seed phrase."
      >
        {!hasWallet && (
          <p className="locked">
            No injected wallet detected. Open this page inside MetaMask's browser, or install
            MetaMask first.
          </p>
        )}
        {hasWallet && !connected && (
          <Btn busy={busy === "wallet"} onClick={onConnect}>
            Connect MetaMask
          </Btn>
        )}
        {connected && (
          <div>
            <p className="tx">
              Connected <span className="mono">{shortAddr(wallet.address)}</span> · chain{" "}
              {wallet.chainId}
            </p>
            {wrongChain && (
              <Btn busy={busy === "wallet"} onClick={onSwitchChain}>
                Switch to GIWA Sepolia
              </Btn>
            )}
            <p className="tx">
              ETH {ethBal} · WETH {wethBal}
              {state.token ? ` · ${state.tokenSymbol ?? "TOKEN"} ${tokenBal}` : ""}
            </p>
            <Btn busy={busy === "wallet"} onClick={onRefreshBalances}>
              Refresh balances
            </Btn>
          </div>
        )}
        <Err msg={errors.wallet ?? null} />
      </Section>

      <Section
        n="1"
        title="Create Config"
        desc="One reusable Config for your launchpad (template #6, concentrated graduation). Sale supply is in whole tokens (9 decimals); the graduation threshold is in WETH (18 decimals). All four roles default to your wallet."
      >
        <Field label="Sale supply (tokens)" value={saleSupply} onChange={setSaleSupply} />
        <Field label="Graduation threshold (WETH)" value={threshold} onChange={setThreshold} />
        <Field label="Config owner" value={roles.owner} onChange={(v) => setRoles((r) => ({ ...r, owner: v }))} mono />
        <Field label="Partner recipient (fees)" value={roles.partner} onChange={(v) => setRoles((r) => ({ ...r, partner: v }))} mono />
        <Field label="Liquidity partner (LP)" value={roles.lp} onChange={(v) => setRoles((r) => ({ ...r, lp: v }))} mono />
        <Field label="Leftover receiver" value={roles.leftover} onChange={(v) => setRoles((r) => ({ ...r, leftover: v }))} mono />
        <div className="row">
          <Btn busy={busy === "config"} onClick={onPreviewConfig}>
            Preview Config
          </Btn>
        </div>
        {configPreview && (
          <div className="result">
            <p>Review hash (binds chain, recipients, amounts, calldata):</p>
            <p className="mono small">{configPreview.reviewHash}</p>
            <p>Total supply: {configPreview.totalSupply} tokens</p>
            <p>Sale allocation: {configPreview.saleAllocation} tokens</p>
            <p>Gross migration base: {configPreview.grossMigrationBase} tokens</p>
            <p>Gross migration quote: {configPreview.grossMigrationQuote} WETH</p>
            <p>Migration quote fee: {configPreview.migrationQuoteFee} WETH</p>
            <p>Locked base: {configPreview.lockedBase} tokens</p>
            <Btn busy={busy === "config"} onClick={onCreateConfig}>
              Create Config on-chain
            </Btn>
          </div>
        )}
        {state.configId && (
          <div className="result">
            <p>
              Config #{state.configId} · hash{" "}
              <span className="mono small">{state.configHash}</span>
            </p>
            {state.configTx && <Tx hash={state.configTx} label="Created in" />}
          </div>
        )}
        <div className="row">
          <Field label="…or load an existing Config ID" value={existingConfigId} onChange={setExistingConfigId} />
          <Btn busy={busy === "config"} onClick={onLoadExistingConfig}>
            Load Config
          </Btn>
        </div>
        <Err msg={errors.config ?? null} />
      </Section>

      <Section
        n="2"
        title="Launch token"
        desc="Issue a new token + its pre-graduation bonding curve (ALC) from your Config. The Creator pays the pool creation fee in ETH (template #6: 0)."
        locked={!state.configId ? "Create or load a Config first." : null}
      >
        <Field label="Token name" value={tokenName} onChange={setTokenName} />
        <Field label="Symbol" value={tokenSymbol} onChange={setTokenSymbol} />
        <Field label="Metadata URI" value={metadataURI} onChange={setMetadataURI} mono />
        <Btn busy={busy === "launch"} onClick={onCreateLaunch}>
          Create token + curve
        </Btn>
        {state.token && state.curve && (
          <div className="result">
            <Addr address={state.token} label="Token" />
            <Addr address={state.curve} label="Curve (ALC)" />
            {state.launchTx && <Tx hash={state.launchTx} label="Launched in" />}
          </div>
        )}
        <div className="row">
          <Field label="…or load an existing curve address" value={existingCurve} onChange={setExistingCurve} mono />
          <Btn busy={busy === "launch"} onClick={onLoadExistingCurve}>
            Load curve
          </Btn>
        </div>
        <Err msg={errors.launch ?? null} />
      </Section>

      <Section
        n="3"
        title="Trade on the curve"
        desc="Buy with WETH or sell the token on the pre-graduation curve. Buys need WETH — wrap ETH below if your WETH balance is short. Quotes are taken at a finalized snapshot block; execution re-simulates before you sign."
        locked={!state.curve ? "Launch a token first." : null}
      >
        <Btn busy={busy === "trade"} onClick={onRefreshCurve}>
          Refresh curve state
        </Btn>
        {curveState && (
          <div className="result">
            <p>
              Status: <b>{statusLabel}</b> · snapshot block {curveState.block}
            </p>
            <Addr address={curveState.baseToken} label="Base token" />
            <Addr address={curveState.quoteToken} label="Quote (WETH)" />
            {curveState.canonicalPool !== "0x0000000000000000000000000000000000000000" && (
              <Addr address={curveState.canonicalPool} label="Canonical pool" />
            )}
          </div>
        )}
        <div className="row">
          <Field label="Wrap ETH → WETH" value={wrapAmount} onChange={setWrapAmount} />
          <Btn busy={busy === "trade"} onClick={onWrap}>
            Wrap
          </Btn>
        </div>
        <div className="row">
          <label className="field">
            <span>Direction</span>
            <select value={tradeDir} onChange={(e) => setTradeDir(e.target.value as "buy" | "sell")}>
              <option value="buy">Buy token with WETH</option>
              <option value="sell">Sell token for WETH</option>
            </select>
          </label>
          <Field label={`Amount in (${tradeDir === "buy" ? "WETH" : state.tokenSymbol ?? "token"})`} value={tradeAmount} onChange={setTradeAmount} />
        </div>
        <div className="row">
          <Btn busy={busy === "trade"} onClick={onQuoteTrade}>
            Get quote
          </Btn>
          <Btn busy={busy === "trade"} onClick={onTrade}>
            Execute swap
          </Btn>
        </div>
        {quoteResult && (
          <div className="result">
            <p>
              Expected out: {quoteResult.expectedOut} {quoteResult.outSymbol}
            </p>
            <p>
              Minimum out (0.5% slippage): {quoteResult.minOut} {quoteResult.outSymbol}
            </p>
            <p>Fee: {quoteResult.fee}</p>
            <p>Fill: {quoteResult.fill}</p>
          </div>
        )}
        {tradeResult && (
          <div className="result">
            <Tx hash={tradeResult.hash} label="Swap tx" />
            <p>Received: {tradeResult.received}</p>
          </div>
        )}
        <Err msg={errors.trade ?? null} />
      </Section>

      <Section
        n="4"
        title="Graduate + migrate"
        desc="When the curve reaches its graduation threshold, do the final buy (only the remaining quote is consumed; the rest stays in your wallet), then migrate to the post-graduation ARL pool in a separate transaction."
        locked={!state.curve ? "Launch a token first." : null}
      >
        <Btn busy={busy === "graduate"} onClick={onRefreshProgress}>
          Refresh progress
        </Btn>
        {progress && (
          <div className="result">
            <p>
              Raised: {progress.current} / {progress.target} WETH ({(progress.progressBps / 100).toFixed(2)}%)
            </p>
            <p>
              Ready to migrate: {progress.ready ? "yes" : "no"} · Migrated:{" "}
              {progress.migrated ? "yes" : "no"}
            </p>
          </div>
        )}
        <p className="desc">
          Max input is your whole WETH balance ({wethBal} WETH). The curve consumes
          only what reaches the graduation threshold and refunds the rest — sending
          exactly the remaining amount always fails, because the ~1% trading fee
          comes out of your input. Preview first: the quote shows the estimated
          consumption and refund before you sign.
        </p>
        <div className="row">
          <Btn busy={busy === "graduate"} onClick={onQuoteFill}>
            Preview final buy
          </Btn>
          <Btn busy={busy === "graduate"} onClick={onFinalFill}>
            Final buy
          </Btn>
        </div>
        {fillQuote && (
          <div className="result">
            <p>Fill: {fillQuote.fillKind}</p>
            <p>Max input (whole WETH balance): {fillQuote.maxInput} WETH</p>
            <p>
              Expected out: {fillQuote.expectedOut} {state.tokenSymbol ?? "token"}
            </p>
            <p>Estimated WETH consumed: {fillQuote.consumed} WETH</p>
            <p>Estimated WETH refunded: {fillQuote.refund} WETH</p>
            <p>Fee: {fillQuote.fee} WETH</p>
          </div>
        )}
        {fillResult && (
          <div className="result">
            <Tx hash={fillResult.hash} label="Final buy tx" />
            <p>Consumed: {fillResult.consumed} WETH</p>
            <p>Unused input (stayed in wallet): {fillResult.unused} WETH</p>
          </div>
        )}
        <Btn busy={busy === "graduate"} onClick={onMigrate}>
          Migrate to ARL pool
        </Btn>
        {state.pool && (
          <div className="result">
            <Addr address={state.pool} label="ARL pool" />
            {state.migrationTx && <Tx hash={state.migrationTx} label="Migration tx" />}
            {state.positions.length > 0 && (
              <p>
                LP NFTs:{" "}
                {state.positions.map((p) => `#${p.tokenId} (${p.role})`).join(", ")}
              </p>
            )}
          </div>
        )}
        <Err msg={errors.graduate ?? null} />
      </Section>

      <Section
        n="5"
        title="Post-graduation: swap + claim fees"
        desc="Trade on the ARL pool and claim what the launch earned. Creator/Partner launch fees sit in the factory FeeVault (claim WETH and token separately); LP fees belong to the migration LP NFTs."
        locked={!state.pool ? "Graduate first — no pool yet." : null}
      >
        <Btn busy={busy === "post"} onClick={onRefreshPool}>
          Refresh pool + fees
        </Btn>
        {poolState && (
          <div className="result">
            <Addr address={poolState.baseToken} label="Base" />
            <Addr address={poolState.quoteToken} label="Quote" />
            <p>
              Reserves: {poolState.reserveBase} base · {poolState.reserveQuote} quote
            </p>
          </div>
        )}
        <div className="row">
          <label className="field">
            <span>Direction</span>
            <select value={poolDir} onChange={(e) => setPoolDir(e.target.value as "buy" | "sell")}>
              <option value="buy">Buy token with WETH</option>
              <option value="sell">Sell token for WETH</option>
            </select>
          </label>
          <Field label={`Amount in (${poolDir === "buy" ? "WETH" : state.tokenSymbol ?? "token"})`} value={poolAmount} onChange={setPoolAmount} />
        </div>
        <div className="row">
          <Btn busy={busy === "post"} onClick={onPoolQuote}>
            Get pool quote
          </Btn>
          <Btn busy={busy === "post"} onClick={onPoolTrade}>
            Swap on pool
          </Btn>
        </div>
        {poolQuote && (
          <div className="result">
            <p>
              Expected out: {poolQuote.expectedOut} {poolQuote.outSymbol}
            </p>
            <p>
              Minimum out (0.5% slippage): {poolQuote.minOut} {poolQuote.outSymbol}
            </p>
          </div>
        )}
        {poolTradeResult && (
          <div className="result">
            <Tx hash={poolTradeResult.hash} label="Tx" />
            <p>Received: {poolTradeResult.received}</p>
          </div>
        )}
        {claimable && (
          <div className="result">
            <p>Claimable launch fees (this wallet):</p>
            <p>WETH: {claimable.quote}</p>
            <p>{state.tokenSymbol ?? "Token"}: {claimable.token}</p>
            <div className="row">
              <Btn busy={busy === "post"} onClick={() => onClaimFees("quote")}>
                Claim WETH fees
              </Btn>
              <Btn busy={busy === "post"} onClick={() => onClaimFees("token")}>
                Claim token fees
              </Btn>
            </div>
          </div>
        )}
        {state.positions.length > 0 && (
          <div className="result">
            <p>Migration LP NFTs:</p>
            {state.positions.map((p) => (
              <p key={p.tokenId}>
                #{p.tokenId} ({p.role}){" "}
                <button
                  className="linkbtn"
                  onClick={() => setLpTokenId(p.tokenId)}
                >
                  use this ID ↓
                </button>
              </p>
            ))}
          </div>
        )}
        <div className="row">
          <Field label="LP NFT token ID" value={lpTokenId} onChange={setLpTokenId} />
          <Btn busy={busy === "post"} onClick={onCheckLpClaimable}>
            Check LP fees
          </Btn>
          <Btn busy={busy === "post"} onClick={onClaimLpFees}>
            Claim LP fees
          </Btn>
        </div>
        {lpClaimable && (
          <div className="result">
            <p>Claimable LP fees: {lpClaimable.base} base · {lpClaimable.quote} quote</p>
          </div>
        )}
        <Err msg={errors.post ?? null} />
      </Section>

      <footer>
        <h3>How it works</h3>
        <p>
          1. Create a reusable Config from reviewed template #6. 2. Launch a token —
          a new token + bonding curve are created together. 3. Trade on the curve
          until the graduation threshold is reached. 4. Final buy + migrate to the
          ARL pool. 5. Trade on the pool and claim Creator/Partner + LP fees.
        </p>
        <p>
          Testnet only — GIWA Sepolia ETH and WETH have no real value. Every
          transaction is simulated before you sign, waits for 13 confirmations,
          and is verified against its receipt block. Get testnet ETH from the{" "}
          <a href="https://faucet.giwa.io" target="_blank" rel="noreferrer">GIWA faucet</a>.
        </p>
        <p>
          <button className="linkbtn" onClick={onReset}>
            Reset saved launch progress
          </button>
        </p>
      </footer>
    </div>
  );
}
