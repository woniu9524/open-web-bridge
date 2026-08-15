// popup：上半是实时连接状态（每 1.5s 轮询 SW），下半是「本地 / 中转」tab 配置。
// 保存写 chrome.storage.local，background.js 的 storage.onChanged 监听立即重连。
const $ = (id) => document.getElementById(id);

// 状态色：连通绿 / 过渡琥珀 / 断开红（浅底用深色调保证可读）。
// 拓扑连线、光点、状态灯、tab 小点都取这个色。
const STATE_COLOR = { live: "#0a7f52", pending: "#9f6000", broken: "#d63c2e" };

// ---------------------------------------------------------------------------
// 状态区
// ---------------------------------------------------------------------------

function render(s) {
  $("ver").textContent = "v" + (s.version || "");
  const relay = s.mode === "relay";

  // 状态判定：已连接 > 连接中/配对中/握手中 > 未连接
  // phase: live 全线连通 / pending 在建立 / broken 断开
  // reached: 拓扑上已点亮到哪一环（0 只有浏览器，1 到中转，2 到 daemon）
  let stateText, phase, reached, note = "";
  if (s.connected) {
    stateText = "Connected";
    phase = "live";
    reached = 2;
  } else if (s.wsState === 0) {
    stateText = "Connecting…";
    phase = "pending";
    reached = 0;
  } else if (s.wsState === 1) {
    // ws 已开但未 helloAcked：relay 等配对，否则等握手 ack
    const pairing = relay && !s.relayPaired;
    stateText = pairing ? "Pairing…" : "Handshaking…";
    phase = "pending";
    reached = 1;
    if (pairing) note = "Waiting for the daemon to join the relay with the same token";
  } else {
    stateText = "Not connected";
    phase = "broken";
    reached = 0;
    note = s.reconnectInMs > 0
      ? `Reconnecting in ${Math.round(s.reconnectInMs / 1000)}s`
      : relay ? "Check that the relay URL and token match on both ends" : "Check that the daemon is running on this machine";
  }

  document.body.className = phase;
  document.body.style.setProperty("--sc", STATE_COLOR[phase]);
  $("state").textContent = stateText;

  // 本地模式隐藏「中转」节点与第二段连线，只剩 浏览器 —— daemon
  $("nRelay").style.display = relay ? "" : "none";
  $("wireB").style.display = relay ? "" : "none";
  $("nRelay").className = "node" + (reached >= 1 ? " lit" : " dim");
  $("nDaemon").className = "node" + (reached >= 2 ? " lit" : " dim");
  // 连线：已打通的段跑光点；正在建立的那一段也跑（慢速）；断开时第一段画断口，
  // 其后的段画虚线。idx 0 = 浏览器→中转/daemon，1 = 中转→daemon。
  const wireCls = (idx) => {
    if (reached > idx) return "wire on";
    if (phase === "pending") return reached === idx ? "wire on" : "wire";
    if (phase === "broken") return reached === idx ? "wire cut" : "wire dash";
    return "wire";
  };
  $("wireA").className = wireCls(0);
  $("wireB").className = wireCls(1);

  const target = s.target || "—";
  $("target").textContent = target;
  $("target").title = target;
  if (relay && s.tokenMasked) note = note || "Token " + s.tokenMasked;
  $("note").textContent = note;
  $("note").style.display = note ? "block" : "none";

  // 实际生效的模式：对应 tab 前亮状态色小点
  $("tabLocal").classList.toggle("active", !relay);
  $("tabRelay").classList.toggle("active", relay);
}

async function refresh() {
  try {
    const s = await chrome.runtime.sendMessage({ cmd: "status" });
    if (s) render(s);
  } catch (e) {
    $("state").textContent = "Background not responding";
    document.body.className = "broken";
    document.body.style.setProperty("--sc", STATE_COLOR.broken);
  }
}

$("reconnect").addEventListener("click", async () => {
  $("reconnect").disabled = true;
  try { await chrome.runtime.sendMessage({ cmd: "reconnect" }); } catch (e) {}
  setTimeout(() => { $("reconnect").disabled = false; refresh(); }, 400);
});

// ---------------------------------------------------------------------------
// 模式 tab + 配置
// ---------------------------------------------------------------------------

function setTab(mode) {
  const relay = mode === "relay";
  $("tabLocal").setAttribute("aria-selected", String(!relay));
  $("tabRelay").setAttribute("aria-selected", String(relay));
  $("paneLocal").classList.toggle("on", !relay);
  $("paneRelay").classList.toggle("on", relay);
  msg("");
}

function msg(text, isErr) {
  $("msg").textContent = text;
  $("msg").className = isErr ? "err" : "";
}

$("tabLocal").addEventListener("click", () => setTab("local"));
$("tabRelay").addEventListener("click", () => setTab("relay"));

// 生成 32 字节随机 base64url Token
$("gen").addEventListener("click", () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  $("relayToken").value = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  msg("New token generated. Save, then copy it to the daemon.");
});

$("copy").addEventListener("click", async () => {
  const v = $("relayToken").value.trim();
  if (!v) return msg("Token is empty.", true);
  try {
    await navigator.clipboard.writeText(v);
    msg("Token copied.");
  } catch (e) {
    $("relayToken").select();
    msg("Copy failed — the text is selected, press Ctrl+C.", true);
  }
});

$("save").addEventListener("click", async () => {
  const relay = $("tabRelay").getAttribute("aria-selected") === "true";
  if (relay) {
    const relayUrl = $("relayUrl").value.trim();
    const relayToken = $("relayToken").value.trim();
    if (!relayUrl || !relayToken) return msg("Relay mode needs both a relay URL and a token.", true);
    if (!/^wss?:\/\//i.test(relayUrl)) return msg("The relay URL must start with wss://.", true);
    await chrome.storage.local.set({ relayUrl, relayToken });
  } else {
    // 切回本地：清空中转字段，使 background 的 relayMode 判定为 false
    const wsUrl = $("wsUrl").value.trim();
    if (wsUrl && !/^wss?:\/\//i.test(wsUrl)) return msg("The daemon address must start with ws://.", true);
    const patch = { relayUrl: "", relayToken: "" };
    if (wsUrl) patch.wsUrl = wsUrl;
    await chrome.storage.local.set(patch);
  }
  msg("Saved. Reconnecting…");
  setTimeout(refresh, 400);
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

(async () => {
  const stored = await chrome.storage.local.get(["wsUrl", "relayUrl", "relayToken"]);
  $("wsUrl").value = stored.wsUrl || "";
  $("relayUrl").value = stored.relayUrl || "";
  $("relayToken").value = stored.relayToken || "";
  // 初始 tab 与 background.js loadConfig 的模式判定一致：relayUrl + relayToken 齐备
  setTab(stored.relayUrl && stored.relayToken ? "relay" : "local");
})();

refresh();
setInterval(refresh, 1500);
