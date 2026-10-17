import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebhookSignatureError, constructEvent, verifyWebhookSignature } from "../src/index.js";

const SECRET = "whsec_0123456789abcdef";
const NOW = 1_760_000_000;
const BODY = JSON.stringify({ id: "evt_1", object: "event", type: "grid.completed", created_at: "2026-10-18T10:00:00Z", data: { id: "g1" } });

// Same signing code as the GeoGridAPI server.
const sign = (body: string, t = NOW, secret = SECRET) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

describe("webhook signatures", () => {
  it("accepts a valid signature, as a string or as bytes", async () => {
    expect(await verifyWebhookSignature(BODY, sign(BODY), SECRET, { now: NOW + 10 })).toBe(true);
    expect(await verifyWebhookSignature(new TextEncoder().encode(BODY), sign(BODY), SECRET, { now: NOW })).toBe(true);
  });

  it("rejects a modified body, a wrong secret or a missing header", async () => {
    expect(await verifyWebhookSignature(`${BODY} `, sign(BODY), SECRET, { now: NOW })).toBe(false);
    expect(await verifyWebhookSignature(BODY, sign(BODY, NOW, "whsec_other"), SECRET, { now: NOW })).toBe(false);
    expect(await verifyWebhookSignature(BODY, undefined, SECRET, { now: NOW })).toBe(false);
    expect(await verifyWebhookSignature(BODY, "garbage", SECRET, { now: NOW })).toBe(false);
  });

  it("rejects a signature older than the tolerance", async () => {
    expect(await verifyWebhookSignature(BODY, sign(BODY), SECRET, { now: NOW + 301 })).toBe(false);
    expect(await verifyWebhookSignature(BODY, sign(BODY), SECRET, { now: NOW + 301, toleranceSeconds: 600 })).toBe(true);
  });

  it("parses the event once verified, and throws otherwise", async () => {
    const event = await constructEvent(BODY, sign(BODY), SECRET, { now: NOW });
    expect(event.type).toBe("grid.completed");
    expect(event.data.id).toBe("g1");
    await expect(constructEvent(BODY, sign(BODY, NOW, "whsec_other"), SECRET, { now: NOW })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});
