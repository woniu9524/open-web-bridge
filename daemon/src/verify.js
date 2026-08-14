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

/** 在独立 vm 上下文求值 signer_code（无 require/无 Node 全局，贴近纯算法环境）。 */
function evalSigner(signerCode) {
  return vm.runInNewContext(signerCode, Object.create(null), { timeout: 5000 });
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
    probe = evalSigner(signer_code);
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
      const fn = evalSigner(signer_code);
      const computed = fn(...argv);
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
    probe = evalSigner(signer_code);
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
      const fn = evalSigner(signer_code);
      const computed = fn(sample.input);
      res = { computed: computed === undefined ? null : computed };
    } catch (e) {
      res = { error: String(e && e.message ? e.message : e) };
    }
    if ("error" in res) {
      results.push({ id: sample.id, ok: false, error: res.error });
      continue;
    }
    const div = first_divergence(sample.expected || {}, res.computed);
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
