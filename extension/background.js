"use strict";
/**
 * Open Web Bridge — MV3 service worker
 *
 * 职责：
 *  - WS client：连本地 daemon，hello 握手、ping/pong、tool_call/tool_result 路由
 *  - SW 保活：chrome.alarms 心跳，防 MV3 service worker 空闲 30s 被回收导致断连
 *  - CDP 会话池：chrome.debugger per-tab attach（worker target 未覆盖）
 *  - 事件转发：Network 域事件 → 本地 buffer + event 推流给 daemon
 *
 * 工具集：
 *  基础: status / list_tabs / find_tab / navigate / evaluate / close_tab
 *  通用: screenshot / click / fill / send_keys / cdp（任意 CDP 逃生舱）
 *  交互盲区: download / upload / print_pdf / list_frames（iframe 定向 evaluate frame_pattern）
 *  环境模拟: emulate（设备/网络/地理/时区/语言/权限/UA） / emulate_reset
 *  抓包: network_start / network_stop / network_list / network_detail / get_initiator
 *  录制(HAR): record_start / record_stop / record_status（独立 recorder，主动收 body
 *            + timing + WebSocket；附 console 归档 / storage 变更流 / 导航截图；
 *            url/resource_type 过滤、多 tab 合并、护栏防爆内存）
 *  脚本: script_list / script_source / search_code（含 eval/VM 动态脚本）
 *  Cookie: cookie_get / cookie_set / cookie_delete
 *  Hook: hook_preset(xhr/fetch/crypto) / hook_function / hook_remove / hook_status
 *  函数调用: oracle_call（window 路径 / objectId 双寻址，确定性冻结元数据）
 *  调试器: break_xhr / break_function / break_remove / frame_read（frozen-snapshot）/ step / resume
 *  证据包: capture_request / console_stream
 *  快照: export_state / import_state（cookie 含 HttpOnly + ls/ss + IndexedDB）
 *  脚本改写: script_patch / script_unpatch / watch_script / watch_remove（Fetch 改写 + fail-safe）
 *  环境: env_compare（navigator/screen/document/features 四批基准采集）
 *  读页: read_page（snapshot 稳定 @e ref / article / text）+ wait_for（selector/text/url/network_idle 轮询）
 *  任务: task_context（navigate new_tab 按任务编组）+ click/fill/screenshot 支持 @e ref（REF_STALE）
 *  鼠标: mouse_click（真实 Input.dispatchMouseEvent + AI 光标贝塞尔移动/涟漪，selector 或 @e ref）
 *  交接: handoff（编入「✋ OWB 等你操作」组交还用户）/ wait_user（url_change/selector/text 轮询接管）
 *        ⚠️ wait_user timeout_ms 上限 280s；经 MCP 调用须把 timeout 调到 ≥ timeout_ms/1000 + 10
 *          （MCP 默认 120s 会在长等待中途掐断）
 *  安全: Fetch fail-safe（WS 断连即放行）+ 死开关（daemon 45s 不可达全量 detach）
 */

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

import { Stats, StatsBuilder } from "./har/stats.js";
import { HARBuilder } from "./har/builder.js";

const DEFAULT_CONFIG = {
  wsUrl: "ws://127.0.0.1:18086/ws",
  relayUrl: "",
  relayToken: "",
};

let config = { ...DEFAULT_CONFIG, relayMode: false };

// 中转 URL：relayUrl + relayToken 齐备时拼成 wss://<relay>/<token>?role=extension
function relayUrlOf(cfg) {
  if (!cfg.relayUrl || !cfg.relayToken) return null;
  return `${cfg.relayUrl.replace(/\/+$/, "")}/${encodeURIComponent(cfg.relayToken)}?role=extension`;
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(["wsUrl", "relayUrl", "relayToken"]);
  config.wsUrl = stored.wsUrl || DEFAULT_CONFIG.wsUrl;
  config.relayUrl = stored.relayUrl || "";
  config.relayToken = stored.relayToken || "";
  config.relayMode = !!(config.relayUrl && config.relayToken);
  // ws.json（扩展目录内可选文件，e2e 隔离/多实例调试用）：覆盖以上任一字段。
  // 文件优先于 storage——它是开发者显式放置的配置。
  try {
    const res = await fetch(chrome.runtime.getURL("ws.json"));
    if (res.ok) {
      const j = await res.json();
      if (j.wsUrl) config.wsUrl = j.wsUrl;
      if (j.relayUrl) config.relayUrl = j.relayUrl;
      if (j.relayToken) config.relayToken = j.relayToken;
      config.relayMode = !!(config.relayUrl && config.relayToken);
      log("ws.json override", config.relayMode ? "relay" : config.wsUrl);
    }
  } catch (e) {}
}

async function boot() {
  await loadConfig();
  await loadHookRegistry();
  startKeepalive();
  connect();
}

// options 页保存即时生效：任一连接字段变化 → 重读配置并立即重连
// （不等自然断连/4401 轮询）。cleanupWs 会把旧 ws 的回调置 null，
// close 不会触发 scheduleReconnect，直接 connect 即可。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes.wsUrl && !changes.relayUrl && !changes.relayToken) return;
  loadConfig().then(() => {
    cleanupWs();
    connect();
  });
});

// ---------------------------------------------------------------------------
// WS 客户端（含重连）
// ---------------------------------------------------------------------------

let ws = null;
let helloAcked = false;
let relayPaired = false; // 中转模式：收到 relay_paired 后置 true，之前不发 hello
let reconnectTimer = null;
let reconnectDelayMs = 1000;
const RECONNECT_MAX_MS = 15000;

function wsOpen() {
  return ws && ws.readyState === 1;
}

function send(msg) {
  if (!wsOpen()) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

function sendHello() {
  send({
    type: "hello",
    payload: {
      client: "open-web-bridge-extension",
      version: chrome.runtime.getManifest().version,
    },
  });
}

function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  cleanupWs();
  const url = config.relayMode ? relayUrlOf(config) : config.wsUrl;
  log("ws connecting", config.relayMode ? "relay" : "local", url);
  try {
    ws = new WebSocket(url);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    reconnectDelayMs = 1000;
    helloAcked = false;
    relayPaired = false;
    // 中转模式：等中转的 relay_paired 再发 hello（onmessage 里处理）；
    // 本地模式：连上即发 hello。
    if (!config.relayMode) sendHello();
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    // 中转模式：配对前只认 relay_paired；收到后发 hello，之后切正常 onMessage。
    // 其余早到帧一律忽略（中转协议保证 relay_paired 先于 daemon 的 hello_ack）。
    if (config.relayMode && !relayPaired) {
      if (msg.type === "relay_paired") {
        relayPaired = true;
        log("relay paired, sending hello");
        sendHello();
      }
      return;
    }
    onMessage(msg);
  };
  ws.onclose = (ev) => {
    helloAcked = false;
    relayPaired = false;
    failSafeFetchAll(); // 红线级：防 Fetch 拦截卡死用户页面
    scheduleDeadman();  // 死开关：daemon 长时间不可达则全面 detach
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}

function cleanupWs() {
  if (!ws) return;
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  try {
    ws.close();
  } catch {}
  ws = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
}

// ---------------------------------------------------------------------------
// 死开关：daemon 长时间不可达时 detach 全部 debugger——debugger 黄条常驻
// 会改变页面布局，paused/断点还会冻结用户页面。
// Fetch 域有即时 fail-safe（ws.onclose），这里是第二道防线。
// ---------------------------------------------------------------------------

const DEADMAN_MS = 45000;
let deadmanTimer = null;

function scheduleDeadman() {
  if (deadmanTimer) return;
  deadmanTimer = setTimeout(async () => {
    deadmanTimer = null;
    if (wsOpen() && helloAcked) return; // 已恢复，无需脱管
    log("deadman: daemon unreachable, detaching all debuggers");
    for (const tabId of [...attachedTabs]) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch (e) {}
    }
  }, DEADMAN_MS);
}

function cancelDeadman() {
  if (deadmanTimer) {
    clearTimeout(deadmanTimer);
    deadmanTimer = null;
  }
}

// ---------------------------------------------------------------------------
// SW 保活（alarms 25s 级心跳；MV3 alarms 最小周期 30s）
// ---------------------------------------------------------------------------

const KEEPALIVE_ALARM = "owb-keepalive";

function startKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!wsOpen()) connect();
});

// ---------------------------------------------------------------------------
// CDP 会话池（per-tab）
// ---------------------------------------------------------------------------

const attachedTabs = new Set();

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.add(tabId);
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
    hookBoundTabs.delete(source.tabId);
    hookRegistry.delete(source.tabId); // detach 后注入脚本随之失效
    debuggerEnabledTabs.delete(source.tabId);
    armedBreakpointsMap.delete(source.tabId);
    breakpointIdsMap.delete(source.tabId);
    scriptRegistryMap.delete(source.tabId);
    pausedState.delete(source.tabId);
    consoleStreamTabs.delete(source.tabId);
    networkEnabledTabs.delete(source.tabId);
    fetchPatchTabs.delete(source.tabId);
    pendingFetches.delete(source.tabId);
    scriptWatchers.delete(source.tabId);
    recorders.delete(source.tabId); // detach 即停录制（数据随 HARBuilder 已可产出）
    recorderSkipped.delete(source.tabId);
    recorderOrigins.delete(source.tabId);
    downloadWatchers.delete(source.tabId);
    frameContexts.delete(source.tabId);
    emulateState.delete(source.tabId);
    saveHookRegistry();
    pushEvent("debugger", { reason: "detach", tabId: source.tabId });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  networkEnabledTabs.delete(tabId);
  networkBuffers.delete(tabId);
  scriptRegistryMap.delete(tabId);
  armedBreakpointsMap.delete(tabId);
  breakpointIdsMap.delete(tabId);
  readPageNextRef.delete(tabId);
  readPageSnapshots.delete(tabId);
  handoffState.delete(tabId);
  recorders.delete(tabId);
  recorderSkipped.delete(tabId);
  recorderOrigins.delete(tabId);
  downloadWatchers.delete(tabId);
  frameContexts.delete(tabId);
  emulateState.delete(tabId);
});

function cdpCall(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// Runtime.evaluate 公共封装：EVAL_EXCEPTION 统一构造 + returnByValue 取值。
// 需要 result 里其他字段（如 evaluate 工具的 type）的调用方直接用 cdpCall。
async function evaluateJs(tabId, expression, opts = {}) {
  const res = await cdpCall(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: opts.returnByValue !== false,
    awaitPromise: !!opts.awaitPromise,
  });
  if (res.exceptionDetails) {
    throw new ToolError(
      "EVAL_EXCEPTION",
      res.exceptionDetails.text +
        (res.exceptionDetails.exception
          ? `: ${res.exceptionDetails.exception.description || ""}`
          : "")
    );
  }
  return res.result ? res.result.value : undefined;
}

// ---------------------------------------------------------------------------
// Network 抓包 buffer（per-tab requestId -> record）
// ---------------------------------------------------------------------------

/** tabId -> Map<requestId, record> */
const networkBuffers = new Map();
const networkEnabledTabs = new Set();
const MAX_BUFFER_PER_TAB = 500;

// attach + Network.enable + 登记（network_start/capture_request/wait_for/watch_script 共用）
async function ensureNetwork(tabId) {
  await ensureAttached(tabId);
  if (networkEnabledTabs.has(tabId)) return;
  await cdpCall(tabId, "Network.enable", { maxTotalBufferSize: 50 * 1024 * 1024 });
  networkEnabledTabs.add(tabId);
}

function getBuffer(tabId) {
  let buf = networkBuffers.get(tabId);
  if (!buf) {
    buf = new Map();
    networkBuffers.set(tabId, buf);
  }
  return buf;
}

function bufferPut(tabId, requestId, record) {
  const buf = getBuffer(tabId);
  if (buf.size >= MAX_BUFFER_PER_TAB && !buf.has(requestId)) {
    // 淘汰最老的一条，防内存膨胀
    const oldest = buf.keys().next().value;
    buf.delete(oldest);
  }
  buf.set(requestId, { ...(buf.get(requestId) || {}), ...record });
}

// ---------------------------------------------------------------------------
// HAR 录制器（per-tab，独立于 networkBuffers）
// 与抓包探查缓冲解耦：无淘汰、主动收 body、记 timing/WebSocket、
// 附带 console/storage/screenshots 增强流。recorders 是 Map<tabId, recorder>，
// 天然支持多 tab 录制；record_stop 不指定 tabId 时停全部并合并为多 page HAR。
// ---------------------------------------------------------------------------

/** tabId -> recorder 对象 */
const recorders = new Map();
/** tabId -> Set<requestId> 被 url/resource_type 过滤掉的请求（后续事件一并跳过） */
const recorderSkipped = new Map();
/** tabId -> securityOrigin（DOMStorage.storageId 用） */
const recorderOrigins = new Map();

// 是否应把给定请求纳入录制（白/黑名单 + resource_type 过滤）
function recorderAccepts(rec, url, resourceType) {
  if (rec.urlFilter && !rec.urlFilter.test(url)) return false;
  if (rec.excludeFilter && rec.excludeFilter.test(url)) return false;
  if (rec.resourceTypes && resourceType && !rec.resourceTypes.has(String(resourceType).toLowerCase())) {
    return false;
  }
  return true;
}

// 把一条 Network 域事件喂给该 tab 的活动 recorder（带过滤 + body 主动拉取）
function feedRecorder(tabId, method, params) {
  const rec = recorders.get(tabId);
  if (!rec) return;
  const stats = rec.stats;

  // 跳过集：被过滤掉的请求，其后续事件也跳过
  const skipped = recorderSkipped.get(tabId);
  if (method === "Network.requestWillBeSent") {
    const url = params.request && params.request.url ? params.request.url : "";
    if (!recorderAccepts(rec, url, params.type)) {
      if (skipped) skipped.add(params.requestId);
      return;
    }
  } else if (skipped && skipped.has(params.requestId)) {
    return;
  }

  StatsBuilder.processEvent(stats, { method, params });

  // loadingFinished：主动拉 response body（受护栏约束）
  if (method === "Network.loadingFinished" && rec.includeBodies && !rec.bodyCapped) {
    const requestId = params.requestId;
    const entry = stats.entries[requestId];
    if (entry) {
      const approxLen = entry.responseLength || 0;
      if (approxLen > rec.maxBodyBytes) {
        // 单条超阈值：跳过 body，仍保留元数据
        entry.responseBody = undefined;
      } else if (rec.bodyBytes + approxLen > rec.maxTotalBodyBytes) {
        // 累计超总量：停止后续所有 body 收集
        rec.bodyCapped = true;
      } else {
        // fire-and-forget；recorder 可能在回调前被停掉，故二次校验
        cdpCall(tabId, "Network.getResponseBody", { requestId })
          .then((body) => {
            if (!body || !recorders.has(tabId)) return;
            const { b64, len } = recordBody(stats, requestId, body);
            rec.bodyBytes += len;
            if (rec.bodyBytes >= rec.maxTotalBodyBytes) rec.bodyCapped = true;
            void b64;
          })
          .catch(() => {});
      }
    }
  }
}

// 把 getResponseBody 结果回填进 stats，返回字节数（base64 折算）
function recordBody(stats, requestId, body) {
  StatsBuilder.processEvent(stats, {
    method: "Network.getResponseBody",
    params: {
      requestId,
      body: body.body,
      base64Encoded: body.base64Encoded,
    },
  });
  const len = body.body ? body.body.length : 0;
  return { b64: !!body.base64Encoded, len };
}

// console 归档：录制时把页面 console/异常按时间戳收进 recorder.consoleLog
function feedRecorderConsole(tabId, entry) {
  const rec = recorders.get(tabId);
  if (!rec || !rec.captureConsole) return;
  rec.consoleLog.push({ ts: Date.now() / 1000, ...entry });
}

// storage 变更流：DOMStorage 域事件 → recorder.storageChanges
function feedRecorderStorage(tabId, isLocalStorage, change) {
  const rec = recorders.get(tabId);
  if (!rec || !rec.captureStorage) return;
  rec.storageChanges.push({ ts: Date.now() / 1000, isLocalStorage, ...change });
}

// 视觉时间线：主帧导航触发截图（低质量 jpeg，防爆磁盘）
async function feedRecorderScreenshot(tabId, reason, url) {
  const rec = recorders.get(tabId);
  if (!rec || !rec.captureScreenshots) return;
  try {
    const { data } = await cdpCall(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 40,
    });
    rec.frames.push({ ts: Date.now() / 1000, reason, url, dataUrl: "data:image/jpeg;base64," + data });
  } catch (e) {}
}

