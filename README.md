# Ammora Launchpad — GIWA Sepolia (testnet)

A static web app that ships a real Ammora launchpad: create a reusable Config
(template #6), launch a token + bonding curve, trade on the curve, graduate +
migrate to the ARL pool, then swap on the pool and claim Creator/Partner + LP
fees. Built for the Ammora Season 2 Builder mission, for
[@capitaliscoin](https://x.com/capitaliscoin).

- Chain: GIWA Sepolia 91342, RPC `https://sepolia-rpc.giwa.io`
- SDK: `@ammora-protocol/sdk@0.3.9` + `viem@2.33.0`
- Static only — no backend, no server, no secrets in the app. Signing is
  only via the connected wallet (MetaMask `window.ethereum`).
- Reference: `../ammora-examples/LAUNCHPAD.md` §11 (SDK boundaries) — do not
  modify the examples dir.

## Run

```bash
npm install
npm run dev      # local dev server
npm run build    # production build -> dist/ (static, base './')
npx vite preview --port 4173   # serve the production build
```

## What was verified (Phase 1, 2026-11-16)

- `npm run build` passes with zero TS errors.
- `npx tsx scripts/verify-reads.ts` — all read checks pass through the app's
  own modules: RPC chain 91342, finalized snapshot block, deployment runtime
  pins OK, template #6 enabled with the reviewed hash, Config plan builds
  (reviewHash `0xd389…340` for the 1,000,000-token / 0.001-WETH defaults),
  launch tx builds (516 bytes calldata, 0 creation fee).
- Headless-Chrome smoke test of the production build: page loads, all six
  sections render, correct "No injected wallet detected" state, zero console
  errors. Screenshot: `/tmp/ammora-mobile.png`.
- CORS: `sepolia-rpc.giwa.io` returns `access-control-allow-origin: *` for
  POST + preflight, so browser calls work from a real browser.

## Known limits of this VM's smoke test

Headless Chrome in this VM has no internet access, so the in-app deployment
check shows "HTTP request failed" there. That is a sandbox limitation, not an
app bug: the identical code path was verified from Node, and CORS is confirmed
open. On a phone with real internet the badge should read "Deployment
verified".

## Not yet verified (needs Phase 2)

Write flows are implemented but untested on-chain: Config creation, token
launch, curve trades, final buy, migration, pool swaps, fee claims. They need
a funded test wallet + a real browser session.

- Throwaway test wallet for Phase 2: address
  `0x1a69cf0008f83833115abeD935b35b7782C73887`. Its private key lives ONLY in
  `../.env-test-wallet` (mode 600, never committed, never printed). Fund it
  with ~0.005 testnet ETH from https://faucet.giwa.io before the end-to-end run.
- The app also works with the user's own MetaMask wallet (0x9107…); the test
  wallet keeps test launches separate from the mission wallet.

## Still needed (Phase 2)

1. A public GitHub repo (user creates it; suggested name `ammora-launchpad`)
   + deploy `dist/` to GitHub Pages (or Vercel).
2. Fund the test wallet, run the full end-to-end flow in a real browser,
   record Config/token/curve/pool + tx hashes.
3. User posts on X from @capitaliscoin and submits the deployed link in the
   Builder mission form for manual review.

## Files

- `src/lib/chain.ts` — chain, deployment, template #6, WETH, explorer links
- `src/lib/pins.ts` — bundled reviewed runtime pins (public data)
- `src/lib/runtime-pins.giwa.json` — the pins file (copied from the examples)
- `src/lib/ammora.ts` — SDK wiring: clients, Config planning, launch, curve,
  swaps, graduation, claims, send/approve helpers
- `src/lib/wallet.ts` — injected-provider connection (MetaMask)
- `src/lib/store.ts` — localStorage launch progress
- `src/App.tsx` — the UI (steps 0–5)
- `scripts/verify-reads.ts` — read-only checks via the app's modules
- `scripts/probe-template.ts` — one-off template/WETH probe
- `scripts/make-test-wallet.ts` — throwaway test-wallet generator
