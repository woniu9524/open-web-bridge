/**
 * 离线验证：node:vm 沙箱运行提取出的函数，对样本库逐一比对。
 *
 * 报 pass_rate + 字符级首偏差点（first_divergence），用于：
 * - 协议代码的 unit test：N 个真实样本离线验证，改完代码先跑一次再麻烦服务端
 * - 站点改版后定位"哪里变了"
 */
import vm from "node:vm";

/** 比对用字符串化：对象/数组走 JSON，其余走 String。 */
function cmpStr(v) {
  return v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** 逐 param 比对，返回第一个偏差点的字符级定位；完全一致返回 null。 */
export function first_divergence(expected, computed) {
  if (typeof computed !== "object" || computed === null || Array.isArray(computed)) {
    computed = {};
  }
  for (const [key, exp] of Object.entries(expected || {})) {
    const got = computed[key];
    const expS = cmpStr(exp);
    const gotS = cmpStr(got);
    if (expS === gotS) continue;
    let i = 0;
    const limit = Math.min(expS.length, gotS.length);
    while (i < limit && expS[i] === gotS[i]) i++;
    return {
      param: key,
      index: i,
      expected: expS.slice(Math.max(0, i - 10), i + 10),
      got: gotS.slice(Math.max(0, i - 10), i + 10),
      expected_len: expS.length,
      got_len: gotS.length,
    };
  }
  return null;
}

const SIGNER_TIMEOUT_MS = 5000;

/**
 * 建沙箱上下文。
 *
 * 裸 Object.create(null) 里连 TextEncoder / btoa 都没有，而真实站点的签名算法
 * 里 base64 和 UTF-8 编码基本是标配 —— 报错只有一句 "TextEncoder is not
 * defined"，调用方分不清是自己代码写错了还是沙箱缺东西。补齐这几个编码原语。
 *
 * ⚠️ vm **不是安全边界**（Node 官方明示），signer_code 以 daemon 的权限运行。
 * 在本地信任模型下这不额外放大风险——能连上 /ctl 的进程本来就能驱动整个浏览器
 * ——但别把它当沙箱使，也别把不可信的第三方代码丢进来。
 */
function makeSignerContext() {
  return vm.createContext({
    TextEncoder, TextDecoder, URLSearchParams,
    btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
    atob: (s) => Buffer.from(String(s), "base64").toString("binary"),
  });
}

/** 求值 signer_code，返回 { ctx, fn }。 */
function evalSigner(signerCode) {
  const ctx = makeSignerContext();
  const fn = vm.runInContext(signerCode, ctx, { timeout: SIGNER_TIMEOUT_MS });
  return { ctx, fn };
}

/**
 * 调用 signer。**调用本身必须发生在 vm 里**——原来 5s timeout 只包住了
 * "求值 signer_code" 这一步，真正的 fn(...) 在宿主里同步执行、零超时保护，
 * 于是 signer 里一个 while(true) 或病态正则就能把单进程 daemon（连同它上面
 * 所有 WS 连接）永久挂死。而 signer_code 恰恰是 AI 生成的、最不可信的输入。
 *
 * 结果经 JSON 往返回传：既避免把 vm realm 的对象漏进宿主，也正好是
 * first_divergence 需要的形状。
 */
function callSigner(ctx, fn, argv) {
  ctx.__owbFn = fn;
  ctx.__owbArgv = JSON.stringify(argv ?? []);
  const json = vm.runInContext(
    "(() => { const r = __owbFn.apply(null, JSON.parse(__owbArgv));" +
    "  return r === undefined ? null : JSON.stringify(r); })()",
    ctx,
    { timeout: SIGNER_TIMEOUT_MS },
  );
  return json === null || json === undefined ? null : JSON.parse(json);
}

/**
 * UX-109 dry-run：只跑不对拍。calls: [{args:[...]}]。
 *
 * 没有 expected 就没有对拍基准——拿函数自己的输出当 expected 等于自己跟自己比，
 * 必然 pass，是假成功。所以这里不产 pass_rate，只把算出来的值交回给调用方看。
 */
export function dry_run_signer(signer_code, calls) {
  let probe;
  try {
    probe = evalSigner(signer_code).fn;
  } catch (e) {
    return { ok: false, error: "signer_code eval failed: " + e.message };
  }
  if (typeof probe !== "function") {
    return { ok: false, error: "signer_code did not evaluate to a function, got " + typeof probe };
  }
  const results = (calls || []).map((c, i) => {
    const id = (c && c.id) || `call-${i}`;
    const argv = Array.isArray(c && c.args) ? c.args : [c && c.args];
    try {
      const { ctx, fn } = evalSigner(signer_code);
      const computed = callSigner(ctx, fn, argv);
      return { id, ok: true, computed: computed === undefined ? null : computed };
    } catch (e) {
      return { id, ok: false, error: String(e && e.message ? e.message : e) };
    }
  });
  return {
    ok: results.every((r) => r.ok),
    mode: "dry_run",
    total: results.length,
    results,
    hint: "dry_run computes outputs only — no expected values to compare against. " +
      "Pass samples: [{id, input, expected}] (expected from oracle_call) to get pass_rate.",
  };
}

/**
 * 离线验证提取出的函数。samples: [{id, input, expected}]
 * signer_code 必须求值为函数 (sampleInput) => {param: value}
 * 每个样本在独立 vm 上下文中执行。
 */
export function verify_signer(signer_code, samples) {
  if (!samples || !samples.length) return { ok: false, error: "no samples" };

  // 先验证 signer_code 能求值为函数
  let probe;
  try {
    probe = evalSigner(signer_code).fn;
  } catch (e) {
    return { ok: false, error: "signer_code eval failed: " + e.message };
  }
  if (typeof probe !== "function") {
    return { ok: false, error: "signer_code did not evaluate to a function, got " + typeof probe };
  }

  const results = [];
  let passed = 0;
  for (const sample of samples) {
    let res;
    try {
      const { ctx, fn } = evalSigner(signer_code);
      const computed = callSigner(ctx, fn, [sample.input]);
      res = { computed: computed === undefined ? null : computed };
    } catch (e) {
      res = { error: String(e && e.message ? e.message : e) };
    }
    if ("error" in res) {
      results.push({ id: sample.id, ok: false, error: res.error });
      continue;
    }
    // 样本没给 expected 时，first_divergence 遍历的是 expected 的键：空对象
    // → 零次循环 → 返回 null → 判定通过。于是「忘了写 expected」会得到
    // pass_rate 1.0 的假绿，正好违背本文件 dry_run_signer 处立的规矩
    //（没有基准就不产 pass_rate）。缺基准就是坏样本，直接判失败并说清楚。
    if (sample.expected === undefined || sample.expected === null) {
      results.push({
        id: sample.id, ok: false,
        error: "sample has no `expected` — nothing to compare against. " +
          "Give the expected params from a real captured request, or call " +
          "with `calls` instead to dry-run the signer without a baseline.",
      });
      continue;
    }
    const div = first_divergence(sample.expected, res.computed);
    const ok = div === null;
    if (ok) passed++;
    const entry = { id: sample.id, ok };
    if (div) entry.first_divergence = div;
    results.push(entry);
  }

  const total = samples.length;
  return {
    ok: passed === total,
    pass_rate: Math.round((passed / total) * 10000) / 10000,
    passed,
    total,
    results,
  };
}
