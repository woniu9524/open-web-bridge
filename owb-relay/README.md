# owb-relay — 中转服务

Open Web Bridge 的中转 broker，跑在 **Cloudflare Workers + Durable Objects** 上。让远程 AI agent 经公网控制你本机的浏览器，而不用暴露本机端口。

## 原理

```
扩展(用户机) ─wss/<token>?role=extension─► ┌─ Cloudflare ─┐ ◄─wss/<token>?role=controller─ daemon(AI agent 机)
                                           │  RelayRoom   │
                                           │  Durable Obj │  ← 按 sha256(token) 寻址的 DO 实例
                                           └──────────────┘     两 role 配对后透明双向转发
```

- 每个 token = 一个 `RelayRoom` Durable Object 实例（用 `sha256(token)` 当 DO id 寻址）。
- 两端带 `?role=extension|controller` 连入；两个 role 齐了即向两端发 `{type:"relay_paired"}`，之后纯字节管道。
- Hibernation API：空闲等待期间 DO 休眠，几乎不烧 CPU——对免费额度极友好。
- TLS 由 CF 边缘内置，**无需 nginx/caddy**。

## 部署（约 2 分钟）

前提：一个 Cloudflare 账号（免费即可）。装 wrangler：

```bash
cd owb-relay
npm install
npx wrangler login          # 浏览器授权一次
npx wrangler deploy         # 部署，输出 https://owb-relay2.<你的子域>.workers.dev
```

部署后拿到中转 URL（如 `wss://owb-relay2.abc.workers.dev`）。两端各配「中转 URL + 同一个 token」即可。

### 自定义域名（可选）

默认 `*.workers.dev` 子域即可用。想用自己的域名：CF Dashboard → Workers & Pages → `owb-relay2` → Settings → Triggers → Custom Domains 绑定，TLS 自动签发。

## 生成 token

token 是线上唯一秘密（32 字节随机足够）。任一端生成都行，扩展弹窗「中转」页有「生成」按钮；命令行：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

把同一个 token 分别填到：
- **扩展** 弹窗「中转」页的「中转 Token」字段；
- **daemon** 环境变量 `OWB_RELAY_TOKEN`。

## 本地开发 / 自测

```bash
npm test                    # 14 项 DO 单元测试（纯 Node mock，无需部署）
npx wrangler dev            # 本地起 Worker（Miniflare），手动连 ws 验证
```

## 故障排查

入口和 DO 都有最外层 catch：出错时**响应体直接带错误信息**（`curl https://<relay>/health` 或看 WS 升级失败的 HTTP body），完整堆栈用 `npx wrangler tail` 看。不会再出现只有 reference id 的裸 1101。

常见错误：

- **`Exceeded allowed volume of requests in Durable Objects free tier`**：免费额度
  （每月 1M DO 请求）耗尽，每月 1 号重置；升级 Workers Paid（$5/月）即时解除。
  两端对失联中转的重连退避上限已放宽到 60s 以减缓消耗。
- **`error code: 1042` / 404（未进 worker）**：workers.dev 路由未启用，确认
  wrangler.toml 里有 `workers_dev = true` 后重新 deploy。
- **裸 1101（无信息）**：说明异常发生在 catch 层之外（部署损坏/平台故障），
  `wrangler tail` 复现观察；换 worker 名重部署可甩掉坏的 DO namespace 状态。

## 安全模型（用前请读）

- **token 是线上唯一秘密**，走 wss（CF 内置 TLS）。token 在 URL 路径里——wss 下传输加密，但会出现在你自己 CF 账号的请求日志里（你自己掌管，可接受）。
- **中转是可信 broker**。MVP **无端到端加密**——CF/DO 能看到全部明文流量（含登录 cookie/storage）。只用你自己的 CF 账号部署，或接受此风险。E2EE（token 派生密钥逐帧加密）为后续硬化项。
- **配对完备性**：连接到某 DO 即证明持有 token（DO id = `sha256(token)`，哈希泄露也无法逆推构造 URL），故 DO 内不再二次校验。
- 同 role 重连（扩展 SW 重启）顶替旧连接；任一端断开即断对端。

## 配额

Durable Objects 已下放到 Workers Free（有限额）。relay 大部分时间空闲休眠，单连接成本极低；若超限，Workers Paid（$5/月）兜底。部署前核对当前配额：[Cloudflare Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)。
