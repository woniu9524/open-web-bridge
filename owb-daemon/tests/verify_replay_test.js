/**
 * daemon 闭环单测：verify_signer + replay（本地 HTTP 服务器）。
 *
 * 覆盖：
 *   1. first_divergence 纯函数：一致 / 中间偏差 / 长度偏差 / 缺 key
 *   2. verify_signer e2e：全过 / 部分过（pass_rate + 首偏差点定位）
 *   3. verify_signer 错误路径：signer_code 不求值为函数
 *   4. replay e2e：本地 http 服务器，GET 带自定义头 + POST 带 body
 *   5. replay 错误路径：无法连接（curl-impersonate 二进制缺失时 REPLAY_FAILED 同样算过）
 *
 * 运行：cd owb-daemon && node tests/verify_replay_test.js
 */
import http from "node:http";
import { first_divergence, verify_signer } from "../src/verify.js";
import { replay } from "../src/replay.js";
import { makeChecker } from "./kit.js";

const { check, summarize } = makeChecker();

const jstr = (o) => JSON.stringify(o);

async function main() {
  // ---- 1. first_divergence ----
  check("div: 完全一致",
    first_divergence({ a: "x", b: "y" }, { a: "x", b: "y" }) == null);
  let d = first_divergence({ sig: "abc123XYZ" }, { sig: "abc123zzz" });
  check("div: 中间偏差定位",
    d != null && d.param === "sig" && d.index === 6, jstr(d));
  d = first_divergence({ sig: "abcdef" }, { sig: "abc" });
  check("div: 长度偏差",
    d != null && d.index === 3 && d.expected_len === 6 && d.got_len === 3,
    jstr(d));
  d = first_divergence({ sig: "x" }, {});
  check("div: 缺 key", d != null && d.param === "sig");

  // ---- 2. verify_signer e2e ----
  const signer = "(input) => ({ sig: input.url.length + ':' + input.url.slice(0, 3) })";
  const urlA = "https://a.example/x", urlB = "https://b.example/y";
  const expectedA = `${urlA.length}:${urlA.slice(0, 3)}`;
  const expectedB = `${urlB.length}:${urlB.slice(0, 3)}`;
  let out = await verify_signer(signer, [
    { id: "r1", input: { url: urlA }, expected: { sig: expectedA } },
    { id: "r2", input: { url: urlB }, expected: { sig: expectedB } },
  ]);
  check("verify: 全过", out.ok && out.pass_rate === 1.0, jstr(out));

  out = await verify_signer(signer, [
    { id: "r1", input: { url: urlA }, expected: { sig: expectedA } },
    { id: "r2", input: { url: urlB }, expected: { sig: "0:WRONG" } },
  ]);
  const r2 = (out.results || []).find((r) => r.id === "r2") || {};
  check("verify: 部分过 pass_rate=0.5",
    !out.ok && out.pass_rate === 0.5, jstr(out));
  check("verify: 首偏差点定位到 sig",
    (r2.first_divergence || {}).param === "sig"
    && r2.first_divergence.index === 0,
    jstr(r2));

  // ---- 3. verify 错误路径 ----
  out = await verify_signer("42", [{ id: "x", input: {}, expected: {} }]);
  check("verify: 非函数报错",
    !out.ok && typeof out.error === "string" && out.error.includes("function"),
    out.error || "");

  // ---- 4. replay e2e（本地 HTTP）----
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const payload = jstr({
        method: req.method,
        path: req.url,
        x_test: req.headers["x-test"] ?? null,
        body: req.method === "POST" ? raw : null,
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      });
      res.end(payload);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  try {
    out = await replay({ method: "GET", url: `http://127.0.0.1:${port}/api?p=1`,
      headers: { "X-Test": "owb" } });
    let payload = {};
    try { payload = JSON.parse((out.data || {}).body || "{}"); } catch {}
    check("replay: GET 状态/回显",
      out.ok && out.data && out.data.status === 200
      && payload.x_test === "owb" && payload.method === "GET",
      jstr(out.data || out).slice(0, 200));

    out = await replay({ method: "POST", url: `http://127.0.0.1:${port}/api`,
      headers: { "Content-Type": "text/plain" }, body: "hello-body" });
    payload = {};
    try { payload = JSON.parse((out.data || {}).body || "{}"); } catch {}
    check("replay: POST body 透传", out.ok && payload.body === "hello-body");

    out = await replay({ method: "GET", url: "http://127.0.0.1:1/unreachable" }, 3);
    check("replay: 连接失败 error", !out.ok && !!out.error,
      String(out.error || "").slice(0, 100));
  } finally {
    server.close();
  }

  return summarize();
}

main().then((rc) => process.exit(rc)).catch((e) => {
  console.error("[FAIL] 测试异常:", e);
  process.exit(1);
});
