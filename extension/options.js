// options 页：配对 token / daemon 地址的读写。保存后 background.js 的
// storage.onChanged 监听会立即重读配置并重连。
const $ = (id) => document.getElementById(id);

(async () => {
  const stored = await chrome.storage.local.get(["wsUrl", "owbToken"]);
  $("token").value = stored.owbToken || "";
  $("wsUrl").value = stored.wsUrl || "";
})();

$("save").addEventListener("click", async () => {
  const token = $("token").value.trim();
  const wsUrl = $("wsUrl").value.trim();
  const patch = { owbToken: token };
  if (wsUrl) patch.wsUrl = wsUrl;
  else await chrome.storage.local.remove("wsUrl");
  await chrome.storage.local.set(patch);
  $("msg").textContent = "已保存，扩展正在重连。";
});
