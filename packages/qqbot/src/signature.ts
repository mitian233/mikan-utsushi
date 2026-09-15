import * as ed from "@noble/ed25519";

const encoder = new TextEncoder();

function secretSeed(secret: string): Uint8Array {
  const bytes = encoder.encode(secret);
  if (bytes.length === 0) throw new Error("QQ app secret is required");
  const seed = new Uint8Array(32);
  for (let index = 0; index < seed.length; index += 1) {
    seed[index] = bytes[index % bytes.length] ?? 0;
  }
  return seed;
}

function decodeHex(value: string): Uint8Array {
  const normalized = value.trim();
  if (!/^[0-9a-f]+$/i.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error("Invalid hexadecimal signature");
  }

  const output = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export async function verifyQQWebhookSignature(input: {
  body: ArrayBuffer;
  timestamp: string;
  signature: string;
  appSecret: string;
}): Promise<boolean> {
  const message = concatBytes(encoder.encode(input.timestamp), new Uint8Array(input.body));
  const publicKey = await ed.getPublicKeyAsync(secretSeed(input.appSecret));
  return ed.verifyAsync(decodeHex(input.signature), message, publicKey);
}

export async function signQQValidationResponse(input: {
  plainToken: string;
  eventTimestamp: string;
  appSecret: string;
}): Promise<string> {
  const message = encoder.encode(`${input.eventTimestamp}${input.plainToken}`);
  const signature = await ed.signAsync(message, secretSeed(input.appSecret));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
