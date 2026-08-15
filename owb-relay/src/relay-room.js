/**
 * RelayRoom — Durable Object：按 token 配对的 WS 中转房间。
 *
 * 每个 token 对应一个 RelayRoom 实例（Worker 用 sha256(token) 当 DO id 寻址）。
 * 两端（extension / controller）带 ?role= 连入，DO 按 role 入槽；两个 role 齐了
 * 即向两端发 {type:"relay_paired"}，之后透明双向转发（纯字节管道，不解析协议）。
 *
 * 用 Hibernation API（acceptWebSocket + webSocketMessage/Close/Error 回调）：
 * 空闲等待配对/等消息期间 DO 休眠，几乎不烧 CPU——relay 大部分时间是空闲，
 * 这对免费额度极友好。
 *
 * 同 role 重连（如扩展 SW 重启）：关闭旧槽、入新槽、重新评估配对。
 * 任一端断开：断开对端、清槽。
 */

const ROLE_EXT = "extension";
const ROLE_CTL = "controller";

export class RelayRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // DO 内未捕获异常同样只会外化成无线索的 internal error——这里 catch 住
  // 打印真实堆栈（wrangler tail 可见），错误信息带回响应体。
  async fetch(request) {
    try {
      return await this._fetch(request);
    } catch (e) {
      console.log("RelayRoom uncaught:", (e && e.stack) || String(e));
      return new Response("relay room error: " + ((e && e.message) || e) + "\n", { status: 500 });
    }
  }

  async _fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    if (role !== ROLE_EXT && role !== ROLE_CTL) {
      return new Response("bad or missing role", { status: 400 });
    }
    const other = role === ROLE_EXT ? ROLE_CTL : ROLE_EXT;

    // 同 role 顶替：关闭该 role 已有连接（兼容 SW 重启重连）。
    // DO 单线程串行，无并发竞态。
    for (const old of this.state.getWebSockets(role)) {
      try { old.close(4400, "replaced"); } catch (e) {}
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    // Hibernation：acceptWebSocket 注册并允许 DO 在消息间隙休眠。
    // role 作为 tag，getWebSockets(role) 可按角色过滤。
    this.state.acceptWebSocket(server, [role]);

    // 对端 role 已在 → 配对完成，向两端发 relay_paired。
    const peer = this.state.getWebSockets(other)[0];
    if (peer) {
      try { server.send(JSON.stringify({ type: "relay_paired", role })); } catch (e) {}
      try { peer.send(JSON.stringify({ type: "relay_paired", role: other })); } catch (e) {}
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // 配对后转发：**定向**发给对端 role，不是广播给「除自己以外的所有人」。
  // 原来用无 tag 的 getWebSockets() 遍历：同 role 顶替后，被 close 但尚未从
  // 注册表移除的幽灵连接也会收到帧——把本该点对点的控制流量发给了一个正在
  // 关闭的旧连接。按 tag 定向既准确又省一次遍历。
  async webSocketMessage(ws, event) {
    const tags = this.state.getTags(ws) || [];
    const mine = tags.includes(ROLE_EXT) ? ROLE_EXT
      : tags.includes(ROLE_CTL) ? ROLE_CTL : null;
    if (!mine) return;
    const other = mine === ROLE_EXT ? ROLE_CTL : ROLE_EXT;
    for (const peer of this.state.getWebSockets(other)) {
      if (peer === ws) continue;
      try {
        peer.send(event);
      } catch (e) {}
    }
  }

  async webSocketClose(ws, code, reason, wasOpen) {
    this._dropPeer(ws);
  }

  async webSocketError(ws, error) {
    this._dropPeer(ws);
  }

  _dropPeer(ws) {
    for (const peer of this.state.getWebSockets()) {
      if (peer === ws) continue;
      try { peer.close(1011, "peer gone"); } catch (e) {}
    }
  }
}
