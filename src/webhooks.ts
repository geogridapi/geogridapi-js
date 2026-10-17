// Webhook signatures: header `GeoGridAPI-Signature: t=<unix seconds>,v1=<hex>`
// where v1 = HMAC-SHA256(secret, `${t}.${raw body}`). Uses Web Crypto, so it
// runs on Node 20+, Deno, Bun, Cloudflare Workers and edge runtimes.

import { GeoGridAPIError } from "./errors.js";
import type { WebhookEvent } from "./types.js";

export const SIGNATURE_HEADER = "GeoGridAPI-Signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface VerifyOptions {
  /** Maximum age of the signature, in seconds (default 300). */
  toleranceSeconds?: number;
  /** Current time in unix seconds, for tests. */
  now?: number;
}

/** Thrown by `constructEvent` when the signature is missing, invalid or too old. */
export class WebhookSignatureError extends GeoGridAPIError {}

const encoder = new TextEncoder();

function parseHeader(header: string): { timestamp: number; signatures: string[] } {
  let timestamp = Number.NaN;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") timestamp = Number(value);
    if (key === "v1") signatures.push(value);
  }
  return { timestamp, signatures };
}

async function hmacHex(secret: string, message: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toBytes(payload: string | Uint8Array): Uint8Array {
  return typeof payload === "string" ? encoder.encode(payload) : payload;
}

/**
 * Checks the `GeoGridAPI-Signature` header of a webhook call.
 * `payload` must be the raw request body, exactly as received (not re-serialized JSON).
 */
export async function verifyWebhookSignature(
  payload: string | Uint8Array,
  header: string | null | undefined,
  secret: string,
  options: VerifyOptions = {},
): Promise<boolean> {
  if (!header || !secret) return false;
  const { timestamp, signatures } = parseHeader(header);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || signatures.length === 0) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return false;

  const prefix = encoder.encode(`${timestamp}.`);
  const body = toBytes(payload);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix, 0);
  message.set(body, prefix.length);
  const expected = await hmacHex(secret, message);
  return signatures.some((signature) => constantTimeEqual(expected, signature.toLowerCase()));
}

/** Verifies the signature, then parses the event. Throws `WebhookSignatureError` when it does not match. */
export async function constructEvent(
  payload: string | Uint8Array,
  header: string | null | undefined,
  secret: string,
  options: VerifyOptions = {},
): Promise<WebhookEvent> {
  if (!(await verifyWebhookSignature(payload, header, secret, options))) {
    throw new WebhookSignatureError("Invalid or expired GeoGridAPI webhook signature.", { code: "invalid_signature" });
  }
  const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
  return JSON.parse(text) as WebhookEvent;
}
