/**
 * Open Web Bridge — xhr Hook 预设
 *
 * 运行环境：页面 main world，由 Page.addScriptToEvaluateOnNewDocument 注入，
 * 必须早于页面任何脚本执行。命中通过 CDP Runtime.addBinding 的 __owbReport 回传。
 *
 * 所有包裹函数登记进 window.__owbSpoof 共享 WeakSet，
 * Function.prototype.toString 的共享补丁对标记函数返回 "[native code]" 原生样式。
 */
(() => {
  if (window.__owbXhrHooked) return; // 幂等：重复注入不重复包裹
  window.__owbXhrHooked = true;

  const MAX_FIELD = 4000;

  // BUG-37 防御: 保存原生 JSON.stringify。crypto 预设会包裹 JSON.stringify，
  // 若同时注入，report() 调全局 JSON.stringify 会触发 crypto hook → report → 递归。
  const nativeStringify = JSON.stringify;

  const truncate = (s) =>
    s && s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + "…(truncated)" : s;

  const report = (obj) => {
    try {
      if (typeof __owbReport === "function") {
        __owbReport(
          nativeStringify({
            preset: "xhr",
            href: location.href,
            ts: Date.now(),
            ...obj,
          }),
        );
      }
    } catch (e) {}
  };

  // ---- toString 原生样式（__owbSpoof 全局共享 WeakSet，多 preset 共存只包一层）----
  // 注意：成员表达式赋值（X.open = function(){}）不触发 ES6 函数名推断，
  // 必须用命名函数表达式，否则原生样式串里函数名为空。
  window.__owbSpoof = window.__owbSpoof || {
    installed: false,
    set: new WeakSet(),
  };
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

  const X = XMLHttpRequest.prototype;
  const nativeOpen = X.open;
  const nativeSend = X.send;
  const nativeSetHeader = X.setRequestHeader;
  let nextId = 1;

  X.open = function open(method, url) {
    this.__owb = {
      id: nextId++,
      method: String(method),
      url: String(url),
      headers: {},
    };
    return nativeOpen.apply(this, arguments);
  };
  markNative(X.open);

  X.setRequestHeader = function setRequestHeader(key, value) {
    if (this.__owb) this.__owb.headers[String(key)] = String(value);
    return nativeSetHeader.apply(this, arguments);
  };
  markNative(X.setRequestHeader);

  X.send = function send(body) {
    const meta = this.__owb || (this.__owb = { id: nextId++ });
    let bodyStr = null;
    try {
      bodyStr = body == null ? null : truncate(String(body));
    } catch (e) {}
    report({
      phase: "request",
      id: meta.id,
      method: meta.method,
      url: meta.url,
      headers: meta.headers,
      body: bodyStr,
      stack: new Error().stack || null,
    });

    this.addEventListener("loadend", function () {
      let resp = null;
      try {
        if (!this.responseType || this.responseType === "text") {
          resp = truncate(String(this.responseText));
        } else if (this.responseType === "json") {
          resp = truncate(nativeStringify(this.response));
        }
      } catch (e) {}
      report({
        phase: "response",
        id: meta.id,
        status: this.status,
        responseURL: this.responseURL,
        body: resp,
      });
    });

    return nativeSend.apply(this, arguments);
  };
  markNative(X.send);
})();
