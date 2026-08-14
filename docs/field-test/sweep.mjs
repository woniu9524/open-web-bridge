/**
 * 广度扫描：对一批真实站点跑核心链路（open → page → article），
 * 收集耗时/快照体量/元素数/错误码，落成 JSONL 供分析。
 *
 * 目的不是"跑通"，而是**暴露差异**：哪些站快照为空、哪些超时、
 * 哪些 article 提取不出正文、哪些报没见过的错误码。
 *
 * 用法：node docs/field-test/sweep.mjs <sites.json> <out.jsonl> [起始下标]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "..", "..", "owb-daemon", "src", "cli.js");

const [, , sitesFile, outFile, startIdxRaw] = process.argv;
const startIdx = parseInt(startIdxRaw || "0", 10);
const sites = JSON.parse(fs.readFileSync(sitesFile, "utf8"));

function owb(args, timeoutMs = 70000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const killer = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => {
      clearTimeout(killer);
      let data = null;
      try { data = JSON.parse(out); } catch {}
      const m = err.match(/error (\w+): ([^\n]*)/);
      resolve({
        ms: Date.now() - t0,
        code,
        data,
        errCode: m ? m[1] : (code === 0 ? null : "CLI_FAIL"),
        errMsg: m ? m[2].slice(0, 200) : (code === 0 ? null : err.slice(0, 200)),
      });
    });
  });
}

const out = fs.createWriteStream(outFile, { flags: "a" });

for (let i = startIdx; i < sites.length; i++) {
  const site = sites[i];
  const rec = { i, name: site.name, url: site.url, tags: site.tags || [] };

  // 1. 打开（新 tab，避免污染用户当前页）
  const nav = await owb(["open", site.url, "--new-tab", "true", "--compact"]);
  rec.nav = { ms: nav.ms, ok: !nav.errCode, err: nav.errCode, msg: nav.errMsg };
  const tabId = nav.data && nav.data.tabId;
  rec.finalUrl = nav.data && nav.data.url;
  rec.title = nav.data && nav.data.title;

  if (tabId) {
    // 2. 语义快照
    const snap = await owb(["page", "--tab", String(tabId), "--compact"]);
    const lines = snap.data && snap.data.lines ? snap.data.lines : "";
    rec.snapshot = {
      ms: snap.ms,
      ok: !snap.errCode,
      err: snap.errCode,
      msg: snap.errMsg,
      bytes: lines.length,
      refs: (lines.match(/@e\d+/g) || []).length,
      // 有多少 ref 是"哑"的（没有可读文字，AI 无从判断点它干嘛）
      blankRefs: (lines.match(/@e\d+ \w+ ""/g) || []).length,
    };

    // 3. 正文提取（内容站才有意义，但全测——看非内容站会不会误报）
    const art = await owb(["page", "--tab", String(tabId), "--mode", "article", "--compact"]);
    const artText = art.data && (art.data.markdown || art.data.text || "");
    rec.article = {
      ms: art.ms,
      ok: !art.errCode,
      err: art.errCode,
      chars: typeof artText === "string" ? artText.length : 0,
    };

    // 4. 关掉，别把用户浏览器堆满
    await owb(["tab", "close", "--tab", String(tabId), "--compact"], 20000);
  }

  out.write(JSON.stringify(rec) + "\n");
  const flag = rec.nav.ok ? (rec.snapshot && rec.snapshot.refs > 0 ? "ok" : "EMPTY") : "NAV_FAIL";
  console.log(
    `[${i + 1}/${sites.length}] ${flag.padEnd(8)} ${site.name.padEnd(16)} ` +
    `nav=${rec.nav.ms}ms snap=${rec.snapshot ? rec.snapshot.refs + "refs/" + rec.snapshot.bytes + "B" : "-"} ` +
    `art=${rec.article ? rec.article.chars + "c" : "-"} ${rec.nav.err || rec.snapshot?.err || ""}`,
  );
}

out.end();
console.log("done");
