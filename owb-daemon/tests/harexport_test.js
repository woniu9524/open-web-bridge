import { harToReplay, harDiff, harAssert } from "../src/harexport.js";

const { check, summarize } = (function () {
  let pass = 0, fail = 0;
  const fails = [];
  return {
    check(name, cond) {
      if (cond) { pass++; }
      else { fail++; fails.push(name); console.log("  FAIL:", name); }
    },
    summarize() {
      console.log(`\n${pass} passed, ${fail} failed`);
      if (fail) process.exitCode = 1;
    },
  };
})();

function makeHar(entries) {
  return { log: { version: "1.2", creator: { name: "test" }, pages: [], entries } };
}

const sampleEntry = (overrides = {}) => ({
  request: {
    method: "GET", url: "https://api.example.com/data?id=1",
    headers: [{ name: "User-Agent", value: "test" }, { name: "X-Sign", value: "abc" }],
    queryString: [], headersSize: -1, bodySize: 0,
    ...overrides.request,
  },
  response: {
    status: 200, statusText: "OK", httpVersion: "http/1.1",
    headers: [{ name: "Content-Type", value: "application/json" }],
    content: { text: '{"ok":1}', size: 8, mimeType: "application/json" },
    headersSize: -1, bodySize: 8,
    ...overrides.response,
  },
  startedDateTime: "2024-01-01T00:00:00.000Z", time: 100, timings: {},
});

// ---- C7: harToReplay ----
const har1 = makeHar([sampleEntry()]);
const py = harToReplay(har1, "python");
check("replay python count", py.count === 1);
check("replay python has requests import", py.code.includes("import requests"));
check("replay python marks dynamic header", py.code.includes("<DYNAMIC>") && py.code.includes("X-Sign"));
check("replay python skips content-length mgmt", !py.code.includes("Content-Length"));

const curl = harToReplay(har1, "curl");
check("replay curl has curl cmd", curl.code.includes("curl") && curl.code.includes("-X"));
check("replay curl dynamic placeholder", curl.code.includes("<DYNAMIC>"));

const node = harToReplay(har1, "node");
check("replay node has fetch", node.code.includes("fetch"));

const postHar = makeHar([sampleEntry({
  request: { method: "POST", url: "https://api.example.com/submit",
    headers: [{ name: "Content-Type", value: "application/json" }], postData: { text: '{"a":1}' } },
})]);
const postPy = harToReplay(postHar, "python");
check("replay POST includes data", postPy.code.includes('"data"') || postPy.code.includes("data="));

const empty = harToReplay(makeHar([]), "python");
check("replay empty count 0", empty.count === 0);

// ---- C8: harDiff ----
const baseHar = makeHar([
  sampleEntry(),
  sampleEntry({ request: { method: "GET", url: "https://api.example.com/removed" } }),
]);
const curHar = makeHar([
  sampleEntry({ response: { status: 500, content: { text: '{"err":1}', size: 9 } } }),
  sampleEntry({ request: { method: "GET", url: "https://api.example.com/added" } }),
]);
const d = harDiff(baseHar, curHar);
check("diff baseline count", d.baseline_entries === 2);
check("diff current count", d.current_entries === 2);
check("diff only_in_baseline has /removed", d.only_in_baseline.some((k) => k.includes("/removed")));
check("diff only_in_current has /added", d.only_in_current.some((k) => k.includes("/added")));
check("diff status changed 200->500", d.status_changed.length === 1 && d.status_changed[0].baseline === 200 && d.status_changed[0].current === 500);
check("diff body changed counted", d.body_changed >= 1);
check("diff not identical", d.identical === false);

const sameHar = makeHar([sampleEntry()]);
const dSame = harDiff(sameHar, sameHar);
check("diff identical true", dSame.identical === true);

// ---- C9: harAssert ----
const aHar = makeHar([
  sampleEntry(),
  sampleEntry({ request: { method: "GET", url: "https://api.example.com/other" } }),
]);
const assertions = [
  { type: "request_exists", url_pattern: "/data" },
  { type: "request_absent", url_pattern: "/nonexistent" },
  { type: "request_exists", url_pattern: "/nonexistent" }, // should fail
  { type: "response_status", url_pattern: "/data", status: 200 },
  { type: "response_status", url_pattern: "/data", status: 404 }, // should fail
  { type: "response_contains", url_pattern: "/data", value: '"ok":1' },
  { type: "min_requests", count: 2 },
  { type: "min_requests", count: 10 }, // should fail
];
const r = harAssert(aHar, assertions);
check("assert total counted", r.passed + r.failed === 8);
check("assert passed count", r.passed === 5);
check("assert failed count", r.failed === 3);
check("assert pass_rate", r.pass_rate === 5 / 8);

// ---- BUG-26/BUG-27/UX-57: 断言字段别名（AI 按直觉传的名字也认） ----
const alias = harAssert(aHar, [
  { type: "response_status", url_pattern: "/data", code: 200 },      // status 别名
  { type: "response_status", url_pattern: "/data", expected: 200 },  // status 别名
  { type: "response_contains", url_pattern: "/data", text: '"ok":1' }, // value 别名
  { type: "response_contains", url_pattern: "/data", contains: '"ok":1' },
  { type: "min_requests", min: 2 },                                  // count 别名
]);
check("alias fields all pass", alias.passed === 5 && alias.failed === 0);

// 缺字段不能被 Number(undefined)=NaN 悄悄判成 false —— 要说清缺什么
const missing = harAssert(aHar, [
  { type: "response_status", url_pattern: "/data" },
  { type: "response_contains", url_pattern: "/data" },
]);
check("missing status field explains itself",
  !missing.results[0].ok && /needs a status field/.test(missing.results[0].detail));
check("missing value field explains itself",
  !missing.results[1].ok && /needs a value field/.test(missing.results[1].detail));

// UX-68: 未知断言类型要给出合法值
const unknown = harAssert(aHar, [{ type: "no_such_assert" }]);
check("unknown assertion type lists valid ones",
  /valid: request_exists\|/.test(unknown.results[0].detail));

// ---- BUG-118: har_to_replay 的 url_pattern 过滤（以前被静默忽略，全量生成）----
const rHar = makeHar([
  { request: { method: "GET", url: "https://x.test/api/data", headers: [] },
    response: { status: 200, content: {} } },
  { request: { method: "GET", url: "https://x.test/analytics.js", headers: [] },
    response: { status: 200, content: {} } },
  { request: { method: "GET", url: "https://cdn.test/font.woff2", headers: [] },
    response: { status: 200, content: {} } },
]);
const all = harToReplay(rHar, "python");
check("no filter keeps every entry", all.count === 3 && all.total === 3);

const filtered = harToReplay(rHar, "python", { url_pattern: "api/data" });
check("url_pattern filters down", filtered.count === 1 && filtered.matched === 1);
check("url_pattern reports the pool it filtered from", filtered.total === 3);
check("filtered code only has the match",
  /api\/data/.test(filtered.code) && !/analytics\.js/.test(filtered.code));

const none = harToReplay(rHar, "python", { url_pattern: "nope-no-match" });
check("no match says so instead of silently emitting everything",
  none.count === 0 && /no entries matched url_pattern/.test(none.code));

let threw = null;
try { harToReplay(rHar, "python", { url_pattern: "([unclosed" }); }
catch (e) { threw = e; }
check("bad regex throws instead of matching nothing silently",
  threw && /bad url_pattern regex/.test(threw.message));

summarize();
