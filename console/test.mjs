// node test.mjs  -- runs the worker against an in-memory KV, no network.
import worker from "./worker.js";
const mem = new Map();
const isJson = t => t === "json" || (t && t.type === "json");
const env = { ADMIN_TOKEN: "s3cret", STATE: { get: async (k, t) => mem.has(k) ? (isJson(t) ? JSON.parse(mem.get(k)) : mem.get(k)) : null, put: async (k, v) => { mem.set(k, v); } } };
const call = (path, body, token = "s3cret") => worker.fetch(new Request("https://x" + path, { method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + token }, body: body && JSON.stringify(body) }), env);
const j = async r => [r.status, await r.json().catch(() => null)];
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m + ": " + JSON.stringify(a) + " != " + JSON.stringify(b)); };

eq((await call("/api/state", null, "wrong")).status, 401, "bad token");
eq((await call("/api/state", null, "")).status, 401, "empty token");
eq((await worker.fetch(new Request("https://x/"), env)).status, 200, "page");
let [, s] = await j(await call("/api/state")); eq(s.phase, "idle", "initial idle");
let [, hb] = await j(await call("/api/heartbeat", { ac: true, battery: 80, host: "mbp" })); eq(hb.wake, false, "no wake pending");
[, s] = await j(await call("/api/wake")); eq(s.phase, "requested", "requested");
[, hb] = await j(await call("/api/heartbeat", { ac: true, battery: 80, host: "mbp" })); eq([hb.wake, hb.hold], [true, true], "mac told to wake once");
[, hb] = await j(await call("/api/heartbeat", { ac: true, holding: true, host: "mbp" })); eq([hb.wake, hb.hold], [false, true], "second heartbeat: already acked, still hold");
[, s] = await j(await call("/api/state")); eq(s.phase, "awake", "awake after ack");
[, hb] = await j(await call("/api/heartbeat", { ac: true, holding: false, host: "mbp" })); eq([hb.wake, hb.hold], [true, true], "hold dropped inside window: wake re-delivered");
[, hb] = await j(await call("/api/heartbeat", { ac: true, holding: true, host: "mbp" })); eq(hb.wake, false, "holding again, no re-delivery");
mem.set("device", JSON.stringify({ ...JSON.parse(mem.get("device")), holding: false, ackAt: Date.now() - 31 * 60e3 }));
[, hb] = await j(await call("/api/heartbeat", { ac: true, holding: false, host: "mbp" })); eq(hb.wake, false, "hold window over: no re-delivery");
[, s] = await j(await call("/api/state")); eq(s.phase, "done", "done after hold expired");
[, s] = await j(await call("/api/wake")); eq(s.phase, "requested", "wake again from done");
[, hb] = await j(await call("/api/heartbeat", { ac: true, holding: false, host: "mbp" })); eq(hb.wake, true, "second wake delivered");
[, s] = await j(await call("/api/state")); eq(s.phase, "awake", "awake again (ack heartbeat implies holding)");
[, s] = await j(await call("/api/cancel")); eq(s.phase, "idle", "released");
[, hb] = await j(await call("/api/heartbeat", { ac: false, holding: false, host: "mbp" })); eq(hb.hold, false, "mac told to stop holding");
[, s] = await j(await call("/api/wake")); [, s] = await j(await call("/api/cancel")); eq(s.phase, "idle", "cancel before ack");
[, hb] = await j(await call("/api/heartbeat", { host: "mbp" })); eq(hb.wake, false, "cancelled request not delivered");
[, s] = await j(await call("/api/settings", { interval: 999, hold: "x" })); eq(s.settings, { interval: 240, hold: 30 }, "settings clamp");
[, hb] = await j(await call("/api/heartbeat", { host: "mbp" })); eq([hb.interval, hb.holdMinutes], [240, 30], "settings reach mac");
console.log("ok");

// Every Mac pairs on its own and only sees its own state.
const reg = (t, mac) => worker.fetch(new Request("https://x/api/register", { method: "POST", headers: { Authorization: "Bearer " + t }, body: mac && JSON.stringify({ mac }) }), env);
const A = "a".repeat(48), B = "b".repeat(48);
eq([(await reg(A)).status, (await reg(A)).status, (await reg(B)).status, (await reg("short")).status], [201, 200, 201, 400], "each Mac registers");
eq((await call("/api/state", null, "f".repeat(48))).status, 401, "unregistered token rejected");
await call("/api/wake", {}, A);
eq([(await j(await call("/api/state", null, A)))[1].phase, (await j(await call("/api/state", null, B)))[1].phase], ["requested", "idle"], "Macs are separate");
eq([(await reg(B, "2".repeat(64))).status, (await reg(B, "3".repeat(64))).status], [200, 409], "a copied token is refused on another Mac");
eq((await reg("s3cret", "2".repeat(64))).status, 409, "ADMIN_TOKEN is never a Mac's own token");
mem.set("owner", await (async s => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, "0")).join(""))("c".repeat(48)));
eq([(await reg("c".repeat(48))).status, (await call("/api/state", null, "c".repeat(48))).status], [409, 200], "old shared token: still opens its Mac, but setting up again makes a new one");
const broken = { ...env, STATE: { ...env.STATE, put: async () => { throw new Error("KV put() limit exceeded for the day."); } } };
const r = await worker.fetch(new Request("https://x/api/wake", { method: "POST", headers: { Authorization: "Bearer " + A }, body: "{}" }), broken);
eq([r.status, (await r.json()).error], [503, "KV put() limit exceeded for the day."], "store errors come back as JSON");
let n = 0; const limited = { ...env, REGISTER_LIMIT: { limit: async () => ({ success: ++n <= 1 }) } };
eq([(await worker.fetch(new Request("https://x/api/register", { method: "POST", headers: { Authorization: "Bearer " + "d".repeat(48) } }), limited)).status,
    (await worker.fetch(new Request("https://x/api/register", { method: "POST", headers: { Authorization: "Bearer " + "e".repeat(48) } }), limited)).status], [201, 429], "pairing is rate limited");
console.log("multi-Mac ok");
