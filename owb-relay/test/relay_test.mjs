/**
 * RelayRoom 单元测试：纯 Node，mock DurableObjectState + WebSocketPair（无需 wrangler）。
 *
 * 覆盖：配对触发 relay_paired、双向转发、同-role 顶替、单端关闭清场、异 token 隔离。
 *
 *   node test/relay_test.mjs
 */

// ---- mock：CF 运行时的 WebSocketPair + DurableObjectState ----

function makeMockWs(id) {
  const ws = {
    _id: id,
    _inbox: [],
    _closed: false,
    _closeCode: null,
    _peer: null,
    accept() {},
    send(m) {
      if (this._closed) return;
      this._peer._inbox.push(m);
    },
    close(code = 1000, reason = "") {
      this._closed = true;
      this._closeCode = code;
    },
  };
  return ws;
}

globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    const a = makeMockWs("0");
    const b = makeMockWs("1");
    a._peer = b;
    b._peer = a;
    this[0] = a;
    this[1] = b;
  }
};

// Node 原生 Response 不允许 status 101（CF 运行时才允许 WS 升级码）；
// 测试里用轻量 stub 放行任意 status，并保留 webSocket 字段。
globalThis.Response = class Response {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status != null ? init.status : 200;
    if (init && init.webSocket !== undefined) this.webSocket = init.webSocket;
  }
};

class FakeState {
  constructor() {
    this._reg = []; // [{ws, tags}]
  }
  acceptWebSocket(ws, tags = []) {
    this._reg.push({ ws, tags });
  }
  getWebSockets(tag) {
    return this._reg
      .filter((r) => !r.ws._closed && (tag === undefined || r.tags.includes(tag)))
      .map((r) => r.ws);
  }
  // 真实 DurableObjectState 的 API：转发要按对端 role 定向就得用它
  getTags(ws) {
    const hit = this._reg.find((r) => r.ws === ws);
    return hit ? hit.tags : [];
  }
}

// ---- 辅助 ----

import { RelayRoom } from "../src/relay-room.js";

let passed = 0;
let failed = 0;

function ok(cond, name) {
  if (cond) {
    passed++;
    console.log("  ok  - " + name);
  } else {
    failed++;
    console.error("  FAIL- " + name);
  }
}

const j = (o) => JSON.stringify(o);
const pj = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

function makeReq(token, role) {
  return new Request(`http://relay.test/${token}?role=${role}`, {
    headers: { upgrade: "websocket" },
  });
}

// 连入一个 role；返回 { server, client }（server=DO 持有的 pair[1]，client=pair[0]）
async function connect(room, state, token, role) {
  await room.fetch(makeReq(token, role));
  const server = state.getWebSockets(role)[0];
  const client = server._peer;
  return { server, client };
}

// ---- 测试用例 ----

async function test_pairing_and_forward() {
  console.log("\n[test] 配对 + 双向转发");
  const state = new FakeState();
  const room = new RelayRoom(state, {});
  const TOKEN = "tok-AAA";

  const ext = await connect(room, state, TOKEN, "extension");
  // 仅 ext 时不应配对
  ok(ext.client._inbox.length === 0, "ext 先连：未配对，无 relay_paired");

  const ctl = await connect(room, state, TOKEN, "controller");
  // 配对完成：两端各收到 relay_paired（role 对应自己）
  const extMsg = pj(ext.client._inbox[0]);
  const ctlMsg = pj(ctl.client._inbox[0]);
  ok(extMsg && extMsg.type === "relay_paired" && extMsg.role === "extension",
    "ext 收到 relay_paired{role:extension}");
  ok(ctlMsg && ctlMsg.type === "relay_paired" && ctlMsg.role === "controller",
    "ctl 收到 relay_paired{role:controller}");

  // ext → ctl 转发（模拟 ext 发 hello）
  await room.webSocketMessage(ext.server, j({ type: "hello", v: 1 }));
  ok(pj(ctl.client._inbox[1]) && pj(ctl.client._inbox[1]).type === "hello",
    "ext 发 hello → ctl 收到");

  // ctl → ext 转发（模拟 ctl 发 tool_call）
  await room.webSocketMessage(ctl.server, j({ type: "tool_call", id: "r1" }));
  ok(pj(ext.client._inbox[1]) && pj(ext.client._inbox[1]).type === "tool_call",
    "ctl 发 tool_call → ext 收到");
}

async function test_close_drops_peer() {
  console.log("\n[test] 单端关闭清场");
  const state = new FakeState();
  const room = new RelayRoom(state, {});
  const ext = await connect(room, state, "tok-CLOSE", "extension");
  const ctl = await connect(room, state, "tok-CLOSE", "controller");

  // 真实运行时：ws 先关闭，再触发 webSocketClose 回调
  ext.server.close(1000);
  await room.webSocketClose(ext.server, 1000, "", true);
  ok(ctl.server._closed, "ext 关闭 → ctl 被关闭");
  ok(state.getWebSockets().length === 0, "两端均已不在 getWebSockets");
}

