// options 页：连接模式 + 各模式字段读写。保存后 background.js 的
// storage.onChanged 监听会立即重读配置并重连。
const $ = (id) => document.getElementById(id);

function setMode(mode) {
  const relay = mode === "relay";
  $("localPanel").classList.toggle("hidden", relay);
  $("relayPanel").classList.toggle("hidden", !relay);
  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.checked = r.value === mode;
  });
}

(async () => {
  const stored = await chrome.storage.local.get(["wsUrl", "relayUrl", "relayToken"]);
  $("wsUrl").value = stored.wsUrl || "";
  $("relayUrl").value = stored.relayUrl || "";
  $("relayToken").value = stored.relayToken || "";
  // 中转模式判定与 background.js loadConfig 一致：relayUrl+relayToken 齐备
  setMode(stored.relayUrl && stored.relayToken ? "relay" : "local");
})();

document.querySelectorAll('input[name="mode"]').forEach((r) => {
  r.addEventListener("change", () => setMode(r.value));
});

// 生成 32 字节随机 base64url Token
$("gen").addEventListener("click", () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  $("relayToken").value = b64;
  $("msg").textContent = "已生成新 Token，记得保存并同步到 daemon 端。";
});

$("save").addEventListener("click", async () => {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  if (mode === "relay") {
    const relayUrl = $("relayUrl").value.trim();
    const relayToken = $("relayToken").value.trim();
    if (!relayUrl || !relayToken) {
      $("msg").textContent = "中转模式需要填写中转 URL 和 Token。";
      return;
    }
    await chrome.storage.local.set({ relayUrl, relayToken });
  } else {
    // 切回本地：清空中转字段，使 relayMode 判定为 false
    const wsUrl = $("wsUrl").value.trim();
    const patch = { relayUrl: "", relayToken: "" };
    if (wsUrl) patch.wsUrl = wsUrl;
    await chrome.storage.local.set(patch);
  }
  $("msg").textContent = "已保存，扩展正在重连。";
});
