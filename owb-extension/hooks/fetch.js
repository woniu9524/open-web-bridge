/**
 * Open Web Bridge — fetch Hook 预设
 *
 * 运行环境：页面 main world，由 Page.addScriptToEvaluateOnNewDocument 注入。
 * 包装 window.fetch：请求（url/method/headers/body + 调用栈）与响应
 * （status + 克隆 body 截断）分两阶段经 __owbReport 回传。
 *
 * toString 原生样式走 window.__owbSpoof 共享机制（多 preset 共存只包一层补丁）。
 */
(() => {
  if (window.__owbFetchHooked) return; // 幂等：重复注入不重复包裹
  window.__owbFetchHooked = true;

  const MAX_FIELD = 4000;

  // BUG-37: 上报时必须用**原生** JSON.stringify。crypto 预设会包裹
  // JSON.stringify，两个预设同时注入时，本文件每上报一次就会反向触发一条
  // 假的 JSON.stringify 调用事件——而 crypto 预设的全部用途就是回答
  // 「页面到底调了多少次 JSON.stringify」。xhr.js / crypto.js / fn_hook.js
  // 都存了原生引用，只有这里漏了。
  const nativeStringify = JSON.stringify;

  const truncate = (s) =>
    s && s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + "…(truncated)" : s;

  const report = (obj) => {
    try {
      if (typeof __owbReport === "function") {
        __owbReport(
          nativeStringify({
            preset: "fetch",
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

  const nativeFetch = window.fetch;
  let nextId = 1;

  const bodyToStr = (body) => {
    try {
      if (body == null) return null;
      if (typeof body === "string") return truncate(body);
      if (body instanceof URLSearchParams) return truncate(body.toString());
      if (body instanceof FormData) {
        const o = {};
        body.forEach((v, k) => {
          o[k] = typeof v === "string" ? v : `[${v && v.constructor ? v.constructor.name : typeof v}]`;
        });
        return truncate(nativeStringify(o));
      }
      return `[${body.constructor ? body.constructor.name : typeof body}]`;
    } catch (e) {
      return null;
    }
  };

  window.fetch = function fetch(input, init) {
    const id = nextId++;
    let url = null;
    let method = "GET";
    let headers = {};
    let body = null;
    try {
      if (typeof input === "string") {
        url = input;
      } else if (input && input.url) {
        url = input.url; // Request 对象
        method = input.method || method;
        if (input.headers && typeof input.headers.forEach === "function") {
          input.headers.forEach((v, k) => { headers[k] = v; });
        }
      }
      if (init) {
        if (init.method) method = String(init.method);
        if (init.headers) {
          const h = init.headers;
          if (typeof h.forEach === "function") h.forEach((v, k) => { headers[k] = v; });
          else if (Array.isArray(h)) h.forEach(([k, v]) => { headers[k] = v; });
          else Object.assign(headers, h);
        }
        body = bodyToStr(init.body);
      }
    } catch (e) {}

    report({
      phase: "request",
      id,
      method,
      url: String(url),
      headers,
      body,
      stack: new Error().stack || null,
    });

    let result;
    try {
      result = nativeFetch.apply(this, arguments);
    } catch (e) {
      report({ phase: "error", id, url: String(url), error: String(e) });
      throw e;
    }
    result.then((resp) => {
      try {
        const meta = {
          phase: "response",
          id,
          status: resp.status,
          responseURL: resp.url,
          contentType: resp.headers ? resp.headers.get("content-type") : null,
        };
        report(meta);
        // 只克隆文本类响应读 body，二进制/流不碰（读 body 会消费流，克隆也有成本）
        const ct = meta.contentType || "";
        if (/text|json|javascript|xml|form|html/i.test(ct)) {
          resp.clone().text().then((t) => {
            report({ phase: "responseBody", id, body: truncate(t) });
          }).catch(() => {});
        }
      } catch (e) {}
    }).catch((e) => {
      report({ phase: "error", id, url: String(url), error: String(e) });
    });
    return result;
  };
  markNative(window.fetch);
})();