async function test_same_role_replace() {
  console.log("\n[test] 同-role 顶替（SW 重启重连）");
  const state = new FakeState();
  const room = new RelayRoom(state, {});
  const ext1 = await connect(room, state, "tok-REPL", "extension");
  // 第二个 ext 连入：旧的应被 4400 关闭
  const ext2 = await connect(room, state, "tok-REPL", "extension");
  ok(ext1.server._closed && ext1.server._closeCode === 4400, "旧 ext 被 4400 顶替");
  ok(state.getWebSockets("extension").length === 1, "仅留一个 ext 槽");
  ok(!ext2.server._closed, "新 ext 在线");

  // ctl 连入 → 与新 ext 配对（不与已死的旧 ext 配对）
  const ctl = await connect(room, state, "tok-REPL", "controller");
  ok(pj(ext2.client._inbox[0]) && pj(ext2.client._inbox[0]).type === "relay_paired",
    "ctl 入场 → 新 ext 配对成功");
}

async function test_different_tokens_isolated() {
  console.log("\n[test] 异 token 隔离（不同 DO 实例）");
  const s1 = new FakeState();
  const r1 = new RelayRoom(s1, {});
  const s2 = new FakeState();
  const r2 = new RelayRoom(s2, {});
  await connect(r1, s1, "tok-ONE", "extension");
  await connect(r2, s2, "tok-TWO", "controller");
  // r1 只有 ext，r2 只有 ctl —— 各自都不会配对
  ok(s1.getWebSockets().length === 1 && s2.getWebSockets().length === 1,
    "两个 token 互不影响，各自未配对");
}

async function test_bad_role_rejected() {
  console.log("\n[test] 非法 role 拒绝");
  const state = new FakeState();
  const room = new RelayRoom(state, {});
  const res = await room.fetch(makeReq("tok-X", "evil"));
  ok(res.status === 400, "role=evil → 400");
  ok(state.getWebSockets().length === 0, "无连接被接受");
}

// ---- Worker 入口（此前零覆盖）----

// index.js 只用到 request.url 和 request.headers.get("upgrade")
function makeWorkerReq(path, upgrade) {
  return {
    url: `https://relay.example.workers.dev${path}`,
    headers: { get: (k) => (String(k).toLowerCase() === "upgrade" ? upgrade || null : null) },
  };
}

const fakeEnv = {
  RELAY_ROOM: {
    idFromName: (name) => ({ name }),
    get: (id) => ({ fetch: async () => new Response("routed", { status: 101, webSocket: id.name }) }),
  },
};

// 32 字节 base64url ≈ 43 字符，扩展 popup 生成的就是这个形状
const GOOD_TOKEN = "a".repeat(43);

async function test_worker_entry() {
  console.log("\n[test] Worker 入口路由与 token 门槛");
  const { default: worker } = await import("../src/index.js");

  let res = await worker.fetch(makeWorkerReq("/health"), fakeEnv);
  ok(res.status === 200, "/health → 200");

  res = await worker.fetch(makeWorkerReq("/"), fakeEnv);
  ok(res.status === 400, "空 token → 400");

  // token 门槛：不加这道闸，任意随机路径都会实例化一个新 Durable Object，
  // 只要知道 workers.dev 地址就能批量建房打空免费额度（每月 1M DO 请求）。
  res = await worker.fetch(makeWorkerReq("/short", "websocket"), fakeEnv);
  ok(res.status === 400, "过短 token → 400（不建 DO）");

  res = await worker.fetch(makeWorkerReq(`/${"!".repeat(40)}`, "websocket"), fakeEnv);
  ok(res.status === 400, "非 base64url 字符 → 400");

  res = await worker.fetch(makeWorkerReq(`/${GOOD_TOKEN}`), fakeEnv);
  ok(res.status === 426, "合法 token 但非 websocket → 426");

  res = await worker.fetch(makeWorkerReq(`/${GOOD_TOKEN}`, "WebSocket"), fakeEnv);
  ok(res.status === 101, "合法 token + 升级 → 转给 DO");

  // 同 token 必须稳定寻址到同一个 DO，否则两端永远配不上
  const a = await worker.fetch(makeWorkerReq(`/${GOOD_TOKEN}`, "websocket"), fakeEnv);
  const b = await worker.fetch(makeWorkerReq(`/${GOOD_TOKEN}`, "websocket"), fakeEnv);
  ok(a.webSocket === b.webSocket && /^[0-9a-f]{64}$/.test(a.webSocket),
    "同 token → 同一个 sha256 寻址的 DO");
}

// ---- 运行 ----

(async () => {
  console.log("RelayRoom 单元测试");
  await test_pairing_and_forward();
  await test_close_drops_peer();
  await test_same_role_replace();
  await test_different_tokens_isolated();
  await test_bad_role_rejected();
  await test_worker_entry();
  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
