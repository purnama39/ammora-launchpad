/**
 * Generate a throwaway GIWA Sepolia test wallet for end-to-end testing.
 * The private key is written ONLY to ~/workspace/ammora-builder/.env-test-wallet
 * (mode 600) and NEVER printed. Only the public address is printed.
 * Run: npx tsx scripts/make-test-wallet.ts
 */
import { chmodSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);
const path = new URL("../../.env-test-wallet", import.meta.url);
writeFileSync(
  path,
  [
    "# GIWA Sepolia TESTNET throwaway wallet — Ammora Launchpad end-to-end testing.",
    "# Testnet only. Never fund with real assets. Never commit this file.",
    `AMMORA_TEST_PRIVATE_KEY=${privateKey}`,
    `AMMORA_TEST_ADDRESS=${account.address}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
chmodSync(path, 0o600);
console.log("test wallet address:", account.address);
console.log("key saved to .env-test-wallet (mode 600, not printed)");
