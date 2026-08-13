// popup：查 SW 连接状态并渲染；每 1.5s 轮询保持实时。
const $ = (id) => document.getElementById(id);

function render(s) {
  $("ver").textContent = "v" + (s.version || "");
  const relay = s.mode === "relay";
  const modeEl = $("mode");
  modeEl.textContent = relay ? "中转" : "本地";
  modeEl.className = "badge " + (relay ? "relay" : "local");

  // 状态判定：已连接 > 连接中/配对中/握手中 > 未连接
  let stateText, dotCls, hint = "";
  if (s.connected) {
    stateText = "已连接";
    dotCls = "ok";
  } else if (s.wsState === 0) {
    stateText = "连接中…";
    dotCls = "wait";
  } else if (s.wsState === 1) {
    // ws 已开但未 helloAcked：relay 等配对，否则等握手 ack
    stateText = relay && !s.relayPaired ? "配对中…（等 daemon）" : "握手中…";
    dotCls = "wait";
  } else {
    stateText = "未连接";
    dotCls = "bad";
    if (s.reconnectInMs > 0) hint = `${Math.round(s.reconnectInMs / 1000)}s 后重连`;
  }
  $("state").textContent = stateText;
  $("dot").className = "dot " + dotCls;
  $("target").textContent = s.target || "—";

  const tokenRow = $("tokenRow");
  if (relay && s.tokenMasked) {
    tokenRow.style.display = "flex";
    $("token").textContent = s.tokenMasked;
  } else {
    tokenRow.style.display = "none";
  }
  $("hint").textContent = hint;
}

async function refresh() {
  try {
    const s = await chrome.runtime.sendMessage({ cmd: "status" });
    if (s) render(s);
  } catch (e) {
    $("state").textContent = "SW 未响应";
    $("dot").className = "dot bad";
  }
}

$("reconnect").addEventListener("click", async () => {
  $("reconnect").disabled = true;
  try { await chrome.runtime.sendMessage({ cmd: "reconnect" }); } catch (e) {}
  setTimeout(() => { $("reconnect").disabled = false; refresh(); }, 400);
});

$("options").addEventListener("click", async () => {
  try { await chrome.runtime.sendMessage({ cmd: "openOptions" }); } catch (e) {}
  window.close();
});

refresh();
setInterval(refresh, 1500);
