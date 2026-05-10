import crypto from "node:crypto";

const HASH_ALGORITHM_ALIASES: Record<string, string> = {
  "SHA-256": "sha256",
  "SHA-384": "sha384",
  "SHA-512": "sha512",
  "SHA-512/224": "sha512-224",
  "SHA-512/256": "sha512-256",
  "SHA3-256": "sha3-256",
};

const globalState = globalThis as typeof globalThis & {
  __matterKioskPatchedCreateHash?: boolean;
};

function normalizeHashAlgorithm(algorithm: string): string {
  return HASH_ALGORITHM_ALIASES[algorithm.toUpperCase()] ?? algorithm;
}

if (!globalState.__matterKioskPatchedCreateHash) {
  const originalCreateHash = crypto.createHash.bind(crypto);

  crypto.createHash = ((algorithm, options) => {
    const normalizedAlgorithm =
      typeof algorithm === "string" ? normalizeHashAlgorithm(algorithm) : algorithm;

    return originalCreateHash(normalizedAlgorithm, options);
  }) as typeof crypto.createHash;

  globalState.__matterKioskPatchedCreateHash = true;
}