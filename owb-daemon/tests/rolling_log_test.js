/**
 * RollingJsonl + 审计脱敏的 Node 单测（无浏览器、无 daemon）。
 *
 * 为什么这个文件存在：events.jsonl 原来是一条裸 createWriteStream 追加流——
 * 无轮转、无上限、没人负责删，实测在开发机上长到 19,443,306,283 字节（18 GiB），
 * 而全局安装时它长在 node_modules 底下，用户永远不会去看。修法是让所有长生命
 * 周期日志走 RollingJsonl（按天切分 + 大小上限 + 过期清理），并把 events 默认关掉。
 *
 * 这里守住的是「体积不会再失控」这条线，以及脱敏不能误伤 workflow 回放：
 *   - 按天切文件、跨天换文件（原来日期在构造时冻结，长跑 daemon 写错文件）
 *   - 超过 maxBytes 滚到 .1/.2 分片
 *   - 同一天重启接着写，不把「重启」变成绕过上限的后门
 *   - sweep 只删自己命名格式的过期分片，不碰用户文件
 *   - auditSafe：tool_call 的 args 必须保真（workflow_save 靠它重建回放步骤），
 *     tool_result 必须裁剪并抹掉凭据
 *
 * 运行：node owb-daemon/tests/rolling_log_test.js
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EvidenceStore, RollingJsonl, ymd } from "../src/evidence.js";
import { auditSafe } from "../src/server.js";
import { makeChecker } from "./kit.js";

const { check, summarize } = makeChecker();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-rolling-test-"));
const lsJsonl = (dir) => {
  const d = path.join(tmp, dir);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".jsonl")).sort() : [];
};

try {
  // ---- 1. 按天命名 + 追加 ----
  {
    const store = new EvidenceStore(tmp);
    const log = new RollingJsonl(store, "d1", { keepDays: 0 });
    log.write('{"a":1}\n');
    log.write('{"a":2}\n');
    await log.end();
    const files = lsJsonl("d1");
    check("按当天日期命名单文件", files.length === 1 && files[0] === `${ymd()}.jsonl`,
      JSON.stringify(files));
    const body = fs.readFileSync(path.join(tmp, "d1", files[0]), "utf8");
    check("两条都写进去了", body.trim().split("\n").length === 2, JSON.stringify(body));
  }

  // ---- 2. 跨天换文件（直接改 day 模拟午夜跨越）----
  {
    const store = new EvidenceStore(tmp);
    const log = new RollingJsonl(store, "d2", { keepDays: 0 });
    log.write('{"day":"old"}\n');
    // 原 bug：文件名日期在构造时算一次，长跑 daemon 跨零点后继续写昨天的文件。
    // RollingJsonl 每次 write 都取当天，这里把内部 day 拨旧来模拟。
    log.day = "20200101";
    log.write('{"day":"new"}\n');
    await log.end();
    const files = lsJsonl("d2");
    check("跨天写入换到当天文件", files.includes(`${ymd()}.jsonl`) && files.length === 1,
      JSON.stringify(files));
  }

  // ---- 3. 超过 maxBytes 滚分片 ----
  {
    const store = new EvidenceStore(tmp);
    const log = new RollingJsonl(store, "d3", { maxBytes: 200, keepDays: 0 });
    const line = JSON.stringify({ pad: "x".repeat(80) }) + "\n";  // 91 B
    for (let i = 0; i < 9; i++) log.write(line);  // 91×3 顶过 200 → 每 3 条一个分片
    await log.end();
    const files = lsJsonl("d3");
    check("超上限滚到 .N 分片",
      files.length === 3 && files.includes(`${ymd()}.1.jsonl`)
      && files.includes(`${ymd()}.2.jsonl`), JSON.stringify(files));
    const sizes = files.map((f) => fs.statSync(path.join(tmp, "d3", f)).size);
    // 单条写入不切分，所以允许最后一条把文件顶过线；上限之内即可
    check("每个分片都在上限附近而非无限增长", sizes.every((s) => s <= 200 + line.length),
      JSON.stringify(sizes));
  }

  // ---- 4. 同一天重启：接着写，不重置上限 ----
  {
    const store = new EvidenceStore(tmp);
    const a = new RollingJsonl(store, "d4", { maxBytes: 100, keepDays: 0 });
    const line = JSON.stringify({ pad: "y".repeat(100) }) + "\n";  // 111 B > 上限
    a.write(line);   // part0 落盘后已满
    await a.end();
    const b = new RollingJsonl(store, "d4", { maxBytes: 100, keepDays: 0 });
    b.write(line);
    await b.end();
    const files = lsJsonl("d4");
    check("重启后跳到新分片而不是撑爆旧文件",
      files.length === 2 && files.includes(`${ymd()}.1.jsonl`), JSON.stringify(files));
  }

  // ---- 5. sweep 只删过期的自有分片 ----
  {
    const store = new EvidenceStore(tmp);
    const dir = path.join(tmp, "d5");
    fs.mkdirSync(dir, { recursive: true });
    const old = ymd(new Date(Date.now() - 30 * 86400000));
    const recent = ymd(new Date(Date.now() - 1 * 86400000));
    fs.writeFileSync(path.join(dir, `${old}.jsonl`), "x\n");
    fs.writeFileSync(path.join(dir, `${old}.1.jsonl`), "x\n");
    fs.writeFileSync(path.join(dir, `${recent}.jsonl`), "x\n");
    fs.writeFileSync(path.join(dir, "notes.txt"), "user file\n");
    fs.writeFileSync(path.join(dir, "keepme.jsonl"), "not our naming\n");
    const removed = new RollingJsonl(store, "d5", { keepDays: 14 }).sweep();
    const left = fs.readdirSync(dir).sort();
    check("sweep 删掉过期分片", removed === 2 && !left.includes(`${old}.jsonl`),
      `removed=${removed} left=${JSON.stringify(left)}`);
    check("sweep 保留窗口内的分片", left.includes(`${recent}.jsonl`), JSON.stringify(left));
    check("sweep 不碰非自有命名的文件",
      left.includes("notes.txt") && left.includes("keepme.jsonl"), JSON.stringify(left));
    check("keepDays=0 关闭清理",
      new RollingJsonl(store, "d5", { keepDays: 0 }).sweep() === 0);
  }

  // ---- 6. auditSafe：args 保真 / result 裁剪 ----
  {
    // workflow_save 从 ext-> tool_call 的 args 重建可回放步骤，这里一旦被
    // 改写，录制出来的流程回放就会静默填错值。
    const call = auditSafe({
      dir: "ext->", type: "tool_call",
      payload: { name: "fill", args: { ref: "e3", value: "hunter2" } },
    });
    check("tool_call 的 args 原样保留（回放源）",
      call.payload.args.value === "hunter2" && call.payload.args.ref === "e3",
      JSON.stringify(call.payload));

    const imp = auditSafe({
      dir: "ext->", type: "tool_call",
      payload: { name: "import_state", args: { state: { cookies: [1, 2, 3] } } },
    });
    check("tool_call 的整包凭据参数被抹掉",
      typeof imp.payload.args.state === "string" && /redacted/.test(imp.payload.args.state),
      JSON.stringify(imp.payload));

    const res = auditSafe({
      dir: "ext<-", type: "tool_result",
      payload: { ok: true, cookies: [{ name: "sid", value: "secret", httpOnly: true }] },
    });
    check("tool_result 里的 cookie 被抹掉",
      typeof res.payload.cookies === "string" && !JSON.stringify(res.payload).includes("secret"),
      JSON.stringify(res.payload));

    const big = auditSafe({
      dir: "ext<-", type: "tool_result",
      payload: { data: "A".repeat(50000), format: "png" },
    });
    const bigLen = JSON.stringify(big).length;
    check("超大 result 被裁到上限内（截图 base64 / 整页正文）",
      bigLen < 3000 && !!big.payload._omitted, `len=${bigLen}`);

    check("auditSafe 不因坏输入抛错", (() => {
      const cyc = { self: null }; cyc.self = cyc;
      try { auditSafe({ dir: "ext<-", type: "tool_result", payload: cyc }); return true; }
      catch (e) { return false; }
    })());
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}

process.exitCode = summarize();  // summarize 返回的就是退出码（失败 1）
