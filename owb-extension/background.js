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
  wsUrl: "ws://127.0.0.1:43917/ws",
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
  const stored = await chrome.storage.local.get([
    "wsUrl",
    "relayUrl",
    "relayToken",
  ]);
  config.wsUrl = stored.wsUrl || DEFAULT_CONFIG.wsUrl;
  config.relayUrl = stored.relayUrl || "";
  config.relayToken = stored.relayToken || "";
  config.relayMode = !!(config.relayUrl && config.relayToken);
}

async function boot() {
  await loadConfig();
  await loadHookRegistry();
  startKeepalive();
  connect();
}

// popup 保存即时生效：任一连接字段变化 → 重读配置并立即重连
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

// popup 页：查连接状态 / 触发重连
// （引用的 ws/helloAcked/relayPaired/reconnectTimer 等在下方声明；
//  onMessage 回调异步触发，此时 SW 已完成顶层初始化，无 TDZ 问题）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.cmd) return false;
  if (msg.cmd === "status") {
    sendResponse({
      mode: config.relayMode ? "relay" : "local",
      connected: wsOpen() && helloAcked,
      relayPaired,
      wsState: ws ? ws.readyState : 3, // 0 connecting 1 open 2 closing 3 closed
      target: config.relayMode ? relayUrlOf(config) : config.wsUrl,
      tokenMasked: config.relayToken
        ? config.relayToken.slice(0, 6) + "…" + config.relayToken.slice(-4)
        : null,
      reconnectInMs: reconnectTimer ? reconnectDelayMs : 0,
      version: chrome.runtime.getManifest().version,
    });
    return false; // 同步响应
  }
  if (msg.cmd === "reconnect") {
    cleanupWs();
    connect();
    sendResponse({ ok: true });
    return false;
  }
  return false;
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
// 中转模式退避上限放宽到 60s：对公网中转，每次重连都是一次 DO 计费请求，
// 15s 上限 24 小时打即 ~5.7k 次/天/端，会无谓消耗 Cloudflare 免费额度
// （每月 1M DO 请求）。本地模式保持 15s，重连快且免费。
const RECONNECT_MAX_RELAY_MS = 60000;

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
    scheduleDeadman(); // 死开关：daemon 长时间不可达则全面 detach
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
  const maxMs = config.relayMode ? RECONNECT_MAX_RELAY_MS : RECONNECT_MAX_MS;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, maxMs);
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
  // BUG-46: timeout race — a single hanging CDP response would permanently
  // deadlock the SW. 30s is generous for all known CDP methods. If this
  // fires, the caller gets a rejection instead of an infinite hang.
  const _ms = 30000;
  let timer;
  return Promise.race([
    chrome.debugger.sendCommand({ tabId }, method, params),
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error("cdpCall timeout: " + method + " (" + _ms + "ms)")),
        _ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
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
          : ""),
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
  await cdpCall(tabId, "Network.enable", {
    maxTotalBufferSize: 50 * 1024 * 1024,
  });
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
  if (
    rec.resourceTypes &&
    resourceType &&
    !rec.resourceTypes.has(String(resourceType).toLowerCase())
  ) {
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
  if (
    method === "Network.loadingFinished" &&
    rec.includeBodies &&
    !rec.bodyCapped
  ) {
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
    rec.frames.push({
      ts: Date.now() / 1000,
      reason,
      url,
      dataUrl: "data:image/jpeg;base64," + data,
    });
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
  } catch (e) {
    return [];
  }
}

// diff 两份 cookie 快照：added/changed/removed
function diffCookies(start, end) {
  const mapOf = (list) => {
    const m = {};
    for (const c of list) m[c.name + "|" + (c.domain || "")] = c.value || "";
    return m;
  };
  const a = mapOf(start || []),
    b = mapOf(end || []);
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
    try {
      await cdpCall(tabId, "DOMStorage.disable");
    } catch (e) {}
  }
  const tabTitle =
    title ||
    (function () {
      try {
        return new URL(rec.url).host;
      } catch (e) {
        return rec.url;
      }
    })();
  return buildRecorderPage(rec, tabId, tabTitle);
}

// 停所有活动 recorder，合并为多 page HAR
async function stopAllRecorders(title) {
  const pages = [];
  let totalEntries = 0,
    totalBodyBytes = 0;
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
        tabId,
        startedAt: rec.startedAt,
        endedAt: new Date().toISOString(),
        bodyBytes: rec.bodyBytes,
        bodyCapped: rec.bodyCapped,
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
    pushEvent("record", {
      tabId,
      phase: "stop",
      entries: pages[i]
        ? pages[i].rec
          ? Object.keys(pages[i].rec.stats.entries).length
          : 0
        : 0,
    });
  }
  return {
    tabIds,
    recording: false,
    entries: totalEntries,
    bodyBytes: totalBodyBytes,
    har,
  };
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
        .map((a) =>
          a.value !== undefined ? a.value : a.description || a.type,
        ),
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
      // BUG-38: wait_for network_idle 要能把"永远收不到 loadingFinished"的
      // 僵尸请求排除掉，需要一个本地墙钟起点（wallTime 是秒且可能缺）。
      startedAt: Date.now(),
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
      // BUG-74: 细粒度阶段耗时（DNS/连接/TLS/TTFB），排查慢请求的关键
      timing: params.response.timing || undefined,
      fromCache: !!params.response.fromDiskCache,
      remoteAddress: params.response.remoteIPAddress || undefined,
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
    // BUG-74: CDP 在这里就给了传输体积与结束时刻，原来只记了 finished 布尔，
    // 于是「哪个请求最慢/最重」——性能排查的头号问题——在列表里无从回答，
    // 只能对每条请求单独 network_detail（几百条时不可行）。
    bufferPut(tabId, params.requestId, {
      finished: true,
      finishedAt: Date.now(),
      encodedDataLength: params.encodedDataLength,
    });
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
  if (
    method === "Page.frameNavigated" &&
    params.frame &&
    params.frame.parentId === "0"
  ) {
    // BUG-1/2/53/59: 主帧导航 → 清零 per-tab 状态，防跨页 ref 污染、假 removed、
    // 旧脚本残留。新页面 ref 从 e1 重编，since_last 首次返回全 added（正确语义）。
    readPageNextRef.delete(tabId);
    readPageSnapshots.delete(tabId);
    scriptRegistryMap.delete(tabId);
    feedRecorderScreenshot(tabId, "navigation", params.frame.url || null);
    return;
  }
  // 下载：downloadWillBegin + downloadProgress → 一次性 watcher resolve
  if (method === "Page.downloadWillBegin")
    return onDownloadBegin(tabId, params);
  if (method === "Page.downloadProgress")
    return onDownloadProgress(tabId, params);
  // 执行上下文：iframe 的 contextId 登记（list_frames / frame 定向 evaluate 用）
  if (method === "Runtime.executionContextCreated")
    return onContextCreated(tabId, params);
  if (method === "Runtime.executionContextDestroyed")
    return onContextDestroyed(tabId, params);
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
    feedRecorderStorage(tabId, isLocalStorage, {
      op: "add",
      key: params.key,
      value: params.newValue,
    });
  } else if (method === "DOMStorage.domStorageItemUpdated") {
    feedRecorderStorage(tabId, isLocalStorage, {
      op: "update",
      key: params.key,
      oldValue: params.oldValue,
      value: params.newValue,
    });
  } else if (method === "DOMStorage.domStorageItemRemoved") {
    feedRecorderStorage(tabId, isLocalStorage, {
      op: "remove",
      key: params.key,
      oldValue: params.oldValue,
    });
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
    // BUG-48: 原来 resolve 不带 filename，工具读 result.filename 永远 undefined
    w.resolve({
      state: "completed",
      receivedBytes: params.receivedBytes,
      filename: w.filename,
      url: w.url,
    });
  } else if (params.state === "canceled") {
    w.reject(
      new ToolError("DOWNLOAD_CANCELED", "download was canceled", false),
    );
  }
}

function onContextCreated(tabId, params) {
  const ctx = params.context || {};
  if (!ctx.id || !ctx.auxData) return;
  let list = frameContexts.get(tabId);
  if (!list) {
    list = [];
    frameContexts.set(tabId, list);
  }
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
//
// BUG-33/BUG-56/UX-17: 执行上下文只带 origin（"https://x.com"），不带完整
// iframe URL。AI 拿 list_frames 里看到的 URL（"https://x.com/embed/player"）
// 来匹配必然落空 —— 页面上明明有那个 frame，evaluate 却报 FRAME_NOT_FOUND。
// 这里补一次 Page.getFrameTree，按【完整 URL / name / frameId】匹配到 frameId
// 再换 contextId，origin 匹配只作兜底。
async function resolveFrameContextId(tabId, framePattern) {
  const list = frameContexts.get(tabId);
  if (!list || !list.length) return null;
  // 默认主帧
  if (!framePattern) {
    const def = list.find((c) => c.isDefault);
    return def ? def.contextId : list[0].contextId;
  }
  const pat = String(framePattern);
  // 1) frame 树：完整 URL / name / frameId 子串匹配
  try {
    const tree = await cdpCall(tabId, "Page.getFrameTree");
    const frames = [];
    const walk = (n) => {
      const f = n.frame;
      frames.push({ id: f.id, url: f.url || "", name: f.name || "" });
      (n.childFrames || []).forEach(walk);
    };
    walk(tree.frameTree);
    for (const f of frames) {
      if (f.url.includes(pat) || (f.name && f.name.includes(pat)) || f.id === pat) {
        const c = list.find((x) => x.frameId === f.id);
        if (c) return c.contextId;
      }
    }
  } catch (e) {}
  // 2) 兜底：按 context 的 origin/name 匹配（老行为）
  const c = list.find(
    (x) =>
      (x.url && x.url.includes(pat)) || (x.name && x.name.includes(pat)),
  );
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
  if (!s) {
    s = new Set();
    emulateState.set(tabId, s);
  }
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
// 占位符用正则匹配（吃掉两个标记之间的任意内容）：字面量匹配太脆，格式化器
// 一动 fn_hook.js 的空白/分号就整体失配，hook_function 直接不可用。
const FN_OPTS_SENTINEL_RE =
  /\/\*__OWB_OPTS__\*\/[\s\S]*?\/\*__OWB_OPTS_END__\*\//;
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
    throw new ToolError(
      "PRESET_LOAD_FAILED",
      `${FN_HOOK_TEMPLATE}: HTTP ${res.status}`,
    );
  }
  const template = await res.text();
  if (!FN_OPTS_SENTINEL_RE.test(template)) {
    throw new ToolError(
      "PRESET_LOAD_FAILED",
      "fn_hook.js missing OPTS sentinel",
    );
  }
  // 函数式 replace：opts 里带用户 hook_code，字符串形式会把 $& / $1 当替换模式解释
  const json = JSON.stringify(opts);
  return template.replace(FN_OPTS_SENTINEL_RE, () => json);
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
      out[p.name] =
        v.value.length > 300 ? v.value.slice(0, 300) + "…" : v.value;
    } else if (
      v.type === "number" ||
      v.type === "boolean" ||
      v.type === "undefined"
    ) {
      out[p.name] = v.value;
    } else if (v.type === "object" && v.subtype === "null") {
      out[p.name] = null;
    } else if (v.type === "function") {
      out[p.name] = `[function ${(v.description || "").slice(0, 80)}]`;
    } else {
      out[p.name] =
        `[${v.className || v.type}] ` +
        String(v.description || "").slice(0, 120);
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
    patterns: patches.map((p) => ({
      urlPattern: p.pattern,
      requestStage: "Response",
    })),
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
      await cdpCall(tabId, "Fetch.continueRequest", {
        requestId: params.requestId,
      });
      return;
    }
    const bodyRes = await cdpCall(tabId, "Fetch.getResponseBody", {
      requestId: params.requestId,
    });
    const original = bodyRes.base64Encoded
      ? decodeBase64(bodyRes.body)
      : bodyRes.body;
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
      await cdpCall(tabId, "Fetch.continueRequest", {
        requestId: params.requestId,
      });
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
  "navigator.userAgent",
  "navigator.appVersion",
  "navigator.platform",
  "navigator.vendor",
  "navigator.language",
  "navigator.hardwareConcurrency",
  "navigator.deviceMemory",
  "navigator.maxTouchPoints",
  "navigator.webdriver",
  "navigator.cookieEnabled",
  "navigator.onLine",
  "navigator.doNotTrack",
  "navigator.pdfViewerEnabled",
  "navigator.plugins.length",
  "navigator.mimeTypes.length",
  "navigator.userAgentData",
  "navigator.connection",
  "navigator.permissions",
  "navigator.mediaDevices",
];

const ENV_PROBES_B = [
  "screen.width",
  "screen.height",
  "screen.availWidth",
  "screen.availHeight",
  "screen.colorDepth",
  "screen.pixelDepth",
  "window.devicePixelRatio",
  "window.innerWidth",
  "window.innerHeight",
  "window.outerWidth",
  "window.outerHeight",
  "window.screenX",
  "window.screenY",
];

