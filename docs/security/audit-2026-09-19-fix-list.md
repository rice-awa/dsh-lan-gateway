# 网关代码复审与修复清单

复审日期：2026-09-19。对象：`@riceawa/dsh-lan-gateway` 0.5.3，提交 `88974ec`。
运行底座：dsh `0.1.5-rc.2`（pnpm dlx 安装）。

G1–G8 之外的「记录但不修」四项在发布 0.5.4 之前一并处理，结论见
[后续修复](#后续修复)；改动全部并入同一个 0.5.4。

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

## 本轮修复

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

## 后续修复

下列四项是 G1–G8 复审时记录、评估后暂不处理的条目。发布 0.5.4 之前重新评估，四项
全部修复，编号顺延为 G9–G12；本节修复后清单不再有「记录但不修」条目。逐会话登出、
改密递增代次、`lan_gateway rotate-secret` 三者共同构成三层撤销：单个会话、保留口令
作废全部、换口令作废全部。

### G9：中危，登出不撤销会话本身

原判断：`handleLogout` 只签发一条立即过期的 Cookie，这是无状态会话的固有性质；递增
会话代次会登出全部会话而非当前一个；定向撤销需要重构会话模型，当前以
`lan_gateway rotate-secret` 作为撤销手段。

重新评估后认为「重构会话模型」的代价被高估：会话载荷本就是可扩展的 JSON，加入一个
随机会话 id 不改变无状态性质。问题于是变成维护一份已登出 id 的名单，而名单规模有天然
上界——每条记录只需存活到它所指 Cookie 自身到期为止。

修法：登录时在 Cookie 载荷中加入 128 位随机会话 id（`sid`；旧 Cookie 无此字段）。
`handleLogout` 取出该 id 写入撤销名单，关闭由该会话建立的 WebSocket，再清 Cookie。
名单随 `state.json` 持久化：Cookie 在到期前始终能通过验签，重启若丢掉名单会让已登出
的会话复活；写入与加载两处都剔除已过期条目，名单不会持续增长。`setPassword` 递增
代次时清空名单，新代次已使其中每一条失去意义。缺 `sid` 的旧 Cookie 只能被代次撤销，
这正是它们签发时的语义。登出仍只作用于当前会话，其他设备不受影响——即原判断要求的
行为。

回归用例：`tests/gateway.test.ts` 的会话撤销段落（单 id 撤销、非原地修改、过期条目
剔除、持久化往返、损坏名单容错、`setPassword` 清空），以及
`tests/integration/gateway.test.ts` 的两条登录 → 登出 → 重放用例。

### G10：低危，自签证书默认 825 天，且到期后不会续期

原判断记录「超出浏览器对本地信任根常见的 398 天上限，部分浏览器可能拒绝」。复核发现
该表述有两处问题。

其一，398 天的适用范围被放大了。Apple 的说明（support.apple.com/en-us/102028）写明
该限制不影响由用户或管理员添加的根 CA 签发的证书，而自签证书必然是这样一条根——浏览器
不会预装它。825 天则是 Apple 对 TLS 服务器证书给出的上限
（support.apple.com/en-us/103769），默认值取在该上限之内。因此 825 天不构成被拒绝的
理由。

其二，真正的缺口在别处：没有任何路径替换已到期的自签证书。`loadOrCreateSelfSigned`
只要文件能解析就复用，`tls-regenerate` 需要人工执行，而浏览器对过期证书是硬拒绝，
不给「继续访问」的余地。默认值取多短都挡不住这一点。

修法：默认值维持 825 天，并在配置项文档中写明依据。启动时解析已持久化证书的
`notAfter`，已过期则重新生成并记 warning。续期必然更换密钥，此前手工信任过旧证书的
客户端需要重新信任；但证书既已过期，这一步无论如何都要发生。回归用例用假定时器跨过
`notAfter`，分别断言仍有效的证书被复用、已过期的被替换。

### G11：低危，尾斜杠拼写不落在归属判定内

原判断记录「无可利用后果」，复核后成立：WHATWG 归一化折叠点段但不删除尾斜杠，dsh 的
路由层用 `new URL(req.url, "http://x").pathname` 取路径，所以 `/__login/` 对 dsh 与
对网关同样不是登录页，不存在 G1 那种「网关判为不归属、上游归一化后命中」的分歧。

仍有一处功能缺陷：`POST /__logout/` 不被识别为登出路径，于是既不登出也不报错，而是
转发给 dsh 并落到 SPA fallback，表现为「点了登出但仍是登录状态」。同一拼写下的
`/lan-gateway/config/` 会被放进中继，虽无可利用后果，却与「网关从不转发自己的管理面」
这条不变式不符。

修法：`pathOf` 在 WHATWG 归一化之后去掉结尾斜杠，归属、登录、登出三处判定因此对两种
拼写给出相同结论；转发仍走原始 `req.url`。该改动只收紧归属判定——`/lan-gateway/`
之下没有上游路由——代价为零。

### G12：低危，监听器只绑定 IPv4

原判断记录「若需 IPv6 入口应单独评估」。评估结论是应当绑定：`classifySource` 本就
处理 `::1` 与 `fe80::/10` 两条 IPv6 分支（G8 刚修正过链路本地判定），但
`listen(port, '0.0.0.0')` 只监听 IPv4，这两条分支在实际部署中不可达——IPv6 客户端
既连不上，也就不会被分类。同网段的 IPv6 客户端只能退回 IPv4 才能访问。

修法：`listen()` 不指定 host。主机具备 IPv6 时 node 绑定未指定地址 `::`，IPv4 客户端
以 `::ffff:a.b.c.d` 到达，分类器原本就会拆掉该映射；主机没有 IPv6 时 node 退回
`0.0.0.0`。日志与 `lan_gateway status` 改为报告 `server.address()` 的实际结果，不再
写死字符串。回归用例向回环 IPv6 发起请求，主机无 IPv6 时跳过。

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
