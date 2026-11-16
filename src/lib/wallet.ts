/**
 * Browser wallet connection via the injected provider (MetaMask).
 * Signing is ONLY through the user's connected WalletClient — this module
 * never sees, asks for, or stores a private key or seed phrase.
 */
import { createWalletClient, custom } from "viem";
import type { Address, WalletClient } from "viem";
import { CHAIN_ADD_PARAMS, GIWA_CHAIN_ID, giwaChain } from "./chain";

export type InjectedEthereum = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  isMetaMask?: boolean;
};

declare global {
  interface Window {
    ethereum?: InjectedEthereum;
  }
}

export function getInjectedProvider(): InjectedEthereum | null {
  if (typeof window === "undefined") return null;
  return window.ethereum ?? null;
}

export function hasInjectedWallet(): boolean {
  return getInjectedProvider() !== null;
}

export async function connectWallet(): Promise<{ address: Address; chainId: number }> {
  const provider = getInjectedProvider();
  if (!provider) {
    throw new Error(
      "No wallet detected. Install MetaMask (or another injected wallet) and open this page in its in-app browser.",
    );
  }
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[];
  if (!accounts.length) throw new Error("No account was shared by the wallet.");
  const chainIdHex = (await provider.request({ method: "eth_chainId" })) as string;
  return { address: accounts[0] as Address, chainId: Number.parseInt(chainIdHex, 16) };
}

export async function switchToGiwa(): Promise<void> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("No wallet detected.");
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ADD_PARAMS.chainId }],
    });
  } catch (error) {
    const code = (error as { code?: number })?.code;
    // 4902 = chain not added to the wallet yet.
    if (code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [CHAIN_ADD_PARAMS],
      });
      return;
    }
    throw error;
  }
}

export function getWalletClient(address: Address): WalletClient {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("No wallet detected.");
  return createWalletClient({
    account: address,
    chain: giwaChain,
    transport: custom(provider as never),
  });
}

export { GIWA_CHAIN_ID };
