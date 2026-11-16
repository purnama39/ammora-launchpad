/** Persisted launchpad progress (localStorage — testnet addresses/hashes only). */

export type MigrationPosition = {
  tokenId: string;
  role: string;
};

export type LaunchState = {
  configId: string | null;
  configHash: string | null;
  configTx: string | null;
  configOwner: string | null;
  partnerRecipient: string | null;
  token: string | null;
  tokenSymbol: string | null;
  curve: string | null;
  launchTx: string | null;
  creator: string | null;
  pool: string | null;
  migrationTx: string | null;
  positions: MigrationPosition[];
};

const KEY = "ammora-launchpad-state-v1";

export const emptyState: LaunchState = {
  configId: null,
  configHash: null,
  configTx: null,
  configOwner: null,
  partnerRecipient: null,
  token: null,
  tokenSymbol: null,
  curve: null,
  launchTx: null,
  creator: null,
  pool: null,
  migrationTx: null,
  positions: [],
};

export function loadState(): LaunchState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...emptyState, positions: [] };
    const parsed = JSON.parse(raw) as Partial<LaunchState>;
    return { ...emptyState, ...parsed, positions: parsed.positions ?? [] };
  } catch {
    return { ...emptyState, positions: [] };
  }
}

export function saveState(state: LaunchState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage full/blocked — the app still works for the session.
  }
}

export function clearState(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
