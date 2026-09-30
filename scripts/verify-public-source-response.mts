// Offline stream checks. No provider, framework environment loader or database.
import assert from "node:assert/strict";
import { readPublicSourceText, MAX_PUBLIC_SOURCE_BYTES } from "../lib/engine/public-source-response.ts";

const signal = new AbortController().signal;
assert.equal(await readPublicSourceText(new Response("real-source-shaped fixture"), signal), "real-source-shaped fixture");
await assert.rejects(readPublicSourceText(new Response(null), signal), /missing body/);
await assert.rejects(readPublicSourceText(new Response("small", {
  headers: { "content-length": String(MAX_PUBLIC_SOURCE_BYTES + 1) },
}), signal), /too large/);
await assert.rejects(readPublicSourceText(new Response("small", {
  headers: { "content-length": "invalid" },
}), signal), /invalid length/);

let cancelled = false;
const oversized = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array(MAX_PUBLIC_SOURCE_BYTES));
    controller.enqueue(new Uint8Array(1));
  },
  cancel() { cancelled = true; },
});
await assert.rejects(readPublicSourceText(new Response(oversized), signal), /too large/);
assert.equal(cancelled, true);

const encoded = new TextEncoder().encode("cafe ☕");
const split = new ReadableStream<Uint8Array>({ start(controller) {
  controller.enqueue(encoded.slice(0, -1));
  controller.enqueue(encoded.slice(-1));
  controller.close();
} });
assert.equal(await readPublicSourceText(new Response(split), signal), "cafe ☕");

let stalledCancelled = false;
const ctrl = new AbortController();
const stalled = new ReadableStream<Uint8Array>({ cancel() { stalledCancelled = true; } });
const read = readPublicSourceText(new Response(stalled), ctrl.signal);
ctrl.abort();
await assert.rejects(read, /timed out/);
assert.equal(stalledCancelled, true);
const alreadyAborted = new AbortController();
alreadyAborted.abort();
await assert.rejects(readPublicSourceText(new Response("late"), alreadyAborted.signal), /timed out/);
console.log("PASS public source byte cap, stalled body cancellation and decoding (offline)");
