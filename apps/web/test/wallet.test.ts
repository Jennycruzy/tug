import { describe, expect, it } from "vitest";
import { base58, bech32 } from "../src/wallet.js";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
/** Decodes a bech32 string's data part back to bytes (checksum dropped), to test the encoder on real addresses. */
function bytesOf(s: string): Uint8Array {
  const words = [...s.slice(s.lastIndexOf("1") + 1, -6)].map((c) => CHARSET.indexOf(c));
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

describe("wallet address and signature encodings", () => {
  it("bech32 matches BIP-173's test vector", () => {
    expect(bech32("a", new Uint8Array())).toBe("a12uel5l");
  });

  it("bech32 rebuilds a real Cardano testnet address (longer than 90 characters) from its bytes", () => {
    // The second testnet account's address, as Strike reports it.
    const addr = "addr_test1qpsemj96k72fttx68vgrj656qws8mz90h3x3uclfvpr4hqaw4p707x38mfrqs549pw5jhd2h05vh0n85uc5pnq2dgnfq8p28y9";
    expect(bech32("addr_test", bytesOf(addr))).toBe(addr);
  });

  it("base58 keeps leading zero bytes and matches a known value", () => {
    expect(base58(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(base58(new TextEncoder().encode("hello world"))).toBe("StV1DL6CwTryKyV");
  });
});