const ENV_PROBES_C = [
  "document.readyState",
  "document.visibilityState",
  "document.hidden",
  "document.characterSet",
  "document.referrer",
  "document.compatMode",
  "document.hasFocus",
  "performance.timeOrigin",
  "performance.timing",
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

// 原始 CDP/Chrome 错误 → AI 可操作的 ToolError。
// 裸 CDP 错误（`{"code":-32000,...}`）一律落到 INTERNAL + retryable=true，
// AI 会对着"永远不可能成功"的错误反复重试（UX-27/75/79/123/131/169/177/
// 182/200/201/220/221）。这里按错误文本归类，给出正确的 code、retryable
// 和下一步动作。所有工具经 dispatcher 统一走这条路径。
// UX-88/222/225: 同页跑着的其他扩展会往 Debugger/Network/Runtime 里灌一大堆
// chrome-extension:// 的脚本、请求和执行上下文。对"分析这个网站"来说全是噪声，
// 而且经常把页面自己的东西挤出 limit。默认过滤，include_extensions 可要回。
function isExtensionUrl(u) {
  return /^(chrome|moz|safari-web)-extension:\/\//.test(String(u || ""));
}

// UX-76: Browser.grantPermissions 认得的权限名（CDP PermissionType 枚举）。
// 名字打错时 CDP 收下不报错，AI 拿到 ok=true 却没有授权。
const CDP_PERMISSIONS = new Set([
  "accessibilityEvents", "audioCapture", "backgroundSync",
  "backgroundFetch", "clipboardReadWrite", "clipboardSanitizedWrite",
  "displayCapture", "durableStorage", "geolocation", "idleDetection",
  "midi", "midiSysex", "nfc", "notifications", "paymentHandler",
  "periodicBackgroundSync", "protectedMediaIdentifier", "sensors",
  "storageAccess", "topLevelStorageAccess", "videoCapture",
  "videoCapturePanTiltZoom", "wakeLockScreen", "wakeLockSystem",
  "windowManagement",
]);

const CDP_ERROR_RULES = [
  // BUG-87: 原文案只列了断点与模态框两种成因，但实测最常见的是第三种——
  // 页面主线程被长时间占满（重 JS 站点仍在加载时），CDP 的 Runtime.evaluate
  // 根本排不上队。eBay 实测导航耗时 60 秒，期间快照必超时（该页元素只有 2606 个，
  // 与 DOM 体量无关）。少了这一条，AI 会去找根本不存在的断点。
  [/cdpCall timeout/i, "TIMEOUT", true,
    "CDP call did not return in 30s. Most often the page's main thread is " +
    "saturated (heavy JS, or the page is still loading) — call " +
    "wait_for {network_idle:true} and retry. Other causes: the page is paused " +
    "at a breakpoint (call resume), or blocked by a modal dialog"],
  // BUG-89: Chrome 这条错误有两种措辞——chrome.debugger 报 "No tab with given
  // id"，chrome.tabs 报 "No tab with id: <n>"。原正则只覆盖前者，后者落到
  // INTERNAL（可重试），AI 会对着一个已经不存在的 tab 反复重试。
  // 实测：标签管理类扩展批量收纳标签页时即触发（虎嗅一轮就这么失败的）。
  [/no tab with (given )?id|no target with given id|tab was closed|no tab found/i,
    "NO_TAB", false,
    "that tab no longer exists (it was closed — tab-manager extensions like " +
    "OneTab close tabs in bulk). Call list_tabs for live tabIds, or re-open " +
    "the URL in a new tab"],
  [/cannot access|cannot be debugged|chrome:\/\/|extensions gallery|devtools:\/\//i,
    "FORBIDDEN", false,
    // BUG-83: 实地测试里这个错误反复出现在「明明是 https 页面」的 tab 上。
    // 归因：用户装的标签管理类扩展（OneTab 等）会把标签页整个换成自己的
    // chrome-extension:// 页面，owb 正在操作的 tab 被第三方接管了。
    // 原文案只说「Chrome 禁止调试此 URL」，AI 会以为自己传错了 tabId 而反复重试。
    "Chrome forbids debugging this URL (chrome://, the Web Store, devtools://, " +
    "or another extension's page); call list_tabs to see what this tab actually " +
    "shows now — tab-manager extensions (OneTab and similar) replace tabs with " +
    "their own page, which takes the tab out of reach. Re-open the target URL " +
    "in a fresh tab"],
  // BUG-86: Chrome 的安全拦截页（证书错误/隐私设置错误/不安全下载警告）
  // 禁止 debugger 附着，报的却是一句毫无线索的 "Cannot attach to this target"。
  // 知网连续三轮实测均卡在这里——页面标题是本地化的「隐私设置错误」，
  // 说明是 net::ERR_CERT_* 类拦截。AI 看到原文案只会当成瞬时故障反复重试。
  [/cannot attach to this target/i, "FORBIDDEN", false,
    "Chrome refuses to attach a debugger to this page. Most often it is a " +
    "security interstitial (certificate / privacy error / unsafe-download " +
    "warning) — those pages cannot be inspected at all. Check the tab in the " +
    "browser: if it shows a certificate warning, the site's TLS is broken or " +
    "intercepted; either fix it or click through the warning manually first"],
  [/could not find object with given id|invalid remote object id/i,
    "BAD_ARGS", false,
    "object_id expired (RemoteObjects die on navigation/GC); " +
    "re-run evaluate with returnByValue:false for a fresh objectId"],
  [/no script for id|no script with given id|cannot fetch script/i,
    "NOT_FOUND", false,
    "script_id is stale (script GC'd or page navigated); re-run script_list"],
  [/was ?n[o']?t found|method not found|-32601/i, "BAD_ARGS", false,
    "no such CDP method — check the domain and spelling"],
  [/must be enabled|agent is not enabled|domain .* not enabled/i,
    "BAD_ARGS", false, "enable the CDP domain first (network_start / script_list / break_*)"],
  [/not allowed/i, "FORBIDDEN", false,
    "chrome.debugger forbids this CDP domain from an extension"],
  [/is not paused|not paused/i, "NOT_PAUSED", false,
    "no active breakpoint; arm one with break_function / break_xhr first"],
];

function toToolError(e) {
  if (e instanceof ToolError) return e;
  const raw = String(e && e.message ? e.message : e);
  for (const [re, code, retryable, hint] of CDP_ERROR_RULES) {
    if (re.test(raw)) {
      return new ToolError(code, `${raw} — ${hint}`, retryable);
    }
  }
  return new ToolError("INTERNAL", raw, true);
}

async function resolveTabId(args) {
  if (args.tabId != null) {
    // BUG-90: tabId 传成字符串/NaN 时，错误一路漏到 chrome.debugger.attach，
    // 报出 "Error at property 'tabId': Invalid type: expected integer, found
    // string" 这种 Chrome 内部措辞，还被兜底标成「可重试」——AI 会拿同一个
    // 坏参数反复重试。实测：脚本里 tabId 提取失败拿到字面量 "X" 即触发。
    const n = typeof args.tabId === "number" ? args.tabId : Number(args.tabId);
    if (!Number.isInteger(n)) {
      throw new ToolError(
        "BAD_ARGS",
        `tabId must be an integer, got ${JSON.stringify(args.tabId)} — ` +
          "call list_tabs to get live tabIds",
        false,
      );
    }
    return n;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) {
    throw new ToolError(
      "NO_TAB",
      "no active tab; pass tabId explicitly",
      false,
    );
  }
  // UX-64/97: 缺省落到"当前活动 tab"。多 tab 分析场景下，用户切一下窗口，
  // 后续无 tabId 的调用就悄悄打到了另一个页面上 —— 结果看着正常，数据全错。
  // 只在真正有歧义时报错：挂了多个 tab、而活动 tab 不在其中。
  if (attachedTabs.size > 1 && !attachedTabs.has(tab.id)) {
    throw new ToolError(
      "AMBIGUOUS_TAB",
      `no tabId given and the active tab (${tab.id}) is not one of the ` +
        `${attachedTabs.size} attached tabs (${[...attachedTabs].join(", ")}) — ` +
        "pass tabId explicitly so the call does not land on the wrong page",
      false,
    );
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
      await chrome.tabs.group({
        tabIds: [tabId],
        groupId: currentTask.groupId,
      });
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
    throw new ToolError(
      "BAD_PATTERN",
      `invalid url_pattern: ${e.message}`,
      false,
    );
  }
}

// ref 定位：read_page 打的稳定 ref（吃 "@e12" / "e12" 两种写法）→
// data-owb-ref 选择器。与 selector 二选一。元素不存在时错误语义是 REF_STALE
// （页面可能已导航/重渲染，可重试），区别于普通 selector 的 NOT_FOUND。
function resolveTargetSelector(args, toolName, required = true) {
  const hasSel = !!args.selector;
  const hasRef = args.ref != null && String(args.ref) !== "";
  if (hasSel && hasRef) {
    throw new ToolError(
      "BAD_ARGS",
      `${toolName}: pass either selector or ref, not both`,
      false,
    );
  }
  if (!hasSel && !hasRef) {
    if (required) {
      throw new ToolError(
        "BAD_ARGS",
        `${toolName}: selector or ref is required (one of the two)`,
        false,
      );
    }
    return null;
  }
  if (hasSel) return { selector: args.selector, ref: null };
  const ref = String(args.ref).replace(/^@/, "");
  return { selector: `[data-owb-ref="${ref}"]`, ref: "@" + ref };
}

function targetNotFound(target, toolName, extraHint) {
  const suffix = extraHint ? ` — ${extraHint}` : "";
  if (target.ref) {
    throw new ToolError(
      "REF_STALE",
      `ref ${target.ref} is not in the current document ` +
        "(page navigated or re-rendered); call read_page again for fresh refs" +
        suffix,
      true,
    );
  }
  throw new ToolError(
    "NOT_FOUND",
    `selector not found: ${target.selector}${suffix}`,
  );
}

// BUG-41/BUG-55 + UX-13/UX-214: document.querySelector 不穿透 shadow root，
// 于是 read_page 看不见、click/fill 也点不到自定义元素里的按钮/输入框
// （Web Component 站点整片不可用）。这段在页面里做广度优先的深查：
// 先在当前 root 找，找不到就下钻每个 open shadowRoot。closed root 拿不到，
// 这是浏览器的硬限制。同一段代码 read_page 的采集器也复用。
const DEEP_QUERY_FN = `function __owbDeepQuery(sel, root) {
  root = root || document;
  const hit = root.querySelector(sel);
  if (hit) return hit;
  const walk = root.querySelectorAll("*");
  for (const el of walk) {
    if (el.shadowRoot) {
      const inner = __owbDeepQuery(sel, el.shadowRoot);
      if (inner) return inner;
    }
  }
  return null;
}`;

// "找元素 + scrollIntoView" 的页面表达式骨架（click/fill/screenshot/mouse_click
// 共用）：找到则执行 body 段并返回其结果，未找到返回 null（调用方转
// NOT_FOUND / REF_STALE）。body 里可用变量：el。
function elementSnippet(selector, body) {
  return (
    `(() => { ${DEEP_QUERY_FN}` +
    ` const el = __owbDeepQuery(${JSON.stringify(selector)});` +
    // BUG-100: 不带 behavior 的 scrollIntoView 跟着页面自己的 CSS
    // scroll-behavior 走。站点设了 scroll-behavior:smooth 时这是一次跨帧动画
    // ——紧接着同步读 getBoundingClientRect() 拿到的是动画开始前的旧位置，
    // click/fill/mouse_click 用这个位置算点击坐标就点歪了。更糟的是：
    // Chrome 窗口没有系统焦点（这次探索里反复碰到的同一个环境条件）时，
    // 这个滚动动画会卡住永远不推进——不是"读早了"，是滚动这件事根本没发生，
    // 实测 window.scrollY 在动画本该早就播完的几秒后依然是 0。
    // instant 绕开动画，同步立即到位，跟窗口有没有系统焦点无关。
    ` if (!el) return null; el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });` +
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

// UX-19/148 + BUG-42: 页面内表达式把失败写在 {ok:false,error} 里，工具层却
// 照样 ok=true —— AI 只看外层就以为调用成功了。这里把内层失败抬成工具级错误。
function oracleResult(out, what) {
  if (out && typeof out === "object" && out.ok === false) {
    const msg = String(out.error || "call failed");
    const notFn = /not a function/i.test(msg);
    throw new ToolError(
      notFn ? "NOT_A_FUNCTION" : "ORACLE_FAILED",
      `oracle_call ${what}: ${msg}` +
        (notFn
          ? " — check the path with evaluate(\"typeof <path>\"); " +
            "closure-scoped functions need object_id from frame_read"
          : ""),
      false,
    );
  }
  return out;
}

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
    // UX-105/45: 表单控件常常三个名字来源全空（无 aria-label / 无 placeholder /
    // 无文本），AI 只看到一串同名 textbox 分不清哪个是账号哪个是密码。
    // 补上 name/id、关联 <label>、以及外层 label 的文本。
    let v = el.getAttribute("aria-label") || el.getAttribute("alt") ||
      el.getAttribute("placeholder") || "";
    if (!v && el.id) {
      try {
        const lab = (el.getRootNode() || document).querySelector(
          'label[for="' + CSS.escape(el.id) + '"]');
        if (lab) v = lab.innerText || "";
      } catch (e) {}
    }
    if (!v && el.closest) {
      const wrap = el.closest("label");
      if (wrap) v = wrap.innerText || "";
    }
    if (!v) v = el.getAttribute("name") || el.getAttribute("title") || "";
    if (!v) v = el.value || el.innerText || "";
    // BUG-70: innerText 遵循 CSS 可见性——元素在 visibility:hidden 的容器里
    // （悬停菜单、折叠导航很常见）时返回空串，但它仍有布局盒、仍会进快照。
    // 实测界面新闻首页 43% 的 ref 因此变成 @eN link ""，AI 只能靠 href 猜。
    // textContent 不依赖渲染，是这类元素唯一能拿到的文字。
    if (!v) v = el.textContent || "";
    // BUG-71: 纯图片链接/按钮（<a><img alt="..."></a>）自身没有任何文字，
    // alt 挂在子元素上，取不到就完全无名。
    if (!v && el.querySelector) {
      const im = el.querySelector("img[alt], img[title], [aria-label]");
      if (im) {
        v = im.getAttribute("alt") || im.getAttribute("title") ||
          im.getAttribute("aria-label") || "";
      }
    }
    if (!v) v = el.id ? "#" + el.id : "";
    return String(v).replace(/\\s+/g, " ").trim().slice(0, 80);
  };
  const nodes = [];
  let next = ${nextRef};
  let assigned = 0;
  let truncated = false;
  // BUG-41/BUG-55 + UX-13/UX-214: querySelectorAll 不进 shadow root，
  // Web Component 站点整片元素在快照里根本不存在。这里连 open shadow root
  // 一起收（closed root 浏览器不给，收不到）。
  let shadowRoots = 0;
  const collect = (root, acc) => {
    for (const el of root.querySelectorAll(SEL)) acc.push(el);
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) { shadowRoots++; collect(el.shadowRoot, acc); }
    }
    return acc;
  };
  const els = collect(document, []);
  // BUG-95: next 是扩展侧持久化的计数器，靠"文档导航时清零"保证不重号。但如果
  // 某次事件把计数器错当成整页导航清零了（比如同文档内的 pushState 被
  // Page.frameNavigated 误判），文档其实根本没销毁——DOM 上还留着上一轮
  // collect() 写的 data-owb-ref 属性。新一轮从 e1 重新数，撞上还活在页面里的
  // 旧 e1：两个完全不同的元素共享同一个 ref，AI 点 @e1 点到哪个全看
  // querySelector 命中顺序，静默点错。不管传进来的 next 对不对，先扫一遍当前
  // 文档已经贴好的 data-owb-ref，保证新分配的号必然比现存最大值还大。
  for (const el of els) {
    const r = el.getAttribute("data-owb-ref");
    if (r) {
      const n = parseInt(r.slice(1), 10);
      if (!isNaN(n) && n >= next) next = n + 1;
    }
  }
  // BUG-72: 后台/未绘制的 tab 里所有元素 getBoundingClientRect() 全为 0，
  // 于是可见性过滤把整页元素丢光，快照静默返回空。记下被过滤数，
  // 让扩展侧能区分"页面真没东西"和"页面没渲染"。
  let skippedNoRect = 0;
  // BUG-92: 关闭状态的下拉菜单/面板常用 visibility:hidden（而不是 display:none）
  // 隐藏——祖先 visibility:hidden 的元素仍然占布局盒，getBoundingClientRect()
  // 照样返回非零尺寸，rect 过滤器抓不住。实测 GitHub 顶栏一个未展开的导航
  // 下拉菜单贡献了 30+ 条这样的"幽灵"候选，混进快照挤占正文位置，AI 还可能
  // 去点一个用户压根看不见、点了也没反应的链接。checkVisibility() 会顺着
  // 祖先链检查 visibility/display/content-visibility（选了 checkOpacity 顺带
  // 也管上 opacity:0），做同样的事不用手写祖先遍历。
  let skippedHidden = 0;
  // BUG-79: 用户装的其他扩展会往页面注入悬浮工具栏（翻译、收藏、划词……），
  // 这些元素混进快照后 AI 会当成页面功能去点。实测澎湃 403 页上「页面元素」
  // 全是某翻译扩展的按钮（图片翻译/语音翻译/快捷设置）。按注入宿主容器识别
  // 并整棵剔除：Plasmo/CRXJS 等主流扩展框架都用自定义元素挂载。
  let extensionUi = 0;
  const isExtensionInjected = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement || (n.getRootNode && n.getRootNode().host)) {
      const tag = n.tagName || "";
      if (tag.startsWith("PLASMO-") || tag.startsWith("CRX-") ||
          (n.id && /^(plasmo|crx|__)[-_]/i.test(n.id))) return true;
    }
    return false;
  };
  for (const el of els) {
    if (nodes.length >= ${maxNodes}) { truncated = true; break; }
    const rect = el.getBoundingClientRect(); // 无布局盒 = 不可见，跳过
    if (!rect || !(rect.width > 0 && rect.height > 0)) { skippedNoRect++; continue; }
    if (typeof el.checkVisibility === "function" &&
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      skippedHidden++; continue;
    }
    if (isExtensionInjected(el)) { extensionUi++; continue; }
    const role = roleOf(el);
    const name = nameOf(el);
    let ref = null;
    // UX-80: contenteditable 编辑区 role 落在 generic，原来拿不到 ref，
    // AI 的 ref 工作流无法 fill 富文本框（只能退回 CSS selector）。
    if (INTERACTIVE[role] || el.isContentEditable) {
      ref = el.getAttribute("data-owb-ref"); // 已有 ref 复用原值（同文档内稳定）
      if (!ref) { ref = "e" + next++; el.setAttribute("data-owb-ref", ref); assigned++; }
    }
    let line = (ref ? "@" + ref + " " : "") + role + " \\"" + name.replace(/"/g, "'") + "\\"";
    if (role === "heading") line += " level=" + el.tagName.toLowerCase().charAt(1);
    // 下面这些补充信息任何一条抛错都不该毁掉整张快照
    try {
      // UX-128: checkbox/radio 显示的是 .value（往往是 "on"），不是勾没勾 ——
      // AI 完全看不出当前选中状态。
      if (role === "checkbox" || role === "radio" || role === "switch") {
        line += el.checked ? " checked" : " unchecked";
      }
      // UX-130: date/range/color/email/... 全被压成 textbox，AI 不知道格式要求
      if (el.tagName === "INPUT") {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        if (t !== "text" && role === "textbox") line += " type=" + t;
        if (el.required) line += " required";
      }
      // UX-129: <select> 只看得到 option 文本，看不到要 fill 进去的 value
      if (el.tagName === "SELECT" && el.options && el.options.length) {
        const opts = Array.from(el.options).slice(0, 12).map((o) => o.value);
        if (opts.length) line += " values=[" + opts.join(",") + "]";
        if (el.options.length > 12) line += "+" + (el.options.length - 12);
      }
      // UX-180: 链接不带 href，AI 判断不了这条链接通向哪里（也就没法决定点不点）
      if (role === "link" && el.getAttribute("href")) {
        let href = el.getAttribute("href");
        try { href = new URL(href, location.href).href; } catch (e) {}
        line += " href=" + href.slice(0, 200);
      }
      if (el.disabled || el.getAttribute("aria-disabled") === "true") line += " disabled";
    } catch (e) {}
    nodes.push({ ref, role, name, line, hash: hashOf(line) });
  }
  // UX-100: iframe 在快照里完全不出现，AI 不知道页面还有别的文档要看
  const iframes = [...document.querySelectorAll("iframe")]
    .map((f) => ({ src: f.getAttribute("src") || "", name: f.name || "" }))
    .filter((f) => f.src || f.name).slice(0, 20);
  return { url: location.href, title: document.title, nodes,
    nextRef: next, refsAssigned: assigned, truncated,
    shadowRoots, iframes, skippedNoRect, skippedHidden, extensionUi, candidates: els.length };
})()`;

// article 的页面内提取器：简化 readability——候选根按 <p> 文本总长评分取最优，
// 再将其 h1-h6/p/li/blockquote/pre 后代压成 markdown。不引库。
// BUG-32/BUG-51 + UX-199 重写。旧算法把 document.body 也当候选根，而 body 的
// <p> 文本总长天然最大，于是几乎永远选中 body；再从 body 提 li 就把导航菜单
// （Donate / Log in / Navigation Menu）当成了正文。Wikipedia / GitHub / MDN
// 全军覆没，HN 直接空。
//
// 现在：
//   1. 候选根只取语义容器（article/main/[role=main]/常见正文类名），
//      body 仅在一个语义根都没有时兜底；
//   2. 评分排除 nav/header/footer/aside/form/[role=navigation] 子树里的文本，
//      并给语义根加权 —— 样板区再长也压不过真正的正文；
//   3. 提取时跳过样板容器和 aria-hidden 的后代；
//   4. 提不出正文就明说（reason），不再返回一段导航冒充正文。
const READ_PAGE_ARTICLE_EXPR = `(() => {
  // BUG-81: 站点通知/募捐条/Cookie 提示这一类「正文容器内部的公告块」原来没被
  // 剔除。实测英文维基条目：main.mw-body 前 1817 字符全是募捐横幅，AI 逐篇读
  // 文章时既浪费 token 又可能把横幅当成正文摘要。这类块的共同特征是带
  // notice/banner/dismissable/cookie/consent/subscribe/paywall 语义类名或角色。
  const BOILER = "nav, header, footer, aside, form, [role='navigation'], " +
    "[role='banner'], [role='contentinfo'], [role='search'], [role='complementary'], " +
    "[role='alert'], [role='dialog'], [aria-hidden='true'], " +
    ".nav, .navbar, .menu, .sidebar, .footer, .header, " +
    ".breadcrumb, .toc, .comment, .comments, .advert, .ads, " +
    // 子串选择器必须带 i 标志：CSS 属性选择器默认区分大小写，
    // 而 Wikipedia 的募捐横幅容器 id 是驼峰的 siteNotice，
    // 不加 i 就永远匹配不到（这个修复的第一版就栽在这里）。
    "[class*='sitenotice' i], [class*='site-notice' i], [class*='dismissable' i], " +
    "[class*='dismissible' i], [class*='cookie' i], [class*='consent' i], " +
    "[class*='newsletter' i], [class*='subscribe' i], [class*='paywall' i], " +
    "[class*='promo-banner' i], [class*='banner' i], " +
    "[id*='sitenotice' i], [id*='centralnotice' i], [id*='cookie' i], " +
    "[id*='banner' i]";
  const inBoiler = (el) => !!(el.closest && el.closest(BOILER));
  const textLen = (root) => {
    let n = 0;
    for (const p of root.querySelectorAll("p")) {
      if (inBoiler(p)) continue;
      n += String(p.innerText || "").trim().length;
    }
    return n;
  };
  const semantic = [...document.querySelectorAll(
    "article, main, [role='main'], [itemprop='articleBody'], " +
    ".article, .article-body, .post-content, .entry-content, .markdown-body, " +
    ".content, .post, .rich-content")];
  let best = null, bestScore = -1;
  for (const root of semantic) {
    // 嵌套时取内层（.content > article 这种，article 更贴近正文）
    const score = textLen(root) * 1.25;
    if (score > bestScore) { bestScore = score; best = root; }
  }
  // 一个语义容器都没有时才退回 body，且此时同样排除样板
  if (!best || bestScore <= 0) {
    const bodyScore = document.body ? textLen(document.body) : 0;
    if (bodyScore > bestScore) { best = document.body; bestScore = bodyScore; }
  }
  if (!best || bestScore <= 0) {
    return { title: document.title, content: "", reason:
      "no article-like content found (page is an app/listing/index, not a document) — " +
      "use mode:snapshot for interactive elements or mode:text for raw text" };
  }
  const fence = String.fromCharCode(96, 96, 96);
  const parts = [];
  for (const el of best.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, blockquote, pre")) {
    if (inBoiler(el)) continue;
    const tag = el.tagName.toLowerCase();
    const text = String(el.innerText || "").trim();
    if (!text) continue;
    if (tag === "pre") parts.push(fence + "\\n" + text + "\\n" + fence);
    else if (tag === "blockquote") parts.push("> " + text.replace(/\\n/g, "\\n> "));
    else if (tag === "li") parts.push("- " + text);
    else if (/^h[1-6]$/.test(tag)) parts.push("#".repeat(Number(tag.charAt(1))) + " " + text);
    else parts.push(text);
  }
  const content = parts.join("\\n\\n");
  return { title: document.title, content,
    root: best.tagName.toLowerCase() + (best.className ? "." + String(best.className).split(/\\s+/)[0] : ""),
    reason: content ? undefined :
      "matched a container but it had no prose — try mode:text" };
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
      let done = false;
      return new Promise((resolve) => {
        // BUG-93: requestAnimationFrame 在 visibilityState=hidden 的页面里永远
        // 不触发——不是"没有 rAF"，是 rAF 排了队但浏览器不给这个隐藏页面执行
        // 时机。OS 窗口被其他窗口挡住/未聚焦就是这种状态，调用方已经
        // Page.bringToFront 过（那只解决"tab 在自己窗口里不是激活页"），管不到
        // 窗口本身没有系统焦点这层。原来 resolve 只在 stepFn 里调用，rAF 不来
        // 这个 promise 永远 pending，上层 await 直接硬挂到 30s CDP 超时。这里
        // 加一道兜底计时器：到点了不管动画有没有跑完，直接跳到终点位置并
        // resolve——反正页面看不见，跳不跳都没有视觉差异，但能让调用方拿回
        // 控制权。
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(watchdog);
          state.x = x; state.y = y; apply();
          resolve({ x: state.x, y: state.y });
        };
        const watchdog = setTimeout(finish, dur + 300);
        const stepFn = (ts) => {
          if (done) return;
          if (ts == null) ts = Date.now();
          if (start == null) start = ts;
          const t = Math.min((ts - start) / dur, 1);
          const e = easeInOut(t);
          const u = 1 - e;
          state.x = u * u * fromX + 2 * u * e * cx + e * e * x;
          state.y = u * u * fromY + 2 * u * e * cy + e * e * y;
          apply();
          if (t >= 1) { finish(); return; }
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
    // UX-77: 包成 {tabs, count}，与 cookie_get/script_list 一致；裸数组让 AI
    // 无法用统一模式解析（也没地方挂 count/截断标记）。
    const out = tabs
      .filter((t) => t.id != null)
      .map((t) => ({
        tabId: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        windowId: t.windowId,
        attached: attachedTabs.has(t.id),
        group:
          t.groupId >= 0 ? groupTitles[t.groupId] || String(t.groupId) : null,
      }));
    return { tabs: out, count: out.length };
  },

  async find_tab(args) {
    // UX-178/BUG-31: url_pattern 必填。缺省 ".*" 会静默匹配全部 tab，
    // AI 传错参数名（url/pattern）时以为在过滤，实际拿到整个浏览器。
    if (!args.url_pattern) {
      throw new ToolError(
        "BAD_ARGS",
        "find_tab: url_pattern is required (JS regex matched against tab URL)",
        false,
      );
    }
    const re = toRegExp(args.url_pattern);
    const tabs = await chrome.tabs.query({});
    const hits = tabs
      .filter((t) => t.id != null && re.test(t.url || ""))
      .map((t) => ({ tabId: t.id, url: t.url, title: t.title }));
    return { tabs: hits, count: hits.length }; // UX-77 同款包裹
  },

  async navigate(args) {
    if (!args.url) throw new ToolError("BAD_ARGS", "navigate: url is required");
    // UX-203: wait_until 非法值原来静默忽略，AI 以为设了策略其实没设
    const waitUntil = args.wait_until || args.waitUntil;
    if (waitUntil && !["load", "domcontentloaded", "complete"].includes(waitUntil)) {
      throw new ToolError(
        "BAD_ARGS",
        `navigate: bad wait_until: ${waitUntil} (valid: load|domcontentloaded|complete)`,
        false,
      );
    }
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
    // BUG-1/2/53/59: reset per-tab state on navigation. The CDP
    // Page.frameNavigated handler also does this, but only fires when
    // Page.enable was called. Since read_page / navigate don't always
    // enable Page, we reset here to guarantee refs restart from e1.
    readPageNextRef.delete(tabId);
    readPageSnapshots.delete(tabId);
    scriptRegistryMap.delete(tabId);
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
    // BUG-66: detect chrome-error:// page (invalid URL, DNS failure, etc.)
    // Previously returned ok=true loadCompleted=true for these, giving AI
    // false success on unreachable pages. chrome.tabs.get().url may still
    // show the requested URL, so also check location.href in-page.
    let isChromeError = tab.url && tab.url.startsWith("chrome-error://");
    let errorCode = null;
    let httpErrorHint = null;
    let attachHint = null;
    if (!isChromeError) {
      // BUG-75: 这段探测原来直接 cdpCall，而 navigate 全程没 ensureAttached ——
      // 未附着时 Runtime.evaluate 必抛，异常又被 catch 吞掉，于是错误页检测
      // 形同虚设：对 DNS 失败的域名照样返回 loadCompleted:true（假成功）。
      // 实测 .invalid 域名：tab.url 保留请求 URL，只有页内 location.href
      // 才是 chrome-error://chromewebdata/，所以这条页内探测是必需的。
      try {
        try {
          await ensureAttached(tabId);
        } catch (attachErr) {
          // BUG-86: 附着失败最常见的原因是 Chrome 安全拦截页（证书/隐私错误），
          // 这类页面根本无法被检查。原来这里被外层 catch 静默吞掉，navigate
          // 照报成功，AI 直到下一步 read_page 才撞上难懂的 "Cannot attach"。
          // 提前说破，AI 才不会在不可检查的页面上继续操作。
          attachHint =
            "page loaded but the debugger cannot attach to it (" +
            String((attachErr && attachErr.message) || attachErr).slice(0, 80) +
            ") — most often a Chrome security interstitial (certificate / " +
            "privacy error); the page cannot be read or interacted with";
          throw attachErr;
        }
        const evRes = await cdpCall(tabId, "Runtime.evaluate", {
          expression:
            '(()=>{const e=document.querySelector("#main-frame-error");' +
            'return JSON.stringify({h:location.href,err:e?' +
            '((document.querySelector(".error-code")||{}).textContent||"").trim():null,' +
            't:(document.title||"").slice(0,80),' +
            'len:(document.body?document.body.innerText.trim().length:0)})})()',
          returnByValue: true,
        });
        const probe = JSON.parse((evRes.result && evRes.result.value) || "{}");
        if (
          (probe.h && probe.h.startsWith("chrome-error://")) ||
          probe.err
        ) {
          isChromeError = true;
          errorCode = probe.err || null;
        } else {
          // BUG-78: 服务端返回的 4xx/5xx 错误页是「正常加载」的——没有
          // chrome-error://，页面就是服务器给的那段错误正文。实测澎湃新闻
          // 直接回 403（body 仅 "403 Forbidden Zen/4.3"），而 navigate 照样
          // 报 loadCompleted:true，AI 完全看不出自己被拒了，只会对着一份
          // 几乎空的快照困惑。这里用「标题像 HTTP 错误 + 正文极短」识别，
          // 只提示不拦截（有站点的 404 页做得很丰富，不该误判）。
          const m = /^\s*(\d{3})\s|^(40[0-9]|41[0-9]|42[0-9]|43[0-9]|44[0-9]|50[0-9])\b/.exec(probe.t || "");
          const code = m ? m[1] || m[2] : null;
          if (code && Number(code) >= 400 && (probe.len || 0) < 200) {
            httpErrorHint =
              `page loaded but looks like an HTTP ${code} error page ` +
              `(title="${probe.t}", body only ${probe.len} chars) — ` +
              "the site likely blocked or rejected this request";
          }
        }
      } catch (e) {}
    }
    if (isChromeError) {
      return {
        tabId,
        url: args.url,
        title: "",
        loadCompleted: false,
        // BUG-75: 带上 Chrome 的错误码（ERR_NAME_NOT_RESOLVED /
        // ERR_CONNECTION_CLOSED / ERR_CONNECTION_TIMED_OUT …），
        // AI 才能区分「域名写错了」和「网络不通」这两种完全不同的处置。
        errorCode: errorCode || undefined,
        navigationError:
          "page failed to load" +
          (errorCode ? ` (${errorCode})` : " (chrome-error)") +
          " — check URL validity and network",
        groupId,
      };
    }
    // UX-113: 超时窗口错过 "complete" 事件不等于页面没加载完——回查一次
    // tab.status，别把已经加载好的页面报成 loadCompleted:false。
    const settled = completed || tab.status === "complete";
    const out = {
      tabId,
      url: tab.url,
      title: tab.title,
      loadCompleted: settled,
      groupId,
    };
    // UX-65/BUG-4: loadCompleted=false 既不是错误也没有指引，AI 只会无视它继续
    // 操作半加载的页面。这里点明下一步。
    if (!settled) {
      out._hint =
        `page not finished loading within ${args.timeout_ms || 30000}ms; ` +
        "raise timeout_ms, or call wait_for {network_idle:true} / " +
        "wait_for {selector} before interacting";
    }
    // BUG-78: 服务端 4xx/5xx 是「加载成功」的错误页，不拦截但必须说破，
    // 否则 AI 只会看到一份空快照而误判成「这页没内容」。
    if (httpErrorHint) out.httpErrorHint = httpErrorHint;
    // BUG-86: 附着失败必须在 navigate 就说破，别等到 read_page 才撞墙
    if (attachHint) out.attachHint = attachHint;
    return out;
  },

  // UX-153: 只有前进导航，回退/前进/刷新都得靠 evaluate 手搓。
  async history(args) {
    const tabId = await resolveTabId(args);
    const action = args.action || "back";
    if (!["back", "forward", "reload"].includes(action)) {
      throw new ToolError(
        "BAD_ARGS",
        `history: bad action: ${action} (valid: back|forward|reload)`,
        false,
      );
    }
    await ensureAttached(tabId);
    const before = await chrome.tabs.get(tabId);
    if (action === "reload") {
      await chrome.tabs.reload(tabId, { bypassCache: !!args.bypass_cache });
    } else {
      await evaluateJs(tabId, `(() => { history.${action}(); return 1; })()`);
    }
    // 导航后 per-tab 快照状态失效（同 navigate）
    readPageNextRef.delete(tabId);
    readPageSnapshots.delete(tabId);
    scriptRegistryMap.delete(tabId);
    // 等一拍让 URL 落定；history.back 在同文档锚点跳转时不会触发 loading
    const deadline = Date.now() + Math.min(args.timeout_ms || 10000, 60000);
    let tab = before;
    while (Date.now() < deadline) {
      await sleep(200);
      tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete" && (action === "reload" || tab.url !== before.url)) break;
    }
    return {
      tabId,
      action,
      url: tab.url,
      title: tab.title,
      changed: tab.url !== before.url,
      loadCompleted: tab.status === "complete",
    };
  },

  // UX-143/230: 没有滚动工具，AI 只能 evaluate("window.scrollBy(...)")，
  // 而裸 return 在 script 上下文里回 undefined，看着像滚动失败。
  async scroll(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    const target = resolveTargetSelector(args, "scroll", false);
    let expression;
    if (target) {
      expression = elementSnippet(
        target.selector,
        `return { scrolledToElement: true, x: scrollX, y: scrollY,` +
          ` maxY: Math.max(document.body ? document.body.scrollHeight : 0,` +
          ` document.documentElement.scrollHeight) - innerHeight };`,
      );
    } else {
      const dy = args.y != null ? Number(args.y) : args.dy != null ? Number(args.dy) : null;
      const dx = args.x != null ? Number(args.x) : args.dx != null ? Number(args.dx) : 0;
      const to = args.to; // "top" | "bottom"
      // BUG-100: 不带 behavior 的 scrollTo/scrollBy 跟着页面 CSS
      // scroll-behavior 走——站点设了 smooth 时是跨帧动画，紧接着同步读
      // scrollY 拿到的是动画开始前的旧值；Chrome 窗口没有系统焦点时这个
      // 动画还会直接卡住不推进（不是读早了，是滚动真的没发生，实测数秒后
      // window.scrollY 依然是 0）。instant 绕开动画同步立即到位。
      expression =
        `(() => {` +
        (to === "bottom"
          ? ` scrollTo({ top: document.documentElement.scrollHeight, left: 0, behavior: "instant" });`
          : to === "top"
            ? ` scrollTo({ top: 0, left: 0, behavior: "instant" });`
            : args.absolute
              ? ` scrollTo({ left: ${dx || 0}, top: ${dy == null ? 0 : dy}, behavior: "instant" });`
              : ` scrollBy({ left: ${dx || 0}, top: ${dy == null ? 600 : dy}, behavior: "instant" });`) +
        ` return { x: scrollX, y: scrollY,` +
        ` maxY: Math.max(document.body ? document.body.scrollHeight : 0,` +
        ` document.documentElement.scrollHeight) - innerHeight }; })()`;
    }
    const res = await cdpCall(tabId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    const v = res.result && res.result.value;
    if (!v && target) targetNotFound(target, "scroll");
    // 懒加载页面滚动后内容是异步进来的；给一点时间再让 AI 去 read_page since_last
    await sleep(Math.min(args.settle_ms || 400, 5000));
    return {
      tabId,
      ...v,
      atBottom: v && v.maxY != null ? v.y >= v.maxY - 2 : undefined,
    };
  },

  // 一键清场：关掉 OWB 分组的全部 tab（只动桥创建的组，不碰用户 tab）
  async close_group(args = {}) {
    // UX-124: "一键清场"只关「OWB 分析」组，task:/交接组的 tab 全留着，
    // AI 以为清干净了。默认连 OWB 建的 task 组一起收，交接组默认不动
    // （那是用户正在操作的现场），include_handoff 显式要才关。
    const all = await chrome.tabGroups.query({});
    const wanted = all.filter((g) => {
      const t = g.title || "";
      if (t === OWB_GROUP_TITLE) return true;
      if (t.startsWith("task: ")) return args.include_tasks !== false;
      if (t === HANDOFF_GROUP_TITLE) return args.include_handoff === true;
      return false;
    });
    let closed = 0;
    const groups = [];
    for (const g of wanted) {
      const tabs = await chrome.tabs.query({ groupId: g.id });
      const ids = tabs.map((t) => t.id).filter((id) => id != null);
      if (ids.length) {
        await chrome.tabs.remove(ids);
        closed += ids.length;
        groups.push({ title: g.title, tabs: ids.length });
      }
    }
    const handoffLeft = all.filter(
      (g) => g.title === HANDOFF_GROUP_TITLE && args.include_handoff !== true,
    ).length;
    return {
      closed,
      groups,
      _hint: handoffLeft
        ? `left the "${HANDOFF_GROUP_TITLE}" group open (user is working there); ` +
          "pass include_handoff:true to close it too"
        : undefined,
    };
  },

  async evaluate(args) {
    if (!args.expression)
      throw new ToolError("BAD_ARGS", "evaluate: expression is required");
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    // UX-58: 页面断在断点上时 Runtime.evaluate 会一直挂到 MCP 超时，AI 收到
    // TIMEOUT retryable=true 后重试 → 再次挂住 → 死循环。先拦下来说清怎么办。
    if (pausedState.has(tabId)) {
      throw new ToolError(
        "PAUSED",
        "tab is paused at a breakpoint — evaluate would hang until timeout; " +
          "call frame_read to inspect, then resume (or step) first",
        false,
      );
    }
    // frame_pattern：在指定 iframe 的执行上下文里求值（先用 list_frames 看 frame 列表）
    let contextId = undefined;
    if (args.frame_pattern != null) {
      try {
        await cdpCall(tabId, "Runtime.enable");
      } catch (e) {}
      contextId = await resolveFrameContextId(tabId, args.frame_pattern);
      if (!contextId) {
        throw new ToolError(
          "FRAME_NOT_FOUND",
          `no iframe execution context matching ${JSON.stringify(args.frame_pattern)} — ` +
            "call list_frames: frames listed with contextId:null are " +
            "cross-origin and cannot be evaluated from a page-level " +
            "chrome.debugger session at all",
          false,
        );
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
            : ""),
      );
    }
    // UX-74: returnByValue=false 时要把 objectId/description 一并回传，
    // 否则 oracle_call 的 object_id 模式拿不到句柄，AI 只能改走 cdp 逃生舱。
    const r = res.result || {};
    const out = { value: r.value, type: r.type };
    if (args.returnByValue === false) {
      if (r.objectId !== undefined) out.objectId = r.objectId;
      if (r.subtype !== undefined) out.subtype = r.subtype;
      if (r.className !== undefined) out.className = r.className;
      if (r.description !== undefined) out.description = r.description;
    }
    // UX-18/183/195/226/228: returnByValue 对 function / DOM 节点 / Symbol /
    // BigInt 一律回 undefined 或 {}，AI 只看到 "空结果" 判断不了发生了什么。
    // 补一个 description，并点明取值方式。
    if (out.value === undefined && r.type !== "undefined") {
      if (r.description !== undefined) out.description = r.description;
      if (r.subtype !== undefined) out.subtype = r.subtype;
      if (r.className !== undefined) out.className = r.className;
      const byType = {
        function: "functions are not serializable — return fn.toString() " +
          "or use returnByValue:false to get an objectId",
        bigint: "BigInt is not JSON-serializable — return String(value)",
        symbol: "Symbol is not serializable — return value.toString()",
        object: "DOM nodes / cyclic objects are not serializable — return " +
          "specific fields (el.outerHTML, el.textContent, …)",
      };
      out._hint =
        // UX-227: 不带 awaitPromise 求值 Promise 会拿到空对象，看着像成功
        (r.subtype === "promise"
          ? "expression returned a pending Promise — pass awaitPromise:true " +
            "to get the resolved value (rejections then surface as EVAL_EXCEPTION)"
          : byType[r.type]) ||
        "value is not JSON-serializable; return a primitive projection instead";
    }
    return out;
  },

  async network_start(args) {
    const tabId = await resolveTabId(args);
    const wasEnabled = networkEnabledTabs.has(tabId);
    await ensureNetwork(tabId);
    if (!wasEnabled && args.clear !== false)
      networkBuffers.set(tabId, new Map());
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
    const all = [];
    let extensionRequests = 0;
    let orphanRecords = 0;
    for (const rec of getBuffer(tabId).values()) {
      // BUG-73: 抓包在页面已加载后才启动、或跨 reload 时，会收到只有响应事件
      // 而没有 requestWillBeSent 的记录 —— 它们没有 url/method/requestId，
      // 在列表里就是一行 {status,finished,failed}，AI 既认不出是谁也没法
      // network_detail 它。实测 USGS 上 45 条全是这种，整个抓包结果等于废掉。
      // 无身份 = 不可操作，默认剔除并单独计数（要看用 include_orphans:true）。
      if (!rec.url && !rec.requestId) {
        orphanRecords++;
        if (!args.include_orphans) continue;
      }
      // UX-222: 其他扩展的资源请求混在抓包结果里，忙页面上会把真正的 API 挤掉
      if (!args.include_extensions && isExtensionUrl(rec.url)) {
        extensionRequests++;
        continue;
      }
      if (re && !re.test(rec.url || "")) continue;
      all.push({
        requestId: rec.requestId,
        // UX-62: network_detail/get_initiator 收的是 request_id（snake_case），
        // 两个名字都给，AI 不必手工转换。
        request_id: rec.requestId,
        url: rec.url,
        method: rec.method,
        status: rec.status,
        type: rec.type,
        finished: !!rec.finished,
        failed: !!rec.failed,
        // BUG-74: 耗时与体积直接进列表——性能排查不必对每条再 network_detail
        durationMs:
          rec.finishedAt && rec.startedAt
            ? rec.finishedAt - rec.startedAt
            : undefined,
        size: rec.encodedDataLength,
        fromCache: rec.fromCache || undefined,
      });
    }
    // BUG-74: 按耗时/体积排序，一条命令回答「最慢的是谁」「谁最占带宽」
    const sortKey = args.sort_by === "duration" ? "durationMs"
      : args.sort_by === "size" ? "size" : null;
    if (sortKey) all.sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
    // UX-175: 缓冲是 oldest-first，忙页面上刚发的 AJAX 会被 limit 截在外面。
    // newest:true 从尾部取，AI 想看"刚刚那条请求"时不用调大 limit 捞全量。
    // sort_by 与 newest 语义冲突（排序后再从尾部取 = 拿到最快/最小的几条，
    // 与「按耗时排序」的意图完全相反），排序优先。
    const newest = !sortKey && (!!args.newest || args.order === "newest");
    const out = newest ? all.slice(-limit).reverse() : all.slice(0, limit);
    // UX-61: 包成 {requests, count}，与其他工具一致（原来是裸数组）
    return {
      tabId,
      requests: out,
      count: out.length,
      matched: all.length,
      truncated: all.length > out.length,
      limit,
      buffered: getBuffer(tabId).size,
      order: sortKey
        ? `${args.sort_by}-desc`
        : newest ? "newest-first" : "oldest-first",
      extensionRequestsHidden: extensionRequests || undefined,
      // BUG-73: 剔除了多少条无身份记录（抓包起晚了/跨了 reload）。
      // 数量大说明该在导航前就 network_start，否则前半段请求已经错过。
      orphanRecordsHidden: orphanRecords || undefined,
    };
  },

  async network_detail(args) {
    const tabId = await resolveTabId(args);
    // UX-62: 兼收 requestId（network_list 输出的 camelCase 名）
    const reqId = args.request_id ?? args.requestId;
    if (!reqId) {
      throw new ToolError(
        "BAD_ARGS",
        "network_detail: request_id is required (from network_list)",
        false,
      );
    }
    args = { ...args, request_id: reqId };
    const rec = getBuffer(tabId).get(reqId);
    if (!rec)
      throw new ToolError("NOT_FOUND", `request not in buffer: ${reqId}`);
    const detail = { ...rec };
    if (args.include_body !== false && rec.finished) {
      try {
        const body = await cdpCall(tabId, "Network.getResponseBody", {
          requestId: args.request_id,
        });
        // 全量 body（daemon WS 已调到 64MB 帧）；max_body 兜底防超大响应撑爆 agent 上下文
        const max = Math.max(args.max_body || 500000, 1000);
        detail.body =
          body.body.length > max
            ? body.body.slice(0, max) + "…(truncated)"
            : body.body;
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
    // UX-62: 与 network_detail 同款，request_id / requestId 都收
    const reqId = args.request_id ?? args.requestId;
    // UX-191: 只能按 request_id 查，AI 手里往往只有 URL，得先 network_list
    // 翻一遍找 id。直接支持 url / url_pattern 查最近一条。
    if (!reqId) {
      const pat = args.url_pattern || args.url;
      if (!pat) {
        throw new ToolError(
          "BAD_ARGS",
          "get_initiator: pass request_id (from network_list) or url/url_pattern",
          false,
        );
      }
      const re = args.url ? null : toRegExp(pat);
      let hit = null;
      for (const rec of getBuffer(tabId).values()) {
        const u = rec.url || "";
        if (re ? re.test(u) : u.includes(pat)) hit = rec; // 取最后一条 = 最近
      }
      if (!hit) {
        throw new ToolError(
          "NOT_FOUND",
          `no buffered request matching ${pat} ` +
            "(call network_start before the action that fires it)",
          false,
        );
      }
      return {
        requestId: hit.requestId,
        request_id: hit.requestId,
        url: hit.url,
        initiator: hit.initiator,
      };
    }
    const rec = getBuffer(tabId).get(reqId);
    if (!rec) throw new ToolError("NOT_FOUND", `request not in buffer: ${reqId}`);
    return {
      requestId: rec.requestId,
      request_id: rec.requestId,
      url: rec.url,
      initiator: rec.initiator,
    };
  },

  // ---- HAR 录制（独立于 networkBuffers 的探查缓冲）----

  async record_start(args) {
    const tabId = await resolveTabId(args);
    await ensureNetwork(tabId); // 复用 attach + Network.enable
    const tab = await chrome.tabs.get(tabId);
    let origin = null;
    try {
      origin = new URL(tab.url).origin;
    } catch (e) {}
    const rec = {
      stats: new Stats(tab.url),
      tabId,
      url: tab.url,
      startedAt: new Date().toISOString(),
      includeBodies: args.include_bodies !== false,
      bodyBytes: 0,
      maxBodyBytes: Math.max(
        0,
        args.max_body_bytes != null ? args.max_body_bytes : 5 * 1024 * 1024,
      ),
      maxTotalBodyBytes: Math.max(
        0,
        args.max_total_body_bytes != null
          ? args.max_total_body_bytes
          : 100 * 1024 * 1024,
      ),
      bodyCapped: false,
      // 过滤（白/黑名单 + resource_type）
      urlFilter: args.url_pattern ? toRegExp(args.url_pattern) : null,
      excludeFilter: args.exclude_pattern
        ? toRegExp(args.exclude_pattern)
        : null,
      resourceTypes:
        Array.isArray(args.resource_types) && args.resource_types.length
          ? new Set(args.resource_types.map((t) => String(t).toLowerCase()))
          : null,
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
    try {
      await cdpCall(tabId, "Page.enable");
    } catch (e) {}
    if (rec.captureStorage) {
      try {
        await cdpCall(tabId, "DOMStorage.enable");
      } catch (e) {}
    }
    if (rec.captureConsole) {
      try {
        await cdpCall(tabId, "Runtime.enable");
      } catch (e) {}
      try {
        await cdpCall(tabId, "Log.enable");
      } catch (e) {}
    }
    // cookie 起始快照（stop 时 diff）
    rec._cookiesStart = await snapshotCookies(tabId, origin);
    pushEvent("record", { tabId, phase: "start", url: tab.url });
    return {
      tabId,
      recording: true,
      url: tab.url,
      filters: {
        url_pattern: rec.urlFilter ? rec.urlFilter.source : null,
        exclude_pattern: rec.excludeFilter ? rec.excludeFilter.source : null,
        resource_types: rec.resourceTypes ? [...rec.resourceTypes] : null,
      },
    };
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
      const { har, entries } = await finalizeRecorder(
        onlyTabId,
        rec,
        args.title,
      );
      recorders.delete(onlyTabId);
      recorderSkipped.delete(onlyTabId);
      recorderOrigins.delete(onlyTabId);
      pushEvent("record", {
        tabId: onlyTabId,
        phase: "stop",
        entries,
        bodyBytes: rec.bodyBytes,
      });
      return {
        tabId: onlyTabId,
        recording: false,
        entries,
        bodyBytes: rec.bodyBytes,
        har,
      };
    }
    const tabId = await resolveTabId(args);
    const rec = recorders.get(tabId);
    if (!rec)
      throw new ToolError(
        "NOT_RECORDING",
        // BUG-82: har_save 内部就会调 record_stop，所以「先 stop 再 save」
        // 这个最自然的写法必然失败，且录制数据在 stop 时已随响应返回并丢弃。
        // 错误信息必须说清正确姿势，否则 AI 只会反复重试。
        `tab ${tabId} is not recording. If you already called record_stop, ` +
          "the recording is gone — record_stop returns the HAR inline and drops it. " +
          "Correct flow: record_start → (do things) → har_save (which stops AND " +
          "writes to disk in one step). Do not call record_stop before har_save.",
        false,
      );
    const { har, entries } = await finalizeRecorder(tabId, rec, args.title);
    recorders.delete(tabId);
    recorderSkipped.delete(tabId);
    recorderOrigins.delete(tabId);
    pushEvent("record", {
      tabId,
      phase: "stop",
      entries,
      bodyBytes: rec.bodyBytes,
    });
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
      throw new ToolError(
        "BAD_ARGS",
        "download: selector or url is required (one of the two)",
        false,
      );
    }
    await ensureAttached(tabId);
    const timeoutMs = Math.min(args.timeout_ms || 60000, 180000);

    // BUG-60/BUG-8: Chrome 150 把 Page.setDownloadBehavior 提到了 browser-level，
    // chrome.debugger 只有 page-level target，三种参数组合全部报
    // "Cannot access browser-level commands" —— download 工具整个不可用。
    // 改走扩展自己的 chrome.downloads API（manifest 里已申请 downloads 权限），
    // 它本来就是 SW 权限内的能力，不经过 CDP。
    const watchDownloads = (predicate) =>
      new Promise((resolve, reject) => {
        let settled = false;
        const done = (v, err) => {
          if (settled) return;
          settled = true;
          chrome.downloads.onCreated.removeListener(onCreated);
          chrome.downloads.onChanged.removeListener(onChanged);
          clearTimeout(timer);
          err ? reject(err) : resolve(v);
        };
        let watchedId = null;
        const onCreated = (item) => {
          if (watchedId == null && predicate(item)) watchedId = item.id;
        };
        const onChanged = async (delta) => {
          if (watchedId == null || delta.id !== watchedId) return;
          if (delta.state && delta.state.current === "complete") {
            const [item] = await chrome.downloads.search({ id: watchedId });
            done({
              state: "completed",
              filename: item ? item.filename : "",
              url: item ? item.url : "",
              receivedBytes: item ? item.bytesReceived : undefined,
              mime: item ? item.mime : undefined,
              downloadId: watchedId,
            });
          } else if (delta.state && delta.state.current === "interrupted") {
            done(
              null,
              new ToolError(
                "DOWNLOAD_FAILED",
                "download was interrupted" +
                  (delta.error ? `: ${delta.error.current}` : "") +
                  " — the server may require auth/referer; try replaying the " +
                  "request with daemon.replay instead",
                false,
              ),
            );
          }
        };
        const timer = setTimeout(
          () =>
            done(
              null,
              new ToolError(
                "TIMEOUT",
                `download not completed in ${timeoutMs}ms — the click may not ` +
                  "have started a download (check with list_tabs / read_page), " +
                  "or the file is large: raise timeout_ms",
                true,
              ),
            ),
          timeoutMs,
        );
        chrome.downloads.onCreated.addListener(onCreated);
        chrome.downloads.onChanged.addListener(onChanged);
      });

    let result;
    if (args.url) {
      // BUG-98: 直链分支原来先 await download() 拿到 id，再拿 id 去挂监听——
      // 小文件（甚至 example.com 首页这种几 KB 的 HTML）几乎瞬间下完，
      // onCreated/onChanged 很可能在监听器挂上之前就已经触发过了，
      // watchDownloads 等一个已经发生过的事件，直接硬等到超时。旁边点击
      // 分支的注释早就写明白了这个坑（"先挂监听再点，避免竞态"），
      // 但同样的修法没有搬到这个分支来。改成一样的顺序：先挂通配监听，
      // 再发起下载——不用等 id 才能匹配，反正这次调用期间不会有别的下载
      // 并发触发。
      const p = watchDownloads(() => true);
      await chrome.downloads.download({
        url: args.url,
        filename: args.filename || undefined,
        saveAs: false,
      });
      result = await p;
    } else {
      // 点击触发：先挂监听再点，避免竞态
      const p = watchDownloads(() => true);
      await tools.click({ tabId, selector: args.selector });
      result = await p;
    }
    pushEvent("download", {
      tabId,
      filename: result.filename,
      url: result.url,
    });
    return {
      tabId,
      filename: result.filename,
      path: result.filename, // chrome.downloads 给的是绝对路径
      receivedBytes: result.receivedBytes,
      mime: result.mime,
      state: result.state,
      downloadId: result.downloadId,
    };
  },

  // ---- E2. 文件上传（页面内 DataTransfer + File，无需文件系统）----

  async upload(args) {
    // BUG-97: every other interactive tool (click/fill/mouse_click) accepts
    // either selector or the @eN ref from read_page via resolveTargetSelector —
    // upload only ever took selector, forcing callers to hand-build
    // `[data-owb-ref="..."]` themselves instead of just passing the ref they
    // already have from the snapshot. Inconsistent with the rest of the toolset
    // for no reason; this is the only tool that skipped the shared helper.
    const target = resolveTargetSelector(args, "upload");
    if (!Array.isArray(args.files) || !args.files.length) {
      throw new ToolError("BAD_ARGS", "upload: files array required", false);
    }
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    // 校验 + 归一化文件项
    const norm = args.files.map((f) => {
      if (!f || !f.name || f.base64 == null) {
        throw new ToolError(
          "BAD_ARGS",
          "upload: each file needs {name, base64}",
          false,
        );
      }
      return {
        name: String(f.name),
        base64: String(f.base64),
        mime: f.mime || "application/octet-stream",
      };
    });
    // 页面内：找 input、构造 File、赋给 .files、派发 change（绕文件系统，relay 模式也能用）
    const expr = `(() => {
      ${DEEP_QUERY_FN}
      const input = __owbDeepQuery(${JSON.stringify(target.selector)});
      // UX-146/147: "upload failed" 一句话把"找不到元素"和"元素不是 file input"
      // 混在一起，AI 无从判断该改 selector 还是改目标。找不到元素交回 null，
      // 走跟 click/fill 一样的 targetNotFound——ref 找不到时报可重试的
      // REF_STALE，而不是不管哪种情况都报不可重试的 NOT_FOUND。
      if (!input) return null;
      if (input.tagName !== "INPUT" || (input.type || "").toLowerCase() !== "file") {
        return { ok: false, code: "NOT_FILE_INPUT",
          error: "element is <" + input.tagName.toLowerCase() + ">" +
            (input.type ? " type=" + input.type : "") + ", not <input type=file>" };
      }
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
    const res = await cdpCall(tabId, "Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new ToolError(
        "EVAL_EXCEPTION",
        "upload failed: " + res.exceptionDetails.text,
        false,
      );
    }
    const v = res.result && res.result.value;
    if (!v) {
      targetNotFound(
        target,
        "upload",
        "many sites hide the real <input type=file> behind a styled button; " +
          "call read_page to confirm it's actually there",
      );
    }
    if (!v.ok) {
      throw new ToolError(
        v.code || "UPLOAD_FAILED",
        `upload: ${v.error || "failed"} (${target.ref || target.selector})`,
        false,
      );
    }
    return { tabId, filesSet: v.count };
  },

  // ---- E3. PDF 导出（Page.printToPDF）----

  async print_pdf(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);

    // BUG-64: validate paperFormat — invalid values used to silently pass through
    // to Chrome, giving AI false success.
    const PAPER_FORMATS = [
      "Letter",
      "Legal",
      "Tabloid",
      "Ledger",
      "A0",
      "A1",
      "A2",
      "A3",
      "A4",
      "A5",
      "A6",
    ];
    const paperFormat = args.format || "A4";
    if (!PAPER_FORMATS.includes(paperFormat)) {
      throw new ToolError(
        "BAD_ARGS",
        `print_pdf: format must be one of ${PAPER_FORMATS.join(", ")} (got: ${paperFormat})`,
        false,
      );
    }

    const opts = {
      landscape: !!args.landscape,
      printBackground: args.print_background !== false,
      paperFormat,
      marginTop: args.margin_top != null ? args.margin_top : 0.4,
      marginBottom: args.margin_bottom != null ? args.margin_bottom : 0.4,
      marginLeft: args.margin_left != null ? args.margin_left : 0.4,
      marginRight: args.margin_right != null ? args.margin_right : 0.4,
      preferCSSPageSize: !!args.prefer_css_page_size,
    };
    const { data } = await cdpCall(tabId, "Page.printToPDF", opts);
    return {
      tabId,
      format: opts.paperFormat,
      data,
      size: data ? data.length : 0,
    };
  },

  // ---- E4. iframe / 执行上下文（list_frames + frame 定向 evaluate）----

  async list_frames(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    try {
      await cdpCall(tabId, "Runtime.enable");
    } catch (e) {}
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
    // UX-225: 其他扩展的执行上下文混在 contexts 里，AI 会拿它们当页面 iframe
    const pageCtxs = args.include_extensions
      ? ctxs
      : ctxs.filter((c) => !isExtensionUrl(c.url || c.name));
    // UX-28: main/children 的树形结构 AI 得自己猜；补一份拍平的 frames 列表
    const flat = [];
    const flatten = (n) => {
      flat.push({
        frameId: n.frameId, url: n.url, name: n.name,
        contextId: n.contextId, depth: n.depth,
      });
      (n.children || []).forEach(flatten);
    };
    const main = walk(treeRes.frameTree, 0);
    flatten(main);
    return {
      tabId,
      main,
      frames: flat,
      count: flat.length,
      contexts: pageCtxs,
      // BUG-40/UX-215: 跨源 iframe 在 chrome.debugger 的页面级会话里拿不到
      // 执行上下文，evaluate frame_pattern 必然 FRAME_NOT_FOUND。
      _hint: flat.some((f) => f.depth > 0 && f.contextId == null)
        ? "frames with contextId:null are cross-origin — chrome.debugger's " +
          "page-level session cannot evaluate inside them; read their content " +
          "via network_detail on the frame's document request instead"
        : undefined,
    };
  },

  // ---- D. 环境模拟：设备/网络/地理/时区/语言/权限/UA（统一 emulate 入口）----

  async emulate(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    const applied = [];
    const errs = [];
    const notes = [];
    // UX-210: device 是唯一被识别的视口参数名，AI 天然会写 viewport 或顶层
    // width/height —— 原来一律静默忽略、返回 applied:[] 的假成功。
    let device = args.device || args.viewport;
    if (!device && (args.width != null || args.height != null)) {
      device = {
        width: args.width,
        height: args.height,
        mobile: args.mobile,
        touch: args.touch,
      };
    }
    // 设备视口/触摸
    if (device) {
      const d = device;
      try {
        // UX-69: 新 tab 初始 innerWidth=0（BUG-18）。在 0 视口上直接设移动
        // metrics 会得到 980 而非目标宽度——先垫一个非零视口再设目标值。
        let zeroViewport = false;
        try {
          const probe = await cdpCall(tabId, "Runtime.evaluate", {
            expression: "innerWidth", returnByValue: true,
          });
          zeroViewport = !(probe.result && probe.result.value > 0);
        } catch (e) {}
        if (zeroViewport) {
          await cdpCall(tabId, "Emulation.setDeviceMetricsOverride", {
            width: 1280, height: 900, deviceScaleFactor: 1,
            mobile: false, touch: false,
          });
          notes.push("viewport was 0px (fresh tab); primed to 1280x900 first");
        }
        await cdpCall(tabId, "Emulation.setDeviceMetricsOverride", {
          width: d.width || 360,
          height: d.height || 640,
          deviceScaleFactor:
            d.device_scale_factor != null ? d.device_scale_factor : 1,
          mobile: !!d.mobile,
          touch: !!d.touch,
        });
        // UX-26/107: mobile:true 不会让页面看到 ontouchstart，触摸检测仍失败。
        // Emulation.setTouchEmulationEnabled 才是那一半。
        if (d.touch || d.mobile) {
          try {
            await cdpCall(tabId, "Emulation.setTouchEmulationEnabled", {
              enabled: true, maxTouchPoints: 5,
            });
          } catch (e) {
            notes.push("touch emulation unavailable: " + e.message);
          }
        }
        emulateApplied(tabId, "device");
        applied.push("device");
      } catch (e) {
        errs.push("device: " + e.message);
      }
    }
    // 网络节流
    if (args.network) {
      const n = args.network;
      try {
        // UX-119: download/upload 传 0 本意是"完全断流"，`|| -1` 会把它变成
        // 不限速。只有真正缺省（undefined/null）才用 -1。
        const thr = (v) => (v === undefined || v === null ? -1 : Number(v));
        await cdpCall(tabId, "Network.emulateNetworkConditions", {
          offline: !!n.offline,
          latency: n.latency || 0,
          downloadThroughput: thr(n.download),
          uploadThroughput: thr(n.upload),
        });
        emulateApplied(tabId, "network");
        applied.push("network");
      } catch (e) {
        errs.push("network: " + e.message);
      }
    }
    // 地理位置覆盖
    if (args.geolocation) {
      try {
        await cdpCall(tabId, "Emulation.setGeolocationOverride", {
          latitude: args.geolocation.latitude || 0,
          longitude: args.geolocation.longitude || 0,
          accuracy: args.geolocation.accuracy || 100,
        });
        emulateApplied(tabId, "geolocation");
        applied.push("geolocation");
      } catch (e) {
        errs.push("geolocation: " + e.message);
      }
    }
    // 时区
    if (args.timezone) {
      try {
        await cdpCall(tabId, "Emulation.setTimezoneOverride", {
          timezoneId: args.timezone,
        });
        emulateApplied(tabId, "timezone");
        applied.push("timezone");
      } catch (e) {
        errs.push("timezone: " + e.message);
      }
    }
    // 语言
    if (args.locale) {
      try {
        await cdpCall(tabId, "Emulation.setLocaleOverride", {
          locale: args.locale,
        });
        emulateApplied(tabId, "locale");
        applied.push("locale");
        // UX-60: CDP 只改 Intl，不改 navigator.language。AI 拿后者验证会误判失败。
        notes.push(
          "locale affects Intl APIs (DateTimeFormat/NumberFormat/Collator) only; " +
            "navigator.language is unchanged — verify with " +
            "Intl.DateTimeFormat().resolvedOptions().locale, not navigator.language " +
            "(pass user_agent to also change the Accept-Language header)",
        );
      } catch (e) {
        errs.push("locale: " + e.message);
      }
    }
    // 权限授予（notification/geolocation/camera...）
    if (Array.isArray(args.permissions) && args.permissions.length) {
      // UX-76: 名字打错原来静默通过（CDP 收下就返回 ok），AI 以为授权成功了
      const bad = args.permissions.filter((p) => !CDP_PERMISSIONS.has(p));
      if (bad.length) {
        throw new ToolError(
          "BAD_ARGS",
          `emulate: unknown permission(s): ${bad.join(",")} ` +
            `(valid: ${[...CDP_PERMISSIONS].join("|")})`,
          false,
        );
      }
      try {
        await cdpCall(tabId, "Browser.grantPermissions", {
          permissions: args.permissions,
        });
        emulateApplied(tabId, "permissions");
        applied.push("permissions");
      } catch (e) {
        // BUG-15: chrome.debugger 下 Browser 域常被拒，别报成"已授权"
        errs.push("permissions: " + e.message);
      }
    }
    // UA 覆盖
    if (args.user_agent) {
      try {
        await cdpCall(tabId, "Emulation.setUserAgentOverride", {
          userAgent: args.user_agent,
          acceptLanguage: args.locale || undefined,
        });
        emulateApplied(tabId, "user_agent");
        applied.push("user_agent");
        // BUG-43: 同一次调用里既设 UA 又设 device 时，UA override 会把移动
        // 视口顶回去。UA 之后补设一遍 device metrics，让视口是最终状态。
        if (device && applied.includes("device")) {
          try {
            await cdpCall(tabId, "Emulation.setDeviceMetricsOverride", {
              width: device.width || 360,
              height: device.height || 640,
              deviceScaleFactor:
                device.device_scale_factor != null
                  ? device.device_scale_factor
                  : 1,
              mobile: !!device.mobile,
              touch: !!device.touch,
            });
          } catch (e) {
            errs.push("device re-apply after user_agent: " + e.message);
          }
        }
      } catch (e) {
        errs.push("user_agent: " + e.message);
      }
    }
    // UX-210: 给了参数却一条都没生效 = 参数名不对，必须报错而不是回 ok+applied:[]
    const known = new Set([
      "tabId", "device", "viewport", "width", "height", "mobile", "touch",
      "network", "geolocation", "timezone", "locale", "permissions",
      "user_agent",
    ]);
    const unknown = Object.keys(args).filter((k) => !known.has(k));
    if (!applied.length) {
      throw new ToolError(
        "BAD_ARGS",
        "emulate: nothing applied — no recognized parameter" +
          (unknown.length ? ` (unrecognized: ${unknown.join(",")})` : "") +
          `. Valid: device{width,height,mobile,touch,device_scale_factor} ` +
          "(alias viewport), network{offline,latency,download,upload}, " +
          "geolocation{latitude,longitude}, timezone, locale, permissions[], user_agent" +
          (errs.length ? `. Errors: ${errs.join("; ")}` : ""),
        false,
      );
    }
    return {
      tabId,
      applied,
      ignored: unknown.length ? unknown : undefined,
      notes: notes.length ? notes : undefined,
      errors: errs.length ? errs : undefined,
      active: emulateState.get(tabId) ? [...emulateState.get(tabId)] : [],
    };
  },

  async emulate_reset(args) {
    const tabId = await resolveTabId(args);
    const s = emulateState.get(tabId);
    if (!s) return { tabId, reset: [] };
    const reset = [];
    const failed = [];
    for (const type of s) {
      try {
        if (type === "device") {
          await cdpCall(tabId, "Emulation.clearDeviceMetricsOverride");
          // UX-26/107 的对偶：device 生效时开过 touch emulation，这里要一起关
          try {
            await cdpCall(tabId, "Emulation.setTouchEmulationEnabled", {
              enabled: false,
            });
          } catch (e) {}
        } else if (type === "network") {
          // Network 重置节流：disable 再 enable（emulateNetworkConditions 无 clear）
          try {
            await cdpCall(tabId, "Network.disable");
          } catch (e) {}
          await cdpCall(tabId, "Network.emulateNetworkConditions", {
            offline: false,
            latency: 0,
            downloadThroughput: -1,
            uploadThroughput: -1,
          });
        } else if (type === "geolocation")
          await cdpCall(tabId, "Emulation.clearGeolocationOverride");
        else if (type === "timezone")
          await cdpCall(tabId, "Emulation.setTimezoneOverride", {
            timezoneId: "",
          });
        else if (type === "locale")
          await cdpCall(tabId, "Emulation.setLocaleOverride", { locale: "" });
        else if (type === "permissions")
          await cdpCall(tabId, "Browser.resetPermissions");
        else if (type === "user_agent")
          await cdpCall(tabId, "Emulation.setUserAgentOverride", {
            userAgent: "",
          });
        reset.push(type);
      } catch (e) {
        // BUG-19: 原来 clear 失败被吞掉，仍返回 ok —— AI 以为环境已复原，
        // 之后的截图/布局判断全建立在残留 override 上。
        failed.push(`${type}: ${e && e.message ? e.message : e}`);
      }
    }
    emulateState.delete(tabId);
    const out = { tabId, reset, failed: failed.length ? failed : undefined };
    // BUG-19/UX-152: clear 之后回读一次真实视口。relay 模式下 clear 命令可能
    // 静默不生效，只有量一下才能发现。
    if (reset.includes("device")) {
      try {
        const probe = await cdpCall(tabId, "Runtime.evaluate", {
          expression: "innerWidth + 'x' + innerHeight",
          returnByValue: true,
        });
        out.viewport = probe.result && probe.result.value;
      } catch (e) {}
    }
    if (failed.length) {
      throw new ToolError(
        "RESET_INCOMPLETE",
        `emulate_reset could not clear: ${failed.join("; ")} ` +
          `(cleared: ${reset.join(",") || "none"}). ` +
          "The tab still carries those overrides — reload the tab or " +
          "re-attach if they must be gone.",
        true,
      );
    }
    return out;
  },

  async hook_preset(args) {
    const tabId = await resolveTabId(args);
    const presets = args.presets || (args.preset ? [args.preset] : ["xhr"]);
    // UX-202: 预设名打错原来一路走到 loadPresetSource 才炸出 HTTP 404
    const known = Object.keys(HOOK_PRESETS);
    const bad = presets.filter((p) => !known.includes(p));
    if (bad.length) {
      throw new ToolError(
        "BAD_ARGS",
        `hook_preset: unknown preset(s): ${bad.join(",")} (valid: ${known.join("|")})`,
        false,
      );
    }
    await ensureHookChannel(tabId);
    const reg = tabHookRegistry(tabId);
    const registered = [];
    for (const name of presets) {
      if (reg.has(name)) {
        registered.push({
          preset: name,
          identifier: reg.get(name),
          already: true,
        });
        continue;
      }
      const source = await loadPresetSource(name);
      const { identifier } = await cdpCall(
        tabId,
        "Page.addScriptToEvaluateOnNewDocument",
        { source },
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
    // UX-39/115 + BUG-14: reload 默认为真（不 reload hook 根本不生效），但 AI
    // 常常不知道页面会被刷掉——表单填了一半、登录态没保存的现场就没了。
    // reload:false 时也要说清"现在还没生效"，别让 AI 以为注册完就能收事件。
    return {
      tabId,
      registered,
      reloaded,
      _hint: reloaded
        ? "the page was reloaded — hooks only apply to documents created after " +
          "registration; any in-page state was lost"
        : "reload:false — hooks are registered but NOT active on the current " +
          "document; they take effect on the next navigation/reload",
    };
  },

  async hook_remove(args) {
    const tabId = await resolveTabId(args);
    const reg = tabHookRegistry(tabId);
    const names =
      args.presets || (args.preset ? [args.preset] : [...reg.keys()]);
    const removed = [];
    for (const name of names) {
      const identifier = reg.get(name);
      if (!identifier) continue;
      try {
        await cdpCall(tabId, "Page.removeScriptToEvaluateOnNewDocument", {
          identifier,
        });
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
      throw new ToolError(
        "BAD_ARGS",
        "hook_function: function_path is required",
      );
    }
    const position = args.position || "after";
    if (!["before", "after", "replace"].includes(position)) {
      throw new ToolError(
        "BAD_ARGS",
        `hook_function: bad position: ${position}`,
      );
    }
    const key = `fn:${args.function_path}#${position}`;
    await ensureHookChannel(tabId);
    const reg = tabHookRegistry(tabId);
    if (reg.has(key)) {
      return {
        tabId,
        registered: [{ preset: key, identifier: reg.get(key), already: true }],
      };
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
      tabId,
      "Page.addScriptToEvaluateOnNewDocument",
      { source },
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
    // BUG-88: 参数名写错时静默无参调用，返回 {ok:true, value:null}——
    // AI 会以为自己给的样本跑过了。实测把 call_args 误写成 samples 即复现：
    // __t(1,2) 应得 102，实际是 __t() → NaN → JSON 序列化成 null。
    // 这是最危险的失败形态：看起来成功，结果全错。收到不认识的参数直接报错。
    const KNOWN = new Set([
      "tabId", "function_path", "object_id", "call_args", "freeze",
      "timeout", "timeout_ms",
    ]);
    const unknown = Object.keys(args).filter((k) => !KNOWN.has(k));
    if (unknown.length) {
      throw new ToolError(
        "BAD_ARGS",
        `oracle_call: unknown parameter(s) ${unknown.join(", ")} — ` +
          "call arguments go in call_args (an array), e.g. " +
          '{"function_path":"app.sign","call_args":[1,2]}',
        false,
      );
    }
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
              : ""),
        );
      }
      return oracleResult(res.result ? res.result.value : undefined, "object_id");
    }
    if (!args.function_path) {
      throw new ToolError(
        "BAD_ARGS",
        "oracle_call: function_path or object_id is required " +
          "(function_path is a dotted window path like \"app.sign\", " +
          "not a JS expression)",
        false,
      );
    }
    const expression =
      `${ORACLE_EXPR}(${JSON.stringify(args.function_path)}, ` +
      `${JSON.stringify(callArgs)}, ${freeze})`;
    const out = await evaluateJs(tabId, expression, { awaitPromise: true });
    return oracleResult(out, args.function_path);
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
      const res = await cdpCall(tabId, "Network.getCookies", {
        urls: [origin, tab.url],
      });
      cookies = res.cookies || [];
    } catch (e) {}
    const storage = await evaluateJs(tabId, STATE_EXPORT_EXPR, {
      awaitPromise: true,
    });
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
    let cookiesSet = 0,
      cookiesFailed = 0;
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
    // UX-116: 其他工具的匹配参数都叫 url_pattern，这里叫 url_substring。
    // 两个名字都收（语义仍是子串，不是正则）。
    const urlSub = args.url_substring || args.url_pattern;
    if (!urlSub) {
      throw new ToolError(
        "BAD_ARGS",
        "break_xhr: url_substring is required (plain substring, not a regex)",
        false,
      );
    }
    await ensureDebugger(tabId);
    await cdpCall(tabId, "DOMDebugger.setXHRBreakpoint", { url: urlSub });
    armedBreakpoints(tabId).add("xhr:" + urlSub);
    return { tabId, armed: "xhr:" + urlSub };
  },

  async break_remove(args) {
    const tabId = await resolveTabId(args);
    const armed = armedBreakpoints(tabId);
    const sub = args.url_substring || args.url_pattern; // UX-116 同款别名
    const targets = sub
      ? ["xhr:" + sub]
      : args.key
        ? [args.key]
        : [...armed];
    const bpIds = breakpointIdsMap.get(tabId);
    const removed = [];
    for (const b of targets) {
      if (!armed.has(b)) continue;
      if (b.startsWith("xhr:")) {
        try {
          await cdpCall(tabId, "DOMDebugger.removeXHRBreakpoint", {
            url: b.slice(4),
          });
        } catch (e) {}
      } else {
        // fn:/url: 断点按 breakpointId 移除
        const bpId = bpIds && bpIds.get(b);
        if (bpId) {
          try {
            await cdpCall(tabId, "Debugger.removeBreakpoint", {
              breakpointId: bpId,
            });
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
      // UX-20: 说清"要先设断点再触发"，别让 AI 以为是暂时性故障空转重试
      const armed = [...(armedBreakpointsMap.get(tabId) || [])];
      throw new ToolError(
        "NOT_PAUSED",
        "page is not paused at a breakpoint — " +
          (armed.length
            ? `breakpoints are armed (${armed.join(", ")}) but nothing has hit ` +
              "them yet; trigger the code path (click/evaluate) first"
            : "arm one with break_function / break_xhr, then trigger the code path"),
        false,
      );
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
            tabId,
            scope.object.objectId,
            propLimit,
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
    // BUG-65: 默认 NOT auto-resume。AI 工作流是 read → inspect → continue/step，
    // 自动 resume 打断了断点检查。显式 auto_resume=true 才 resume。
    if (args.auto_resume === true) {
      try {
        await cdpCall(tabId, "Debugger.resume");
        resumed = true;
      } catch (e) {}
    }
    return { tabId, reason: paused.reason, frames, resumed };
  },

  async resume(args) {
    const tabId = await resolveTabId(args);
    // BUG-65: guard against double-resume — Debugger.resume when not paused
    // throws an INTERNAL error that confuses AI.
    if (!pausedState.has(tabId)) {
      // UX-20/84: 说清"没断住"和下一步，别让 AI 以为是暂时性故障反复重试
      throw new ToolError(
        "NOT_PAUSED",
        "page is not paused at a breakpoint; nothing to resume " +
          "(arm one with break_function / break_xhr, then trigger it)",
        false,
      );
    }
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
      // UX-68: 带合法值（原来 ${Object.keys(map)} 靠隐式 toString，读着像数组）
      throw new ToolError(
        "BAD_ARGS",
        `step: bad action: ${args.action} (valid: ${Object.keys(map).join("|")})`,
        false,
      );
    }
    // UX-20: 未断住时 step 会撞裸 CDP 错误
    if (!pausedState.has(tabId)) {
      throw new ToolError(
        "NOT_PAUSED",
        "page is not paused at a breakpoint; cannot step " +
          "(arm one with break_function / break_xhr, then trigger it)",
        false,
      );
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
    // UX-22/207: console_stream 只是开关，事件从 daemon_hook_logs 取 ——
    // 描述里没说，AI 会去找一个并不存在的 events 工具。
    return {
      tabId,
      consoleStream: on,
      _hint: on
        ? 'console events are polled via daemon.hook_logs({source:"console"}), ' +
          "not pushed through this tool"
        : undefined,
    };
  },

  // ---- 宏工具：一键证据包 ----

  async capture_request(args) {
    const tabId = await resolveTabId(args);
    if (!args.url_pattern) {
      throw new ToolError(
        "BAD_ARGS",
        "capture_request: url_pattern is required",
      );
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
        `no request matching ${args.url_pattern} within timeout`,
        true,
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
      (k) =>
        args[k] !== undefined &&
        args[k] !== null &&
        args[k] !== false &&
        args[k] !== "",
    );
    if (given.length !== 1) {
      // UX-232/141/205: wait_user 用 condition:"…"，wait_for 用四选一的具名参数。
      // AI 常把 wait_user 的写法套到 wait_for 上，原来只报"四选一"不说错在哪。
      const misused = ["condition", "state_", "wait_until", "event"].filter(
        (k) => args[k] !== undefined,
      );
      throw new ToolError(
        "BAD_ARGS",
        "wait_for: pass exactly one of selector|text|url_pattern|network_idle" +
          (misused.length
            ? ` (got ${misused.join(",")} — that is wait_user's shape; ` +
              "wait_for takes the condition as a named parameter)"
            : given.length > 1
              ? ` (got ${given.join(",")})`
              : " (got none)"),
        false,
      );
    }
    const kind = given[0];
    const state = args.state || "visible";
    if (kind === "selector" && !["visible", "attached"].includes(state)) {
      // UX-68: 枚举报错带合法值
      throw new ToolError(
        "BAD_ARGS",
        `wait_for: bad state: ${state} (valid: visible|attached)`,
        false,
      );
    }
    const timeoutMs = Math.min(args.timeout_ms || 10000, 110000);
    const idleMs = args.idle_ms || 500;
    const start = Date.now();
    const deadline = start + timeoutMs;
    const elapsedMs = () => Date.now() - start;

    if (kind === "network_idle") {
      // BUG-38: 老实现把 buffer 里所有 !finished && !failed 都算在飞，于是
      // WebSocket/SSE 这种长连接、以及永远收不到 loadingFinished 的后台请求，
      // 会让 network_idle 在任何页面上都超时（example.com 也不例外）。
      // 现在：长连接类型直接不算，且超过 stale_ms 还没收尾的请求视为僵尸。
      const STREAMING = new Set(["websocket", "eventsource", "media", "manifest"]);
      const staleMs = Math.max(args.stale_ms || 15000, 1000);
      await ensureNetwork(tabId);
      let idleSince = null;
      while (Date.now() < deadline) {
        let inflight = 0;
        const now = Date.now();
        for (const rec of getBuffer(tabId).values()) {
          if (rec.finished || rec.failed) continue;
          if (STREAMING.has(String(rec.type || "").toLowerCase())) continue;
          const startedMs = rec.startedAt || rec.wallTime * 1000 || 0;
          if (startedMs && now - startedMs > staleMs) continue; // 僵尸请求
          inflight++;
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
              return {
                tabId,
                condition: kind,
                elapsedMs: elapsedMs(),
                url: tab.url,
              };
            }
          } else {
            const expression =
              kind === "selector"
                ? `(() => { ${DEEP_QUERY_FN}` +
                  ` const el = __owbDeepQuery(${JSON.stringify(args.selector)});` +
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
                tabId,
                condition: kind,
                elapsedMs: elapsedMs(),
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
      // UX-2/66/112: retryable=true 不带退避指引会诱导原地死循环重试
      `wait_for: ${kind} condition not met within ${timeoutMs}ms — ` +
        "do NOT retry with the same timeout_ms; either raise it " +
        "(max 110000), verify the condition is reachable " +
        "(read_page / network_list), or trigger the action that satisfies it",
      true,
    );
  },

  // ---- 读页：snapshot（稳定 ref）/ article / text ----

  async read_page(args) {
    const tabId = await resolveTabId(args);
    const mode = args.mode || "snapshot";
    if (!["snapshot", "article", "text"].includes(mode)) {
      // UX-68: 枚举报错带合法值
      throw new ToolError(
        "BAD_ARGS",
        `read_page: bad mode: ${mode} (valid: snapshot|article|text)`,
        false,
      );
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
        tabId,
        mode,
        text: text.length > maxChars ? text.slice(0, maxChars) : text,
        truncated: text.length > maxChars,
      };
    }

    if (mode === "article") {
      const v = (await evaluateJs(tabId, READ_PAGE_ARTICLE_EXPR)) || {
        title: "",
        content: "",
      };
      const full = v.content || "";
      return {
        tabId,
        mode,
        title: v.title,
        // UX-104/198/36: 三种模式的正文字段名各不相同（content/text/nodes），
        // AI 得按模式切字段。统一附一份 text 别名，字段名不再是陷阱。
        content: full.length > maxChars ? full.slice(0, maxChars) : full,
        text: full.length > maxChars ? full.slice(0, maxChars) : full,
        length: full.length,
        truncated: full.length > maxChars,
        // UX-138: 截断了却不说截了多少
        omitted: full.length > maxChars ? full.length - maxChars : undefined,
        root: v.root,
        reason: v.reason, // BUG-51/UX-199: 空正文要说明原因，不是静默空串
      };
    }

    // snapshot：页面表达式算好 nodes/line/hash，增量比对在扩展侧做
    const maxNodes = Math.min(Math.max(args.max_nodes || 400, 1), 2000);
    const nextRef = readPageNextRef.get(tabId) || 1;
    let v = (await evaluateJs(
      tabId,
      READ_PAGE_SNAPSHOT_EXPR(nextRef, maxNodes),
    )) || { nodes: [], nextRef };
    // BUG-72: 页面有候选元素、却因全部零尺寸被过滤光 —— 这是「tab 在后台没绘制」
    // 的特征（Chrome 不给后台 tab 做布局），不是「页面真的空」。静默返回空快照
    // 会让 AI 以为页面没内容而走错路。前台化一次重试，并在结果里说明发生了什么。
    let renderNote = null;
    if (!v.nodes.length && v.skippedNoRect > 0) {
      try {
        await cdpCall(tabId, "Page.bringToFront");
        await new Promise((r) => setTimeout(r, 250));
        const again = await evaluateJs(
          tabId,
          READ_PAGE_SNAPSHOT_EXPR(nextRef, maxNodes),
        );
        if (again && again.nodes.length) {
          v = again;
          renderNote =
            `tab was not being rendered (all ${v.skippedNoRect || 0} candidate ` +
            "elements had zero layout boxes); brought it to front and re-read";
        }
      } catch (e) {}
      if (!renderNote) {
        // BUG-96: bringToFront 只能把 tab 切成它自己窗口里的激活页，管不到
        // Chrome 窗口本身有没有操作系统级焦点——重试已经做过、失败了，原来的
        // "Activate the tab and retry" 建议听起来像还有没试过的招，实际上
        // 刚试过。查一下 visibilityState，分清"重试后依然 hidden（大概率是
        // 窗口没有系统焦点，用户要切过去，重试没用）"和"重试后已经 visible
        // 但还是没元素（大概率是页面真的空/内容被 CSS 隐藏）"，给出对应
        // 的下一步而不是笼统一句话。
        let stillHidden = null;
        try {
          stillHidden = (await evaluateJs(tabId, "document.visibilityState")) === "hidden";
        } catch (e) {}
        renderNote = stillHidden
          ? `page has ${v.candidates || 0} candidate elements but all were skipped ` +
            "for zero layout boxes, and the tab is still visibilityState=hidden after " +
            "bringToFront + retry — this usually means the Chrome *window* itself " +
            "doesn't have OS-level focus (covered by another window), which " +
            "bringToFront cannot fix. Retrying won't help; ask the user to switch to " +
            "that browser window."
          : `page has ${v.candidates || 0} candidate elements but all were skipped ` +
            "for zero layout boxes — content is likely hidden by CSS or the page is " +
            "genuinely near-empty (also check for a bot-block/interstitial response).";
      }
    }
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
        if (old === undefined) {
          stats.added++;
          kept.push(n);
        } else if (old !== n.hash) {
          stats.changed++;
          kept.push(n);
        } else {
          stats.unchanged++;
        }
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
      tabId,
      mode,
      url: v.url,
      title: v.title,
      lines,
      // UX-198/36/104: 三模式字段名不同（lines/content/text），AI 必须按模式
      // 切字段。统一附 text 别名。
      text: lines,
      nodes,
      count: nodes.length,
      truncated,
      // UX-121/6: truncated=true 不说被截了多少，AI 无从判断要不要调大 max_nodes
      totalNodes: v.nodes ? v.nodes.length : nodes.length,
      omittedNodes:
        v.truncated || nodes.length < (v.nodes || []).length
          ? "raise max_nodes (default 400, max 2000) or narrow with since_last"
          : undefined,
      refsAssigned: v.refsAssigned,
      // BUG-72: 空快照/渲染异常时说明原因，不让 AI 面对无解释的空结果
      renderNote: renderNote || undefined,
      // BUG-79: 剔除了多少个「其他扩展注入的悬浮 UI」元素
      extensionUiHidden: v.extensionUi || undefined,
      // UX-214: 快照里有多少内容来自 shadow DOM（0 = 该页没用 Web Component）
      shadowRoots: v.shadowRoots || undefined,
      // UX-100: iframe 的存在必须让 AI 知道，否则找不到的元素永远找不到
      iframes: v.iframes && v.iframes.length ? v.iframes : undefined,
      ...(stats ? { stats } : {}),
      // UX-218/32: since_last 的增删统计藏在 stats 里，顶层看不到
      ...(stats ? { added: stats.added, changed: stats.changed,
                    removed: stats.removed, unchanged: stats.unchanged } : {}),
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
      return {
        cleared: true,
        title: t.title,
        groupId: t.groupId,
        tabIds,
        tabCount: tabIds.length,
      };
    }
    if (!args.title) {
      throw new ToolError(
        "BAD_ARGS",
        "task_context: title is required (use action: clear to end a task)",
        false,
      );
    }
    currentTask = { title: String(args.title), groupId: null };
    return { taskSet: true, title: currentTask.title };
  },

  // ---- 真实鼠标与人机交接 ----
  // mouse_click：Input.dispatchMouseEvent 走真实输入管线（isTrusted=true，
  // 触发 hover/focus/dblclick 等副作用），配合 AI 光标动画让操作对用户可见。

  async mouse_click(args) {
    const tabId = await resolveTabId(args);
    // UX-231: canvas/地图/画布上要按坐标点，原来强制 selector|ref
    const hasCoords = args.x != null && args.y != null;
    const target = resolveTargetSelector(args, "mouse_click", !hasCoords);
    const button = args.button || "left";
    if (!["left", "right", "middle"].includes(button)) {
      throw new ToolError(
        "BAD_ARGS",
        `mouse_click: bad button: ${button} (valid: left|right|middle)`,
        false,
      );
    }
    const clickCount = Math.min(
      Math.max(parseInt(args.click_count, 10) || 1, 1),
      2,
    );
    await ensureAttached(tabId);
    let v;
    if (target) {
      // 元素中心点（视口坐标）：scrollIntoView 后取 getBoundingClientRect
      const found = await cdpCall(tabId, "Runtime.evaluate", {
        expression: elementSnippet(
          target.selector,
          `const r = el.getBoundingClientRect();` +
            ` return { x: r.x + r.width / 2, y: r.y + r.height / 2,` +
            ` tag: el.tagName, text: String(el.innerText || el.value || "").slice(0, 80) };`,
        ),
        returnByValue: true,
      });
      v = found.result && found.result.value;
      if (!v) targetNotFound(target, "mouse_click");
    } else {
      v = { x: Number(args.x), y: Number(args.y), tag: null, text: null };
    }
    const x = v.x,
      y = v.y;
    // BUG-35: bring tab to front — cursor animation uses requestAnimationFrame
    // which is suspended in background tabs, causing permanent hang.
    try {
      await cdpCall(tabId, "Page.bringToFront");
    } catch (e) {}
    // AI 光标：ensure 覆盖层（幂等）→ 贝塞尔移动动画（~450ms，await 到位再点）
    await evaluateJs(tabId, CURSOR_OVERLAY_EXPR, { returnByValue: false });
    await evaluateJs(tabId, `window.__owbCursor.moveTo(${x}, ${y}, 450)`, {
      awaitPromise: true,
    });
    // 真实鼠标事件序列：moved → pressed → released（双击再来一轮 clickCount=2）
    await cdpCall(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
    });
    for (let i = 1; i <= clickCount; i++) {
      await cdpCall(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button,
        clickCount: i,
      });
      await cdpCall(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button,
        clickCount: i,
      });
    }
    // 涟漪反馈（fire-and-forget）
    cdpCall(tabId, "Runtime.evaluate", {
      expression: `window.__owbCursor.clickFx()`,
      returnByValue: false,
    }).catch(() => {});
    return {
      tabId,
      x,
      y,
      button,
      clicked: target ? target.ref || target.selector : `(${x},${y})`,
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
      throw new ToolError(
        "BAD_ARGS",
        // UX-68: 枚举报错带合法值
        `wait_user: bad condition: ${condition} (valid: url_change|selector|text)`,
        false,
      );
    }
    if (condition === "selector" && !args.selector) {
      throw new ToolError(
        "BAD_ARGS",
        "wait_user: selector is required when condition=selector",
        false,
      );
    }
    if (condition === "text" && !args.text) {
      throw new ToolError(
        "BAD_ARGS",
        "wait_user: text is required when condition=text",
        false,
      );
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
            return await resolveWaitUser(
              tabId,
              condition,
              tab.url || "",
              elapsedMs(),
              clear,
            );
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
            return await resolveWaitUser(
              tabId,
              condition,
              tab.url || "",
              elapsedMs(),
              clear,
            );
          }
        }
      } catch (e) {
        // 导航途中 execution context 销毁等瞬态错误：继续轮询到 deadline
      }
      await sleep(500);
    }
    throw new ToolError(
      "TIMEOUT",
      // UX-102/111/179: 同上，外加"用户可能压根没看到交接提示"这条真实原因
      `wait_user: ${condition} condition not met within ${timeoutMs}ms — ` +
        "the user may not have acted yet; do NOT retry immediately. " +
        "Check the tab with read_page/screenshot, call handoff again with a " +
        "clearer reason, or raise timeout_ms (also raise the MCP timeout " +
        "param to timeout_ms/1000 + 10)",
      true,
    );
  },

  // ---- Fetch 域脚本改写与监视 ----

  async script_patch(args) {
    const tabId = await resolveTabId(args);
    if (!args.url_pattern) {
      throw new ToolError(
        "BAD_ARGS",
        "script_patch: url_pattern is required (CDP glob)",
      );
    }
    // UX-78: 兼收 type 别名。原来传 type:"proxy_probe" 会被静默当成默认
    // prepend——AI 拿到 ok=true 却没得到想要的行为（假成功同类）。
    const type = args.patch_type || args.type || "prepend";
    if (!["prepend", "proxy_probe"].includes(type)) {
      // UX-68: 枚举报错必须带合法值，否则 AI 只能试错
      throw new ToolError(
        "BAD_ARGS",
        `script_patch: bad patch_type: ${type} (valid: prepend|proxy_probe)`,
        false,
      );
    }
    if (type === "prepend" && !args.code) {
      throw new ToolError(
        "BAD_ARGS",
        "script_patch: code is required for prepend",
      );
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
    return {
      tabId,
      patch: { id: entry.id, pattern: entry.pattern, type: entry.type },
    };
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
      throw new ToolError(
        "BAD_ARGS",
        "watch_script: url_pattern is required (CDP glob)",
      );
    }
    // UX-83: 兼收 event 别名（工具名叫 watch_script，AI 惯性传 event）
    const action = args.action || args.event || "notify";
    if (action === "patch") {
      // 声明式"命中即改写"等价于直接注册 Fetch 改写
      return await tools.script_patch({
        tabId,
        url_pattern: args.url_pattern,
        patch_type: args.patch_type || args.type || "proxy_probe",
        code: args.code,
      });
    }
    if (action !== "notify") {
      // UX-68: 带合法值
      throw new ToolError(
        "BAD_ARGS",
        `watch_script: bad action: ${action} (valid: notify|patch)`,
        false,
      );
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
    return {
      tabId,
      watcher: { id: entry.id, pattern: entry.pattern, action: "notify" },
    };
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
        throw new ToolError(
          "BAD_TAB",
          `close_tab: tab not found: ${tabId}`,
          false,
        );
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
          `close_tab: tab ${tabId} is not in an OWB-managed group ` +
            `("${OWB_GROUP_TITLE}" / "${HANDOFF_GROUP_TITLE}" / "task: " prefix); ` +
            "refusing to close a user tab — pass force: true to override",
          false,
        );
      }
    }
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      // UX-177: force 模式下不存在的 tab 会漏出原始 Chrome 错误
      const msg = String(e && e.message ? e.message : e);
      throw new ToolError(
        "BAD_TAB",
        /no tab with id/i.test(msg)
          ? `close_tab: no tab with id ${tabId} (already closed?) — ` +
            "call list_tabs for live tabIds"
          : `close_tab: ${msg}`,
        false,
      );
    }
    return { tabId, closed: true };
  },

  async screenshot(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    // BUG-63: validate format explicitly — invalid values used to silently fall
    // back to png, giving AI false success.
    const format = (args.format || "png").toLowerCase();
    if (!["png", "jpeg"].includes(format)) {
      throw new ToolError(
        "BAD_ARGS",
        `screenshot: format must be 'png' or 'jpeg' (got: ${args.format})`,
        false,
      );
    }
    const params = { format };
    if (format === "jpeg") {
      params.quality = Math.min(
        Math.max(parseInt(args.quality, 10) || 80, 1),
        100,
      );
    }
    // full_page：captureBeyondViewport 截整页（不指定 clip 时）
    if (args.full_page) {
      // BUG-61: captureBeyondViewport alone hangs on Chrome 150.
      // Measure full document dimensions and use explicit clip + captureBeyondViewport.
      const dimRes = await cdpCall(tabId, "Runtime.evaluate", {
        expression:
          `JSON.stringify({` +
          `w: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),` +
          `h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)` +
          `})`,
        returnByValue: true,
      });
      const dims = dimRes.result && JSON.parse(dimRes.result.value);
      if (dims && dims.w > 0 && dims.h > 0) {
        params.clip = { x: 0, y: 0, width: dims.w, height: dims.h, scale: 1 };
      }
      params.captureBeyondViewport = true;
    }
    const target = resolveTargetSelector(args, "screenshot", false);
    if (target) {
      const res = await cdpCall(tabId, "Runtime.evaluate", {
        expression: elementSnippet(
          target.selector,
          `const r = el.getBoundingClientRect();` +
            ` return { x: r.x, y: r.y, width: r.width, height: r.height };`,
        ),
        returnByValue: true,
      });
      const rect = res.result && res.result.value;
      if (!rect) targetNotFound(target, "screenshot");
      // UX-12: 0 宽/高元素传给 CDP 会回一句原始协议错误，AI 看不懂
      if (!(rect.width > 0 && rect.height > 0)) {
        throw new ToolError(
          "ELEMENT_NOT_VISIBLE",
          `screenshot: ${target.selector} has zero size ` +
            `(${rect.width}x${rect.height}) — it is hidden or not laid out; ` +
            "scroll it into view or wait_for {state:'visible'} first",
          true,
        );
      }
      params.clip = { ...rect, scale: 1 };
    }
    const shot = await cdpCall(tabId, "Page.captureScreenshot", params);
    return {
      tabId,
      format,
      data: shot.data,
      dataLength: shot.data.length,
      // UX-96: base64 在 data 字段，不是 base64 字段 —— 返回里点一句
      encoding: "base64",
    };
  },

  // 开发用：让扩展重载自己。改完 background.js 不必再去 chrome://extensions
  // 手点重载——那一步在开发循环里出现得太频繁，且 AI 无法代劳（扩展管理页
  // 禁止被 debugger 附着）。重载会重启 SW，本次调用的响应可能来不及送达，
  // 因此先回包再重载。
  async reload_extension() {
    setTimeout(() => {
      try { chrome.runtime.reload(); } catch (e) {}
    }, 150);
    return {
      reloading: true,
      note: "extension is restarting; the WS will drop and reconnect within a few seconds",
    };
  },

  // 逃生舱：任意 CDP 方法直通，新能力不用等扩展发版。
  // 高危方法（Fetch.enable 跳过 fail-safe 等）由调用方自负。
  async cdp(args) {
    const tabId = await resolveTabId(args);
    if (!args.method) {
      throw new ToolError("BAD_ARGS", "cdp: method is required", false);
    }
    await ensureAttached(tabId);
    const result = await cdpCall(tabId, args.method, args.params || {});
    // UX-79: chrome.debugger 对某些域（Security/Target…）返回空/undefined 而不
    // 抛错，工具照样 ok=true —— AI 拿到 {ok:false} 却没有 error 可读。
    if (result === undefined || result === null) {
      throw new ToolError(
        "CDP_EMPTY",
        `cdp: ${args.method} returned no result — the domain is likely not ` +
          "reachable from chrome.debugger (Browser/Target/Security are " +
          "commonly blocked) or needs its domain enabled first",
        false,
      );
    }
    // UX-134: Runtime.evaluate 经逃生舱调用时，异常藏在 result.exceptionDetails
    // 里而工具仍报 ok=true。把它抬到工具层。
    if (result.exceptionDetails) {
      throw new ToolError(
        "EVAL_EXCEPTION",
        `cdp ${args.method}: ` +
          result.exceptionDetails.text +
          (result.exceptionDetails.exception
            ? `: ${result.exceptionDetails.exception.description || ""}`
            : ""),
        false,
      );
    }
    return { tabId, method: args.method, result };
  },

  async click(args) {
    const tabId = await resolveTabId(args);
    const target = resolveTargetSelector(args, "click");
    await ensureAttached(tabId);
    const res = await cdpCall(tabId, "Runtime.evaluate", {
      expression: elementSnippet(
        target.selector,
        // BUG-24: disabled 元素 .click() 是 no-op，原来照样返回 ok=true
        `if (el.disabled || el.getAttribute("aria-disabled") === "true") {` +
          `   return { __disabled: true, tag: el.tagName };` +
          ` }` +
          ` const urlBefore = location.href;` +
          ` el.click();` +
          ` return { tag: el.tagName, urlBefore,` +
          `   text: String(el.innerText || el.value || "").slice(0, 80) };`,
      ),
      returnByValue: true,
    });
    // UX-81: 不看 exceptionDetails，任何 JS 异常都会被误报成 REF_STALE/NOT_FOUND
    if (res.exceptionDetails) {
      throw new ToolError(
        "EVAL_EXCEPTION",
        `click failed on ${target.selector}: ` +
          res.exceptionDetails.text +
          (res.exceptionDetails.exception
            ? `: ${res.exceptionDetails.exception.description || ""}`
            : ""),
        false,
      );
    }
    const v = res.result && res.result.value;
    if (!v) targetNotFound(target, "click");
    if (v.__disabled) {
      throw new ToolError(
        "ELEMENT_DISABLED",
        `click: ${target.selector} is disabled — the click would be a no-op ` +
          "(fill the required fields first, or wait_for the element to enable)",
        true,
      );
    }
    // UX-46: click 成功 ≠ 发生导航。AI 用"url 变了"判断成功会误判（站点可能
    // 新开 tab、被拦截、或走 SPA 路由）。这里直接给结论。
    let urlAfter = v.urlBefore;
    try {
      const after = await cdpCall(tabId, "Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      });
      urlAfter = (after.result && after.result.value) || urlAfter;
    } catch (e) {}
    const navigated = urlAfter !== v.urlBefore;
    const out = {
      tabId,
      clicked: target.selector,
      ...(target.ref ? { ref: target.ref } : {}),
      tag: v.tag,
      text: v.text,
      navigated,
      url: urlAfter,
    };
    if (!navigated) {
      out._hint =
        "the click dispatched but the URL did not change — this is normal for " +
        "in-page actions; if you expected navigation it may have opened a new " +
        "tab (list_tabs), been intercepted, or be an SPA route change " +
        "(use wait_for {url_pattern} or read_page since_last to confirm)";
    }
    return out;
  },

  async fill(args) {
    const tabId = await resolveTabId(args);
    const target = resolveTargetSelector(args, "fill");
    // BUG-94: value 缺失（调用方拼错参数名、或 CLI 用法错误漏传）时，下面的表达式
    // 会把 `args.value != null ? args.value : ""` 悄悄当成清空字段处理——字段
    // 被清空、change 事件正常触发、fill 报 filled:true/actual:""，看起来完全
    // 正常，调用方以为自己填成功了。区分"显式传空串清空字段"（合法）和
    // "根本没传 value"（几乎总是调用方的错）：只拒后者。
    if (args.value === undefined || args.value === null) {
      throw new ToolError(
        "BAD_ARGS",
        'fill: value is required (pass value:"" to explicitly clear the field)',
        false,
      );
    }
    await ensureAttached(tabId);
    const res = await cdpCall(tabId, "Runtime.evaluate", {
      expression: elementSnippet(
        target.selector,
        `el.focus();` +
          ` const value = ${JSON.stringify(String(args.value != null ? args.value : ""))};` +
          ` const type = (el.getAttribute("type") || "").toLowerCase();` +
          // BUG-23: checkbox/radio 没有可写的 value 语义，写 value 是静默无效；
          // 这类元素要动 .checked。
          ` if (el.tagName === "INPUT" && (type === "checkbox" || type === "radio")) {` +
          `   const want = !/^(false|0|off|no|unchecked|)$/i.test(value);` +
          `   const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked").set;` +
          `   setter.call(el, want);` +
          `   el.dispatchEvent(new Event("input", { bubbles: true }));` +
          `   el.dispatchEvent(new Event("change", { bubbles: true }));` +
          `   return { tag: el.tagName, type, checked: el.checked, value: el.value };` +
          ` }` +
          ` if (el.isContentEditable) {` +
          `   el.textContent = value;` +
          `   el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));` +
          `   el.dispatchEvent(new Event("change", { bubbles: true }));` +
          `   return { tag: el.tagName, contentEditable: true, value: el.textContent };` +
          ` }` +
          // UX-99: 不可填元素（div/span/a…）原来落到 NOT_FOUND，AI 一头雾水
          ` const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype` +
          `   : el.tagName === "SELECT" ? HTMLSelectElement.prototype` +
          `   : el.tagName === "INPUT" ? HTMLInputElement.prototype : null;` +
          ` if (!proto) { return { __notFillable: true, tag: el.tagName, role: el.getAttribute("role") }; }` +
          ` Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);` + // native setter 绕 React 受控组件
          ` el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));` +
          ` el.dispatchEvent(new Event("change", { bubbles: true }));` +
          // 回读：<select> 传了不存在的 option 时 value 会保持原值 —— 假成功
          ` return { tag: el.tagName, type, value, actual: el.value };`,
      ),
      returnByValue: true,
    });
    // UX-81: fill 不查 exceptionDetails，任何 JS 异常都变成误导性的 REF_STALE
    if (res.exceptionDetails) {
      throw new ToolError(
        "EVAL_EXCEPTION",
        `fill failed on ${target.selector}: ` +
          res.exceptionDetails.text +
          (res.exceptionDetails.exception
            ? `: ${res.exceptionDetails.exception.description || ""}`
            : ""),
        false,
      );
    }
    const v = res.result && res.result.value;
    if (!v) targetNotFound(target, "fill");
    if (v.__notFillable) {
      throw new ToolError(
        "NOT_FILLABLE",
        `fill: ${target.selector} is a <${String(v.tag).toLowerCase()}>` +
          (v.role ? ` (role=${v.role})` : "") +
          " — not an input/textarea/select and not contenteditable. " +
          "Use click for buttons/links, or target the inner editable element.",
        false,
      );
    }
    // BUG-34 同类：<select> 传不存在的 option 会静默保持原值
    if (v.actual !== undefined && v.actual !== v.value) {
      throw new ToolError(
        "FILL_REJECTED",
        `fill: ${target.selector} kept "${v.actual}" instead of "${v.value}"` +
          (v.tag === "SELECT"
            ? " — <select> only accepts an existing option value; " +
              "call read_page to list the options"
            : " — the page rejected or rewrote the value"),
        false,
      );
    }
    return {
      tabId,
      filled: target.selector,
      ...(target.ref ? { ref: target.ref } : {}),
      ...v,
    };
  },

  async send_keys(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    // BUG-58: bring tab to front — Input.dispatchKeyEvent is silently dropped
    // when the tab lacks OS focus. Page.bringToFront ensures focus.
    try {
      await cdpCall(tabId, "Page.bringToFront");
    } catch (e) {}
    // UX-31/167: text 和 keys 同时给时另一个被静默丢弃，AI 以为两段都发了
    const hasText = args.text != null && args.text !== "";
    const hasKeys = args.keys != null && String(args.keys).trim() !== "";
    if (hasText && hasKeys) {
      throw new ToolError(
        "BAD_ARGS",
        "send_keys: pass either text or keys, not both " +
          "(text goes through Input.insertText, keys through real key events; " +
          "call the tool twice if you need both)",
        false,
      );
    }
    if (hasText) {
      await cdpCall(tabId, "Input.insertText", { text: String(args.text) });
      return { tabId, inserted: String(args.text).length };
    }
    const keys = String(args.keys || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!keys.length) {
      throw new ToolError(
        "BAD_ARGS",
        "send_keys: text or keys is required (one of the two)",
        false,
      );
    }
    const KEYMAP = {
      Enter: { vk: 13, text: "\r" },
      Tab: { vk: 9 },
      Escape: { vk: 27 },
      Backspace: { vk: 8 },
      Delete: { vk: 46 },
      Home: { vk: 36 },
      End: { vk: 35 },
      PageUp: { vk: 33 },
      PageDown: { vk: 34 },
      ArrowLeft: { vk: 37 },
      ArrowUp: { vk: 38 },
      ArrowRight: { vk: 39 },
      ArrowDown: { vk: 40 },
      // UX-117: Space 一直不在表里，"按空格"这种最普通的操作做不了
      Space: { vk: 32, text: " ", code: "Space" },
      // UX-117: F1-F12
      ...Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [
          "F" + (i + 1),
          { vk: 112 + i, code: "F" + (i + 1) },
        ]),
      ),
    };
    // UX-165/30: 修饰键组合（Ctrl+A / Meta+C / Shift+Tab）完全不支持，
    // 全选、复制、反向 Tab 这些基本交互都做不出来。
    const MODBIT = { ctrl: 2, control: 2, alt: 1, shift: 8, meta: 4, cmd: 4, command: 4 };
    const codeOf = (ch) => {
      if (/^[a-z]$/i.test(ch)) return "Key" + ch.toUpperCase();
      if (/^[0-9]$/.test(ch)) return "Digit" + ch;
      return ch;
    };
    const pressed = [];
    for (const combo of keys) {
      const parts = combo.split("+");
      const keyName = parts.pop();
      let modifiers = 0;
      for (const m of parts) {
        const bit = MODBIT[m.toLowerCase()];
        if (!bit) {
          throw new ToolError(
            "BAD_ARGS",
            `send_keys: unknown modifier: ${m} ` +
              "(valid: Ctrl|Alt|Shift|Meta, e.g. \"Ctrl+a\" or \"Shift+Tab\")",
            false,
          );
        }
        modifiers |= bit;
      }
      let def = KEYMAP[keyName];
      // UX-166: 单字符键（a-z / 0-9）不被支持，AI 只能退回 text 模式，
      // 但 text 走 insertText 不产生真实按键事件（快捷键/热键场景失效）。
      if (!def && keyName.length === 1) {
        const upper = keyName.toUpperCase();
        def = {
          vk: upper.charCodeAt(0),
          text: modifiers & ~8 ? undefined : keyName, // 带 Ctrl/Alt/Meta 时不产字符
          code: codeOf(keyName),
          key: keyName,
        };
      }
      if (!def) {
        throw new ToolError(
          "BAD_ARGS",
          `send_keys: unknown key: ${keyName} ` +
            `(named keys: ${Object.keys(KEYMAP).join(" ")}; ` +
            "single characters and Ctrl+/Alt+/Shift+/Meta+ combos also work; " +
            "use the text param for free-form typing)",
          false,
        );
      }
      const base = {
        key: def.key || keyName,
        code: def.code || keyName,
        windowsVirtualKeyCode: def.vk,
        nativeVirtualKeyCode: def.vk,
        modifiers,
      };
      await cdpCall(tabId, "Input.dispatchKeyEvent", {
        type: def.text ? "keyDown" : "rawKeyDown",
        ...(def.text ? { text: def.text } : {}),
        ...base,
      });
      await cdpCall(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        ...base,
      });
      pressed.push(combo);
    }
    return { tabId, pressed };
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
      throw new ToolError(
        "BAD_ARGS",
        "cookie_set: name and value are required",
        false,
      );
    }
    const params = { name: args.name, value: String(args.value) };
    for (const k of [
      "url",
      "domain",
      "path",
      "secure",
      "httpOnly",
      "sameSite",
      "expires",
    ]) {
      if (args[k] !== undefined) params[k] = args[k];
    }
    // UX-94: CDP 静默丢弃非法 sameSite（返回 success:true 但 cookie 没这属性）
    if (params.sameSite !== undefined) {
      if (!["Strict", "Lax", "None"].includes(params.sameSite)) {
        throw new ToolError(
          "BAD_ARGS",
          `cookie_set: bad sameSite: ${params.sameSite} (valid: Strict|Lax|None)`,
          false,
        );
      }
    }
    // UX-206: expires 必须是 Unix 秒（double）。ISO 字符串直传会撞 CDP
    // "BINDINGS: double value expected" 的 INTERNAL 错误——这里先归一化。
    if (params.expires !== undefined) {
      let exp = params.expires;
      if (typeof exp === "string") {
        const ms = Date.parse(exp);
        if (Number.isNaN(ms)) {
          throw new ToolError(
            "BAD_ARGS",
            `cookie_set: bad expires: ${exp} ` +
              "(Unix seconds, or a Date-parseable string)",
            false,
          );
        }
        exp = ms / 1000;
      }
      exp = Number(exp);
      if (!Number.isFinite(exp)) {
        throw new ToolError(
          "BAD_ARGS",
          `cookie_set: bad expires: ${params.expires} (Unix seconds)`,
          false,
        );
      }
      params.expires = exp;
    } else if (args.expirationDate !== undefined) {
      // chrome.cookies API 的字段名，AI 常混用
      params.expires = Number(args.expirationDate);
    }
    if (!params.url && !params.domain) {
      const tab = await chrome.tabs.get(tabId);
      params.url = tab.url;
    }
    const res = await cdpCall(tabId, "Network.setCookie", params);
    if (!res.success) {
      throw new ToolError(
        "BAD_ARGS",
        "cookie_set: Network.setCookie rejected the cookie " +
          "(check the url/domain/sameSite combination; " +
          "sameSite=None requires secure=true)",
        false,
      );
    }
    return { tabId, success: true };
  },

  async cookie_delete(args) {
    const tabId = await resolveTabId(args);
    await ensureAttached(tabId);
    if (!args.name) {
      throw new ToolError("BAD_ARGS", "cookie_delete: name is required", false);
    }
    const params = { name: args.name };
    for (const k of ["url", "domain", "path"]) {
      if (args[k] !== undefined) params[k] = args[k];
    }
    if (!params.url && !params.domain) {
      const tab = await chrome.tabs.get(tabId);
      params.url = tab.url;
    }
    // BUG-52: cookie_get 回的 domain 带前导点（".example.com"），原样传回
    // Network.deleteCookies 匹配不上，删除静默失败（返回 ok，cookie 还在）。
    // 两种写法都删一遍。
    const variants = [params];
    if (params.domain && params.domain.startsWith(".")) {
      variants.push({ ...params, domain: params.domain.slice(1) });
    } else if (params.domain) {
      variants.push({ ...params, domain: "." + params.domain });
    }
    for (const p of variants) {
      await cdpCall(tabId, "Network.deleteCookies", p);
    }
    // 回读确认：删不掉要说出来，别报假成功
    let remaining = [];
    try {
      const check = await cdpCall(tabId, "Network.getCookies", {
        urls: params.url ? [params.url] : undefined,
      });
      remaining = (check.cookies || []).filter((c) => c.name === args.name);
    } catch (e) {}
    if (remaining.length) {
      throw new ToolError(
        "DELETE_FAILED",
        `cookie_delete: "${args.name}" still present after delete ` +
          `(domain=${remaining.map((c) => c.domain).join(",")}, ` +
          `path=${remaining.map((c) => c.path).join(",")}) — ` +
          "pass the exact domain/path from cookie_get",
        false,
      );
    }
    return { tabId, deleted: args.name, verified: true };
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
    let extensionScripts = 0;
    for (const s of reg.values()) {
      // UX-88: Debugger 会把同页运行的【其他扩展】的 content script 一起登记，
      // 在真实站点上常常淹没页面自己的脚本。默认剔除，include_extensions 可要回。
      if (!args.include_extensions && isExtensionUrl(s.url)) {
        extensionScripts++;
        continue;
      }
      if (re && !re.test(s.url || "")) continue;
      out.push(s);
    }
    // UX-82: script_patch 注册的活动改写在任何工具里都查不到，AI 无法审计
    const patches = (fetchPatchTabs.get(tabId) || []).map((p) => ({
      id: p.id, pattern: p.pattern, type: p.type,
    }));
    const watchers = (scriptWatchers.get(tabId) || []).map((w) => ({
      id: w.id, pattern: w.pattern, action: "notify",
    }));
    return {
      tabId,
      count: out.length,
      scripts: out,
      patches,
      watchers,
      extensionScriptsHidden: extensionScripts || undefined,
    };
  },

  async script_source(args) {
    const tabId = await resolveTabId(args);
    if (!args.script_id) {
      throw new ToolError(
        "BAD_ARGS",
        "script_source: script_id is required (get one from script_list)",
      );
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
    if (!args.query) {
      throw new ToolError("BAD_ARGS", "search_code: query is required", false);
    }
    await ensureDebugger(tabId);
    const reg = scriptRegistryMap.get(tabId) || new Map();
    const re = args.url_pattern ? toRegExp(args.url_pattern) : null;
    const limit = Math.min(args.limit || 50, 200);
    const matches = [];
    let extensionScripts = 0;
    for (const s of reg.values()) {
      if (matches.length >= limit) break;
      // UX-88: 不过滤时，HN 上搜 "fetch"、GitHub 上搜 "token" 命中的 10 条
      // 全部来自别的扩展的注入脚本，页面自己的代码一条都排不上。
      if (!args.include_extensions && isExtensionUrl(s.url)) {
        extensionScripts++;
        continue;
      }
      if (re && !re.test(s.url || "")) continue;
      try {
        const res = await cdpCall(tabId, "Debugger.searchInContent", {
          scriptId: s.scriptId,
          query: args.query,
          caseSensitive: !!args.case_sensitive,
          // UX-193: is_regex 从来没往下传，query 一直按字面量搜
          isRegex: !!(args.is_regex ?? args.isRegex),
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
        throw new ToolError(
          "NOT_FOUND",
          `function not found: ${args.function_path}`,
        );
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
      return {
        tabId,
        armed: key,
        breakpointId: bp.breakpointId,
        locations: bp.locations,
      };
    }
    throw new ToolError(
      "BAD_ARGS",
      "break_function: pass either function_path or (url_pattern + line_number)",
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
        error: {
          code: "UNKNOWN_TOOL",
          message: `unknown tool: ${name}`,
          retryable: false,
        },
      },
    });
    return;
  }

  try {
    const data = await handler(args);
    send({ type: "tool_result", requestId, payload: { ok: true, data } });
  } catch (e) {
    // 统一归类：裸 CDP 错误在这里变成带 code/retryable/下一步的可操作错误
    const te = toToolError(e);
    const err = { code: te.code, message: te.message, retryable: te.retryable };
    send({
      type: "tool_result",
      requestId,
      payload: { ok: false, error: err },
    });
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