// 组装单个 recorder 的 HAR page 数据（含增强字段挂到 page._recording）
function buildRecorderPage(rec, tabId, title) {
  const har = new HARBuilder().create([rec.stats], title);
  const page = har.log.pages[0] || {};
  // 增强产物挂到 page 的扩展字段（HAR 允许下划线前缀自定义字段）
  page._recording = {
    tabId,
    startedAt: rec.startedAt,
    endedAt: new Date().toISOString(),
    bodyBytes: rec.bodyBytes,
    bodyCapped: rec.bodyCapped,
    filters: {
      url_pattern: rec.urlFilter ? rec.urlFilter.source : null,
      exclude_pattern: rec.excludeFilter ? rec.excludeFilter.source : null,
      resource_types: rec.resourceTypes ? [...rec.resourceTypes] : null,
    },
    console: rec.captureConsole ? rec.consoleLog : undefined,
    storageChanges: rec.captureStorage ? rec.storageChanges : undefined,
    frames: rec.captureScreenshots ? rec.frames : undefined,
    cookiesDiff: rec.cookiesDiff || undefined,
  };
  return { har, entries: Object.keys(rec.stats.entries).length };
}

// cookie 快照（含 HttpOnly）
async function snapshotCookies(tabId, origin) {
  if (!origin) return [];
  try {
    const res = await cdpCall(tabId, "Network.getCookies", { urls: [origin] });
    return res.cookies || [];
  } catch (e) { return []; }
}

// diff 两份 cookie 快照：added/changed/removed
function diffCookies(start, end) {
  const mapOf = (list) => {
    const m = {};
    for (const c of list) m[c.name + "|" + (c.domain || "")] = c.value || "";
    return m;
  };
  const a = mapOf(start || []), b = mapOf(end || []);
  const out = { added: [], changed: [], removed: [] };
  for (const k of Object.keys(b)) {
    if (!(k in a)) out.added.push(k);
    else if (a[k] !== b[k]) out.changed.push(k);
  }
  for (const k of Object.keys(a)) {
    if (!(k in b)) out.removed.push(k);
  }
  return out;
}

// 收尾单个 recorder：cookie diff + 构建 HAR
async function finalizeRecorder(tabId, rec, title) {
  const origin = recorderOrigins.get(tabId);
  if (rec.captureStorage && origin) {
    const endCookies = await snapshotCookies(tabId, origin);
    rec.cookiesDiff = diffCookies(rec._cookiesStart || [], endCookies);
  }
  // 关闭录制专用域（不动 networkEnabledTabs：探查缓冲可能仍要用）
  if (rec.captureStorage) {
    try { await cdpCall(tabId, "DOMStorage.disable"); } catch (e) {}
  }
  const tabTitle = title || (function () {
    try { return new URL(rec.url).host; } catch (e) { return rec.url; }
  })();
  return buildRecorderPage(rec, tabId, tabTitle);
}

// 停所有活动 recorder，合并为多 page HAR
async function stopAllRecorders(title) {
  const pages = [];
  let totalEntries = 0, totalBodyBytes = 0;
  const tabIds = [...recorders.keys()];
  for (const tabId of tabIds) {
    const rec = recorders.get(tabId);
    if (!rec) continue;
    const page = await finalizeRecorder(tabId, rec, title);
    totalEntries += page.entries;
    totalBodyBytes += rec.bodyBytes;
    // 把单 page har 的 entries/pages 并入合并 har
    pages.push({ stats: rec.stats, rec, tabId });
  }
  // 用 HARBuilder 直接吃多个 stats（create 支持多 page）
  const statsArr = pages.map((p) => p.stats);
  const har = new HARBuilder().create(statsArr, title || "multi-tab-recording");
  // 给每个 page 挂 _recording 增强字段
  for (let i = 0; i < pages.length; i++) {
    const { rec, tabId } = pages[i];
    const page = har.log.pages[i];
    if (page) {
      page._recording = {
        tabId, startedAt: rec.startedAt, endedAt: new Date().toISOString(),
        bodyBytes: rec.bodyBytes, bodyCapped: rec.bodyCapped,
        console: rec.captureConsole ? rec.consoleLog : undefined,
        storageChanges: rec.captureStorage ? rec.storageChanges : undefined,
        frames: rec.captureScreenshots ? rec.frames : undefined,
        cookiesDiff: rec.cookiesDiff || undefined,
      };
    }
  }
  for (let i = 0; i < tabIds.length; i++) {
    const tabId = tabIds[i];
    recorders.delete(tabId);
    recorderSkipped.delete(tabId);
    recorderOrigins.delete(tabId);
    pushEvent("record", { tabId, phase: "stop", entries: pages[i] ? pages[i].rec ? Object.keys(pages[i].rec.stats.entries).length : 0 : 0 });
  }
  return { tabIds, recording: false, entries: totalEntries, bodyBytes: totalBodyBytes, har };
}

function statusOf(tabId, rec) {
  return {
    tabId,
    recording: true,
    url: rec.url,
    entries: Object.keys(rec.stats.entries).length,
    bodyBytes: rec.bodyBytes,
    bodyCapped: rec.bodyCapped,
    consoleEvents: rec.consoleLog.length,
    storageChanges: rec.storageChanges.length,
    frames: rec.frames.length,
    startedAt: rec.startedAt,
  };
}

// ---- onEvent 分域处理（主干只做路由）----

// Hook 回传通道（Runtime.addBinding）
function onBindingCalled(tabId, params) {
  if (params.name !== HOOK_BINDING_NAME || !hookBoundTabs.has(tabId)) return;
  let payload = null;
  try {
    payload = JSON.parse(params.payload);
  } catch {}
  if (payload) {
    pushEvent("hook:" + (payload.preset || "unknown"), { tabId, ...payload });
  }
}

// Debugger 暂停现场：全帧存入 pausedState 供 frame_read（frozen-snapshot）
function onDebuggerPaused(tabId, params) {
  pausedState.set(tabId, {
    reason: params.reason,
    callFrames: params.callFrames || [],
  });
  const top = (params.callFrames || [])[0] || {};
  pushEvent("debugger", {
    tabId,
    phase: "paused",
    reason: params.reason,
    topFrame: {
      functionName: top.functionName || "(anonymous)",
      url: top.url,
      lineNumber: top.location ? top.location.lineNumber : undefined,
    },
  });
}

function onDebuggerResumed(tabId) {
  pausedState.delete(tabId);
  pushEvent("debugger", { tabId, phase: "resumed" });
}

// 脚本注册表（script_list / search_code 的原料）
function onScriptParsed(tabId, params) {
  let reg = scriptRegistryMap.get(tabId);
  if (!reg) {
    reg = new Map();
    scriptRegistryMap.set(tabId, reg);
  }
  if (reg.size >= MAX_SCRIPTS_PER_TAB && !reg.has(params.scriptId)) {
    reg.delete(reg.keys().next().value); // 淘汰最老
  }
  reg.set(params.scriptId, {
    scriptId: params.scriptId,
    url: params.url || null,
    startLine: params.startLine,
    endLine: params.endLine,
    hasSourceURLComment: !!params.hasSourceURL,
  });
}

// 控制台流（页面报错与警告事件流）
function onConsoleEvent(tabId, method, params) {
  let entry = null;
  if (method === "Runtime.consoleAPICalled") {
    entry = {
      tabId,
      type: params.type,
      args: (params.args || [])
        .slice(0, 10)
        .map((a) => (a.value !== undefined ? a.value : a.description || a.type)),
    };
  } else {
    const e = params.entry || {}; // Log.entryAdded
    entry = {
      tabId,
      type: e.level,
      args: [e.text],
      url: e.url,
      lineNumber: e.lineNumber,
    };
  }
  // 录制归档：不受 stream 订阅约束（recorder 自己 enable 了 Runtime/Log）
  feedRecorderConsole(tabId, entry);
  if (consoleStreamTabs.has(tabId)) {
    pushEvent("console", entry);
  }
}

// Network 域：抓包 buffer + 事件推流 + watch_script 命中通知
// 注意：录制器（feedRecorder）在 onEvent 主干里先于本函数调用，
// 这里只管探查缓冲，二者互不干扰。
function onNetworkEvent(tabId, method, params) {
  if (!networkEnabledTabs.has(tabId)) return;

  if (method === "Network.requestWillBeSent") {
    const rec = {
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      requestHeaders: params.request.headers,
      postData: params.request.postData || null,
      hasPostData: !!params.request.hasPostData,
      type: params.type,
      initiator: params.initiator || null,
      timestamp: params.timestamp,
      wallTime: params.wallTime,
    };
    bufferPut(tabId, params.requestId, rec);
    pushEvent("network", { tabId, phase: "request", ...truncateForEvent(rec) });
    return;
  }
  if (method === "Network.responseReceived") {
    bufferPut(tabId, params.requestId, {
      status: params.response.status,
      responseHeaders: params.response.headers,
      mimeType: params.response.mimeType,
    });
    // watch_script notify：命中即推事件（覆盖懒加载脚本）
    const watchers = scriptWatchers.get(tabId);
    if (watchers && params.type === "Script") {
      const url = params.response.url || "";
      for (const w of watchers) {
        if (w.regex.test(url)) {
          pushEvent("script", {
            tabId,
            phase: "loaded",
            url,
            requestId: params.requestId,
            watcherId: w.id,
            mimeType: params.response.mimeType,
          });
        }
      }
    }
    return;
  }
  if (method === "Network.loadingFinished") {
    bufferPut(tabId, params.requestId, { finished: true });
    return;
  }
  if (method === "Network.loadingFailed") {
    bufferPut(tabId, params.requestId, {
      failed: true,
      errorText: params.errorText,
    });
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  if (method === "Runtime.bindingCalled") return onBindingCalled(tabId, params);
  if (method === "Debugger.paused") return onDebuggerPaused(tabId, params);
  if (method === "Debugger.resumed") return onDebuggerResumed(tabId);
  if (method === "Debugger.scriptParsed") return onScriptParsed(tabId, params);
  if (method === "Runtime.consoleAPICalled" || method === "Log.entryAdded") {
    return onConsoleEvent(tabId, method, params);
  }
  // 录制：DOMStorage 域 → storage 变更流
  if (method.startsWith("DOMStorage.")) {
    onDomStorageEvent(tabId, method, params);
    return;
  }
  // 录制：主帧导航 → 视觉时间线截图
  if (method === "Page.frameNavigated" && params.frame && params.frame.parentId === "0") {
    feedRecorderScreenshot(tabId, "navigation", params.frame.url || null);
    return;
  }
  // 下载：downloadWillBegin + downloadProgress → 一次性 watcher resolve
  if (method === "Page.downloadWillBegin") return onDownloadBegin(tabId, params);
  if (method === "Page.downloadProgress") return onDownloadProgress(tabId, params);
  // 执行上下文：iframe 的 contextId 登记（list_frames / frame 定向 evaluate 用）
  if (method === "Runtime.executionContextCreated") return onContextCreated(tabId, params);
  if (method === "Runtime.executionContextDestroyed") return onContextDestroyed(tabId, params);
  // Fetch 域脚本改写（async fire-and-forget，内部异常自吞并放行）
  if (method === "Fetch.requestPaused") {
    handleFetchPaused(tabId, params);
    return;
  }
  if (method.startsWith("Network.")) {
    // 录制器先吃（全 Network 事件，含 dataReceived/WS 等探查缓冲忽略的），
    // 再走探查缓冲；两者独立，互不影响
    feedRecorder(tabId, method, params);
    return onNetworkEvent(tabId, method, params);
  }
});

// DOMStorage 事件 → recorder.storageChanges（localStorage/sessionStorage 变更）
function onDomStorageEvent(tabId, method, params) {
  const rec = recorders.get(tabId);
  if (!rec || !rec.captureStorage) return;
  const origin = recorderOrigins.get(tabId);
  // 只关心本 tab origin 的 storage（避免 iframe/其他 origin 噪音）
  const sid = params.storageId || {};
  if (origin && sid.securityOrigin && sid.securityOrigin !== origin) return;
  const isLocalStorage = !!sid.isLocalStorage;
  if (method === "DOMStorage.domStorageItemAdded") {
    feedRecorderStorage(tabId, isLocalStorage, { op: "add", key: params.key, value: params.newValue });
  } else if (method === "DOMStorage.domStorageItemUpdated") {
    feedRecorderStorage(tabId, isLocalStorage, { op: "update", key: params.key, oldValue: params.oldValue, value: params.newValue });
  } else if (method === "DOMStorage.domStorageItemRemoved") {
    feedRecorderStorage(tabId, isLocalStorage, { op: "remove", key: params.key, oldValue: params.oldValue });
  } else if (method === "DOMStorage.domStorageItemsCleared") {
    feedRecorderStorage(tabId, isLocalStorage, { op: "clear" });
  }
}

function truncateForEvent(rec) {
  const out = { ...rec };
  if (out.postData && out.postData.length > 2000) {
    out.postData = out.postData.slice(0, 2000) + "…(truncated)";
  }
  delete out.requestHeaders; // 事件里不带全量 headers，detail 里取
  return out;
}

// ---------------------------------------------------------------------------
// E. 浏览器交互盲区：下载 / 上传 / PDF / iframe
// ---------------------------------------------------------------------------

/** tabId -> { resolve, reject, filename, url, guid } 一次性下载 watcher */
const downloadWatchers = new Map();
/** tabId -> Array<{contextId, frameId, name, url, auxData}> iframe 执行上下文登记 */
const frameContexts = new Map();

function onDownloadBegin(tabId, params) {
  const w = downloadWatchers.get(tabId);
  if (!w) return;
  w.guid = params.guid;
  w.url = params.url;
  w.filename = params.suggestedFilename || w.filename;
}

function onDownloadProgress(tabId, params) {
  const w = downloadWatchers.get(tabId);
  if (!w || params.guid !== w.guid) return;
  if (params.state === "completed") {
    w.resolve({ state: "completed", receivedBytes: params.receivedBytes });
  } else if (params.state === "canceled") {
    w.reject(new ToolError("DOWNLOAD_CANCELED", "download was canceled", false));
  }
}

function onContextCreated(tabId, params) {
  const ctx = params.context || {};
  if (!ctx.id || !ctx.auxData) return;
  let list = frameContexts.get(tabId);
  if (!list) { list = []; frameContexts.set(tabId, list); }
  // 去重（同 contextId 不重复登记）
  if (!list.some((c) => c.contextId === ctx.id)) {
    list.push({
      contextId: ctx.id,
      frameId: ctx.auxData.frameId || null,
      name: ctx.name || "",
      url: ctx.origin || "",
      isDefault: !!ctx.auxData.isDefault,
    });
  }
}

function onContextDestroyed(tabId, params) {
  const list = frameContexts.get(tabId);
  if (!list) return;
  const idx = list.findIndex((c) => c.contextId === params.executionContextId);
  if (idx >= 0) list.splice(idx, 1);
}

// 按 frame url/name 子串匹配找 iframe 的 contextId（evaluate 在指定 frame 执行用）
function resolveFrameContextId(tabId, framePattern) {
  const list = frameContexts.get(tabId);
  if (!list || !list.length) return null;
  // 默认主帧
  if (!framePattern) {
    const def = list.find((c) => c.isDefault);
    return def ? def.contextId : list[0].contextId;
  }
  const c = list.find((x) => (x.url && x.url.includes(framePattern)) || (x.name && x.name.includes(framePattern)));
  return c ? c.contextId : null;
}

// ---------------------------------------------------------------------------
// D. 环境模拟：设备 / 网络 / 地理 / 时区 / 语言 / 权限 / UA 覆盖
// 每项独立可选，emulate_reset 清空。emulateState 记已覆盖项便于 reset + status。
// ---------------------------------------------------------------------------

/** tabId -> Set<overrideType> 已应用的覆盖类型 */
const emulateState = new Map();

function emulateApplied(tabId, type) {
  let s = emulateState.get(tabId);
  if (!s) { s = new Set(); emulateState.set(tabId, s); }
  s.add(type);
}

// ---------------------------------------------------------------------------
// Hook 注入：Page.addScriptToEvaluateOnNewDocument +
// Runtime.addBinding 回传通道。注册表持久化到 chrome.storage.local，
// SW 重启后可去重（addScriptToEvaluateOnNewDocument 没有 list API）。
// ---------------------------------------------------------------------------

const HOOK_PRESETS = {
  xhr: "hooks/xhr.js",
  fetch: "hooks/fetch.js",
  crypto: "hooks/crypto.js",
};
const FN_HOOK_TEMPLATE = "hooks/fn_hook.js";
const FN_OPTS_SENTINEL = "/*__OWB_OPTS__*/null/*__OWB_OPTS_END__*/";
const HOOK_BINDING_NAME = "__owbReport";
const HOOK_REGISTRY_KEY = "hookRegistry";

