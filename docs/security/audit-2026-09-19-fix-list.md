# 网关代码复审与待修复清单

复审日期：2026-09-19。对象：`@riceawa/dsh-lan-gateway` 0.5.3，提交 `88974ec`。
运行底座：dsh `0.1.5-rc.2`（pnpm dlx 安装）。

本轮为代码复审，未对运行中的服务发起请求。所引用的 dsh 行为均来自本地安装的
`@deepseek-ai/dsh-client-connection` 与 `@deepseek-ai/dsh-host-webserver` 源码，
以及 WHATWG URL 解析行为的隔离验证。

## 背景

0.5.3 的中继日志把「谁在什么时候换取了上游会话」暴露出来之后，两条与上游
dsh 的会话设计耦合的路径变得可观测，据此复查了 `gateway.ts` 的请求路径判定、
Cookie 组装与响应转发三处。另外复核了 `auth.ts` 的分类与限流、`state.ts` 的
口令校验。

与 [SECURITY-AUDIT.md](SECURITY-AUDIT.md)（0.4.0，QVD-2026-57410）不同，本轮
不涉及默认放行或来源信任问题——那些已在 0.5.0 收敛。本轮全部是 0.5.x 引入的
实现细节。

## 待修复

以下 G1–G8 已在 0.5.4 全部修复。每条保留原始判断依据，末尾附实际改法；回归用例见
`tests/integration/gateway.test.ts`（G1/G3/G4/G7）与 `tests/gateway.test.ts`（G5/G8）。

### G1：中危，归属路径判定可被点段绕过

位置：`src/gateway.ts:87`（`isOwnedPath`）、`src/gateway.ts:92`（`pathOf`）。

`isOwnedPath` 对 `req.url` 的原始字符串做前缀匹配，而 dsh 的路由层用
`new URL(req.url, "http://x").pathname` 取路径，WHATWG URL 会归一化点段。隔离验证：

```
"/foo/../lan-gateway/config"  ->  "/lan-gateway/config"   ← 网关判为不归属，dsh 归一化后命中
"/lan-gateway%2fconfig"       ->  "/lan-gateway%2fconfig"  ← %2f 不解码，这条路不通
```

因此 `GET /foo/../lan-gateway/config` 会绕过归属判定进入中继；网关把 Host 改写为
`127.0.0.1:<dshPort>`，而该路由的 `isTrustedConfigRequest` 恰好只要求 Host 是回环，
判定通过。结果是经网关可读写网关自身的配置（端口、CIDR、cookieName、enabled、
allowInsecurePlaintext、lanPasswordless 等）。

需先通过网关自己的登录门，而已通过登录门者本已持有共享上游会话（等价于完整
harness 访问权），所以不是提权，而是「网关从不转发自己管理面」这条不变式不成立。
窄场景下另有增量：中继不可用时转发不带上游 Cookie、dsh 自身 API 返回 401，但该
路由挂在 webserver 上不受上游会话约束，仍可写。

修法：所有路径判定统一使用归一化后的路径，与 dsh 的路由层保持一致；转发仍用原始
`req.url`（dsh 自己会做同样的归一化）。

### G2：中危，launch token 写入日志

位置：`src/upstream-session.ts:231`（`doExchange` 的 `acquiring session from ${url}`）。

`authenticatedUrl()` 返回 `http://127.0.0.1:<port>/?token=<launchToken>`
（`dsh-client-connection/lib/index.js:370`），该行把整条 URL 打进 `ctx.logger.info`。
launch token 是 bearer 凭据，配合 G4 可经网关自身兑现为持久的上游会话 Cookie。

对比之下 dsh 自己的卫生是到位的：303 带 `referrer-policy: no-referrer`、Cookie 为
`HttpOnly`、token 只在 `GET /` 被接受。这一行日志是唯一破坏该卫生的位置。

修法：只记录 `target.pathname`，token 查询参数不入日志。

### G3：中危，客户端 Cookie 遮蔽中继会话，可自锁

位置：`src/gateway.ts:378`（`attachUpstreamSession`）、`src/gateway.ts:407`（401 启发式）。

`attachUpstreamSession` 把中继会话追加在客户端 Cookie 之后，而 dsh 的
`cookieValue`（`dsh-client-connection/lib/index.js:284`）取第一个同名段。因此客户端
若已持有同名的 `dsh-auth-<sha256(authority)>`，上游认证用的是客户端那条，中继的
共享会话被静默忽略。

叠加网关自己的 401 启发式（`attached && statusCode === 401 → session.invalidate()`）
后形成自锁：客户端 Cookie 验签失败 → 上游 401 → 网关判定「上游吊销了会话」→
丢弃 → 下个请求重新换取（必然成功）→ 客户端那条仍排在前面 → 再次 401，循环不收敛。

