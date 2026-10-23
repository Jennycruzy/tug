/**
 * Browser wallets for TUG in your account: Cardano (CIP-30: Eternl, Lace, …), Ethereum (EIP-1193: MetaMask,
 * Rabby, …) and Solana (Phantom). Each gives an address and signs Strike's consent message exactly as Strike asks
 * (strike-auth: CIP-30 signData with the hex message; EIP-191 personal_sign; Solana signMessage, base58).
 */

type Cip30Api = {
  getNetworkId(): Promise<number>;
  getUsedAddresses(): Promise<string[]>;
  getUnusedAddresses(): Promise<string[]>;
  getChangeAddress(): Promise<string>;
  signData(addr: string, payloadHex: string): Promise<{ signature: string; key: string }>;
};
type Cip30Wallet = { name?: string; icon?: string; enable(): Promise<Cip30Api> };
type Eip1193 = { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
type Phantom = { connect(): Promise<{ publicKey: { toBase58(): string } }>; signMessage(m: Uint8Array, enc?: string): Promise<{ signature: Uint8Array }> };

declare global {
  interface Window {
    cardano?: Record<string, Cip30Wallet>;
    ethereum?: Eip1193;
    phantom?: { solana?: Phantom };
  }
}

export interface WalletChoice {
  id: string;
  label: string;
  chain: "cardano" | "ethereum" | "solana";
  connect(): Promise<{ address: string; sign(message: string): Promise<string> }>;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const utf8 = (s: string) => new TextEncoder().encode(s);

// bech32 (BIP-173) without the 90-character limit: Cardano addresses are longer.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values: number[]): number {
  const g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= g[i]!;
  }
  return chk;
}
export function bech32(hrp: string, bytes: Uint8Array): string {
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  const expand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod([...expand, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  let n = BigInt(`0x${hex(bytes) || "0"}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** The wallets this browser has, testnet only (a Cardano wallet must be on a test network). */
export function walletsInBrowser(): WalletChoice[] {
  const out: WalletChoice[] = [];
  for (const [id, w] of Object.entries(window.cardano ?? {})) {
    if (!w || typeof w.enable !== "function" || id === "typhoncip30") continue;
    out.push({
      id: `cardano-${id}`,
      label: `${w.name ?? id} (Cardano)`,
      chain: "cardano",
      connect: async () => {
        const api = await w.enable();
        if ((await api.getNetworkId()) !== 0) throw new Error("Switch this wallet to the Cardano test network (Preprod) and try again.");
        const raw = (await api.getUsedAddresses())[0] ?? (await api.getUnusedAddresses())[0] ?? (await api.getChangeAddress());
        const address = bech32("addr_test", fromHex(raw));
        return { address, sign: async (m) => JSON.stringify(await api.signData(raw, hex(utf8(m)))) };
      },
    });
  }
  const eth = window.ethereum;
  if (eth) {
    out.push({
      id: "ethereum",
      label: "MetaMask or another Ethereum wallet",
      chain: "ethereum",
      connect: async () => {
        const [address] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
        if (!address) throw new Error("The wallet gave no address.");
        return { address, sign: async (m) => String(await eth.request({ method: "personal_sign", params: [`0x${hex(utf8(m))}`, address] })) };
      },
    });
  }
  const sol = window.phantom?.solana;
  if (sol) {
    out.push({
      id: "solana",
      label: "Phantom (Solana)",
      chain: "solana",
      connect: async () => {
        const address = (await sol.connect()).publicKey.toBase58();
        return { address, sign: async (m) => base58((await sol.signMessage(utf8(m), "utf8")).signature) };
      },
    });
  }
  return out;
}