/** tabId -> Map<presetName, identifier> */
const hookRegistry = new Map();
const hookBoundTabs = new Set();

async function loadHookRegistry() {
  const stored = await chrome.storage.local.get(HOOK_REGISTRY_KEY);
  const obj = stored[HOOK_REGISTRY_KEY] || {};
  for (const [tabIdStr, presets] of Object.entries(obj)) {
    hookRegistry.set(Number(tabIdStr), new Map(Object.entries(presets)));
  }
}

async function saveHookRegistry() {
  const obj = {};
  for (const [tabId, presets] of hookRegistry) {
    obj[String(tabId)] = Object.fromEntries(presets);
  }
  await chrome.storage.local.set({ [HOOK_REGISTRY_KEY]: obj });
}

function tabHookRegistry(tabId) {
  let reg = hookRegistry.get(tabId);
  if (!reg) {
    reg = new Map();
    hookRegistry.set(tabId, reg);
  }
  return reg;
}

async function ensureHookChannel(tabId) {
  await ensureAttached(tabId);
  if (hookBoundTabs.has(tabId)) return;
  // ⚠️ Page.enable 必须先于 addScriptToEvaluateOnNewDocument：
  // 未 enable 时 addScript 返回成功但脚本永不注入（CDP 静默 no-op，e2e 实测）。
  await cdpCall(tabId, "Page.enable");
  await cdpCall(tabId, "Runtime.enable");
  await cdpCall(tabId, "Runtime.addBinding", { name: HOOK_BINDING_NAME });
  hookBoundTabs.add(tabId);
}

async function loadPresetSource(name) {
  const rel = HOOK_PRESETS[name];
  if (!rel) throw new ToolError("BAD_PRESET", `unknown preset: ${name}`);
  const res = await fetch(chrome.runtime.getURL(rel));
  if (!res.ok) {
    throw new ToolError("PRESET_LOAD_FAILED", `${rel}: HTTP ${res.status}`);
  }
  return res.text();
}

async function loadFnHookSource(opts) {
  const res = await fetch(chrome.runtime.getURL(FN_HOOK_TEMPLATE));
  if (!res.ok) {
    throw new ToolError("PRESET_LOAD_FAILED", `${FN_HOOK_TEMPLATE}: HTTP ${res.status}`);
  }
  const template = await res.text();
  if (!template.includes(FN_OPTS_SENTINEL)) {
    throw new ToolError("PRESET_LOAD_FAILED", "fn_hook.js missing OPTS sentinel");
  }
  return template.replace(FN_OPTS_SENTINEL, JSON.stringify(opts));
}

// ---------------------------------------------------------------------------
// Debugger 域：按需启用，不常驻；断点走 frozen-snapshot
// 模式（pause → 全帧 dump → 立即 resume），避免页面长冻结触发时间差检测。
// ---------------------------------------------------------------------------

const debuggerEnabledTabs = new Set();
/** tabId -> Set<"xhr:substring" | "fn:path" | "url:pattern:line"> 已武装断点 */
const armedBreakpointsMap = new Map();
/** tabId -> Map<armedKey, breakpointId>（fn:/url: 断点移除需要 breakpointId） */
const breakpointIdsMap = new Map();
/** tabId -> Map<scriptId, {url, startLine, endLine}>（Debugger 启用期间收集，含 eval/VM 脚本） */
const scriptRegistryMap = new Map();
const MAX_SCRIPTS_PER_TAB = 1000;
/** tabId -> {reason, callFrames} 当前暂停现场 */
const pausedState = new Map();
const consoleStreamTabs = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function armedBreakpoints(tabId) {
  let s = armedBreakpointsMap.get(tabId);
  if (!s) {
    s = new Set();
    armedBreakpointsMap.set(tabId, s);
  }
  return s;
}

function tabBreakpointIds(tabId) {
  let m = breakpointIdsMap.get(tabId);
  if (!m) {
    m = new Map();
    breakpointIdsMap.set(tabId, m);
  }
  return m;
}

async function ensureDebugger(tabId) {
  await ensureAttached(tabId);
  if (debuggerEnabledTabs.has(tabId)) return;
  await cdpCall(tabId, "Debugger.enable");
  debuggerEnabledTabs.add(tabId);
}

async function maybeDisableDebugger(tabId) {
  if (!debuggerEnabledTabs.has(tabId)) return;
  if (armedBreakpoints(tabId).size > 0) return;
  if (pausedState.has(tabId)) return;
  try {
    await cdpCall(tabId, "Debugger.disable");
  } catch (e) {}
  debuggerEnabledTabs.delete(tabId);
}

async function readScopeProperties(tabId, objectId, limit) {
  const { result } = await cdpCall(tabId, "Runtime.getProperties", {
    objectId,
    ownProperties: true,
  });
  const out = {};
  for (const p of result.slice(0, limit)) {
    const v = p.value;
    if (!v) {
      out[p.name] = undefined;
      continue;
    }
    if (v.type === "string") {
      out[p.name] = v.value.length > 300 ? v.value.slice(0, 300) + "…" : v.value;
    } else if (v.type === "number" || v.type === "boolean" || v.type === "undefined") {
      out[p.name] = v.value;
    } else if (v.type === "object" && v.subtype === "null") {
      out[p.name] = null;
    } else if (v.type === "function") {
      out[p.name] = `[function ${(v.description || "").slice(0, 80)}]`;
    } else {
      out[p.name] =
        `[${v.className || v.type}] ` + String(v.description || "").slice(0, 120);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetch 域脚本改写 + fail-safe：
// WS 断连必须立即 Fetch.disable + 放行全部 pending，否则用户页面卡死。
// ---------------------------------------------------------------------------

/** tabId -> [{id, pattern, regex, type, code}] */
const fetchPatchTabs = new Map();
/** tabId -> Map<requestId, pausedParams> */
const pendingFetches = new Map();
/** tabId -> [{id, pattern, regex}] script 加载监视器 */
const scriptWatchers = new Map();
let scriptRegId = 0;

function tabPatches(tabId) {
  let list = fetchPatchTabs.get(tabId);
  if (!list) {
    list = [];
    fetchPatchTabs.set(tabId, list);
  }
  return list;
}

// CDP Fetch urlPattern 是 glob（* ?），不是 JS regex；匹配侧需要等价 RegExp
function globToRegExp(glob) {
  const esc = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp("^" + esc + "$", "i");
}

async function rebuildFetchPatterns(tabId) {
  const patches = tabPatches(tabId);
  if (!patches.length) {
    if (pendingFetches.has(tabId) || fetchPatchTabs.has(tabId)) {
      try {
        await cdpCall(tabId, "Fetch.disable");
      } catch (e) {}
      pendingFetches.delete(tabId);
    }
    return;
  }
  await cdpCall(tabId, "Fetch.enable", {
    patterns: patches.map((p) => ({ urlPattern: p.pattern, requestStage: "Response" })),
  });
}

// proxy_probe：shadow window.navigator/screen 为 Proxy，每 key 上报一次。
// ⚠️ proxy 类改写会改变脚本运行行为，行为敏感的站点禁用。
const PROXY_PROBE_SNIPPET = `(() => {
  if (window.__owbProxyProbe) return;
  window.__owbProxyProbe = true;
  const seen = new Set();
  const report = (label, key) => {
    const k = label + "." + String(key);
    if (seen.has(k)) return;
    seen.add(k);
    try {
      if (typeof __owbReport === "function") {
        __owbReport(JSON.stringify({ preset: "probe", href: location.href, ts: Date.now(), get: k }));
      }
    } catch (e) {}
  };
  const shadow = (label, target) => {
    try {
      const proxy = new Proxy(target, {
        get(t, p) {
          if (typeof p === "string") report(label, p);
          return Reflect.get(t, p, t); // getter 绑定原对象，防 illegal invocation
        },
      });
      Object.defineProperty(window, label, { get: () => proxy, configurable: true });
    } catch (e) {}
  };
  shadow("navigator", navigator);
  shadow("screen", screen);
})();`;

function applyScriptPatch(source, patch) {
  if (patch.type === "prepend") return (patch.code || "") + "\n" + source;
  if (patch.type === "proxy_probe") return PROXY_PROBE_SNIPPET + "\n" + source;
  return source;
}

// ---- base64 编解码（SW 环境，Unicode 安全）----

function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function decodeBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function handleFetchPaused(tabId, params) {
  let pending = pendingFetches.get(tabId);
  if (!pending) {
    pending = new Map();
    pendingFetches.set(tabId, pending);
  }
  pending.set(params.requestId, params);

  const url = (params.request && params.request.url) || "";
  const patches = tabPatches(tabId);
  const patch = patches.find((p) => p.regex.test(url));
  const isScript =
    params.resourceType === "Script" || /\.m?js(\?|#|$)/i.test(url);

  try {
    if (!patch || !isScript) {
      await cdpCall(tabId, "Fetch.continueRequest", { requestId: params.requestId });
      return;
    }
    const bodyRes = await cdpCall(tabId, "Fetch.getResponseBody", {
      requestId: params.requestId,
    });
    const original = bodyRes.base64Encoded ? decodeBase64(bodyRes.body) : bodyRes.body;
    const patched = applyScriptPatch(original, patch);
    pushEvent("script", {
      tabId,
      phase: "patched",
      url,
      patchId: patch.id,
      type: patch.type,
      originalSize: original.length,
    });
    await cdpCall(tabId, "Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode: params.responseStatusCode || 200,
      responseHeaders: params.responseHeaders || [],
      body: encodeBase64(patched),
    });
  } catch (e) {
    // 改写失败一律放行，宁可漏插桩不可卡页面
    try {
      await cdpCall(tabId, "Fetch.continueRequest", { requestId: params.requestId });
    } catch (e2) {}
  } finally {
    pending.delete(params.requestId);
  }
}

// fail-safe：WS 断连 → 放行全部 pending + Fetch.disable + 清空改写登记
// （重连后 agent 需重新 script_patch；宁可丢插桩不可卡死用户页面）
function failSafeFetchAll() {
  for (const [tabId, pending] of pendingFetches) {
    for (const requestId of pending.keys()) {
      cdpCall(tabId, "Fetch.continueRequest", { requestId }).catch(() => {});
    }
    cdpCall(tabId, "Fetch.disable").catch(() => {});
  }
  pendingFetches.clear();
  fetchPatchTabs.clear();
}

// ---------------------------------------------------------------------------
// env_compare：页面环境基准采集，分批 evaluate
// ---------------------------------------------------------------------------

const ENV_PROBES_A = [
  "navigator.userAgent", "navigator.appVersion", "navigator.platform",
  "navigator.vendor", "navigator.language", "navigator.hardwareConcurrency",
  "navigator.deviceMemory", "navigator.maxTouchPoints", "navigator.webdriver",
  "navigator.cookieEnabled", "navigator.onLine", "navigator.doNotTrack",
  "navigator.pdfViewerEnabled", "navigator.plugins.length",
  "navigator.mimeTypes.length", "navigator.userAgentData",
  "navigator.connection", "navigator.permissions", "navigator.mediaDevices",
];

const ENV_PROBES_B = [
  "screen.width", "screen.height", "screen.availWidth", "screen.availHeight",
  "screen.colorDepth", "screen.pixelDepth",
  "window.devicePixelRatio", "window.innerWidth", "window.innerHeight",
  "window.outerWidth", "window.outerHeight", "window.screenX", "window.screenY",
];

const ENV_PROBES_C = [
  "document.readyState", "document.visibilityState", "document.hidden",
  "document.characterSet", "document.referrer", "document.compatMode",
  "document.hasFocus", "performance.timeOrigin", "performance.timing",
  "performance.navigation",
];

// 通用属性采集器：函数/对象压成标签，异常压成 [err:...]
const ENV_COLLECT_EXPR = (probes) => `(() => {
  const out = {};
  const get = (p) => {
    try {
      const segs = p.split(".");
      let v = window;
      for (const s of segs) { if (s === "window") continue; v = v[s]; }
      if (typeof v === "function") return "[function]";
      if (v === undefined) return undefined;
      if (v === null) return null;
      if (Array.isArray(v)) return v.join(",");
      if (typeof v === "object") return Object.prototype.toString.call(v);
      return v;
    } catch (e) { return "[err:" + e.message + "]"; }
  };
  for (const p of ${JSON.stringify(probes)}) out[p] = get(p);
  return out;
})()`;

// 特征批：需要执行代码的探针（DOM 布局 / canvas / WebGL / toString / Symbol tag）
const ENV_FEATURES_EXPR = `(() => {
  const out = {};
  try { out["document.hasFocus()"] = document.hasFocus(); } catch (e) { out["document.hasFocus()"] = "[err]"; }
  try {
    const div = document.createElement("div");
    div.innerHTML = "<span style=\\"display:inline-block;width:50px;height:20px\\">x</span>";
    document.body.appendChild(div);
    const span = div.firstChild;
    out["dom.offsetWidth"] = span.offsetWidth;
    out["dom.offsetHeight"] = span.offsetHeight;
    out["dom.rect.w"] = Math.round(span.getBoundingClientRect().width * 100) / 100;
    div.remove();
  } catch (e) { out["dom"] = "[err:" + e.message + "]"; }
  try {
    const c = document.createElement("canvas");
    c.width = 16; c.height = 16;
    const ctx = c.getContext("2d");
    ctx.fillText("a", 1, 8);
    out["canvas.dataURL.len"] = c.toDataURL().length;
  } catch (e) { out["canvas"] = "[err:" + e.message + "]"; }
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (gl) {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      out["webgl.vendor"] = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      out["webgl.renderer"] = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } else { out["webgl"] = null; }
  } catch (e) { out["webgl"] = "[err:" + e.message + "]"; }
  try {
    out["toString.eval"] = Function.prototype.toString.call(eval).slice(0, 60);
    out["toString.XHR"] = Function.prototype.toString.call(XMLHttpRequest).slice(0, 60);
    out["tag.document"] = Object.prototype.toString.call(document);
    out["tag.screen"] = Object.prototype.toString.call(screen);
    out["window.chrome"] = typeof window.chrome;
    out["navigator.userAgentData.type"] = typeof navigator.userAgentData;
    out["navigator.connection.type"] = typeof navigator.connection;
    out["performance.memory.type"] = typeof performance.memory;
    out["AudioContext.type"] = typeof window.AudioContext;
    out["Notification.type"] = typeof window.Notification;
    out["sharedArrayBuffer.type"] = typeof window.SharedArrayBuffer;
  } catch (e) {}
  return out;
})()`;

// ---------------------------------------------------------------------------
// event 推流（seq 由 daemon 分配）
// ---------------------------------------------------------------------------

function pushEvent(source, data) {
  send({ type: "event", payload: { source, data } });
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

class ToolError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

async function resolveTabId(args) {
  if (args.tabId != null) return args.tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) {
    throw new ToolError("NO_TAB", "no active tab; pass tabId explicitly", false);
  }
  return tab.id;
}

// ---------------------------------------------------------------------------
// OWB 标签分组：
// 只给【桥自己创建的 tab】（navigate new_tab）编组，用户已有的 tab 绝不动。
// 价值：视觉上一眼区分分析现场 + close_group 一键清场。
// ---------------------------------------------------------------------------

const OWB_GROUP_TITLE = "OWB 分析";
const OWB_GROUP_COLOR = "blue";

// 通用命名组：按标题找已有组或新建（OWB 分析 / task 任务 / handoff 交接共用）
async function ensureNamedGroup(tabId, title, color) {
  const groups = await chrome.tabGroups.query({ title });
  if (groups.length) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: groups[0].id });
    return groups[0].id;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, { title, color });
  return groupId;
}

async function ensureOwbGroup(tabId) {
  return ensureNamedGroup(tabId, OWB_GROUP_TITLE, OWB_GROUP_COLOR);
}

// ---------------------------------------------------------------------------
// 任务分组（task_context 管道）：daemon task_begin 远程 set 任务后，
// navigate new_tab 的 tab 编到 "task: 标题" 组（cyan），与 OWB 分析组分离，
// task_end/clear 时按组统计产出 tab。⚠️ SW 重启丢 currentTask：
// 组本身还在，只是之后新建的 tab 不再入组，可接受。
// ---------------------------------------------------------------------------

/** @type {null | {title: string, groupId: number|null}} */
let currentTask = null;
const TASK_GROUP_COLOR = "cyan";

