/**
 * 请求重放：curl-impersonate 独立 exe 带浏览器 TLS 指纹重放，验证请求可脱离浏览器复现。
 * 子进程调 curl-impersonate（lexiforest/curl-impersonate，保 JA3 指纹）。
 *
 * 二进制查找顺序：env OWB_CURL_BINARY → <repo>/bin/ 下 curl-impersonate* → PATH。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_BODY_DEFAULT = 4000;
const DOWNLOAD_URL = "https://github.com/lexiforest/curl-impersonate/releases";

// 浏览器族别名 → 具体 impersonate 目标（v2 二进制不认裸 "chrome"）；
// 已带版本号的目标（chrome136/firefox147…）原样透传
const IMPERSONATE_ALIAS = {
  chrome: "chrome136",
  edge: "edge101",
  firefox: "firefox135",
  safari: "safari180",
};

/** curl-impersonate 二进制查找；找不到返回 null。 */
function findCurlBinary() {
  const envBin = process.env.OWB_CURL_BINARY;
  if (envBin && fs.existsSync(envBin)) return envBin;

  // <repo>/bin/ 下 curl-impersonate*（.exe）
  const binDir = path.join(REPO_ROOT, "bin");
  try {
    const hit = fs.readdirSync(binDir)
      .filter((f) => /^curl-impersonate/i.test(f))
      .sort()[0];
    if (hit) return path.join(binDir, hit);
  } catch (e) { /* bin/ 不存在 */ }

  // PATH
  const names = process.platform === "win32"
    ? ["curl-impersonate.exe", "curl-impersonate-chrome.exe"]
    : ["curl-impersonate", "curl-impersonate-chrome"];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function execFileP(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** 解析 -D 落盘的响应头：取最后一个 header 块（跳过重定向/100-continue）。 */
function parseHeaders(raw) {
  const blocks = raw.split(/\r?\n\r?\n/).filter((b) => b.trim());
  const last = blocks.length ? blocks[blocks.length - 1] : "";
  const lines = last.split(/\r?\n/);
  const status = parseInt((lines[0] || "").split(/\s+/)[1], 10) || 0;
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { status, headers };
}

/**
 * 重放一条请求。
 *
 * spec: {
 *   method, url, headers, body, params,
 *   impersonate (默认 "chrome"), allow_redirects (默认 false),
 *   max_body (响应体回传截断，默认 4000)
 * }
 */
export async function replay(spec, timeout = 20.0) {
  if (!spec || !spec.url) return { ok: false, error: "replay: url is required" };
  const binary = findCurlBinary();
  if (!binary) {
    return {
      ok: false,
      error:
        "curl-impersonate 二进制未找到。请从 " + DOWNLOAD_URL +
        " 下载 curl-impersonate（.exe），放到 <repo>/bin/ 或加入 PATH，" +
        "也可设 OWB_CURL_BINARY 指向它",
    };
  }

  const method = String(spec.method || "GET").toUpperCase();
  const maxBody = spec.max_body ? Math.trunc(Number(spec.max_body)) : MAX_BODY_DEFAULT;
  let url = spec.url;
  if (spec.params && typeof spec.params === "object") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(spec.params)) qs.append(k, String(v));
    url += (url.includes("?") ? "&" : "?") + qs.toString();
  }

  // -D/-o 临时文件分离响应头与 body
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-replay-"));
  const headerFile = path.join(tmp, "headers.txt");
  const bodyFile = path.join(tmp, "body.bin");

  const args = ["-sS", "-X", method, "--max-time", String(timeout)];
  const target = String(spec.impersonate || "chrome");
  args.push("--impersonate", IMPERSONATE_ALIAS[target] || target);
  if (spec.allow_redirects) args.push("-L");
  for (const [k, v] of Object.entries(spec.headers || {})) {
    args.push("-H", `${k}: ${v}`);
  }
  if (spec.body !== null && spec.body !== undefined) {
    args.push("--data-raw", String(spec.body));
  }
  args.push("-D", headerFile, "-o", bodyFile, url);

  const started = performance.now();
  let headerRaw = "";
  let body = "";
  try {
    await execFileP(binary, args, {
      timeout: (timeout + 5) * 1000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    try { headerRaw = fs.readFileSync(headerFile, "utf8"); } catch (e) {}
    try { body = fs.readFileSync(bodyFile, "utf8"); } catch (e) {}
  } catch (e) {
    const detail = (e.stderr || e.message || String(e)).trim().slice(0, 500);
    return { ok: false, error: `curl-impersonate failed: ${detail}` };
  } finally {
    // 临时文件即读即清
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
  const elapsedMs = Math.trunc(performance.now() - started);

  const { status, headers } = parseHeaders(headerRaw);
  const truncated = body.length > maxBody;
  return {
    ok: true,
    data: {
      status,
      headers,
      body: body.slice(0, maxBody) + (truncated ? "…(truncated)" : ""),
      body_len: body.length,
      elapsed_ms: elapsedMs,
    },
  };
}
