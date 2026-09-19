# 更新日志

## 0.5.5

一轮架构复审的修复，覆盖 C1–C6 / D1–D14。与 0.5.4 的 G 系列不同，这一轮既有行为缺陷，也有结构清理：请求判定从 `LanGateway` 中拆出，配置契约收敛到一处，运行意图不再有两个真相源。

**会话与生命周期缺陷（P1）。** 改密码时，`handleLogin` 会在 scrypt 校验**之前**读取代次，校验用掉的时间里代次若已前进，登录仍按旧代次签发 cookie，等于为一次已作废的凭据发了一张新票。现在登录前后各取一次代次，不一致即拒绝签发。WebSocket 握手同理：握手在途时改密或 `disable`，此前那条连接仍会 splice，销毁流程追不到它。现在 splice 前后各检查一次代次与关闭标志，中途作废的连接直接关闭。

**运行意图统一到一个写入点。** 此前「网关是否该跑」有两个真相源：卡片写的 `enabled` 与工具 `enable` / `disable` 写的 `manualOverride`，后者存在时压过前者且永不复位。后果是工具启用过的网关，卡片关不掉；卡片启用的网关，工具关掉后重启又回来了。现在 `setRunIntent` 是唯一入口：settings 服务挂载时写 `enabled` 字段（卡片也写这个字段），未挂载时才退回内存标志。首设密码也不再让「待启用」的意图卡死——凭证补齐后按同一意图重新 reconcile，未表达过意图则不启动。

**配置保存改为字段补丁。** 卡片此前提交整份表单，服务端按 schema 校验后整体替换 settings section。这会把 schema 默认值写进用户 section，让它们从此压过组合层——`cookieName` 就是这样被重置的：组合层里自定义的 cookie 名，只要在卡片上改了任何一个无关字段，就回落到 `dsh_gw_auth`，已有登录 cookie 全部失效。未知键同样被写进 section。现在保存走 `mutate` 的 `set` / `unset`：只写提交过的字段，空值走 `unset` 使其重新继承组合层，未知键被丢弃并在响应里列出。

**登录 POST 纳入同站围栏。** 此前只有转发路径校验 Origin，签发会话的登录不校验——跨站表单可以消耗受害者来源地址的登录额度。登录用一套更宽的规则 `loginOriginAllowed`：仍接纳不带 Origin 的 curl / CLI 提交，但拒绝 `Sec-Fetch-Site: cross-site` 与和 Host 不符的 Origin。

**上游会话中继的 WebSocket 错误路径。** 上游以非 101 应答握手时（例如会话已失效返回 401），node 既不触发 `upgrade` 也不触发 `error`，客户端挂在一个永远不会应答的 socket 上。现在非 101 直接回给客户端，并在 401 时丢弃中继会话，否则一个只走 WebSocket 重连的底座会永远重放一条死会话。

**结构清理。** 请求判定（路径归一化、归属前缀、登录与同站围栏、三个头部变换）移入 `src/request-policy.ts`，成为对字面 `RequestHead` 的纯函数，可脱离 socket 测试；`LanGateway` 只保留 socket、生命周期与 splice。卡片字段模型移入零依赖的 `src/config-fields.ts`，host 侧由它派生 `OPTIONAL_CONFIG_KEYS` 与 `CONFIG_FIELD_KEYS`，「哪些键存在」与「哪些键空了要清」不再各有副本。`UpstreamSession.peek()` 删除，头部改写不再为「响亮拒绝」多绕一步。生命周期副作用全部走串行队列，配置保存、改密与工具调用不再可能交错。

**其余修复。** `setPassword` 改用异步 scrypt，不再阻塞与 dsh 共用的事件循环（`state.ts` 的该函数因此变成异步）。状态查询不再有写副作用：`tlsStatusLine` 此前调用 `loadOrCreateSelfSigned`，网关停用、证书又不存在时，一次 `status` 就会生成 RSA 密钥并写盘；现在用只读的 `readSelfSignedStatus`。删除死代码：`parseFormBody`、`verifyCookie`、`COOKIE_NAME`，以及 `limited` 的三段未接线路径（限流拒绝现在直接在 POST 上渲染提示，不再经 `?limited=1` 绕一圈）。`revokeSession` 改为接受注入时钟，与其他时间边界函数一致。`READ_ONLY_METHODS` 与配置保存的跨站判定合并到 `request-policy.ts` 一处。

**测试面。** 新增 `tests/request-policy.test.ts`（判定缝的纯函数覆盖）、`tests/integration/management-plane.test.ts`（真实 `apply()` + 真实 `SettingsProvider`，覆盖工具与卡片交替启停、未编辑字段与未知键的保留、清空后继承、拒绝不可启动配置）、`tests/integration/session-races.test.ts`（改密落在登录与握手途中的竞态，以及上游非 101 应答）。`process.env.HOME` 在测试内重定向到临时目录，`state.ts` 与 `tls.ts` 都在调用时解析 `homedir()`，因此测试不再触碰插件真实文件。测试总数 117 → 186。

