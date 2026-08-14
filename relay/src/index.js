/**
 * Worker 入口：把带 token 的 WS 升级请求路由到对应的 RelayRoom Durable Object。
 *
 * URL 形态：wss://<relay>/<token>?role=extension|controller
 *
 * 安全模型：
 *  - token 在 URL 路径，wss 下传输加密；raw token 会出现在你自己 CF 账号的请求日志里
 *    （你自己掌管，可接受）。
 *  - DO 名用 sha256(token) 寻址——连接到某 DO 即证明持有 token（哈希泄露也无法
 *    逆推构造 URL），故 token 安全完备，DO 内不再二次校验。
 *  - 中转是可信 broker；MVP 无 E2EE，DO 能看到全部明文流量（含登录 cookie）。
 */
export { RelayRoom } from "./relay-room.js";

export default {
  // 最外层兜底：任何未捕获异常都会变成 Cloudflare 1101（页面只有一个
  // reference id，毫无线索）。这里 catch 住打印真实堆栈——`wrangler tail`
  // 即可看到，且返回体带上错误信息方便 curl 定位。
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env);
    } catch (e) {
      console.log("owb-relay uncaught:", (e && e.stack) || String(e));
      return new Response("relay error: " + ((e && e.message) || e) + "\n", { status: 500 });
    }
  },
};

async function handle(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok\n");
    }

    // 取路径首段作为 token（base64url 字母表无 /，安全）
    const token = url.pathname.slice(1).split("/")[0];
    if (!token) {
      return new Response("token required: wss://<relay>/<token>?role=...\n", { status: 400 });
    }

    const upgrade = (request.headers.get("upgrade") || "").toLowerCase();
    if (upgrade !== "websocket") {
      return new Response("expect websocket upgrade\n", { status: 426 });
    }

    const id = env.RELAY_ROOM.idFromName(await sha256Hex(token));
    const stub = env.RELAY_ROOM.get(id);
    // 原样把升级请求转给 DO（token 在 path、role 在 query 已就位）
    return stub.fetch(request);
}

async function sha256Hex(s) {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
