/**
 * Open Web Bridge — crypto Hook 预设
 *
 * 运行环境：页面 main world，由 Page.addScriptToEvaluateOnNewDocument 注入。
 * 监视页面常用的编解码/序列化原语：btoa / atob / JSON.stringify，
 * 命中带截断的入参/返回值与调用栈经 __owbReport 回传。
 *
 * ⚠️ 高频源：JSON.stringify 在复杂站点每秒可命中上千次，daemon 侧请配合
 * 订阅过滤（ctl subscribe sources/url_pattern）使用，原始事件全量落盘 work/。
 *
 * toString 原生样式走 window.__owbSpoof 共享机制（多 preset 共存只包一层补丁）。
 */
(() => {
  if (window.__owbCryptoHooked) return; // 幂等：重复注入不重复包裹
  window.__owbCryptoHooked = true;

  const MAX_FIELD = 2000;

  const truncate = (s) =>
    s && s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + "…(truncated)" : s;

  const report = (obj) => {
    try {
      if (typeof __owbReport === "function") {
        __owbReport(
          JSON.stringify({
            preset: "crypto",
            href: location.href,
            ts: Date.now(),
            ...obj,
          })
        );
      }
    } catch (e) {}
  };

  // ---- toString 原生样式（__owbSpoof 全局共享 WeakSet，多 preset 共存只包一层）----
  window.__owbSpoof = window.__owbSpoof || { installed: false, set: new WeakSet() };
  const spoof = window.__owbSpoof;
  if (!spoof.installed) {
    const nativeToString = Function.prototype.toString;
    const set = spoof.set;
    Function.prototype.toString = function toString() {
      if (set.has(this)) return `function ${this.name}() { [native code] }`;
      return nativeToString.call(this);
    };
    spoof.set.add(Function.prototype.toString);
    spoof.installed = true;
  }
  const markNative = (fn) => spoof.set.add(fn);

  const argStr = (v) => {
    try {
      if (typeof v === "string") return truncate(v);
      return truncate(JSON.stringify(v));
    } catch (e) {
      return String(typeof v);
    }
  };

  const nativeBtoa = window.btoa;
  window.btoa = function btoa(data) {
    const ret = nativeBtoa.apply(this, arguments);
    report({ fn: "btoa", input: argStr(data), output: truncate(String(ret)) });
    return ret;
  };
  markNative(window.btoa);

  const nativeAtob = window.atob;
  window.atob = function atob(data) {
    const ret = nativeAtob.apply(this, arguments);
    report({ fn: "atob", input: argStr(data), output: truncate(String(ret)) });
    return ret;
  };
  markNative(window.atob);

  // JSON.stringify 只报调用栈采样 + 截断结果（最高频，字段给最小）
  const nativeStringify = JSON.stringify;
  JSON.stringify = function stringify(value, replacer, space) {
    const ret = nativeStringify.apply(this, arguments);
    report({
      fn: "JSON.stringify",
      output: truncate(String(ret)),
      stack: new Error().stack || null,
    });
    return ret;
  };
  markNative(JSON.stringify);
})();