async function ensureTaskGroup(tabId) {
  const title = `task: ${currentTask.title}`;
  // 优先复用记忆里的 groupId（同任务跨多次 navigate 不重复建组）
  if (currentTask.groupId != null) {
    try {
      await chrome.tabs.group({ tabIds: [tabId], groupId: currentTask.groupId });
      return currentTask.groupId;
    } catch (e) {
      currentTask.groupId = null; // 组已被用户关掉/失效，降级重建
    }
  }
  currentTask.groupId = await ensureNamedGroup(tabId, title, TASK_GROUP_COLOR);
  return currentTask.groupId;
}

// ---------------------------------------------------------------------------
// 人机交接：handoff 把 tab 编入「等你操作」组（orange）交还用户，
// handoffState 记录交接中的 tab；wait_user 命中后按它清场。tabs.onRemoved 清理。
// ---------------------------------------------------------------------------

const HANDOFF_GROUP_TITLE = "✋ OWB 等你操作";
const HANDOFF_GROUP_COLOR = "orange";
/** 处于交接态的 tabId 集合 */
const handoffState = new Set();

// wait_user 命中后的清场：交接态 tab 出组 + 删状态 + 推 resolved 事件
async function resolveWaitUser(tabId, condition, url, elapsedMs, clear) {
  if (clear && handoffState.has(tabId)) {
    handoffState.delete(tabId);
    try {
      await chrome.tabs.ungroup([tabId]);
    } catch (e) {}
    pushEvent("handoff", { tabId, phase: "resolved", url });
  }
  return { tabId, tookOver: true, condition, url, elapsedMs };
}

function toRegExp(pattern, flags = "i") {
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    throw new ToolError("BAD_PATTERN", `invalid url_pattern: ${e.message}`, false);
  }
}

// ref 定位：read_page 打的稳定 ref（吃 "@e12" / "e12" 两种写法）→
// data-owb-ref 选择器。与 selector 二选一。元素不存在时错误语义是 REF_STALE
// （页面可能已导航/重渲染，可重试），区别于普通 selector 的 NOT_FOUND。
function resolveTargetSelector(args, toolName, required = true) {
  const hasSel = !!args.selector;
  const hasRef = args.ref != null && String(args.ref) !== "";
  if (hasSel && hasRef) {
    throw new ToolError("BAD_ARGS", `${toolName}: selector 与 ref 二选一`, false);
  }
  if (!hasSel && !hasRef) {
    if (required) {
      throw new ToolError("BAD_ARGS", `${toolName}: selector 或 ref 必填一个`, false);
    }
    return null;
  }
  if (hasSel) return { selector: args.selector, ref: null };
  const ref = String(args.ref).replace(/^@/, "");
  return { selector: `[data-owb-ref="${ref}"]`, ref: "@" + ref };
}

function targetNotFound(target, toolName) {
  if (target.ref) {
    throw new ToolError(
      "REF_STALE",
      `ref ${target.ref} 不在当前文档（页面可能已导航或重渲染），重新 read_page 拿新 ref`,
      true
    );
  }
  throw new ToolError("NOT_FOUND", `selector not found: ${target.selector}`);
}

// "找元素 + scrollIntoView" 的页面表达式骨架（click/fill/screenshot/mouse_click
// 共用）：找到则执行 body 段并返回其结果，未找到返回 null（调用方转
// NOT_FOUND / REF_STALE）。body 里可用变量：el。
function elementSnippet(selector, body) {
  return (
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});` +
    ` if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" });` +
    ` ${body} })()`
  );
}

// oracle_call 的页面内包装器：
// 冻结/记录 Date.now 与 Math.random 实际值作为样本元数据，finally 恢复原函数。
const ORACLE_EXPR = `(async (fnPath, callArgs, freeze) => {
  const meta = { frozen: !!freeze, dateNow: [], mathRandom: [] };
  const _dn = Date.now, _mr = Math.random;
  const fNow = _dn.call(Date), fRand = _mr.call(Math);
  Date.now = freeze ? () => fNow : (...a) => { const v = _dn.apply(Date, a); meta.dateNow.push(v); return v; };
  Math.random = freeze ? () => fRand : (...a) => { const v = _mr.apply(Math, a); meta.mathRandom.push(v); return v; };
  try {
    const segs = String(fnPath).split(".");
    let fn = window, owner = null;
    for (const s of segs) { if (s === "window") continue; owner = fn; fn = fn && fn[s]; }
    if (typeof fn !== "function") throw new Error("not a function: " + fnPath);
    let result = fn.apply(owner, callArgs || []);
    if (result && typeof result.then === "function") result = await result;
    let value;
    try { value = JSON.parse(JSON.stringify(result === undefined ? null : result)); }
    catch (e) { value = String(result); }
    if (freeze) { meta.dateNow = [fNow]; meta.mathRandom = [fRand]; }
    return { ok: true, value, meta };
  } catch (e) {
    return { ok: false, error: String((e && e.stack) || e) };
  } finally { Date.now = _dn; Math.random = _mr; }
})`;

const ORACLE_CALL_ON_OBJECT = `async function (opts) {
  const meta = { frozen: !!opts.freeze, dateNow: [], mathRandom: [] };
  const _dn = Date.now, _mr = Math.random;
  const fNow = _dn.call(Date), fRand = _mr.call(Math);
  Date.now = opts.freeze ? () => fNow : (...a) => { const v = _dn.apply(Date, a); meta.dateNow.push(v); return v; };
  Math.random = opts.freeze ? () => fRand : (...a) => { const v = _mr.apply(Math, a); meta.mathRandom.push(v); return v; };
  try {
    let result = this(...(opts.callArgs || []));
    if (result && typeof result.then === "function") result = await result;
    let value;
    try { value = JSON.parse(JSON.stringify(result === undefined ? null : result)); }
    catch (e) { value = String(result); }
    if (opts.freeze) { meta.dateNow = [fNow]; meta.mathRandom = [fRand]; }
    return { ok: true, value, meta };
  } catch (e) {
    return { ok: false, error: String((e && e.stack) || e) };
  } finally { Date.now = _dn; Math.random = _mr; }
}`;

// export_state 的页面内采集器：
// localStorage + sessionStorage + IndexedDB（getAllKeys/getAll + keyPath 元数据，
// 每 store 上限 1000 条防内存爆）。Runtime.evaluate(awaitPromise, returnByValue) 执行。
const STATE_EXPORT_EXPR = `(async () => {
  const dump = { ls: {}, ss: {}, idb: {} };
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); dump.ls[k] = localStorage.getItem(k);
    }
  } catch (e) { dump.lsError = String(e); }
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i); dump.ss[k] = sessionStorage.getItem(k);
    }
  } catch (e) { dump.ssError = String(e); }
  if (typeof indexedDB !== "undefined" && indexedDB.databases) {
    try {
      const dbs = await indexedDB.databases();
      for (const info of dbs) {
        if (!info || !info.name) continue;
        dump.idb[info.name] = await new Promise((resolve) => {
          let req;
          try { req = indexedDB.open(info.name); }
          catch (e) { resolve({ __error: String(e) }); return; }
          req.onerror = () => resolve({ __error: String(req.error) });
          req.onsuccess = () => {
            const db = req.result;
            const out = {};
            const stores = Array.from(db.objectStoreNames || []);
            if (!stores.length) { db.close(); resolve(out); return; }
            let left = stores.length;
            for (const sn of stores) {
              const done = (entry) => {
                out[sn] = entry;
                if (--left === 0) { db.close(); resolve(out); }
              };
              try {
                const tx = db.transaction(sn, "readonly");
                const store = tx.objectStore(sn);
                const meta = {
                  keyPath: store.keyPath == null ? null : String(store.keyPath),
                  autoIncrement: !!store.autoIncrement,
                };
                const keysReq = store.getAllKeys();
                const valsReq = store.getAll();
                let keys = null, vals = null, failed = null;
                const fin = () => {
                  if (failed) { done({ __error: failed }); return; }
                  if (keys === null || vals === null) return;
                  const records = vals.map((v, i) => ({ k: keys[i], v: v })).slice(0, 1000);
                  done({ ...meta, records, truncated: vals.length > 1000 });
                };
                keysReq.onsuccess = () => { keys = keysReq.result; fin(); };
                valsReq.onsuccess = () => { vals = valsReq.result; fin(); };
                keysReq.onerror = () => { failed = String(keysReq.error); fin(); };
                valsReq.onerror = () => { failed = String(valsReq.error); fin(); };
              } catch (e) { done({ __error: String(e) }); }
            }
          };
        });
      }
    } catch (e) { dump.idbError = String(e); }
  }
  return dump;
})()`;

// import_state 的页面内恢复器：接收 export 的 storage 部分。
// 仅恢复到已存在的 DB/store（不创建新库，MVP 限制）。
const STATE_IMPORT_EXPR = `(async (storage) => {
  const out = { ls: 0, ss: 0, idb: {}, errors: [] };
  try {
    localStorage.clear();
    for (const [k, v] of Object.entries(storage.ls || {})) { localStorage.setItem(k, v); out.ls++; }
  } catch (e) { out.errors.push("ls: " + e); }
  try {
    sessionStorage.clear();
    for (const [k, v] of Object.entries(storage.ss || {})) { sessionStorage.setItem(k, v); out.ss++; }
  } catch (e) { out.errors.push("ss: " + e); }
  for (const [dbName, stores] of Object.entries(storage.idb || {})) {
    if (!stores || stores.__error) { out.idb[dbName] = "skipped(export error)"; continue; }
    out.idb[dbName] = await new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(dbName); }
      catch (e) { resolve("open failed: " + e); return; }
      req.onerror = () => resolve("open failed: " + req.error);
      req.onsuccess = () => {
        const db = req.result;
        const existing = Array.from(db.objectStoreNames || []);
        const todo = Object.entries(stores).filter(([, entry]) => entry && !entry.__error);
        if (!todo.length) { db.close(); resolve({ restored: 0, errors: [] }); return; }
        let left = todo.length, restored = 0;
        const errs = [];
        const fin = () => { if (--left === 0) { db.close(); resolve({ restored, errors: errs }); } };
        for (const [sn, entry] of todo) {
          if (!existing.includes(sn)) { errs.push(sn + ": store missing"); fin(); continue; }
          try {
            const tx = db.transaction(sn, "readwrite");
            const store = tx.objectStore(sn);
            store.clear();
            for (const rec of entry.records || []) {
              if (entry.keyPath == null) store.put(rec.v, rec.k);
              else store.put(rec.v);
            }
            tx.oncomplete = () => { restored += (entry.records || []).length; fin(); };
            tx.onerror = () => { errs.push(sn + ": " + tx.error); fin(); };
          } catch (e) { errs.push(sn + ": " + e); fin(); }
        }
      };
    });
  }
  return out;
})`;

// ---------------------------------------------------------------------------
// read_page：无障碍树式读页。核心卖点是稳定 ref——
// 可交互元素打 data-owb-ref="e<N>" 属性，同文档内跨快照复用原值，
// click/fill/screenshot 可直接吃 @e ref。编号单调源在扩展侧（per-tab），
// 页面导航后文档重建、ref 自然失效（REF_STALE 提示重新 read_page）。
// ---------------------------------------------------------------------------

/** tabId -> 下一个待分配的 ref 序号（data-owb-ref 的 e<N> 单调源） */
const readPageNextRef = new Map();
/** tabId -> Map<key, hash> 上次 snapshot 的行哈希（since_last 增量原料；key = ref 或 "#hash"） */
const readPageSnapshots = new Map();

// snapshot 的页面内采集器：候选交互元素 → role/name/ref/line/hash。
// hash 在页面里算好（h*31+charCodeAt），增量比对只搬数值。returnByValue 执行。
const READ_PAGE_SNAPSHOT_EXPR = (nextRef, maxNodes) => `(() => {
  const INTERACTIVE = { link:1, button:1, textbox:1, checkbox:1, radio:1, combobox:1,
    listbox:1, option:1, menuitem:1, tab:1, switch:1, slider:1, spinbutton:1, searchbox:1 };
  const SEL = "a[href], button, input, select, textarea, summary, [role], " +
    "[contenteditable='true'], h1, h2, h3, h4, h5, h6, img[alt]";
  const hashOf = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return h;
  };
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
      return "textbox";
    }
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "summary") return "button";
    if (tag === "img") return "img";
    if (/^h[1-6]$/.test(tag)) return "heading";
    return "generic";
  };
  const nameOf = (el) => {
    const v = el.getAttribute("aria-label") || el.getAttribute("alt") ||
      el.getAttribute("placeholder") || el.value || el.innerText || "";
    return String(v).replace(/\\s+/g, " ").trim().slice(0, 80);
  };
  const nodes = [];
  let next = ${nextRef};
  let assigned = 0;
  let truncated = false;
  const els = document.querySelectorAll(SEL);
  for (const el of els) {
    if (nodes.length >= ${maxNodes}) { truncated = true; break; }
    const rect = el.getBoundingClientRect(); // 无布局盒 = 不可见，跳过
    if (!rect || !(rect.width > 0 && rect.height > 0)) continue;
    const role = roleOf(el);
    const name = nameOf(el);
    let ref = null;
    if (INTERACTIVE[role]) {
      ref = el.getAttribute("data-owb-ref"); // 已有 ref 复用原值（同文档内稳定）
      if (!ref) { ref = "e" + next++; el.setAttribute("data-owb-ref", ref); assigned++; }
    }
    let line = (ref ? "@" + ref + " " : "") + role + " \\"" + name.replace(/"/g, "'") + "\\"";
    if (role === "heading") line += " level=" + el.tagName.toLowerCase().charAt(1);
    nodes.push({ ref, role, name, line, hash: hashOf(line) });
  }
  return { url: location.href, title: document.title, nodes,
    nextRef: next, refsAssigned: assigned, truncated };
})()`;

// article 的页面内提取器：简化 readability——候选根按 <p> 文本总长评分取最优，
// 再将其 h1-h6/p/li/blockquote/pre 后代压成 markdown。不引库。
const READ_PAGE_ARTICLE_EXPR = `(() => {
  const roots = [document.body];
  for (const el of document.querySelectorAll(
    "article, main, [role='main'], .article, .content, .post, .rich-content")) {
    roots.push(el);
  }
  let best = null, bestScore = -1;
  for (const root of roots) {
    if (!root) continue;
    let score = 0;
    for (const p of root.querySelectorAll("p")) score += String(p.innerText || "").length;
    if (score > bestScore) { bestScore = score; best = root; }
  }
  if (!best) return { title: document.title, content: "" };
  const fence = String.fromCharCode(96, 96, 96);
  const parts = [];
  for (const el of best.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, blockquote, pre")) {
    const tag = el.tagName.toLowerCase();
    const text = String(el.innerText || "").trim();
    if (!text) continue;
    if (tag === "pre") parts.push(fence + "\\n" + text + "\\n" + fence);
    else if (tag === "blockquote") parts.push("> " + text.replace(/\\n/g, "\\n> "));
    else if (tag === "li") parts.push("- " + text);
    else if (/^h[1-6]$/.test(tag)) parts.push("#".repeat(Number(tag.charAt(1))) + " " + text);
    else parts.push(text);
  }
  return { title: document.title, content: parts.join("\\n\\n") };
})()`;

