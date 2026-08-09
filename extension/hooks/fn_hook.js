/**
 * Open Web Bridge — 自定义函数 Hook 模板（hook_function）
 *
 * 注入前由扩展把 /*__OWB_OPTS__*\/null 占位替换为 JSON：
 * {
 *   key,            // 注册表键：fn:<path>#<position>，幂等依据
 *   path,           // 如 "XMLHttpRequest.prototype.open" / "MyNS.sign"
 *   position,       // "before" | "after" | "replace"
 *   hookCode,       // 自定义 JS，回调参数 (args, result, stack)
 *   replacement,    // replace 模式的函数源码（函数表达式）
 *   trace: { args, ret, stack },
 *   nonOverridable  // defineProperty writable:false，防页面 SDK 覆盖
 * }
 *
 * 时序：注入早于页面脚本（addScriptToEvaluateOnNewDocument），页面自定义的
 * 全局函数注入时可能尚不存在 → 模板按 100ms×15s 轮询等待目标出现后再安装，
 * 超时报 phase:"error"。已存在则同步安装/报错。
 */
(() => {
  const OPTS = /*__OWB_OPTS__*/null/*__OWB_OPTS_END__*/;
  if (!OPTS || !OPTS.path) return;
  window.__owbFnHooked = window.__owbFnHooked || {};
  if (window.__owbFnHooked[OPTS.key]) return; // 幂等
  window.__owbFnHooked[OPTS.key] = true;

  const MAX_FIELD = 2000;
  const report = (obj) => {
    try {
      if (typeof __owbReport === "function") {
        __owbReport(
          JSON.stringify({ preset: "fn", href: location.href, ts: Date.now(), ...obj })
        );
      }
    } catch (e) {}
  };
  const safeVal = (v) => {
    try {
      if (typeof v === "string") {
        return v.length > MAX_FIELD ? v.slice(0, MAX_FIELD) + "…(truncated)" : v;
      }
      const s = JSON.stringify(v);
      if (s === undefined) return String(v);
      return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + "…(truncated)" : s;
    } catch (e) {
      return "[unserializable]";
    }
  };
  const safeArgs = (args) => Array.prototype.map.call(args, safeVal);

  // toString 原生样式：全局共享 WeakSet，与 xhr 预设等共存兼容
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

  // 解析路径："a.b.c" → owner=a.b, name="c"（"window" 段跳过）
  const segs = OPTS.path.split(".");
  const name = segs[segs.length - 1];
  const resolve = () => {
    let owner = window;
    for (let i = 0; i < segs.length - 1; i++) {
      if (segs[i] === "window") continue;
      owner = owner && owner[segs[i]];
    }
    return owner;
  };

  const install = (owner) => {
    if (typeof owner[name] !== "function") {
      report({ phase: "error", key: OPTS.key, error: "not a function: " + OPTS.path });
      return;
    }
    const original = owner[name];
    const custom = OPTS.hookCode
      ? new Function("args", "result", "stack", OPTS.hookCode)
      : null;
    const replacement = OPTS.replacement ? (0, eval)("(" + OPTS.replacement + ")") : null;

    const hooked = function (...args) {
      const stack = OPTS.trace && OPTS.trace.stack ? new Error().stack : null;
      if (OPTS.position === "replace") {
        return replacement ? replacement.apply(this, args) : undefined;
      }
      if (OPTS.position === "before") {
        if (OPTS.trace && OPTS.trace.args) {
          report({ key: OPTS.key, phase: "call", path: OPTS.path, args: safeArgs(args), stack });
        }
        if (custom) {
          try {
            custom.call(this, args, undefined, stack);
          } catch (e) {}
        }
        return original.apply(this, args);
      }
      // after：先执行原函数拿到返回值再上报
      const ret = original.apply(this, args);
      if (OPTS.trace && (OPTS.trace.args || OPTS.trace.ret)) {
        report({
          key: OPTS.key,
          phase: "return",
          path: OPTS.path,
          args: OPTS.trace.args ? safeArgs(args) : undefined,
          returnValue: OPTS.trace.ret ? safeVal(ret) : undefined,
          stack,
        });
      }
      if (custom) {
        try {
          custom.call(this, args, ret, stack);
        } catch (e) {}
      }
      return ret;
    };
    Object.defineProperty(hooked, "name", { value: name });
    markNative(hooked);

    if (OPTS.nonOverridable) {
      Object.defineProperty(owner, name, {
        value: hooked,
        writable: false,
        configurable: false,
      });
    } else {
      owner[name] = hooked;
    }
    report({ phase: "installed", key: OPTS.key, path: OPTS.path, position: OPTS.position });
  };

  const ownerNow = resolve();
  if (ownerNow && name in ownerNow) {
    // 目标已存在：立即安装/报错（同步语义不变）
    install(ownerNow);
  } else {
    // addScriptToEvaluateOnNewDocument 先于页面任何脚本执行，页面自定义的
    // 全局函数（及懒加载 SDK）此时尚未定义——轮询等待出现（真机 e2e 实测踩坑）。
    let waited = 0;
    const timer = setInterval(() => {
      waited += 100;
      const owner = resolve();
      if (owner && name in owner) {
        clearInterval(timer);
        install(owner);
      } else if (waited >= 15000) {
        clearInterval(timer);
        report({ phase: "error", key: OPTS.key, error: "not found after 15s: " + OPTS.path });
      }
    }, 100);
    if (timer.unref) timer.unref(); // Node 单测环境不拖住事件循环
  }
})();