## 0.5.4

一轮针对 0.5.x 实现细节的代码复审修复，清单见 [docs/security/audit-2026-09-19-fix-list.md](docs/security/audit-2026-09-19-fix-list.md)。八项来自 G1–G8（四项与上游会话设计耦合，四项为独立的小缺陷），另四项为复审时记录、发布前重新评估后一并处理的条目（G9–G12）。

归属路径判定改为路由归一化。`isOwnedPath` 原先对 `req.url` 做原始字符串前缀匹配，而 dsh 的路由层用 `new URL(...).pathname` 取路径、WHATWG 会折叠点段。两者在 `/foo/../lan-gateway/config` 上分歧：网关判为不归属而放进中继，dsh 归一化后正好命中插件自己的 `/lan-gateway/config` 路由——而该路由只要求 Host 是回环，网关恰恰把 Host 改写成回环。结果「网关从不转发自己的管理面」这条不变式不成立。现在归属、登录、登出三处判定统一用归一化路径，转发仍走原始 `req.url`。

客户端 `dsh-auth-*` Cookie 不再能遮蔽中继会话。`attachUpstreamSession` 把中继会话追加在客户端 Cookie 之后，上游取第一个同名段，于是一个客户端自带的同名 Cookie（典型来源是 dsh 签名密钥被重置后遗留的旧 Cookie）会一直压住中继那条：验签失败 → 上游 401 → 网关按 401 启发式丢弃中继会话 → 下个请求重新换取 → 又被压住。转发前先剥离该命名空间，中继持有的成为唯一一条。

上游 `Set-Cookie` 不再原样回传。dsh 唯一签发 Cookie 的路由是 `GET /?token=` 的交换，透传等于让已通过网关门的客户端把「骑共享会话」升级为「提取一条持久会话」。现在响应转发时剥离 hop-by-hop 头，并剥离 `set-cookie` 中的 `dsh-auth-*`（其他路由的 Cookie 仍透传）。

中继日志不再记录 launch token。`acquiring session from ${url}` 把整条带 `?token=` 的 URL 打进日志，那是个 bearer 凭据。

另外四项：`RateLimiter.prune()` 此前无调用者，一次性来源的桶永久驻留，现在按窗口清扫并加了桶表上限；`verifyPassword` 改用异步 scrypt，不再让登录尝试阻塞与 dsh 共用的事件循环；客户端提供的 `X-Forwarded-*` / `Forwarded` 转发前删除；`fe80::/10` 判定此前只覆盖 `fe80::/16`，改为按前 10 bit 判定。

复审时记录、发布前重新评估后一并处理的四项。**登出改为定向撤销**：此前登出只签发一条立即过期的 Cookie，会话本身仍然有效，其副本在到期前一直可用。现在登录时在 Cookie 载荷里加一个 128 位随机 id，登出把该 id 写进持久化的撤销名单并关闭这条会话建立的 WebSocket，其他设备不受影响；`rotate-secret` 仍是作废全部会话的手段，改密递增代次同理。名单只需存活到它所指 Cookie 到期为止，写入与加载都剔除过期条目。**自签证书到期后自动换发**：`loadOrCreateSelfSigned` 此前只要文件能解析就复用，而浏览器对过期证书是硬拒绝，于是证书一过期就再也进不去，只能人工 `tls-regenerate`。现在启动时解析 `notAfter`，已过期即换发并记 warning。默认有效期仍为 825 天：398 天限制只约束链到平台预装根的证书，Apple 明确豁免用户或管理员自行添加的根，自签证书正属此类，而 825 天在 Apple 对 TLS 服务器证书给出的上限之内；依据已写进配置项文档。**归属判定接纳尾斜杠**：`/__logout/` 此前不被识别为登出路径，既不登出也不报错，而是转发出去落到 SPA fallback。`pathOf` 在归一化之后去掉结尾斜杠，归属、登录、登出三处判定对两种拼写给出一致结论。**监听器改为双栈**：`listen(port, '0.0.0.0')` 只监听 IPv4，`::1` 与 `fe80::/10` 两条分类分支在实际部署中不可达。现在不指定 host，主机具备 IPv6 时绑定 `::`（IPv4 客户端以 `::ffff:a.b.c.d` 到达，分类器本来就会拆掉该映射），没有 IPv6 时退回 `0.0.0.0`；日志与 `status` 报告实际绑定的地址。

## 0.5.3

修掉明文代理入口下的登录死循环。声明了 `trustedTerminator`、但那个代理只做明文用户鉴权（浏览器以 `http://` 访问代理）时，密码输对了也会立刻弹回 `/__login`。

原因是 `trustedTerminator` 被无条件当成加密入口，登录 cookie 一律加 `Secure`；浏览器拒收明文 http 上的 Secure cookie，会话在登录跳转之间就没了。

新增 `secureCookies` 配置项显式覆盖该属性，留空 = 自动（原来的推断规则）。设置页对应「自动 / 始终 Secure / 不加 Secure」三档。`lan_gateway status` 现在报告实际生效的属性，以及声明的代理属于 TLS 还是明文入口。