// mouse_click 的 AI 光标覆盖层：幂等创建 window.__owbCursor 单例。
// 固定定位容器（z-index 拉满 + pointer-events:none，不挡真实鼠标命中测试），
// 内联 SVG 箭头光标（#2563eb + 白描边 + drop-shadow，与系统光标一眼可辨）；
// moveTo 走二次贝塞尔（控制点=中点+垂直偏移）+ ease-in-out，rAF 驱动，
// transform: translate3d 更新；clickFx 放一圈扩散淡出的涟漪（~400ms 自清理）。
// 全部样式走 element.style（CSP 兼容最好，不用 <style>）；
// 导航后单例随文档销毁，下次 mouse_click 重新 ensure。
const CURSOR_OVERLAY_EXPR = `(() => {
  if (window.__owbCursor) return window.__owbCursor;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const root = document.createElement("div");
  root.id = "__owb-cursor-layer";
  const rs = root.style;
  rs.position = "fixed";
  rs.left = "0";
  rs.top = "0";
  rs.width = "0";
  rs.height = "0";
  rs.zIndex = "2147483647";
  rs.pointerEvents = "none";
  (document.body || document.documentElement).appendChild(root);

  const cursor = document.createElement("div");
  const cs = cursor.style;
  cs.position = "fixed";
  cs.left = "0";
  cs.top = "0";
  cs.willChange = "transform";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.style.filter = "drop-shadow(0 1px 2px rgba(0,0,0,0.45))";
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M5 3 L5 17.5 L9.2 13.8 L11.4 19.3 L13.8 18.2 L11.7 12.8 L17 12.8 Z");
  path.setAttribute("fill", "#2563eb");
  path.setAttribute("stroke", "#ffffff");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  cursor.appendChild(svg);
  root.appendChild(cursor);

  const state = { x: 0, y: 0 };
  const apply = () => {
    cs.transform = "translate3d(" + state.x + "px," + state.y + "px,0)";
  };
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
  apply();

  const api = {
    // 从当前位置贝塞尔移动到 (x, y)，duration ms，resolve 最终坐标
    moveTo(x, y, duration) {
      const dur = Math.max(Number(duration) || 0, 0);
      if (!dur) {
        state.x = x; state.y = y; apply();
        return Promise.resolve({ x, y });
      }
      const fromX = state.x, fromY = state.y;
      const dx = x - fromX, dy = y - fromY;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      // 控制点 = 中点 + 垂直方向偏移（弧一点更像人手移动）
      const off = Math.min(dist * 0.2, 80);
      const cx = (fromX + x) / 2 - (dy / dist) * off;
      const cy = (fromY + y) / 2 + (dx / dist) * off;
      let start = null;
      return new Promise((resolve) => {
        const stepFn = (ts) => {
          if (ts == null) ts = Date.now();
          if (start == null) start = ts;
          const t = Math.min((ts - start) / dur, 1);
          const e = easeInOut(t);
          const u = 1 - e;
          state.x = u * u * fromX + 2 * u * e * cx + e * e * x;
          state.y = u * u * fromY + 2 * u * e * cy + e * e * y;
          apply();
          if (t >= 1) { resolve({ x: state.x, y: state.y }); return; }
          requestAnimationFrame(stepFn);
        };
        requestAnimationFrame(stepFn);
      });
    },
    // 当前位置放一圈扩散淡出的涟漪（~400ms 后自清理，fire-and-forget）
    clickFx() {
      const rip = document.createElement("div");
      const s = rip.style;
      s.position = "fixed";
      s.left = (state.x - 11) + "px";
      s.top = (state.y - 11) + "px";
      s.width = "22px";
      s.height = "22px";
      s.borderRadius = "50%";
      s.border = "2px solid #2563eb";
      s.background = "rgba(37,99,235,0.25)";
      s.transition = "transform 0.4s ease-out, opacity 0.4s ease-out";
      s.opacity = "1";
      root.appendChild(rip);
      void rip.offsetWidth; // 强制 reflow，transition 才能从初值起跳
      s.transform = "scale(2.2)";
      s.opacity = "0";
      setTimeout(() => { try { root.removeChild(rip); } catch (e) {} }, 450);
    },
  };
  window.__owbCursor = api;
  return api;
})()`;

