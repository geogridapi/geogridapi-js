// Smoke test of the built package on the oldest supported Node.js (the test runner needs Node 22+).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";
import { GeoGridAPI, constructEvent } from "../dist/index.js";

const require = createRequire(import.meta.url);
assert.equal(typeof require("../dist/index.cjs").GeoGridAPI, "function");

const fetch = async () => new Response(JSON.stringify({ object: "balance", points: 7, mode: "test" }), { status: 200 });
const client = new GeoGridAPI({ apiKey: "gga_test_x", fetch });
assert.equal((await client.balance.get()).points, 7);

const body = JSON.stringify({ id: "evt", object: "event", type: "grid.completed", data: { id: "g1" } });
const t = Math.floor(Date.now() / 1000);
const header = `t=${t},v1=${createHmac("sha256", "whsec_x").update(`${t}.${body}`).digest("hex")}`;
assert.equal((await constructEvent(body, header, "whsec_x")).data.id, "g1");
console.log(`runtime check OK on Node ${process.version}`);
