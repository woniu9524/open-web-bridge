/**
 * 「静默假绿」输入守卫。
 *
 * 这一类缺陷的共同形状：非法/缺失的输入被 JS 的宽松语义吞掉，工具报成功，
 * 实际什么都没验证。对 AI 调用方来说，假绿比报错危害大一个数量级——报错会
 * 让它换路，假绿会让它把错误结论当事实继续往下走。
 *
 * 仓库已经系统性修过好几轮同类（BUG-26/27/114/118、UX-56/57/68/172/173），
 * 这里守住后来发现的漏网三处中可纯函数验证的两处：
 *   harAssert  —— url_pattern 缺省 → new RegExp(undefined) 得 /(?:)/ 恒真匹配
 *   verify_signer —— 样本缺 expected → 空对象对拍必过，pass_rate 1.0
 *（第三处 replay 的 max_body NaN 需要 curl-impersonate 二进制，随
 *  verify_replay_test 一起在 npm run test:replay 覆盖。）
 *
 * 运行：node owb-daemon/tests/input_guards_test.js
 */
import { harAssert } from "../src/harexport.js";
import { verify_signer } from "../src/verify.js";
import { makeChecker } from "./kit.js";

const { check, summarize } = makeChecker();

const HAR = {
  log: {
    version: "1.2", creator: { name: "test" }, pages: [],
    entries: [
      { request: { method: "GET", url: "https://api.example.com/v1/user", headers: [] },
        response: { status: 200, headers: [], content: { text: "hello" } } },
      { request: { method: "POST", url: "https://api.example.com/v1/pay", headers: [] },
        response: { status: 500, headers: [], content: { text: "boom" } } },
    ],
  },
};

// ---- harAssert：漏 url_pattern 不能当成通过 ----
{
  const r = harAssert(HAR, [{ type: "request_exists" }]);
  check("request_exists 漏 url_pattern → 判失败而非恒真",
    r.ok === false && r.failed === 1 && /url_pattern/.test(r.results[0].detail),
    JSON.stringify(r.results[0]));

  const absent = harAssert(HAR, [{ type: "request_absent" }]);
  check("request_absent 漏 url_pattern → 判失败而非恒假",
    absent.ok === false && /url_pattern/.test(absent.results[0].detail),
    JSON.stringify(absent.results[0]));

  const st = harAssert(HAR, [{ type: "response_status", status: 200 }]);
  check("response_status 漏 url_pattern 不会落到第一条请求上",
    st.ok === false && /url_pattern/.test(st.results[0].detail),
    JSON.stringify(st.results[0]));

  // 护栏不能误伤正常用法
  const good = harAssert(HAR, [
    { type: "request_exists", url_pattern: "/v1/user" },
    { type: "response_status", url_pattern: "/v1/pay", status: 500 },
    { type: "min_requests", count: 2 },
  ]);
  check("合法断言仍然全过", good.ok === true && good.passed === 3,
    JSON.stringify(good.results));
}

// ---- verify_signer：样本缺 expected 不能算通过 ----
{
  const code = "(input) => ({ sig: String(input.a) + '-' + String(input.b) })";

  const noExp = verify_signer(code, [{ id: "s1", input: { a: 1, b: 2 } }]);
  check("样本缺 expected → 不再是 pass_rate 1.0 的假绿",
    noExp.ok === false && noExp.pass_rate === 0
    && /expected/.test(noExp.results[0].error || ""),
    JSON.stringify(noExp));

  const ok = verify_signer(code, [
    { id: "s1", input: { a: 1, b: 2 }, expected: { sig: "1-2" } },
  ]);
  check("有基准且一致仍然通过", ok.ok === true && ok.pass_rate === 1,
    JSON.stringify(ok));

  const bad = verify_signer(code, [
    { id: "s1", input: { a: 1, b: 2 }, expected: { sig: "9-9" } },
  ]);
  check("有基准但不一致仍然报偏差",
    bad.ok === false && !!bad.results[0].first_divergence,
    JSON.stringify(bad.results[0]));
}

process.exitCode = summarize();