同时补上共享会话中继的日志：中继从不抛异常（换取失败就退回匿名转发），导致「cookie 名字不对」「上游不可达」「底座根本没有浏览器会话」三种情况在日志里长得一模一样。现在 `UpstreamSessionRelay` 接了 `ctx.logger`，每次换取都记录结果，失败时列出上游实际返回的 cookie 名字。顺带修掉一处小失效：`authenticatedUrl()` 瞬时不可用时不再把已持有的会话丢掉（那会以匿名身份转发、必然 401），而是继续用仍可能有效的会话。

## 0.5.2

修掉共享上游会话中继的 cookie 匹配。0.5.0 / 0.5.1 装在 dsh ≥ 0.1.2-rc.1 上时，网关自己的登录能过，但每个转发请求都被上游 401，浏览器只看到：

```
dsh web authentication required; reopen the URL printed by dsh web.
```

插件原先用 `dsh-auth-=` 这个前缀去找上游签发的会话 cookie，而 dsh 实际签发的名字是 `dsh-auth-<base64url(sha256(authority))>`，前缀后面永远跟哈希而不是 `=`，匹配必然为空。令牌换取本身是好的（`GET /?token=…` 确实发出、也拿到了 `Set-Cookie`），只是那条 cookie 在这一步被丢弃，转发请求全部以匿名身份发出。现在改为「名字以 `dsh-auth-` 开头且后面还有内容」。

同一失效域还修掉一个启动竞态：`listenerKey` 把「中继是否可用」计入重启判据。监听器若早于 `connection` 服务启动（因此没有中继），会在服务挂载后自动重启，而不是一直匿名转发、状态里却写着 relay active。

新增 `tests/upstream-session.test.ts`，用真实回环 HTTP 服务端跑完整换取链路（集成测试注入的是假会话对象，正好绕过了这段）。

## 0.5.1

修掉加载失败。0.5.0 及更早装在 dsh ≥ 0.1.2-rc.1 上会让整个 plugin tree 起不来：

```
Error: dsh: plugin tree failed to load: ...
SyntaxError: The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'
```

`@deepseek-ai/dsh-settings` 从 `0.1.2-rc.1` 起删掉了 `settingsNamespace()` 这个品牌化辅助函数（命名空间改为 `register()` 内部校验的普通字符串字面量），旧插件在 ESM 链接期就失败。cordis 的 include 一旦失败会连坐整棵树，所以表现是所有插件都起不来，而报错点看着像隔壁插件的名字。

0.5.1 移除了该导入，运行时行为不变：新旧版本的 `register()` 都按同一个 `NAMESPACE_PATTERN` 校验并原样接受这个字面量。因此 0.5.1 在 `0.1.0-rc.6` 到 `0.1.5-rc.2` 的底座上都能加载。

## 0.5.0

默认拒绝模型的加固版本，针对 QVD-2026-57410（DSH Web API 的 Host 信任缺陷）。

- 移除 `authRequired`，认证恒为必需。所有来源——loopback、LAN、公网——都要出示网关会话；LAN 免密改为显式 `lanPasswordless`，默认关闭。
- 新增共享上游会话中继。
- 未设密码一律拒绝监听。

## 从 v0.4 及更早升级

1. 把底座升到 dsh ≥ 0.1.2-rc.1（含 QVD-2026-57410 的上游修复）。低于该版本插件仍能跑，但 `lanPasswordless` 会拒绝启用。
2. 配置里写过 `authRequired: false` 的删掉它。想要 LAN 免密就改成 `lanPasswordless: true`。
3. 以明文（无 TLS）运行且从未设过密码的，升级后 `enable` 会拒绝。先启用 TLS / 声明 `trustedTerminator` / 显式 `allowInsecurePlaintext: true` 之一，再 `lan_gateway set-password`。
4. 曾以「免密 + 伪造 Host」形态暴露过的实例，按可能已失陷处置：轮换模型和系统凭据，检查有没有未知登录会话。

一步到位的迁移示例（HTTPS 自签名 + LAN 免密）：

```yaml
- id: dsh-lan-gateway
  config:
    enabled: true
    tlsEnabled: true
    tlsMode: self-signed
    # 证书 SAN 覆盖所有接入方式。Tailscale 走 100.64.0.0/10（CGNAT），
    # 按默认 lanCidrs 归为 internet，仍需密码登录。
    tlsSelfSignedHosts: localhost,my-host,192.168.1.20,100.99.1.2
    lanPasswordless: true
```

首次以 `https://<主机名|LAN-IP|Tailscale-IP>:3081` 访问会看到自签名证书警告（预期）。证书在首次启用 TLS 时生成一次并持久化到 `~/.dsh/lan-gateway/tls/`；若已有一张旧证书，必须用 `lan_gateway tls-regenerate` 重新签发，新的 `tlsSelfSignedHosts` 才会进 SAN。
