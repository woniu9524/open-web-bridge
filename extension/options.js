// options 页：daemon 地址的读写。保存后 background.js 的
// storage.onChanged 监听会立即重读配置并重连。
const $ = (id) => document.getElementById(id);

(async () => {
  const stored = await chrome.storage.local.get(["wsUrl"]);
  $("wsUrl").value = stored.wsUrl || "";
})();

$("save").addEventListener("click", async () => {
  const wsUrl = $("wsUrl").value.trim();
  if (wsUrl) {
    await chrome.storage.local.set({ wsUrl });
  } else {
    await chrome.storage.local.remove("wsUrl");
  }
  $("msg").textContent = "已保存，扩展正在重连。";
});
