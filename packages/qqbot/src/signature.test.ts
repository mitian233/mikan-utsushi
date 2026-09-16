import { describe, expect, it } from "vitest";
import { signQQValidationResponse, verifyQQWebhookSignature } from "./signature";

const appSecret = "test-app-secret";
const timestamp = "1700000000";
const body = new TextEncoder().encode('{"op":0,"d":{"plain_token":"token"}}');
const webhookSignature =
  "c7b9adfd0b1018a66df597a62c2c3c99a7f4eb81b4ca746ba4aefa71ee0dd27fa2e17898508af39ccffed66618f88106f2e3e38b1b1f5f2d77a4055f85d3f70f";
const validationSignature =
  "c6d024b25471c0cf42159020ebefb87dca2a0d7ccee79bd2441866179ac51f890945516b4dc1626c0ed9394659cdbf0825f0f9a29d69c7950cc4eda264dad801";

describe("QQ webhook signatures", () => {
  it("accepts a valid signature over the exact raw body bytes", async () => {
    await expect(
      verifyQQWebhookSignature({
        body: body.buffer,
        timestamp,
        signature: webhookSignature,
        appSecret,
      }),
    ).resolves.toBe(true);
  });

  it("rejects a signature when any raw body byte changes", async () => {
    const alteredBody = new Uint8Array(body);
    alteredBody[0] = alteredBody[0] ^ 1;

    await expect(
      verifyQQWebhookSignature({
        body: alteredBody.buffer,
        timestamp,
        signature: webhookSignature,
        appSecret,
      }),
    ).resolves.toBe(false);
  });

  it("produces a stable validation signature for fixed input", async () => {
    await expect(
      signQQValidationResponse({
        plainToken: "token",
        eventTimestamp: timestamp,
        appSecret,
      }),
    ).resolves.toBe(validationSignature);
  });
});