const tools = {
  async status() {
    return {
      ws: ws ? ws.readyState : -1,
      helloAcked,
      attachedTabs: [...attachedTabs],
      networkEnabledTabs: [...networkEnabledTabs],
      debuggerEnabledTabs: [...debuggerEnabledTabs],
      pausedTabs: [...pausedState.keys()],
      consoleStreamTabs: [...consoleStreamTabs],
      version: chrome.runtime.getManifest().version,
    };
  },

  async list_tabs() {
    const tabs = await chrome.tabs.query({});
    const groupTitles = {};
    try {
      for (const g of await chrome.tabGroups.query({})) {
        groupTitles[g.id] = g.title;
      }
    } catch (e) {}
    return tabs
      .filter((t) => t.id != null)
      .map((t) => ({
        tabId: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        windowId: t.windowId,
        attached: attachedTabs.has(t.id),
        group: t.groupId >= 0 ? groupTitles[t.groupId] || String(t.groupId) : null,
      }));
  },

  async find_tab(args) {
    const re = toRegExp(args.url_pattern || ".*");
    const tabs = await chrome.tabs.query({});
    const hits = tabs.filter((t) => t.id != null && re.test(t.url || ""));
    return hits.map((t) => ({ tabId: t.id, url: t.url, title: t.title }));
  },

  async navigate(args) {
    if (!args.url) throw new ToolError("BAD_ARGS", "navigate: url is required");
    // new_tab：桥自己开的 tab 才编入 OWB 组；默认复用当前 tab（不动用户的现场）
    let tabId = null;
    let created = false;
    if (args.new_tab) {
      const t = await chrome.tabs.create({
        url: args.url,
        active: args.active !== false,
      });
      tabId = t.id;
      created = true;
    } else {
      tabId = await resolveTabId(args);
    }
    const loaded = new Promise((resolve) => {
      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(true);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(false);
      }, args.timeout_ms || 30000);
    });
    if (!created) await chrome.tabs.update(tabId, { url: args.url });
    let groupId = null;
    if (created) {
      try {
        // 有任务上下文时，桥新建的 tab 编到 task 组；否则照旧 OWB 分析组
        groupId = currentTask
          ? await ensureTaskGroup(tabId)
          : await ensureOwbGroup(tabId);
      } catch (e) {
        // 编组失败不阻断导航（部分环境无 tabGroups UI）
      }
    }
    const completed = await loaded;
    const tab = await chrome.tabs.get(tabId);
    return { tabId, url: tab.url, title: tab.title, loadCompleted: completed, groupId };
  },

  // 一键清场：关掉 OWB 分组的全部 tab（只动桥创建的组，不碰用户 tab）
  async close_group() {
    const groups = await chrome.tabGroups.query({ title: OWB_GROUP_TITLE });
    let closed = 0;
    for (const g of groups) {
      const tabs = await chrome.tabs.query({ groupId: g.id });
      const ids = tabs.map((t) => t.id).filter((id) => id != null);
      if (ids.length) {
        await chrome.tabs.remove(ids);
        closed += ids.length;
      }
    }
    return { closed };
  },

  async evaluate(args) {
    if (!args.expression) throw new ToolError("BAD_ARGS", "evaluate: expression is required");
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    // frame_pattern：在指定 iframe 的执行上下文里求值（先用 list_frames 看 frame 列表）
    let contextId = undefined;
    if (args.frame_pattern != null) {
      try { await cdpCall(tabId, "Runtime.enable"); } catch (e) {}
      contextId = resolveFrameContextId(tabId, args.frame_pattern);
      if (!contextId) {
        throw new ToolError("FRAME_NOT_FOUND",
          `no iframe context matching ${JSON.stringify(args.frame_pattern)}; call list_frames first`, true);
      }
    }
    const res = await cdpCall(tabId, "Runtime.evaluate", {
      expression: args.expression,
      returnByValue: args.returnByValue !== false,
      awaitPromise: !!args.awaitPromise,
      contextId,
    });
    if (res.exceptionDetails) {
      throw new ToolError(
        "EVAL_EXCEPTION",
        res.exceptionDetails.text +
          (res.exceptionDetails.exception
            ? `: ${res.exceptionDetails.exception.description || ""}`
            : "")
      );
    }
    return { value: res.result ? res.result.value : undefined, type: res.result ? res.result.type : undefined };
  },

  async network_start(args) {
    const tabId = await resolveTabId(args);
    const wasEnabled = networkEnabledTabs.has(tabId);
    await ensureNetwork(tabId);
    if (!wasEnabled && args.clear !== false) networkBuffers.set(tabId, new Map());
    return { tabId, capturing: true };
  },

  async network_stop(args) {
    const tabId = await resolveTabId(args);
    if (networkEnabledTabs.has(tabId)) {
      await cdpCall(tabId, "Network.disable");
      networkEnabledTabs.delete(tabId);
    }
    return { tabId, capturing: false, buffered: getBuffer(tabId).size };
  },

  async network_list(args) {
    const tabId = await resolveTabId(args);
    const re = args.url_pattern ? toRegExp(args.url_pattern) : null;
    const limit = args.limit || 100;
    const out = [];
    for (const rec of getBuffer(tabId).values()) {
      if (re && !re.test(rec.url || "")) continue;
      out.push({
        requestId: rec.requestId,
        url: rec.url,
        method: rec.method,
        status: rec.status,
        type: rec.type,
        finished: !!rec.finished,
        failed: !!rec.failed,
      });
      if (out.length >= limit) break;
    }
    return out;
  },

  async network_detail(args) {
    const tabId = await resolveTabId(args);
    const rec = getBuffer(tabId).get(args.request_id);
    if (!rec) throw new ToolError("NOT_FOUND", `request not in buffer: ${args.request_id}`);
    const detail = { ...rec };
    if (args.include_body !== false && rec.finished) {
      try {
        const body = await cdpCall(tabId, "Network.getResponseBody", { requestId: args.request_id });
        // 全量 body（daemon WS 已调到 64MB 帧）；max_body 兜底防超大响应撑爆 agent 上下文
        const max = Math.max(args.max_body || 500000, 1000);
        detail.body = body.body.length > max ? body.body.slice(0, max) + "…(truncated)" : body.body;
        detail.bodyLength = body.body.length;
        detail.truncated = body.body.length > max;
        detail.base64Encoded = body.base64Encoded;
      } catch (e) {
        detail.body = null;
        detail.bodyError = String(e);
      }
    }
    return detail;
  },

  async get_initiator(args) {
    const tabId = await resolveTabId(args);
    const rec = getBuffer(tabId).get(args.request_id);
    if (!rec) throw new ToolError("NOT_FOUND", `request not in buffer: ${args.request_id}`);
    return { requestId: rec.requestId, url: rec.url, initiator: rec.initiator };
  },

  // ---- HAR 录制（独立于 networkBuffers 的探查缓冲）----

  async record_start(args) {
    const tabId = await resolveTabId(args);
    await ensureNetwork(tabId); // 复用 attach + Network.enable
    const tab = await chrome.tabs.get(tabId);
    let origin = null;
    try { origin = new URL(tab.url).origin; } catch (e) {}
    const rec = {
      stats: new Stats(tab.url),
      tabId,
      url: tab.url,
      startedAt: new Date().toISOString(),
      includeBodies: args.include_bodies !== false,
      bodyBytes: 0,
      maxBodyBytes: Math.max(0, args.max_body_bytes != null ? args.max_body_bytes : 5 * 1024 * 1024),
      maxTotalBodyBytes: Math.max(0, args.max_total_body_bytes != null ? args.max_total_body_bytes : 100 * 1024 * 1024),
      bodyCapped: false,
      // 过滤（白/黑名单 + resource_type）
      urlFilter: args.url_pattern ? toRegExp(args.url_pattern) : null,
      excludeFilter: args.exclude_pattern ? toRegExp(args.exclude_pattern) : null,
      resourceTypes: Array.isArray(args.resource_types) && args.resource_types.length
        ? new Set(args.resource_types.map((t) => String(t).toLowerCase())) : null,
      // 增强流
      captureConsole: args.capture_console !== false,
      captureScreenshots: !!args.capture_screenshots,
      captureStorage: args.capture_storage !== false,
      consoleLog: [],
      frames: [],
      storageChanges: [],
      cookiesDiff: null, // record_stop 时填
      // 多 tab 关联
      openerTabId: tab.openerTabId != null ? tab.openerTabId : null,
    };
    rec.stats.openerTabId = rec.openerTabId;
    // 已在录：覆盖（旧录制数据丢弃，避免混淆）
    recorders.set(tabId, rec);
    recorderSkipped.set(tabId, new Set());
    recorderOrigins.set(tabId, origin);
    // 启用增强域：Page.enable（导航截图）+ DOMStorage.enable（storage 流）+
    // Runtime/Log.enable（console 归档）。已启用过的重复调用无副作用。
    try { await cdpCall(tabId, "Page.enable"); } catch (e) {}
    if (rec.captureStorage) {
      try { await cdpCall(tabId, "DOMStorage.enable"); } catch (e) {}
    }
    if (rec.captureConsole) {
      try { await cdpCall(tabId, "Runtime.enable"); } catch (e) {}
      try { await cdpCall(tabId, "Log.enable"); } catch (e) {}
    }
    // cookie 起始快照（stop 时 diff）
    rec._cookiesStart = await snapshotCookies(tabId, origin);
    pushEvent("record", { tabId, phase: "start", url: tab.url });
    return { tabId, recording: true, url: tab.url, filters: {
      url_pattern: rec.urlFilter ? rec.urlFilter.source : null,
      exclude_pattern: rec.excludeFilter ? rec.excludeFilter.source : null,
      resource_types: rec.resourceTypes ? [...rec.resourceTypes] : null,
    } };
  },

  async record_stop(args) {
    // 不指定 tabId：
    //   多个 recorder 在录 → 停全部合并为多 page HAR
    //   恰好一个 recorder 在录 → 停那个（不管是否当前活动 tab）
    //   无 recorder → NOT_RECORDING
    if (args.tabId == null) {
      if (!recorders.size) {
        throw new ToolError("NOT_RECORDING", "no active recorder", false);
      }
      if (recorders.size > 1) return stopAllRecorders(args.title);
      // 单 recorder：直接取它的 tabId
      const onlyTabId = recorders.keys().next().value;
      const rec = recorders.get(onlyTabId);
      const { har, entries } = await finalizeRecorder(onlyTabId, rec, args.title);
      recorders.delete(onlyTabId);
      recorderSkipped.delete(onlyTabId);
      recorderOrigins.delete(onlyTabId);
      pushEvent("record", { tabId: onlyTabId, phase: "stop", entries, bodyBytes: rec.bodyBytes });
      return { tabId: onlyTabId, recording: false, entries, bodyBytes: rec.bodyBytes, har };
    }
    const tabId = await resolveTabId(args);
    const rec = recorders.get(tabId);
    if (!rec) throw new ToolError("NOT_RECORDING", `tab ${tabId} is not recording`, false);
    const { har, entries } = await finalizeRecorder(tabId, rec, args.title);
    recorders.delete(tabId);
    recorderSkipped.delete(tabId);
    recorderOrigins.delete(tabId);
    pushEvent("record", { tabId, phase: "stop", entries, bodyBytes: rec.bodyBytes });
    return { tabId, recording: false, entries, bodyBytes: rec.bodyBytes, har };
  },

  async record_status(args) {
    // 不指定 tabId：汇总所有活动 recorder
    if (args.tabId == null) {
      if (!recorders.size) return { recording: false, recorders: [] };
      const out = [];
      for (const [tabId, rec] of recorders) {
        out.push(statusOf(tabId, rec));
      }
      return { recording: true, recorders: out };
    }
    const tabId = await resolveTabId(args);
    const rec = recorders.get(tabId);
    if (!rec) return { tabId, recording: false };
    return statusOf(tabId, rec);
  },

  // ---- E1. 文件下载（Page.setDownloadBehavior + downloadProgress 等）----

  async download(args) {
    const tabId = await resolveTabId(args);
    if (!args.selector && !args.url) {
      throw new ToolError("BAD_ARGS", "download: selector 或 url 必填一个", false);
    }
    await ensureAttached(tabId);
    try { await cdpCall(tabId, "Page.enable"); } catch (e) {}
    // 默认下载目录：浏览器默认 Downloads；save_path（绝对路径）可覆盖
    const dlPath = args.save_path || "";
    try {
      await cdpCall(tabId, "Page.setDownloadBehavior",
        dlPath ? { behavior: "allow", downloadPath: dlPath } : { behavior: "allow", eventsEnabled: true });
    } catch (e) {
      // 旧版 Chrome 仅支持 behavior+downloadPath，eventsEnabled 可能不支持
      await cdpCall(tabId, "Page.setDownloadBehavior",
        dlPath ? { behavior: "allow", downloadPath: dlPath } : { behavior: "default" });
    }
    // 登记一次性 watcher
    const timeoutMs = Math.min(args.timeout_ms || 60000, 180000);
    const watchPromise = new Promise((resolve, reject) => {
      const w = { resolve, reject, filename: "", url: "", guid: null };
      downloadWatchers.set(tabId, w);
    });
    // 触发下载：url 直接导航，或 click selector
    try {
      if (args.url) {
        await cdpCall(tabId, "Page.navigate", { url: args.url });
      } else {
        await tools.click({ tabId, selector: args.selector });
      }
    } catch (e) {
      downloadWatchers.delete(tabId);
      throw e;
    }
    // 等下载收尾
    let result;
    try {
      const timer = new Promise((_, reject) =>
        setTimeout(() => reject(new ToolError("TIMEOUT", `download not completed in ${timeoutMs}ms`, true)), timeoutMs));
      result = await Promise.race([watchPromise, timer]);
    } finally {
      downloadWatchers.delete(tabId);
    }
    const fullPath = dlPath && result.filename ? dlPath.replace(/[\\/]+$/, "") + "/" + result.filename : result.filename || "(default dir)";
    pushEvent("download", { tabId, filename: result.filename, url: watchPromise.url });
    return { tabId, filename: result.filename, path: fullPath, receivedBytes: result.receivedBytes, state: result.state };
  },

  // ---- E2. 文件上传（页面内 DataTransfer + File，无需文件系统）----

  async upload(args) {
    if (!args.selector) throw new ToolError("BAD_ARGS", "upload: selector is required", false);
    if (!Array.isArray(args.files) || !args.files.length) {
      throw new ToolError("BAD_ARGS", "upload: files array required", false);
    }
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    // 校验 + 归一化文件项
    const norm = args.files.map((f) => {
      if (!f || !f.name || f.base64 == null) {
        throw new ToolError("BAD_ARGS", "upload: each file needs {name, base64}", false);
      }
      return { name: String(f.name), base64: String(f.base64), mime: f.mime || "application/octet-stream" };
    });
    // 页面内：找 input、构造 File、赋给 .files、派发 change（绕文件系统，relay 模式也能用）
    const expr = `(() => {
      const input = document.querySelector(${JSON.stringify(args.selector)});
      if (!input) return { ok: false, error: "selector not found" };
      const dt = new DataTransfer();
      for (const f of ${JSON.stringify(norm)}) {
        const bin = atob(f.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], f.name, { type: f.mime }));
      }
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, count: input.files.length };
    })()`;
    const res = await cdpCall(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
    const v = res.result && res.result.value;
    if (!v || !v.ok) {
      throw new ToolError("UPLOAD_FAILED", (v && v.error) || "upload failed", false);
    }
    return { tabId, filesSet: v.count };
  },

  // ---- E3. PDF 导出（Page.printToPDF）----

  async print_pdf(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    const opts = {
      landscape: !!args.landscape,
      printBackground: args.print_background !== false,
      paperFormat: args.format || "A4",
      marginTop: args.margin_top != null ? args.margin_top : 0.4,
      marginBottom: args.margin_bottom != null ? args.margin_bottom : 0.4,
      marginLeft: args.margin_left != null ? args.margin_left : 0.4,
      marginRight: args.margin_right != null ? args.margin_right : 0.4,
      preferCSSPageSize: !!args.prefer_css_page_size,
    };
    const { data } = await cdpCall(tabId, "Page.printToPDF", opts);
    return { tabId, format: opts.paperFormat, data, size: data ? data.length : 0 };
  },

  // ---- E4. iframe / 执行上下文（list_frames + frame 定向 evaluate）----

  async list_frames(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    try { await cdpCall(tabId, "Runtime.enable"); } catch (e) {}
    const treeRes = await cdpCall(tabId, "Page.getFrameTree");
    const ctxs = frameContexts.get(tabId) || [];
    // frame 树 + 各 frame 的 contextId（若有）
    const ctxByFrame = new Map(ctxs.map((c) => [c.frameId, c.contextId]));
    const walk = (frame, depth) => {
      const f = frame.frame;
      return {
        frameId: f.id,
        url: f.url,
        name: f.name || "",
        contextId: ctxByFrame.get(f.id) || null,
        securityOrigin: f.securityOrigin || "",
        mimeType: f.mimeType || "",
        depth,
        children: (frame.childFrames || []).map((c) => walk(c, depth + 1)),
      };
    };
    return { tabId, main: walk(treeRes.frameTree, 0), contexts: ctxs };
  },

  // ---- D. 环境模拟：设备/网络/地理/时区/语言/权限/UA（统一 emulate 入口）----

  async emulate(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    const applied = [];
    const errs = [];
    // 设备视口/触摸
    if (args.device) {
      const d = args.device;
      try {
        await cdpCall(tabId, "Emulation.setDeviceMetricsOverride", {
          width: d.width || 360, height: d.height || 640,
          deviceScaleFactor: d.device_scale_factor != null ? d.device_scale_factor : 1,
          mobile: !!d.mobile, touch: !!d.touch,
        });
        emulateApplied(tabId, "device"); applied.push("device");
      } catch (e) { errs.push("device: " + e.message); }
    }
    // 网络节流
    if (args.network) {
      const n = args.network;
      try {
        await cdpCall(tabId, "Network.emulateNetworkConditions", {
          offline: !!n.offline,
          latency: n.latency || 0,
          downloadThroughput: n.download || -1,
          uploadThroughput: n.upload || -1,
        });
        emulateApplied(tabId, "network"); applied.push("network");
      } catch (e) { errs.push("network: " + e.message); }
    }
    // 地理位置覆盖
    if (args.geolocation) {
      try {
        await cdpCall(tabId, "Emulation.setGeolocationOverride", {
          latitude: args.geolocation.latitude || 0,
          longitude: args.geolocation.longitude || 0,
          accuracy: args.geolocation.accuracy || 100,
        });
        emulateApplied(tabId, "geolocation"); applied.push("geolocation");
      } catch (e) { errs.push("geolocation: " + e.message); }
    }
    // 时区
    if (args.timezone) {
      try {
        await cdpCall(tabId, "Emulation.setTimezoneOverride", { timezoneId: args.timezone });
        emulateApplied(tabId, "timezone"); applied.push("timezone");
      } catch (e) { errs.push("timezone: " + e.message); }
    }
    // 语言
    if (args.locale) {
      try {
        await cdpCall(tabId, "Emulation.setLocaleOverride", { locale: args.locale });
        emulateApplied(tabId, "locale"); applied.push("locale");
      } catch (e) { errs.push("locale: " + e.message); }
    }
    // 权限授予（notification/geolocation/camera...）
    if (Array.isArray(args.permissions) && args.permissions.length) {
      try {
        await cdpCall(tabId, "Browser.grantPermissions", { permissions: args.permissions });
        emulateApplied(tabId, "permissions"); applied.push("permissions");
      } catch (e) { errs.push("permissions: " + e.message); }
    }
    // UA 覆盖
    if (args.user_agent) {
      try {
        await cdpCall(tabId, "Emulation.setUserAgentOverride",
          { userAgent: args.user_agent, acceptLanguage: args.locale || undefined });
        emulateApplied(tabId, "user_agent"); applied.push("user_agent");
      } catch (e) { errs.push("user_agent: " + e.message); }
    }
    return { tabId, applied, errors: errs.length ? errs : undefined,
             active: emulateState.get(tabId) ? [...emulateState.get(tabId)] : [] };
  },

  async emulate_reset(args) {
    const tabId = await resolveTabId(args);
    const s = emulateState.get(tabId);
    if (!s) return { tabId, reset: [] };
    const reset = [];
    for (const type of s) {
      try {
        if (type === "device") await cdpCall(tabId, "Emulation.clearDeviceMetricsOverride");
        else if (type === "network") {
          // Network 重置节流：disable 再 enable（emulateNetworkConditions 无 clear）
          try { await cdpCall(tabId, "Network.disable"); } catch (e) {}
          await cdpCall(tabId, "Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        }
        else if (type === "geolocation") await cdpCall(tabId, "Emulation.clearGeolocationOverride");
        else if (type === "timezone") await cdpCall(tabId, "Emulation.setTimezoneOverride", { timezoneId: "" });
        else if (type === "locale") await cdpCall(tabId, "Emulation.setLocaleOverride", { locale: "" });
        else if (type === "permissions") await cdpCall(tabId, "Browser.resetPermissions");
        else if (type === "user_agent") await cdpCall(tabId, "Emulation.setUserAgentOverride", { userAgent: "" });
        reset.push(type);
      } catch (e) {}
    }
    emulateState.delete(tabId);
    return { tabId, reset };
  },

  async hook_preset(args) {
    const tabId = await resolveTabId(args);
    const presets = args.presets || (args.preset ? [args.preset] : ["xhr"]);
    await ensureHookChannel(tabId);
    const reg = tabHookRegistry(tabId);
    const registered = [];
    for (const name of presets) {
      if (reg.has(name)) {
        registered.push({ preset: name, identifier: reg.get(name), already: true });
        continue;
      }
      const source = await loadPresetSource(name);
      const { identifier } = await cdpCall(
        tabId, "Page.addScriptToEvaluateOnNewDocument", { source }
      );
      reg.set(name, identifier);
      registered.push({ preset: name, identifier });
    }
    await saveHookRegistry();
    // addScriptToEvaluateOnNewDocument 只对之后创建的 document 生效
    let reloaded = false;
    if (args.reload !== false) {
      await cdpCall(tabId, "Page.reload", { ignoreCache: !!args.ignoreCache });
      reloaded = true;
    }
    return { tabId, registered, reloaded };
  },

  async hook_remove(args) {
    const tabId = await resolveTabId(args);
    const reg = tabHookRegistry(tabId);
    const names = args.presets || (args.preset ? [args.preset] : [...reg.keys()]);
    const removed = [];
    for (const name of names) {
      const identifier = reg.get(name);
      if (!identifier) continue;
      try {
        await cdpCall(tabId, "Page.removeScriptToEvaluateOnNewDocument", { identifier });
      } catch (e) {
        // debugger session 已失效（detach）时移除会报错，登记照删
      }
      reg.delete(name);
      removed.push(name);
    }
    await saveHookRegistry();
    return { tabId, removed };
  },

  async hook_status(args) {
    const tabId = await resolveTabId(args);
    const reg = hookRegistry.get(tabId);
    return {
      tabId,
      presets: reg ? Object.fromEntries(reg) : {},
      bindingReady: hookBoundTabs.has(tabId),
    };
  },

  async hook_function(args) {
    const tabId = await resolveTabId(args);
    if (!args.function_path) {
      throw new ToolError("BAD_ARGS", "hook_function: function_path is required");
    }
    const position = args.position || "after";
    if (!["before", "after", "replace"].includes(position)) {
      throw new ToolError("BAD_ARGS", `hook_function: bad position: ${position}`);
    }
    const key = `fn:${args.function_path}#${position}`;
    await ensureHookChannel(tabId);
    const reg = tabHookRegistry(tabId);
    if (reg.has(key)) {
      return { tabId, registered: [{ preset: key, identifier: reg.get(key), already: true }] };
    }
    const source = await loadFnHookSource({
      key,
      path: args.function_path,
      position,
      hookCode: args.hook_code || null,
      replacement: args.replacement || null,
      trace: {
        args: args.trace_args !== false,
        ret: args.trace_ret !== false,
        stack: !!args.trace_stack,
      },
      nonOverridable: !!args.non_overridable,
    });
    const { identifier } = await cdpCall(
      tabId, "Page.addScriptToEvaluateOnNewDocument", { source }
    );
    reg.set(key, identifier);
    await saveHookRegistry();
    let reloaded = false;
    if (args.reload !== false) {
      await cdpCall(tabId, "Page.reload", { ignoreCache: !!args.ignoreCache });
      reloaded = true;
    }
    return { tabId, registered: [{ preset: key, identifier }], reloaded };
  },

  // ---- 页面内函数调用（oracle_call）----

  async oracle_call(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    const freeze = args.freeze !== false;
    const callArgs = args.call_args || [];
    if (args.object_id) {
      // objectId 引用（frame_read 拿到的闭包函数）
      const res = await cdpCall(tabId, "Runtime.callFunctionOn", {
        objectId: args.object_id,
        functionDeclaration: ORACLE_CALL_ON_OBJECT,
        arguments: [{ value: { callArgs, freeze } }],
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.exceptionDetails) {
        throw new ToolError(
          "EVAL_EXCEPTION",
          res.exceptionDetails.text +
            (res.exceptionDetails.exception
              ? `: ${res.exceptionDetails.exception.description || ""}`
              : "")
        );
      }
      return res.result ? res.result.value : undefined;
    }
    if (!args.function_path) {
      throw new ToolError("BAD_ARGS", "oracle_call: function_path or object_id is required");
    }
    const expression =
      `${ORACLE_EXPR}(${JSON.stringify(args.function_path)}, ` +
      `${JSON.stringify(callArgs)}, ${freeze})`;
    return evaluateJs(tabId, expression, { awaitPromise: true });
  },

  // ---- 会话态快照/恢复 ----

  async export_state(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    const tab = await chrome.tabs.get(tabId);
    let origin;
    try {
      origin = new URL(tab.url).origin;
    } catch (e) {
      throw new ToolError("BAD_TAB", `tab has no http(s) url: ${tab.url}`);
    }
    // HttpOnly cookie 也包含（CDP 全量拿）
    let cookies = [];
    try {
      const res = await cdpCall(tabId, "Network.getCookies", { urls: [origin, tab.url] });
      cookies = res.cookies || [];
    } catch (e) {}
    const storage = await evaluateJs(tabId, STATE_EXPORT_EXPR, { awaitPromise: true });
    return {
      tabId,
      url: tab.url,
      origin,
      cookies,
      storage: storage ?? null,
      exportedAt: new Date().toISOString(),
    };
  },

  async import_state(args) {
    const tabId = await resolveTabId(args);
    const state = args.state;
    if (!state || typeof state !== "object") {
      throw new ToolError("BAD_ARGS", "import_state: state object is required");
    }
    await ensureAttached(tabId);
    let cookiesSet = 0, cookiesFailed = 0;
    for (const c of state.cookies || []) {
      try {
        const params = { name: c.name, value: c.value, path: c.path || "/" };
        // url 与 domain 二选一：域名 cookie（.example.com）用 domain，否则用 url
        if (c.domain && c.domain.startsWith(".")) params.domain = c.domain;
        else if (state.origin) params.url = state.origin + "/";
        params.secure = !!c.secure;
        params.httpOnly = !!c.httpOnly;
        if (c.sameSite) params.sameSite = c.sameSite;
        if (c.expires && c.expires > 0) params.expires = Math.floor(c.expires);
        await cdpCall(tabId, "Network.setCookie", params);
        cookiesSet++;
      } catch (e) {
        cookiesFailed++;
      }
    }
    const expression = `(${STATE_IMPORT_EXPR})(${JSON.stringify(state.storage || {})})`;
    const storage = await evaluateJs(tabId, expression, { awaitPromise: true });
    return {
      tabId,
      cookiesSet,
      cookiesFailed,
      storage: storage ?? null,
    };
  },

  // ---- Debugger 域 ----

  async break_xhr(args) {
    const tabId = await resolveTabId(args);
    if (!args.url_substring) {
      throw new ToolError("BAD_ARGS", "break_xhr: url_substring is required");
    }
    await ensureDebugger(tabId);
    await cdpCall(tabId, "DOMDebugger.setXHRBreakpoint", { url: args.url_substring });
    armedBreakpoints(tabId).add("xhr:" + args.url_substring);
    return { tabId, armed: "xhr:" + args.url_substring };
  },

  async break_remove(args) {
    const tabId = await resolveTabId(args);
    const armed = armedBreakpoints(tabId);
    const targets = args.url_substring
      ? ["xhr:" + args.url_substring]
      : args.key
        ? [args.key]
        : [...armed];
    const bpIds = breakpointIdsMap.get(tabId);
    const removed = [];
    for (const b of targets) {
      if (!armed.has(b)) continue;
      if (b.startsWith("xhr:")) {
        try {
          await cdpCall(tabId, "DOMDebugger.removeXHRBreakpoint", { url: b.slice(4) });
        } catch (e) {}
      } else {
        // fn:/url: 断点按 breakpointId 移除
        const bpId = bpIds && bpIds.get(b);
        if (bpId) {
          try {
            await cdpCall(tabId, "Debugger.removeBreakpoint", { breakpointId: bpId });
          } catch (e) {}
          bpIds.delete(b);
        }
      }
      armed.delete(b);
      removed.push(b);
    }
    await maybeDisableDebugger(tabId);
    return { tabId, removed };
  },

  async frame_read(args) {
    const tabId = await resolveTabId(args);
    const paused = pausedState.get(tabId);
    if (!paused) {
      throw new ToolError("NOT_PAUSED", "page is not paused at a breakpoint", true);
    }
    const maxFrames = args.max_frames || 3;
    const propLimit = args.prop_limit || 40;
    const frames = [];
    for (let i = 0; i < Math.min(paused.callFrames.length, maxFrames); i++) {
      const cf = paused.callFrames[i];
      const scopes = {};
      for (const scope of cf.scopeChain || []) {
        if (scope.type === "global" && args.include_global !== true) continue;
        if (!scope.object || !scope.object.objectId) continue;
        try {
          scopes[scope.type] = await readScopeProperties(
            tabId, scope.object.objectId, propLimit
          );
        } catch (e) {
          scopes[scope.type] = { __error: String(e) };
        }
      }
      frames.push({
        frameIndex: i,
        functionName: cf.functionName || "(anonymous)",
        url: cf.url,
        lineNumber: cf.location ? cf.location.lineNumber : undefined,
        this: cf.this ? cf.this.description || cf.this.type : undefined,
        scopes,
      });
    }
    // frozen-snapshot：默认 dump 完立即 resume，防页面长冻结
    let resumed = false;
    if (args.auto_resume !== false) {
      try {
        await cdpCall(tabId, "Debugger.resume");
        resumed = true;
      } catch (e) {}
    }
    return { tabId, reason: paused.reason, frames, resumed };
  },

  async resume(args) {
    const tabId = await resolveTabId(args);
    await cdpCall(tabId, "Debugger.resume");
    return { tabId, resumed: true };
  },

  async step(args) {
    const tabId = await resolveTabId(args);
    const map = {
      into: "Debugger.stepInto",
      over: "Debugger.stepOver",
      out: "Debugger.stepOut",
    };
    const method = map[args.action || "over"];
    if (!method) {
      throw new ToolError("BAD_ARGS", `step: action must be one of ${Object.keys(map)}`);
    }
    await cdpCall(tabId, method, {});
    return { tabId, stepped: args.action || "over" };
  },

  async console_stream(args) {
    const tabId = await resolveTabId(args);
    const on = args.enabled !== false;
    await ensureAttached(tabId);
    if (on) {
      await cdpCall(tabId, "Runtime.enable");
      await cdpCall(tabId, "Log.enable");
      consoleStreamTabs.add(tabId);
    } else {
      consoleStreamTabs.delete(tabId);
    }
    return { tabId, consoleStream: on };
  },

  // ---- 宏工具：一键证据包 ----

  async capture_request(args) {
    const tabId = await resolveTabId(args);
    if (!args.url_pattern) {
      throw new ToolError("BAD_ARGS", "capture_request: url_pattern is required");
    }
    const re = toRegExp(args.url_pattern);
    await ensureNetwork(tabId);
    const buf = getBuffer(tabId);
    const before = new Set(buf.keys());

    if (args.trigger && args.trigger.expression) {
      await tools.evaluate({ tabId, expression: args.trigger.expression });
    }

    const deadline = Date.now() + (args.timeout_ms || 15000);
    let found = null;
    while (Date.now() < deadline) {
      for (const rec of buf.values()) {
        if (!before.has(rec.requestId) && re.test(rec.url || "")) {
          found = rec;
          break;
        }
      }
      if (found) break;
      await sleep(200);
    }
    if (!found) {
      throw new ToolError(
        "TIMEOUT",
        `no request matching ${args.url_pattern} within timeout`, true
      );
    }
    // 等响应收尾（最多 5s），保证 body 可取
    const finishDeadline = Date.now() + 5000;
    while (!found.finished && !found.failed && Date.now() < finishDeadline) {
      await sleep(100);
    }

    const detail = await tools.network_detail({
      tabId,
      request_id: found.requestId,
    });
    const newRequests = [];
    for (const rec of buf.values()) {
      if (before.has(rec.requestId)) continue;
      newRequests.push({
        requestId: rec.requestId,
        url: rec.url,
        method: rec.method,
        status: rec.status,
        type: rec.type,
      });
    }
    return {
      tabId,
      request: detail,
      initiator: found.initiator,
      newRequests,
    };
  },

  // ---- 条件等待：扩展侧轮询，250ms 间隔 + deadline ----

  async wait_for(args) {
    const tabId = await resolveTabId(args);
    const kinds = ["selector", "text", "url_pattern", "network_idle"];
    const given = kinds.filter(
      (k) => args[k] !== undefined && args[k] !== null && args[k] !== false && args[k] !== ""
    );
    if (given.length !== 1) {
      throw new ToolError(
        "BAD_ARGS",
        "wait_for: selector/text/url_pattern/network_idle 四选一（且必给一个）", false
      );
    }
    const kind = given[0];
    const state = args.state || "visible";
    if (kind === "selector" && !["visible", "attached"].includes(state)) {
      throw new ToolError("BAD_ARGS", `wait_for: bad state: ${state}`, false);
    }
    const timeoutMs = Math.min(args.timeout_ms || 10000, 110000);
    const idleMs = args.idle_ms || 500;
    const start = Date.now();
    const deadline = start + timeoutMs;
    const elapsedMs = () => Date.now() - start;

    if (kind === "network_idle") {
      // in-flight = buffer 里 !finished && !failed 的记录数；持续为 0 满 idle_ms 即返回
      await ensureNetwork(tabId);
      let idleSince = null;
      while (Date.now() < deadline) {
        let inflight = 0;
        for (const rec of getBuffer(tabId).values()) {
          if (!rec.finished && !rec.failed) inflight++;
        }
        if (inflight === 0) {
          if (idleSince == null) idleSince = Date.now();
          if (Date.now() - idleSince >= idleMs) {
            return { tabId, condition: kind, elapsedMs: elapsedMs(), idleMs };
          }
        } else {
          idleSince = null;
        }
        await sleep(250);
      }
    } else {
      const re = kind === "url_pattern" ? toRegExp(args.url_pattern) : null;
      await ensureAttached(tabId);
      while (Date.now() < deadline) {
        try {
          if (kind === "url_pattern") {
            const tab = await chrome.tabs.get(tabId);
            if (re.test(tab.url || "")) {
              return { tabId, condition: kind, elapsedMs: elapsedMs(), url: tab.url };
            }
          } else {
            const expression =
              kind === "selector"
                ? `(() => { const el = document.querySelector(${JSON.stringify(args.selector)});` +
                  ` if (!el) return null;` +
                  (state === "visible"
                    ? ` const r = el.getBoundingClientRect();` +
                      ` if (!(r.width > 0 && r.height > 0)) return null;`
                    : "") +
                  ` return { tag: el.tagName, text: String(el.innerText || el.value || "").slice(0, 80) }; })()`
                : `(() => (document.body && document.body.innerText.includes(${JSON.stringify(args.text)})) || false)()`;
            const res = await cdpCall(tabId, "Runtime.evaluate", {
              expression,
              returnByValue: true,
            });
            const v = res.result && res.result.value;
            if (v) {
              return {
                tabId, condition: kind, elapsedMs: elapsedMs(),
                ...(kind === "selector" ? v : { text: args.text }),
              };
            }
          }
        } catch (e) {
          // 导航途中 execution context 销毁等瞬态错误：继续轮询到 deadline
        }
        await sleep(250);
      }
    }
    throw new ToolError(
      "TIMEOUT",
      `wait_for: ${kind} 条件 ${timeoutMs}ms 内未满足`, true
    );
  },

  // ---- 读页：snapshot（稳定 ref）/ article / text ----

  async read_page(args) {
    const tabId = await resolveTabId(args);
    const mode = args.mode || "snapshot";
    if (!["snapshot", "article", "text"].includes(mode)) {
      throw new ToolError("BAD_ARGS", `read_page: bad mode: ${mode}`, false);
    }
    const maxChars = Math.max(args.max_chars || 20000, 100);
    await ensureAttached(tabId);

    if (mode === "text") {
      const res = await cdpCall(tabId, "Runtime.evaluate", {
        expression: `(() => String((document.body && document.body.innerText) || ""))()`,
        returnByValue: true,
      });
      const text = (res.result && res.result.value) || "";
      return {
        tabId, mode,
        text: text.length > maxChars ? text.slice(0, maxChars) : text,
        truncated: text.length > maxChars,
      };
    }

    if (mode === "article") {
      const v = (await evaluateJs(tabId, READ_PAGE_ARTICLE_EXPR)) || { title: "", content: "" };
      return {
        tabId, mode, title: v.title,
        content: v.content.length > maxChars ? v.content.slice(0, maxChars) : v.content,
        length: v.content.length,
        truncated: v.content.length > maxChars,
      };
    }

    // snapshot：页面表达式算好 nodes/line/hash，增量比对在扩展侧做
    const maxNodes = Math.min(Math.max(args.max_nodes || 400, 1), 2000);
    const nextRef = readPageNextRef.get(tabId) || 1;
    const v = (await evaluateJs(tabId, READ_PAGE_SNAPSHOT_EXPR(nextRef, maxNodes))) || { nodes: [], nextRef };
    readPageNextRef.set(tabId, v.nextRef);

    const prev = readPageSnapshots.get(tabId) || new Map();
    const cur = new Map();
    for (const n of v.nodes) cur.set(n.ref || "#" + n.hash, n.hash);
    let nodes = v.nodes;
    let stats = null;
    if (args.since_last) {
      stats = { added: 0, changed: 0, removed: 0, unchanged: 0 };
      const kept = [];
      for (const n of nodes) {
        const key = n.ref || "#" + n.hash;
        const old = prev.get(key);
        if (old === undefined) { stats.added++; kept.push(n); }
        else if (old !== n.hash) { stats.changed++; kept.push(n); }
        else { stats.unchanged++; }
      }
      for (const k of prev.keys()) {
        if (!cur.has(k)) stats.removed++;
      }
      nodes = kept;
    }
    readPageSnapshots.set(tabId, cur);

    let lines = nodes.map((n) => n.line).join("\n");
    let truncated = !!v.truncated;
    if (lines.length > maxChars) {
      lines = lines.slice(0, maxChars);
      truncated = true;
    }
    return {
      tabId, mode, url: v.url, title: v.title,
      lines, nodes, truncated, refsAssigned: v.refsAssigned,
      ...(stats ? { stats } : {}),
    };
  },

  // ---- 任务上下文（内部管道工具，daemon task_begin/task_end 远程调）----

  async task_context(args) {
    if (args.action === "clear") {
      if (!currentTask) return { cleared: false };
      const t = currentTask;
      currentTask = null;
      let tabIds = [];
      if (t.groupId != null) {
        try {
          const tabs = await chrome.tabs.query({ groupId: t.groupId });
          tabIds = tabs.map((x) => x.id).filter((id) => id != null);
        } catch (e) {
          // 组已不存在：统计按空返回
        }
      }
      return { cleared: true, title: t.title, groupId: t.groupId, tabIds, tabCount: tabIds.length };
    }
    if (!args.title) {
      throw new ToolError("BAD_ARGS", "task_context: title 必填（清任务用 action: clear）", false);
    }
    currentTask = { title: String(args.title), groupId: null };
    return { taskSet: true, title: currentTask.title };
  },

  // ---- 真实鼠标与人机交接 ----
  // mouse_click：Input.dispatchMouseEvent 走真实输入管线（isTrusted=true，
  // 触发 hover/focus/dblclick 等副作用），配合 AI 光标动画让操作对用户可见。

  async mouse_click(args) {
    const tabId = await resolveTabId(args);
    const target = resolveTargetSelector(args, "mouse_click");
    const button = args.button || "left";
    if (!["left", "right", "middle"].includes(button)) {
      throw new ToolError("BAD_ARGS", `mouse_click: bad button: ${button}`, false);
    }
    const clickCount = Math.min(Math.max(parseInt(args.click_count, 10) || 1, 1), 2);
    await ensureAttached(tabId);
    // 元素中心点（视口坐标）：scrollIntoView 后取 getBoundingClientRect
    const found = await cdpCall(tabId, "Runtime.evaluate", {
      expression: elementSnippet(
        target.selector,
        `const r = el.getBoundingClientRect();` +
        ` return { x: r.x + r.width / 2, y: r.y + r.height / 2,` +
        ` tag: el.tagName, text: String(el.innerText || el.value || "").slice(0, 80) };`
      ),
      returnByValue: true,
    });
    const v = found.result && found.result.value;
    if (!v) targetNotFound(target, "mouse_click");
    const x = v.x, y = v.y;
    // AI 光标：ensure 覆盖层（幂等）→ 贝塞尔移动动画（~450ms，await 到位再点）
    await evaluateJs(tabId, CURSOR_OVERLAY_EXPR, { returnByValue: false });
    await evaluateJs(tabId, `window.__owbCursor.moveTo(${x}, ${y}, 450)`, { awaitPromise: true });
    // 真实鼠标事件序列：moved → pressed → released（双击再来一轮 clickCount=2）
    await cdpCall(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: "none",
    });
    for (let i = 1; i <= clickCount; i++) {
      await cdpCall(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button, clickCount: i,
      });
      await cdpCall(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button, clickCount: i,
      });
    }
    // 涟漪反馈（fire-and-forget）
    cdpCall(tabId, "Runtime.evaluate", {
      expression: `window.__owbCursor.clickFx()`,
      returnByValue: false,
    }).catch(() => {});
    return {
      tabId, x, y, button,
      clicked: target.ref || target.selector,
      ...(v.tag ? { tag: v.tag } : {}),
      ...(v.text ? { text: v.text } : {}),
    };
  },

  // handoff：把 tab 编入「✋ OWB 等你操作」组（orange）交还用户，
  // 记录交接状态（wait_user 命中后按它清场）并推 waiting 事件。
  async handoff(args) {
    const tabId = await resolveTabId(args);
    const reason = String(args.reason || "");
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || "";
    try {
      await ensureNamedGroup(tabId, HANDOFF_GROUP_TITLE, HANDOFF_GROUP_COLOR);
    } catch (e) {
      // 编组失败不阻断交接（部分环境无 tabGroups UI）
    }
    handoffState.add(tabId);
    pushEvent("handoff", { tabId, phase: "waiting", reason, url });
    return { tabId, handedOff: true, reason, url };
  },

  // wait_user：挂起轮询（500ms）直到用户接管迹象出现。不要求先 handoff——
  // 基线 URL 取调用时 tab 的 URL。命中且该 tab 处于交接态时默认清场
  // （出组 + 删状态 + 推 resolved 事件，clear:false 可关）。
  // ⚠️ 经 MCP 调用时把 timeout 调到 ≥ timeout_ms/1000 + 10（MCP 默认 120s 会提前掐断）。
  async wait_user(args) {
    const tabId = await resolveTabId(args);
    const condition = args.condition || "url_change";
    if (!["url_change", "selector", "text"].includes(condition)) {
      throw new ToolError("BAD_ARGS", `wait_user: bad condition: ${condition}`, false);
    }
    if (condition === "selector" && !args.selector) {
      throw new ToolError("BAD_ARGS", "wait_user: condition=selector 时 selector 必填", false);
    }
    if (condition === "text" && !args.text) {
      throw new ToolError("BAD_ARGS", "wait_user: condition=text 时 text 必填", false);
    }
    // daemon ctl 天花板 300s，留 20s 余量给编排开销
    const timeoutMs = Math.min(args.timeout_ms || 280000, 280000);
    const clear = args.clear !== false;
    if (condition !== "url_change") await ensureAttached(tabId);
    const tab0 = await chrome.tabs.get(tabId);
    const baselineUrl = tab0.url || "";
    const start = Date.now();
    const deadline = start + timeoutMs;
    const elapsedMs = () => Date.now() - start;
    while (Date.now() < deadline) {
      try {
        if (condition === "url_change") {
          const tab = await chrome.tabs.get(tabId);
          if ((tab.url || "") !== baselineUrl) {
            return await resolveWaitUser(tabId, condition, tab.url || "", elapsedMs(), clear);
          }
        } else {
          // 与 wait_for 一致的可见性判断
          const expression =
            condition === "selector"
              ? `(() => { const el = document.querySelector(${JSON.stringify(args.selector)});` +
                ` if (!el) return null;` +
                ` const r = el.getBoundingClientRect();` +
                ` if (!(r.width > 0 && r.height > 0)) return null;` +
                ` return true; })()`
              : `(() => (document.body && document.body.innerText.includes(${JSON.stringify(args.text)})) || false)()`;
          const res = await cdpCall(tabId, "Runtime.evaluate", {
            expression,
            returnByValue: true,
          });
          if (res.result && res.result.value) {
            const tab = await chrome.tabs.get(tabId);
            return await resolveWaitUser(tabId, condition, tab.url || "", elapsedMs(), clear);
          }
        }
      } catch (e) {
        // 导航途中 execution context 销毁等瞬态错误：继续轮询到 deadline
      }
      await sleep(500);
    }
    throw new ToolError(
      "TIMEOUT",
      `wait_user: ${condition} 条件 ${timeoutMs}ms 内未满足`, true
    );
  },

  // ---- Fetch 域脚本改写与监视 ----

  async script_patch(args) {
    const tabId = await resolveTabId(args);
    if (!args.url_pattern) {
      throw new ToolError("BAD_ARGS", "script_patch: url_pattern is required (CDP glob)");
    }
    const type = args.patch_type || "prepend";
    if (!["prepend", "proxy_probe"].includes(type)) {
      throw new ToolError("BAD_ARGS", `script_patch: bad patch_type: ${type}`);
    }
    if (type === "prepend" && !args.code) {
      throw new ToolError("BAD_ARGS", "script_patch: code is required for prepend");
    }
    await ensureAttached(tabId);
    const entry = {
      id: ++scriptRegId,
      pattern: args.url_pattern,
      regex: globToRegExp(args.url_pattern),
      type,
      code: args.code || null,
    };
    tabPatches(tabId).push(entry);
    await rebuildFetchPatterns(tabId);
    return { tabId, patch: { id: entry.id, pattern: entry.pattern, type: entry.type } };
  },

  async script_unpatch(args) {
    const tabId = await resolveTabId(args);
    const patches = tabPatches(tabId);
    const before = patches.length;
    const kept = patches.filter((p) => {
      if (args.id != null) return p.id !== args.id;
      if (args.url_pattern) return p.pattern !== args.url_pattern;
      return false; // 无过滤条件 = 全清
    });
    fetchPatchTabs.set(tabId, kept);
    await rebuildFetchPatterns(tabId);
    return { tabId, removed: before - kept.length };
  },

  async watch_script(args) {
    const tabId = await resolveTabId(args);
    if (!args.url_pattern) {
      throw new ToolError("BAD_ARGS", "watch_script: url_pattern is required (CDP glob)");
    }
    const action = args.action || "notify";
    if (action === "patch") {
      // 声明式"命中即改写"等价于直接注册 Fetch 改写
      return await tools.script_patch({
        tabId,
        url_pattern: args.url_pattern,
        patch_type: args.patch_type || "proxy_probe",
        code: args.code,
      });
    }
    if (action !== "notify") {
      throw new ToolError("BAD_ARGS", `watch_script: bad action: ${action}`);
    }
    await ensureNetwork(tabId);
    let list = scriptWatchers.get(tabId);
    if (!list) {
      list = [];
      scriptWatchers.set(tabId, list);
    }
    const entry = {
      id: ++scriptRegId,
      pattern: args.url_pattern,
      regex: globToRegExp(args.url_pattern),
    };
    list.push(entry);
    return { tabId, watcher: { id: entry.id, pattern: entry.pattern, action: "notify" } };
  },

  async watch_remove(args) {
    const tabId = await resolveTabId(args);
    const list = scriptWatchers.get(tabId) || [];
    const kept = list.filter((w) => {
      if (args.id != null) return w.id !== args.id;
      if (args.url_pattern) return w.pattern !== args.url_pattern;
      return false;
    });
    scriptWatchers.set(tabId, kept);
    return { tabId, removed: list.length - kept.length };
  },

  // ---- 环境基准采集（env_compare）----

  async env_compare(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    const batches = {};
    const generic = {
      navigator: ENV_PROBES_A,
      screen_window: ENV_PROBES_B,
      document_perf: ENV_PROBES_C,
    };
    for (const [name, probes] of Object.entries(generic)) {
      const res = await cdpCall(tabId, "Runtime.evaluate", {
        expression: ENV_COLLECT_EXPR(probes),
        returnByValue: true,
      });
      batches[name] = res.result ? res.result.value : { __error: "no result" };
    }
    const res = await cdpCall(tabId, "Runtime.evaluate", {
      expression: ENV_FEATURES_EXPR,
      returnByValue: true,
    });
    batches.features = res.result ? res.result.value : { __error: "no result" };
    return { tabId, batches };
  },

  // ---- 通用操作面（截图 / CDP 逃生舱 / 关 tab / 输入三件套）----

  // 安全护栏：默认只允许关 OWB 管理的分组里的 tab（OWB 分析 / ✋ OWB 等你操作 /
  // task: 前缀），用户的 tab 绝不误关；force: true 显式跳过限制。
  async close_tab(args) {
    const tabId = await resolveTabId(args);
    if (!args.force) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) {
        throw new ToolError("BAD_TAB", `close_tab: tab not found: ${tabId}`, false);
      }
      let managed = false;
      if (tab.groupId != null && tab.groupId >= 0) {
        try {
          const group = await chrome.tabGroups.get(tab.groupId);
          const title = group.title || "";
          managed =
            title === OWB_GROUP_TITLE ||
            title === HANDOFF_GROUP_TITLE ||
            title.startsWith("task: ");
        } catch (e) {}
      }
      if (!managed) {
        throw new ToolError(
          "FORBIDDEN",
          `close_tab: tab ${tabId} 不在 OWB 管理的分组（「${OWB_GROUP_TITLE}」/「${HANDOFF_GROUP_TITLE}」/「task: 」前缀），拒绝关闭；确认要关请传 force: true`,
          false
        );
      }
    }
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      throw new ToolError("BAD_TAB", `close_tab: ${e.message}`, false);
    }
    return { tabId, closed: true };
  },

  async screenshot(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    const format = args.format === "jpeg" ? "jpeg" : "png";
    const params = { format };
    if (format === "jpeg") {
      params.quality = Math.min(Math.max(parseInt(args.quality, 10) || 80, 1), 100);
    }
    // full_page：captureBeyondViewport 截整页（不指定 clip 时）
    if (args.full_page) params.captureBeyondViewport = true;
    const target = resolveTargetSelector(args, "screenshot", false);
    if (target) {
      const res = await cdpCall(tabId, "Runtime.evaluate", {
        expression: elementSnippet(
          target.selector,
          `const r = el.getBoundingClientRect();` +
          ` return { x: r.x, y: r.y, width: r.width, height: r.height };`
        ),
        returnByValue: true,
      });
      const rect = res.result && res.result.value;
      if (!rect) targetNotFound(target, "screenshot");
      params.clip = { ...rect, scale: 1 };
    }
    const shot = await cdpCall(tabId, "Page.captureScreenshot", params);
    return { tabId, format, data: shot.data, dataLength: shot.data.length };
  },

  // 逃生舱：任意 CDP 方法直通，新能力不用等扩展发版。
  // 高危方法（Fetch.enable 跳过 fail-safe 等）由调用方自负。
  async cdp(args) {
    const tabId = await resolveTabId(args);
    if (!args.method) throw new ToolError("BAD_ARGS", "cdp: method is required");
    await ensureAttached(tabId);
    const result = await cdpCall(tabId, args.method, args.params || {});
    return { tabId, method: args.method, result };
  },

  async click(args) {
    const tabId = await resolveTabId(args);
    const target = resolveTargetSelector(args, "click");
    await ensureAttached(tabId);
    const res = await cdpCall(tabId, "Runtime.evaluate", {
      expression: elementSnippet(
        target.selector,
        `el.click();` +
        ` return { tag: el.tagName, text: String(el.innerText || el.value || "").slice(0, 80) };`
      ),
      returnByValue: true,
    });
    const v = res.result && res.result.value;
    if (!v) targetNotFound(target, "click");
    return { tabId, clicked: target.selector, ...(target.ref ? { ref: target.ref } : {}), ...v };
  },

  async fill(args) {
    const tabId = await resolveTabId(args);
    const target = resolveTargetSelector(args, "fill");
    await ensureAttached(tabId);
    const res = await cdpCall(tabId, "Runtime.evaluate", {
      expression: elementSnippet(
        target.selector,
        `el.focus();` +
        ` const value = ${JSON.stringify(String(args.value != null ? args.value : ""))};` +
        ` if (el.isContentEditable) { el.textContent = value; }` +
        ` else {` +
        `   const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;` +
        `   Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);` + // native setter 绕 React 受控组件
        ` }` +
        ` el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));` +
        ` el.dispatchEvent(new Event("change", { bubbles: true }));` +
        ` return { tag: el.tagName, value };`
      ),
      returnByValue: true,
    });
    const v = res.result && res.result.value;
    if (!v) targetNotFound(target, "fill");
    return { tabId, filled: target.selector, ...(target.ref ? { ref: target.ref } : {}), ...v };
  },

  async send_keys(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    if (args.text != null && args.text !== "") {
      await cdpCall(tabId, "Input.insertText", { text: String(args.text) });
      return { tabId, inserted: String(args.text).length };
    }
    const keys = String(args.keys || "").trim().split(/\s+/).filter(Boolean);
    if (!keys.length) {
      throw new ToolError("BAD_ARGS", "send_keys: text 或 keys 必填一个");
    }
    const KEYMAP = {
      Enter: { vk: 13, text: "\r" },
      Tab: { vk: 9 },
      Escape: { vk: 27 },
      Backspace: { vk: 8 },
      Delete: { vk: 46 },
      Home: { vk: 36 }, End: { vk: 35 },
      PageUp: { vk: 33 }, PageDown: { vk: 34 },
      ArrowLeft: { vk: 37 }, ArrowUp: { vk: 38 },
      ArrowRight: { vk: 39 }, ArrowDown: { vk: 40 },
    };
    for (const k of keys) {
      const def = KEYMAP[k];
      if (!def) {
        throw new ToolError(
          "BAD_ARGS",
          `unknown key: ${k}（支持 ${Object.keys(KEYMAP).join(" ")}；自由文本用 text 参数）`
        );
      }
      const base = {
        key: k, code: k,
        windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk,
      };
      await cdpCall(tabId, "Input.dispatchKeyEvent", {
        type: def.text ? "keyDown" : "rawKeyDown",
        ...(def.text ? { text: def.text } : {}),
        ...base,
      });
      await cdpCall(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
    }
    return { tabId, pressed: keys };
  },

  // ---- Cookie 基础件（cookie_get/cookie_set）----

  async cookie_get(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    let urls = args.urls;
    if (!urls || !urls.length) {
      const tab = await chrome.tabs.get(tabId);
      urls = [tab.url];
    }
    const res = await cdpCall(tabId, "Network.getCookies", { urls });
    return { tabId, urls, cookies: res.cookies || [] };
  },

  async cookie_set(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    if (!args.name || args.value === undefined) {
      throw new ToolError("BAD_ARGS", "cookie_set: name 和 value 必填");
    }
    const params = { name: args.name, value: String(args.value) };
    for (const k of ["url", "domain", "path", "secure", "httpOnly", "sameSite", "expires"]) {
      if (args[k] !== undefined) params[k] = args[k];
    }
    if (!params.url && !params.domain) {
      const tab = await chrome.tabs.get(tabId);
      params.url = tab.url;
    }
    const res = await cdpCall(tabId, "Network.setCookie", params);
    if (!res.success) {
      throw new ToolError("BAD_ARGS", "cookie_set: Network.setCookie 拒绝（检查 url/domain/sameSite 组合）");
    }
    return { tabId, success: true };
  },

  async cookie_delete(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    if (!args.name) throw new ToolError("BAD_ARGS", "cookie_delete: name 必填");
    const params = { name: args.name };
    for (const k of ["url", "domain", "path"]) {
      if (args[k] !== undefined) params[k] = args[k];
    }
    if (!params.url && !params.domain) {
      const tab = await chrome.tabs.get(tabId);
      params.url = tab.url;
    }
    await cdpCall(tabId, "Network.deleteCookies", params);
    return { tabId, deleted: args.name };
  },

  // ---- 脚本源码感知（枚举全部 JS 含 eval/VM + 拉源码 + 关键词定位）----
  // ⚠️ scriptId 仅在同一 Debugger 启用会话内有效；Debugger 会关 V8 JIT 拖慢页面，
  // 分析完用 break_remove '{}' 顺手 disable。

  async script_list(args) {
    const tabId = await resolveTabId(args);
    await ensureDebugger(tabId);
    await sleep(Math.min(args.wait_ms || 500, 5000)); // 等 scriptParsed 灌进来
    const reg = scriptRegistryMap.get(tabId) || new Map();
    const re = args.url_pattern ? toRegExp(args.url_pattern) : null;
    const out = [];
    for (const s of reg.values()) {
      if (re && !re.test(s.url || "")) continue;
      out.push(s);
    }
    return { tabId, count: out.length, scripts: out };
  },

  async script_source(args) {
    const tabId = await resolveTabId(args);
    if (!args.script_id) {
      throw new ToolError("BAD_ARGS", "script_source: script_id 必填（script_list 获取）");
    }
    await ensureDebugger(tabId);
    const res = await cdpCall(tabId, "Debugger.getScriptSource", {
      scriptId: args.script_id,
    });
    const src = res.scriptSource || "";
    const max = Math.max(args.max_chars || 300000, 1000);
    return {
      tabId,
      scriptId: args.script_id,
      length: src.length,
      truncated: src.length > max,
      source: src.length > max ? src.slice(0, max) : src,
    };
  },

  async search_code(args) {
    const tabId = await resolveTabId(args);
    if (!args.query) throw new ToolError("BAD_ARGS", "search_code: query 必填");
    await ensureDebugger(tabId);
    const reg = scriptRegistryMap.get(tabId) || new Map();
    const re = args.url_pattern ? toRegExp(args.url_pattern) : null;
    const limit = Math.min(args.limit || 50, 200);
    const matches = [];
    for (const s of reg.values()) {
      if (matches.length >= limit) break;
      if (re && !re.test(s.url || "")) continue;
      try {
        const res = await cdpCall(tabId, "Debugger.searchInContent", {
          scriptId: s.scriptId,
          query: args.query,
          caseSensitive: !!args.case_sensitive,
        });
        for (const m of res.result || []) {
          matches.push({
            scriptId: s.scriptId,
            url: s.url,
            lineNumber: m.lineNumber,
            lineContent: String(m.lineContent || "").slice(0, 300),
          });
          if (matches.length >= limit) break;
        }
      } catch (e) {}
    }
    return { tabId, query: args.query, count: matches.length, matches };
  },

  // ---- 函数断点（break_function）----
  // 两条路径：function_path（Runtime 解析函数对象，断在调用入口）；
  // url_pattern + line_number（按位置锚定，覆盖混淆匿名函数）。

  async break_function(args) {
    const tabId = await resolveTabId(args);
    await ensureDebugger(tabId);
    const bpIds = tabBreakpointIds(tabId);
    if (args.function_path) {
      const res = await cdpCall(tabId, "Runtime.evaluate", {
        expression:
          `(() => { const segs = ${JSON.stringify(args.function_path)}.split(".");` +
          ` let f = window; for (const s of segs) { if (s === "window") continue; f = f && f[s]; }` +
          ` return typeof f === "function" ? f : null; })()`,
      });
      if (!res.result || !res.result.objectId) {
        throw new ToolError("NOT_FOUND", `function not found: ${args.function_path}`);
      }
      const bp = await cdpCall(tabId, "Debugger.setBreakpointOnFunctionCall", {
        objectId: res.result.objectId,
        condition: args.condition,
      });
      const key = "fn:" + args.function_path;
      armedBreakpoints(tabId).add(key);
      bpIds.set(key, bp.breakpointId);
      return { tabId, armed: key, breakpointId: bp.breakpointId };
    }
    if (args.url_pattern && args.line_number != null) {
      const bp = await cdpCall(tabId, "Debugger.setBreakpointByUrl", {
        lineNumber: args.line_number,
        urlRegex: args.url_pattern,
        columnNumber: args.column_number,
        condition: args.condition,
      });
      const key = `url:${args.url_pattern}:${args.line_number}`;
      armedBreakpoints(tabId).add(key);
      bpIds.set(key, bp.breakpointId);
      return { tabId, armed: key, breakpointId: bp.breakpointId, locations: bp.locations };
    }
    throw new ToolError(
      "BAD_ARGS",
      "break_function: function_path 或 (url_pattern + line_number) 必填一组"
    );
  },
};

