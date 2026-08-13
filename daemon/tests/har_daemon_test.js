/**
 * HAR daemon 本地工具集成测试：har_to_replay / har_diff / har_assert / har_save。
 *
 * 直接 import Bridge（不起子进程），用临时 work 目录，调 call_local 验证：
 *  - har_to_replay 支持 har 对象入参 + path 文件入参 + save 落盘
 *  - har_diff 支持 两份 har 对象 / 两个 path
 *  - har_assert 支持 path 入参 + 各断言类型
 *  - har_save 无扩展时优雅失败（NO_EXTENSION / NO_HAR）
 *
 * 运行：cd daemon && node tests/har_daemon_test.js
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bridge } from "../src/server.js";

const { check, summarize } = (function () {
  let pass = 0, fail = 0;
  return {
    check(name, cond, extra) {
      if (cond) { pass++; }
      else { fail++; console.log("  FAIL:", name, extra ?? ""); }
    },
    summarize() {
      console.log(`\n${pass} passed, ${fail} failed`);
      if (fail) process.exitCode = 1;
    },
  };
})();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-har-"));
const bridge = new Bridge(tmpDir);
// Bridge 构造时打开了 events/sessions 的 WriteStream；挂 error 监听，
// 避免 rmSync 删除 tmpDir 后进程退出时流 flush 触发未捕获 error 崩测试。
bridge.events_log.on("error", () => {});
bridge.session_log.on("error", () => {});

const SAMPLE_HAR = {
  log: {
    version: "1.2", creator: { name: "test" }, pages: [],
    entries: [
      {
        request: { method: "GET", url: "https://api.example.com/data",
          headers: [{ name: "X-Sign", value: "abc" }, { name: "User-Agent", value: "t" }],
          postData: undefined },
        response: { status: 200, content: { text: '{"ok":1}', size: 8 },
          headers: [{ name: "Content-Type", value: "application/json" }] },
        _resourceType: "fetch",
      },
      {
        request: { method: "POST", url: "https://api.example.com/submit",
          headers: [{ name: "Content-Type", value: "application/json" }],
          postData: { text: '{"a":1}' } },
        response: { status: 201, content: { text: '{"id":9}', size: 9 },
          headers: [] },
        _resourceType: "fetch",
      },
    ],
  },
};

// ---- har_to_replay：对象入参 ----
let r = await bridge.call_local("har_to_replay", { har: SAMPLE_HAR, format: "python" });
check("har_to_replay ok", r.ok === true);
check("har_to_replay count=2", r.data.count === 2);
check("har_to_replay python has requests", r.data.code.includes("import requests"));
check("har_to_replay marks X-Sign dynamic", r.data.code.includes("<DYNAMIC>"));
check("har_to_replay POST has data", r.data.code.includes("submit") && r.data.code.includes("data="));

r = await bridge.call_local("har_to_replay", { har: SAMPLE_HAR, format: "curl" });
check("har_to_replay curl ok", r.ok && r.data.count === 2);

r = await bridge.call_local("har_to_replay", { har: SAMPLE_HAR, format: "node" });
check("har_to_replay node ok", r.ok && r.data.code.includes("fetch"));

// ---- har_to_replay：path 入参 + save 落盘 ----
bridge.store.write_json("sample.har", SAMPLE_HAR);
r = await bridge.call_local("har_to_replay", { path: "sample.har", format: "python", save: true });
check("har_to_replay path ok", r.ok && r.data.count === 2);
check("har_to_replay save 落盘", !!r.data.path && fs.existsSync(r.data.path));

r = await bridge.call_local("har_to_replay", { path: "nope.har" });
check("har_to_replay 缺文件 NOT_FOUND", !r.ok && r.error.code === "NOT_FOUND");

r = await bridge.call_local("har_to_replay", {});
check("har_to_replay 无参 BAD_ARGS", !r.ok && r.error.code === "BAD_ARGS");

// ---- har_diff：对象 + path 混合 ----
const HAR_V2 = JSON.parse(JSON.stringify(SAMPLE_HAR));
HAR_V2.log.entries[0].response.status = 500;
HAR_V2.log.entries[0].response.content.text = '{"err":1}';
HAR_V2.log.entries[1].request.url = "https://api.example.com/renamed";
bridge.store.write_json("current.har", HAR_V2);

r = await bridge.call_local("har_diff",
  { baseline: "sample.har", current: "current.har" });
check("har_diff ok", r.ok);
check("har_diff status_changed", r.data.status_changed.length === 1);
check("har_diff body_changed", r.data.body_changed >= 1);
check("har_diff only_in_baseline has /submit", r.data.only_in_baseline.some((k) => k.includes("/submit")));
check("har_diff only_in_current has /renamed", r.data.only_in_current.some((k) => k.includes("/renamed")));
check("har_diff not identical", r.data.identical === false);

r = await bridge.call_local("har_diff",
  { baseline: SAMPLE_HAR, current: SAMPLE_HAR });
check("har_diff identical", r.ok && r.data.identical === true);

r = await bridge.call_local("har_diff",
  { baseline: "missing.har", current: "current.har" });
check("har_diff 缺文件失败", !r.ok && r.error.code === "DIFF_FAILED");

// ---- har_assert：path 入参 ----
r = await bridge.call_local("har_assert", {
  path: "sample.har",
  assertions: [
    { type: "request_exists", url_pattern: "/data" },
    { type: "response_status", url_pattern: "/data", status: 200 },
    { type: "response_contains", url_pattern: "/submit", value: '"id":9' },
    { type: "min_requests", count: 2 },
    { type: "request_absent", url_pattern: "/nope" },
    { type: "response_status", url_pattern: "/data", status: 404 }, // fail
  ],
});
check("har_assert ok", r.ok);
check("har_assert passed=5", r.data.passed === 5, `passed=${r.data.passed}`);
check("har_assert failed=1", r.data.failed === 1, `failed=${r.data.failed}`);

r = await bridge.call_local("har_assert", {});
check("har_assert 无参 BAD_ARGS", !r.ok && r.error.code === "BAD_ARGS");

// ---- har_save：无扩展优雅失败 ----
r = await bridge.call_local("har_save", {});
check("har_save 无扩展失败", !r.ok);

// 清理
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

summarize();