触发条件：dsh 的签名密钥持久化、仅在缺失时生成（`initializeSecret`），所以该记录
一旦被重置，所有浏览器持有的旧 Cookie 都未过期但验签失败，这些客户端即进入循环。

修法：转发前剥离 `Cookie` 中所有 `dsh-auth-*` 段，再附加中继会话，使中继持有唯一
权威的那条。

### G4：中危，上游 `Set-Cookie` 原样回传

位置：`src/gateway.ts:410`（`res.writeHead(proxyRes.statusCode, proxyRes.headers)`）。

响应头整份透传，不过滤 `set-cookie`。dsh 唯一会签发 Cookie 的路由是 `GET /?token=`
的交换，因此一个已通过网关门的客户端只要发 `GET /?token=<真 token>`，就能从网关
拿到一条持久的上游会话 Cookie。既要有网关会话又要有 token，不是绕过，但它把
「骑共享会话」升级为「提取一条会话」，与 G2 连起来构成完整链路。同一处也未过滤
hop-by-hop 响应头。

修法：转发响应时剥离 hop-by-hop 头，并剥离 `set-cookie` 中的 `dsh-auth-*`。

### G5：低危，`RateLimiter.prune()` 未被调用，桶表无界

位置：`src/auth.ts:210` 定义，全仓库（含测试）无调用者。

每个曾 POST `/__login` 的源地址留下一个 bucket，过期后只有该地址再次出现才会被
覆盖，一次性地址的条目永久驻留。

修法：在 `allow()` 内按窗口递增触发 `prune()`，或为桶表加上限。

### G6：低危，`scryptSync` 阻塞事件循环

位置：`src/state.ts:50`（`verifyPassword`）、`src/gateway.ts:324`。

每次登录尝试同步跑 scrypt 数十毫秒，阻塞的是与 dsh 同一进程的事件循环。限流在
scrypt 之前（顺序正确），但限流键是源地址，换地址可放大。

修法：改用异步 `scrypt`，`verifyPassword` 返回 Promise。

### G7：低危，客户端转发头原样透传

位置：`src/gateway.ts:363`（`upstreamHeaders` 的 `{...req.headers}`）。

网关自身不读 `X-Forwarded-For`（这点正确），但把它连同 `Forwarded`、
`X-Forwarded-Proto`、`X-Real-IP` 一起原样送给上游，等于把来源伪造的空间留给下游。

修法：转发前删除客户端提供的转发类头。

### G8：低危，`fe80::/10` 判定只覆盖 `/16`

位置：`src/auth.ts:104`。

`address.toLowerCase().startsWith('fe80:')` 只匹配 `fe80::/16`，`fe80::/10` 还包含
`feb0::`–`febf::`。方向是更严格（被判为 internet 而要求登录），不是放开。

修法：按前 10 bit 判定。

## 记录但不修

- **登出不推进会话代次**：`handleLogout` 只签发一条立即过期的 Cookie。无状态会话
  的固有性质；推进代次会登出所有会话而非当前一个。按会话 ID 的定向撤销需要重构
  会话模型，当前以 `lan_gateway rotate-secret` 作为撤销手段。
- **自签证书默认 825 天**：超出浏览器对本地信任根常见的 398 天上限。部分浏览器可能
  拒绝，属部署体验问题；改默认值会静默缩短既有部署的证书寿命，留待单独决策。
- **`/__login/` 尾斜杠**：不被识别为归属路径，会转发给 dsh 并落到 fallback。与 G1
  同源，但归一化不改变尾斜杠，且无可利用后果。
- **未绑定 IPv6**：`listen(port, '0.0.0.0')` 只监听 IPv4，`::1` 与 `fe80:` 两条分类
  分支在实际部署中不可达（G8 因此也只有理论意义）。若需 IPv6 入口应单独评估。

## 与上游 token 设计的关系

dsh 的 `?token=` 交换与本网关不冲突：中继做的正是浏览器做的事——`GET /?token=…`，
Host 用 `127.0.0.1:<dshPort>`，收下 `Set-Cookie` 重放。两点是对上的：

- Cookie 绑定 authority，而网关在每个转发请求上都把 Host 改写成与换取时相同的
  authority，因此换来的 Cookie 必然匹配后续请求。
- token 是进程级的（`PROCESS_LAUNCH_TOKENS` 是 WeakMap，每次 `dsh web` 重新生成），
  网关的 `authenticatedUrl` 是每次获取会话时重新调用的回调，重启后能拿到新 token。

`authorizeIndex` 只挂在根路径与 index 上，`/api/*` 与 WebSocket 走 `isAuthenticated`
（纯 Cookie），静态资源公开。因此网关的 401 启发式在 `attached === true` 时的语义是
准确的，问题只出在 G3 的同名遮蔽上。