// ---------------------------------------------------------------------------
// 消息路由
// ---------------------------------------------------------------------------

async function onMessage(msg) {
  if (msg.type === "hello_ack") {
    helloAcked = true;
    cancelDeadman();
    log("hello_ack");
    return;
  }
  if (msg.type === "ping") {
    send({ type: "pong", payload: msg.payload || {} });
    return;
  }
  if (msg.type !== "tool_call") return;

  const { requestId, payload } = msg;
  const name = payload && payload.name;
  const args = (payload && payload.args) || {};
  const handler = tools[name];

  if (!handler) {
    send({
      type: "tool_result",
      requestId,
      payload: {
        ok: false,
        error: { code: "UNKNOWN_TOOL", message: `unknown tool: ${name}`, retryable: false },
      },
    });
    return;
  }

  try {
    const data = await handler(args);
    send({ type: "tool_result", requestId, payload: { ok: true, data } });
  } catch (e) {
    const err =
      e instanceof ToolError
        ? { code: e.code, message: e.message, retryable: e.retryable }
        : { code: "INTERNAL", message: String(e && e.message ? e.message : e), retryable: true };
    send({ type: "tool_result", requestId, payload: { ok: false, error: err } });
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function log(...a) {
  console.log("[owb]", ...a);
}

// boot 的三处触发分工：
//  - onInstalled：扩展安装/更新后
//  - onStartup：浏览器启动时
//  - 顶层：SW 每次冷启动唤醒——MV3 SW 空闲即被回收，此后 alarms/WS 消息
//    唤醒时上面两个事件都不再触发，必须靠顶层执行恢复连接
chrome.runtime.onInstalled.addListener(() => {
  boot();
});

chrome.runtime.onStartup.addListener(() => {
  boot();
});

boot();
