# 网关架构复审

复审日期：2026-09-19。对象：`@riceawa/dsh-lan-gateway` 0.5.4，提交 `c82eae7`。
src 共 3669 行（含 client，按 `wc -l`，含注释与空行），测试 8 文件 117 例。

核查更新：同日对照同一提交复核；原有编号保留，修正过度结论与不完整修法，新增 D8–D14。

> 本文件是**架构层面**的复审，与 [docs/security/](../security/) 下的三轮安全审计
> （QVD-2026-57410、SECURITY-AUDIT.md、audit-2026-09-19-fix-list.md）侧重点不同：
> 那三轮针对默认放行、来源信任与实现细节缺陷，本轮针对模块划分、接缝位置与可测性。
> 核查发现的会话竞态也涉及安全，不再声称与安全审计完全不重叠。
> 本轮只更新本文，不修改产品源码、用户设置或运行中的服务。

## 结论

原审查的大部分代码观察属实，但严重性、因果关系和修法有几处需要更正：

- **C1 的双真值源冲突成立**，但原来只改 `shouldRun` 的方案不完整：工具仍然只写
  `manualOverride`，settings 存在时工具的 enable/disable 将失效。
- **不能断言只有 C1 有用户可见影响**。核查补充了保存重置 cookie 名（D8）、登录签发
  跨越密码撤销（D9）、WebSocket 握手跨越撤销（D10）等问题。
- C2–C5 主要是可维护性建议，并不都是已发生的错误；C2 并非配置路由可测的前提。
  D3 的「含测试零引用」不适用于 `verifyCookie`，D4 的两个 loopback 判定职责也不相同。
- **优先 D9/D10 的会话竞态，再处理 C1/D8 与生命周期 D11、升级失败 D12**。
  不必等待全面拆分模块才修这些问题。

原有六项深化候选与 D1–D7 保留，但「具体缺陷」中包含清理建议和部署限制，并非同等严重。
新增 D8–D14 分别标明验证方式；没有用通过现有测试推断未覆盖路径正确。

## 审查范围与方法

仓库没有 `CONTEXT.md`，也没有 `docs/adr/`，因此领域词汇取自各模块的文档注释，
架构词汇（module / interface / depth / seam / locality / leverage、删除测试）取自
`codebase-design` 约定。

本次区分 **读码结论**、**隔离验证** 和 **设计建议**。读码结论附源码位置；
设计建议不等同于运行时缺陷，不把代码规模、私有方法或注入接口本身作为缺陷证据。

验证记录：

- `pnpm test`：8 文件、117 例全部通过；`pnpm typecheck`：通过。
- 临时隔离验证：5 例通过（断言当前错误行为），覆盖 C1、D2/D8、D9、D10、D13。
  使用真实 `apply()` / `LanGateway` 逻辑，替换磁盘 state、监听器启停与外部依赖；
  D9 用可控 Promise 暂停口令校验，D10 暂停 relay 获取并模拟上游 101。
  验证文件执行后移除，未加入正式回归套件；下文记录触发步骤与断言。
- 重新检索生产与测试引用，确认 D3 的例外；设置保存验证确认默认值与未知键进入 section。

未向运行中的网关或 dsh 发起请求，未修改真实 state/TLS 文件，未做性能基准或真实浏览器验收。
D2 另以已安装的 schema 实现复核默认值、未知键及 `__proto__` 输入；后者未成为输出自身属性，
输出与普通对象均未出现探测属性。这只是特定输入验证，不是全面原型污染审计。

## 深化候选

### C1：`apply()` 是上帝模块，且「网关该不该运行」有两个真值源

位置：`src/index.ts:373-725`。

**问题（结构）**。单个 `apply()` 闭包同时持有并编排：state 生命周期、监听器启停与重启、
settings 命名空间注册与 watch、`connection` 服务注入与中继工厂、`/lan-gateway/config`
HTTP 路由（`518-607`，90 行内联）、`GatewayController` 六个方法（`613-715`）、启动守卫、
TLS 解析与状态行格式化。`status()` 一个方法要读六处闭包可变状态（`gateway`、`state`、
`effective()`、`manualOverride`、`lastError`、`upstreamSessionAvailable`），再拼一段 12 行的
字符串。这是 depth 的反面：导出面很小，实现耦合极大，任何一处改动都要先理解整张闭包网。

**问题（行为）**。真正有害的是这一行：

```js
// src/index.ts:453
const shouldRun = manualOverride ?? cfg.enabled
```

`manualOverride` 只在三处赋值，且**没有任何路径把它复位为 `undefined`**：

| 位置 | 赋值 | 触发 |
| --- | --- | --- |
| `src/index.ts:637` | `true` | `lan_gateway enable` |
| `src/index.ts:644` | `false` | `lan_gateway disable` |
| `src/index.ts:661` | `false` | 清除密码 |

而 settings 卡片改的是 `cfg.enabled`。两者同时是「是否运行」的真值源：

- 先 `lan_gateway disable`（override=false），再在卡片勾选 `enabled` 保存 →
  `false ?? true` 得 `false`，网关不启动。
- 先 `lan_gateway enable`（override=true），再在卡片取消勾选保存 →
  `true ?? false` 得 `true`，网关照旧监听。

两条路径都保存成功且无错误提示（`syncGateway` 只在 catch 中写 `lastError`），
卡片的 enabled 字段与运行状态可能不一致，但 `running` 状态行仍反映实际监听状态。
反向工具命令可以恢复启停；若要消除 override、恢复卡片作为唯一开关，则当前须重载插件。
`manualOverride` 还泄漏进 `status()` 输出，成为一个无法从卡片清除的隐形状态。

**方案（核查修正）**。settings 存在时，应让工具 enable/disable 与卡片写同一配置意图；
无 settings 时才使用内存 override。原审查建议的条件表达式不能单独应用：当前工具两个方法
仍只赋值 `manualOverride`，忽略它就会破坏工具启停。还要一并定义清除密码、settings 挂载/
卸载时的意图迁移及写入失败语义。不要为了写一个 enabled 而 replace 掉其他用户覆盖。

管理路由与生命周期可以分离，但先补测试、修冲突，不要求一次拆完 `apply()`。
`listenerKey` 用来判断是否需要重建、`syncing` 用来序列化副作用、override 用来表达操作意图，
**三者职责不同，不能承诺用一次比较替代串行化**。D11 还指出了当前绕过队列的调用。

配置路由可通过 fake context 捕获 `webServer.register()` 的 handler 做隔离测试；本次已如此
复现 C1/D2/D8。因此「当前未覆盖」属实，「拆不开所以不可测」不成立。

**推荐强度：Strong**。

### C2：请求判定逻辑被困在 `LanGateway` 里，`auth.ts` 自己声明的原则没有贯彻

位置：`src/gateway.ts:161-192`、`315-395`、`536-595`；`src/auth.ts:1-9`。

**问题**。`auth.ts` 的模块注释写着「Pure functions where possible so the tests can exercise
them without a live server」——它自己遵守了（`classifySource`、`signCookie`、`verifySession`、
`originMatchesHost`、`RateLimiter`），但 `gateway.ts` 没有。同样性质、同样安全关键的判定
混合了文件内未导出函数与类私有方法，当前正式测试主要通过真实 socket 触达：

| 判定 | 位置 | 形态 |
| --- | --- | --- |
| `isOwnedPath(pathname)` | `src/gateway.ts:161` | 纯函数 |
| `pathOf(url)` | `src/gateway.ts:184` | 纯函数 |
| `requiresLogin(source)` | `src/gateway.ts:351` | config → bool |
| `sameSiteAllowed(req, upgrade)` | `src/gateway.ts:386` | headers → bool |
| `upstreamHeaders(req, keepUpgrade)` | `src/gateway.ts:536` | headers → headers |
| `downstreamHeaders(upstream)` | `src/gateway.ts:580` | headers → headers |
| `withoutUpstreamSessionPairs(cookie)` | `src/gateway.ts:152` | string → string |
| `sessionCookie(req)` | `src/gateway.ts:315` | headers → string |

它们分布在一个同时拥有 `http.Server`、`activeDuplexes` Map、`RateLimiter` 和两个 relay 分支
的模块中。当前测试选择通过监听端口验证这些不变式：
`tests/integration/gateway.test.ts` 757 行 26 例中，相当一部分是在为「Host 改写后点段归一化」
「尾斜杠归属」「转发头剥离」这类纯字符串判定搭真实的 loopback 会话。原审查未测量性能，不能据此断言它是套件最慢部分。

反证在同一个仓库里：`gatewayStartProblems`（`src/index.ts:229`）、`resolveSecureCookies`
（`src/index.ts:265`）、`isTrustedConfigRequest`（`src/index.ts:355`）已经是「纯判定 + 导出供测」
的形态，注释里明写 "Exported for tests"。模式已经存在，只是没有一致应用。

**方案**。新建 `src/request-policy.ts`（或并入 `auth.ts`），把上表八项搬进去，签名统一为
`(headers/config/socket, ...) → decision`。`LanGateway` 退化为传输适配器：收 socket、调 policy、
转发。`GatewayConfig.classifySource` 注入口可重新评估，但不能断言随之可删：
policy 单元测试可直接喂 `SourceClass`，集成测试仍需验证 LAN/internet 的实际接线。
依赖注入本身是合理测试接缝，真实 socket 回归测试也应保留。

**收益**。判定获得直接的单元测试入口，传输层继续通过集成测试验证接线与生命周期；
不能按搬走几个方法就断言职责从八项降为三项，也不建议删除对应的关键集成回归。
`pathOf` / `isOwnedPath` 是 0.5.4 刚修过的高危项（点段绕过，见
[audit-2026-09-19-fix-list.md](../security/audit-2026-09-19-fix-list.md) 的 G1），
它值得一个有名字的家，而不是躲在两个私有方法里。

**推荐强度：Strong**。

### C3：上游协议的同一事实被两处编码，且两处规则不同

位置：`src/gateway.ts:101-158` 与 `src/upstream-session.ts:29-105`。

**问题**。`dsh-auth-` 前缀常量在两个文件里各声明一次（`src/gateway.ts:102`、
`src/upstream-session.ts:30`），且两侧匹配规则**不同**：

```js
// src/gateway.ts:136 —— 作用于 Cookie 头的 name=value 片段
return pair.startsWith(UPSTREAM_COOKIE_PREFIX)

// src/upstream-session.ts:104 —— 作用于 Set-Cookie 整串，多一个长度守卫
return name.startsWith(UPSTREAM_COOKIE_PREFIX) && name.length > UPSTREAM_COOKIE_PREFIX.length
```

差异不是随意的：`src/upstream-session.ts:97-101` 的注释记录了「匹配 `dsh-auth-=` 必然为空、
静默匿名转发」——那正是 0.5.2 修复的、导致中继完全失效的缺陷。**一个有过明确写错历史的
协议事实，在同一代码库里以两种规则存在**。而该事实的所有者是 `upstream-session.ts`
（整个模块的职责就是这条协议），`gateway.ts` 只是消费方却在自行推导。

**方案**。由 `upstream-session.ts` 导出两个谓词（`isUpstreamCookiePair(pair)`、
`isUpstreamSessionCookie(setCookie)`），删掉 `gateway.ts` 的 `UPSTREAM_COOKIE_PREFIX` 与
`isUpstreamSessionPair`。

**收益**。协议知识单点化。dsh 若改 cookie 命名，改动落在拥有该协议的 module 内，
且它的测试文件已用真实 loopback 服务端铸造真实的
`dsh-auth-<b64url(sha256(authority))>` 名字来验证（`tests/upstream-session.test.ts:58`）——
那正是这个事实应该被测的地方。

**核查限定**：剥离整个保留命名空间与接受可用会话 cookie 是不同职责；过滤
`dsh-auth-=` 比获取阶段更宽并非错误。0.5.2 的历史问题不证明当前规则差异导致故障。
可以集中协议知识，但要保留「过滤」与「接受」的语义区别。

**推荐强度：Worth exploring**（去重建议，未证实当前行为缺陷）。

### C4：配置契约有多处独立描述，字段完整性缺乏约束

位置：`src/index.ts:117-216`、`195`；`src/client/lan-gateway-card.tsx:34-50`、`222-238`；
以及两张 `LABELS` 表。

**问题**。同一条线上契约有五处独立描述：`Config` schemastery（`src/index.ts:198`，权威校验）、
`Config` 接口（`src/index.ts:117`）、`OPTIONAL_CONFIG_KEYS`（`src/index.ts:195`，清空语义）、
`LanGatewaySettings`（`src/client/lan-gateway-card.tsx:34`）、`FIELDS`（同文件 `222`）。

其中两份已经**完全重复且当前精确一致**：

```
OPTIONAL_CONFIG_KEYS          = {dshTargetPort, tlsCertPath, tlsKeyPath, trustedTerminator}
FIELDS 中 optional: true 的项 = {dshTargetPort, tlsCertPath, tlsKeyPath, trustedTerminator}
```

一致，但没有约束强制两者一致。`authRequired` 是兼容拒绝项，不展示本身不算 UI 缺陷；
实际漏掉的可配置字段还包括 `cookieName`，它在每次保存时被重置——见 D8。

**方案**。把 `FIELDS` 及 kind→codec 的 `formatValue` / `parseValue` 提到无依赖的共享 module
`src/config-fields.ts`，两侧都 import：host 侧由它派生 `OPTIONAL_CONFIG_KEYS`，client 侧由它
渲染控件。约束是它必须零依赖、零副作用（不能引用 schemastery），而 `FIELDS` 现在的形态
恰好满足。i18n 文案属于 client，留在 `card.tsx` 不动。

**收益**。「哪些键可清空」不再有第二份副本。原文的「八处降到五处」没有统一计数口径，
还漏了 listenerKey、README 等位置，不作为量化收益。`parseValue` / `formatValue` 已经是唯一被覆盖的卡片
逻辑（`tests/settings-card.test.ts`），提升为共享 module 后现有六个 codec 测试可以继续复用，但仍需补齐字段完整性和保存往返测试。

**推荐强度：Worth exploring**。收益真实，但需要接受「host 与 client 共享一个 module」这个
新约束——卡片零服务注入并不禁止共享纯模块，不能据此推导出必须先取得架构许可。

### C5：`UpstreamSession.peek()` 让头部改写多绕一步，接口可以少一半

位置：`src/upstream-session.ts:39-46`、`211-213`；`src/gateway.ts:559-570`、`598-627`、`662-665`。

**问题**。调用点是这样写的：

```js
// src/gateway.ts:600-602；handleUpgrade 的 663-665 同样形态
if (session !== undefined) await session.cookie()   // 返回值被丢弃
const headers = this.upstreamHeaders(req, false)
const attached = this.attachUpstreamSession(headers) // 内部改用 peek() 再读一次
```

`cookie()` 的返回值被丢弃，紧接着通过 `peek()` 从缓存状态里把它读回来。`peek()` 在整个
`src/` 中没有第二个调用者（只有 `tests/upstream-session.test.ts:113/124/149` 在用）。
这个「先确保取到、再旁路读取」的两步，正是接口承载冗余方法的典型征兆：调用点没有把值
串下去，于是接口多加了一个读取面。

**方案**。让 attach 接收值而非会话对象——`attachUpstreamSession(headers, cookie)`，
`cookie` 来自上一步 `await session.cookie()` 的返回值。`UpstreamSession` 接口收缩为
`{ cookie(), invalidate() }`，`peek()` 删除。连带 `upstreamHeaders` + attach +
`downstreamHeaders` 成为一个纯变换 `(headers, cookie?) → headers`，归入 C2 的 policy module。

**收益**。接口从三个方法降到两个，且头部组装不再依赖「会话对象内部恰好缓存了什么」这个
隐式时序。测试侧：`tests/integration/gateway.test.ts` 目前要手工构造 `{peek, cookie, invalidate}`
三方法对象当替身（`608-612`、`642-646` 两处），收缩后替身只需两个方法，头部改写的测试
也可以完全不构造会话对象。

**推荐强度：Worth exploring**。

### C6：配置路由不可达时卡片静默消失，三处文案已成死代码

位置：`src/client/lan-gateway-card.tsx:96-99`、`146-150`、`317-318`。

**问题**。远端浏览器（经网关访问）拿 `/lan-gateway/config` 会得到网关自己的 403
（`src/gateway.ts:420-424`；`src/index.ts:35-36` 明确记载这是刻意设计），卡片随即
`if (loadFailed) return null`（`317`）。于是 Settings → Plugins 里**什么都不显示**。

而两张语言表里躺着为这个场景准备、却从未被引用的文案（计数均为 0）：
`readOnly`（`97` / `148`）、`loadFailed`（`99` / `150`）、`overridden`（`96` / `147`）。
当前代码只能证明这些文案未被使用；其演变原因需要提交历史证据，不能由死文案反推。

**方案**。二选一，都很小：把 `readOnly` 接成 `loadFailed` 的降级渲染（远端用户至少知道
此卡片需在宿主本机打开），或者删掉这三个键。

**收益**。可理解性清理。留着的死文案会让下一个读者以为存在一条降级路径。

**推荐强度：Speculative**。

## 具体缺陷

### D1：`setPassword` 违反同一文件写下的规则

位置：`src/state.ts:98`。

`setPassword` 用 `scryptSync`，而同一文件 `src/state.ts:65-70` 为 `verifyPassword` 改用异步
`scrypt` 给出了理由：「`scryptSync` occupies the event loop for tens of milliseconds per
attempt, and that loop is shared with the dsh process the gateway is forwarding to」。
`setPassword` 做的是同一件 CPU 密集工作，理由逐字适用，且调用方
`GatewayController.setPassword` 本来就是 `async`（`src/index.ts:648`）。

这是上一轮安全复审的残留：G6 把问题记在 `verifyPassword`（`src/state.ts:50`，当时的行号）
与 `src/gateway.ts:324`，按「改 `verifyPassword` 为异步」修掉，`setPassword` 这条同步路径
不在该条的范围内，因而一并留了下来。

修法：复用已有异步 `deriveKey`，同步调整调用者与测试。此项是低频管理操作的阻塞风险，
与可被网络反复触发的密码验证不应赋予同等优先级；未测量实际延迟。

### D2：`/lan-gateway/config` 的保存路径会把 schema 默认值与未知键写进用户 settings

位置：`src/index.ts:558-589`。

隔离验证（`@deepseek-ai/schemastery@3.18.2`）确认两点行为：

- **默认值会被填充**：`z.object({a: z.boolean().default(false), keep: z.boolean().default(true)})({a:true})`
  → `{"a":true,"keep":true}`。
- **未知键会被透传**：`({a:true, evil:'payload'})` → `{"a":true,"evil":"payload"}`。
  `__proto__` 被丢弃，**无原型污染**——这点已单独验证排除。

于是 `Config(submitted)` 的输出经 `Object.entries` 循环（`584-589`）后：`authRequired: true`
会随**每一次保存**写入持久化的 `lan-gateway` 用户 section，尽管卡片从不显示也不发送它；
请求体里任何未知键同样原样落入 section。

严重性有限——该路由由 `isTrustedConfigRequest`（`src/index.ts:355`）限制在回环同源，
即本机用户或本机进程。但「已移除的能力」被持续写回用户配置，与
`src/index.ts:132-137` 声明「保留仅为响亮拒绝」的意图相反。

修法：构造 section 时以显式键表（或 C4 的 `FIELDS`）做白名单过滤，而不是遍历校验器输出。

### D3：死代码

核查修正：下列项的生产使用情况不同，不能统称「含测试目录调用者计数为零」：

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `parseFormBody` | `src/login.ts:99` | 无任何调用者；`handleLogin` 用 `new URLSearchParams`（`src/gateway.ts:463`） |
| `verifyCookie` | `src/auth.ts:199` | 生产无调用，但测试多处调用；是可精简包装，不是全仓库零引用 |
| `COOKIE_NAME` | `src/login.ts:18` | 无任何引用，且与 schema 默认值 `'dsh_gw_auth'`（`src/index.ts:206`）重复 |
| `limited` 机制 | `src/login.ts:23,28`；`src/gateway.ts:355,357,442` | 三处构成一条**从未接通的路径** |

`limited` 值得单独说明：`renderLoginPage` 支持 `opts.limited` 渲染「Too many attempts」，
`serveUnauthorized(res, limited)` 会拼 `?limited=1`，`handleLogin` 也确实从 URL 把这个标志
读了出来——但 `serveUnauthorized` 的唯一调用点传的是 `false`（`src/gateway.ts:427`），
且 `limited` 局部变量读完即弃（`442`），GET 分支（`443-445`）也不把它传给 `serveLoginGet`。
一个自洽设计的三段接线全部缺失；最终限流文案是靠 `serveLoginError` 走 `error` 字符串送达的。

### D4：常量与概念重复

- `READ_ONLY_METHODS`：`src/gateway.ts:99` 与 `src/index.ts:345` 各一份，内容相同。
- 两个 loopback 判定：`isLoopbackHost`（`src/index.ts:335`，字符串解析，识别 `[::1]`）与
  `classifySource` 的 `ipv4 >>> 24 === 127`（`src/auth.ts:94`，经 `normalizeAddress` 拆
  `::ffff:` 映射）。二者当前在主流输入上结论一致，但**手段不同、可修正面不同**：
  `isLoopbackHost` 不吃 `::ffff:127.0.0.1` 形式，`classifySource` 则吃。这类分叉通常到某次
  单边修复时才暴露。**核查限定**：前者验证 URL hostname，后者分类 socket IP（还含 LAN）；
  输入域与信任边界不同，差异本身不构成缺陷。应分别明确支持范围，不能直接互换。
- `OPTIONAL_CONFIG_KEYS` 与 `FIELDS.optional`：见 C4。

### D5：`revokeSession` 内部取 `Date.now()`，与全库可注入时钟的惯例不一致

位置：`src/state.ts:112`。

`isCertExpired(certPem, now)`（`src/tls.ts:175`）与 `verifySession(..., now)`
（`src/auth.ts:159`）都注入时钟。后果是 `tests/gateway.test.ts` 必须为它启用 fake timers
（`31-33` 恢复真实时钟），其他时间边界测试也会使用 fake timers。显式时钟可改善可测性，但这是设计一致性建议，
不是已证实的行为错误；「全库可注入时钟」表述过强，加载撤销表等也直接读 `Date.now()`。

### D6：登录 POST 不在同站栅栏之内，登出却在

`handleHttp` 在 `src/gateway.ts:408-415` 就分流了 `LOGIN_PATH`，早于 `431` 的同站检查；
而 `handleLogout` 显式做了 `sameSiteAllowed`（`516-520`，注释「A logout is a state change:
refuse cross-site triggers」）。同一条论证对签发会话的登录同样成立。

不能只用「攻击者需要知道密码」就断言影响接近零：跨站表单提交错误密码也会消耗
受害者来源地址的登录桶，结合 D7 可影响代理后的共享额度。此结论为读码分析，未做浏览器
跨站复现。是否校验登录 Origin，应明确浏览器与非浏览器客户端兼容策略。

### D7：限流以 `socket.remoteAddress` 为键，声明受信终止代理后全站共享一个桶

位置：`src/gateway.ts:453`。

`trustedTerminator`（`src/index.ts:170-175`）是受支持的部署形态，此时所有浏览器请求都来自
代理地址，于是 `LOGIN_ATTEMPTS_LIMIT = 5`（`src/gateway.ts:95`）变成**整个部署每分钟 5 次**，
而非每客户端 5 次。而 `X-Forwarded-For` 又刻意不可信（`src/gateway.ts:120-132`，这点正确），
所以这里没有便宜的修法——要么接受并在文档中写明，要么为终结点模式单独配置上限。
至少值得在配置项注释里点明这个耦合。

## 核查补充的遗漏

### D8：保存任何卡片字段都会重置自定义 cookie 名（P1，隔离验证）

位置：`src/client/lan-gateway-card.tsx:34`、`222`、`363`；`src/index.ts:206`、`560`、`591`。

`cookieName` 不在 client 接口和 FIELDS 中；save 从空对象遍历 FIELDS 构造完整配置，
`Config(submitted)` 为缺失字段填入 `dsh_gw_auth`，随后 `replace(section)` 将其持久化。
即便 composition 设置了别的 cookie 名，新用户覆盖也会将其盖掉。

验证：fake settings 的 base 使用 `custom_cookie`，向真实 config handler POST
`{enabled:false, evil:'payload'}`，捕获 replace 参数；结果含
`cookieName:'dsh_gw_auth'`、`authRequired:true` 与 `evil:'payload'`。
卡片恰好缺少同一字段，因此保存端口等无关项也会触发，导致原登录 cookie 不再被识别。

建议明确全量替换与增量修改契约，保留未编辑字段；兼容拒绝项不能简单与可编辑字段混为一张表。
仅给 D2 加未知键白名单不足以修复此问题。

### D9：旧密码验证完成后可以签发新 epoch 的 cookie（P1，隔离验证）

位置：`src/gateway.ts:468`、`477`；`src/state.ts:71`；`src/index.ts:654`。

`verifyPassword(this.state, password)` 捕获旧 state/hash 后异步执行 scrypt；等待期间
set-password 或 rotate-secret 可替换 state 并提升 epoch。恢复后签名却读取新的
`this.state.cookieSecret` / `sessionEpoch`，没有确认验证依据仍然有效。

验证步骤：暂停 `verifyPassword` 的 Promise → `gateway.setState()` 安装 epoch 2 和新密码记录
→ 让旧验证返回 true。返回的 302 cookie 可通过 `verifySession(..., epoch=2)`。
这是可控替身验证异步时序，不是对真实 scrypt 耗时窗口的概率测量。

建议校验前捕获认证版本，完成后拒绝版本已变或 listener 已关闭的请求；不能把旧验证结果
用于新版本签名。应覆盖改密码、清密码、轮换密钥及关闭期间的在途登录。

### D10：撤销与关闭只处理已登记 WebSocket，漏掉在途握手（P1，隔离验证）

位置：`src/gateway.ts:236`、`272`、`523`、`648`、`663`、`674`。

握手先验证 claims，再等待 relay cookie / 上游 101，最后才 `trackDuplex`。
期间 epoch 变更、该 sid 登出或 listener 关闭只会清理 Map 中已有 socket；
101 回调既不复查会话，也不检查 disposed，旧握手可以在清理完成后登记为存活连接。

验证：携带 epoch 1 cookie 进入 handleUpgrade，暂停 relay.cookie → 安装 epoch 2 →
释放 Promise 并模拟上游 101。结果 activeDuplexes 为 1，客户端 socket 未被销毁。
此验证覆盖 epoch 竞态；登出和关闭由同样缺少在途跟踪/复查的代码路径推得，未分别动态复现。

建议从收到 upgrade 开始拥有并跟踪连接，在异步边界与接通前检查当前认证/生命周期版本；
撤销同时取消在途请求并关闭两端。C2 的纯函数抽取本身不能解决这个时序问题。

### D11：生命周期副作用并未全部进入串行队列（P1，读码）

位置：`src/index.ts:389`、`416`、`449`、`663`、`703`、`721`。

只有 syncGateway 内的操作串行化；清密码、TLS 换发和插件 dispose 直接调用 stop/start。
startGateway 在 `await next.listen()` 之后才发布 gateway，期间 dispose 可能看到 undefined
而什么也不关闭，随后启动完成，监听器脱离插件生命周期。TLS 换发与 settings 同步也可能
交叉启停。该触发依赖调用时序，本次未运行完整 Cordis 热重载复现。

settings 卸载回调（`483`）切回 composition 后没有 reconcile；connection 注入（`497`）
也没有对称的清理来重置 relay factory / 可用性。后者重载时 listenerKey 只记录 boolean，
不能识别 provider 代际变化；是否持有失效 provider 还需宿主集成验证。

建议统一生命周期操作队列，加入 disposed/generation 与在途启动收尾，成对处理 provider
挂载/卸载。另把 effective() 纳入异常边界：它当前在 try 外抛错会使 syncing 拒绝，后续
`.then()` 不再执行。这里是条件风险，不声称当前 scope.get 已经抛错。

### D12：WebSocket 上游非 101 响应没有处理分支（P1，读码）

位置：`src/gateway.ts:667` 至文件末尾；对照 HTTP 分支 `src/gateway.ts:613`。

upgrade 代理只监听 `upgrade` 和 `error`，没有 `response` handler。上游正常返回 401/403/404
不会进入这两个分支，客户端得不到拒绝响应或显式关闭；这里也没有握手超时。
尤其是共享上游 session 被撤销时，HTTP 分支会 invalidate，WS 分支却不会；如果只有 WS
重连，缓存可能一直复用到刷新窗口。

101 分支还直接转发所有上游 headers，未应用 HTTP 分支的 `dsh-auth-*` Set-Cookie
过滤。这是传输分支的策略遗漏，是否实际泄漏取决于上游是否在 101 设置该 cookie。
不能原样调用 downstreamHeaders，因为成功升级仍需保留 Connection/Upgrade。

建议显式处理普通响应、失效凭证、超时和双端关闭；为 101 单独组合 cookie 过滤策略。
补成功透传、401 拒绝、握手挂起及断连测试。该项未用真实上游 socket 动态复现。

### D13：设置首个密码后的同步分支永远不执行（P2，隔离验证）

位置：`src/index.ts:374`、`653`、`672`；`src/state.ts:147`。

`previous = state` 保存的是 GatewayState 对象，loadState 总会返回对象；因此
`previous === undefined` 永远为 false。先在无密码时 enable（失败，但留下运行意图），
再 set-password，代码不会重新 reconcile，监听器继续停止，旧的「无密码」lastError 也保留。

验证：fake loadState 返回无密码 state，调用真实 tool execute 的 enable 确认失败，随后
set-password；监视 LanGateway.listen，调用次数仍为 0。

是否应自动启动需要定义产品语义；如果保留运行意图，应在凭证变化后重新 reconcile，
若要求用户再次 enable，应移除不可达条件并明确提示。

### D14：状态读取会创建 TLS 文件，修改 SAN 则不会更新已有证书（P2，读码）

位置：`src/index.ts:318`、`324`、`533`；`src/tls.ts:52`、`90`。

tlsStatusLine 调用 loadOrCreateSelfSigned：TLS 配置已开启、证书文件尚不存在时，
即使网关停用，GET config / tool status 也会生成 RSA 密钥并写证书，查询并非只读。
相反，已有有效证书时修改 tlsSelfSignedHosts 或 tlsCertMaxAgeDays 会触发 listenerKey
重启，但 loadOrRenewSelfSigned 仍复用旧证书；新 SAN/有效期要等显式换发才体现。

README 的「生成一次、重启复用」已描述后一行为，不能把它直接算成违反规格。
问题是状态查询含写副作用、卡片没有说明哪些设置仅影响下次生成。建议让状态读取只读，
在 UI 标明换发条件；不要为了自动应用 SAN 而无提示替换用户已信任的证书。

## 测试面

现有测试覆盖了多种认证和转发场景，但没有运行覆盖率工具，不能声称这些模块「基本全覆」。
缺口集中在管理面、异步竞态与 WS 成功/失败生命周期。

1. **`/lan-gateway/config` 写路径零覆盖**。`apply()` 整体未测：`tests/start-guard.test.ts`
   只测三个纯守卫加 `Config()` 可调用性，不碰路由。D2 的两个问题都在这条路径上——
   新增 D9–D12 也显示其他未覆盖的缺陷场景。
2. **WebSocket 成功路径未测**。`handleUpgrade` 只测了 401/403 拒绝；`proxyReq.on('upgrade')`
   的 101 重建、`head` 转发、`proxyHead` unshift、双向 pipe、`trackDuplex` / `destroyDuplexesFor`
   （`src/gateway.ts:674-695`、`285-306`）全部未覆盖。这是全库风险最高的未测路径：
   双向 pipe 的背压与半关闭语义、以及「登出要能关掉这条会话的 socket」这个 0.5.4 新承诺，
   都只有 handler 代码没有验证。
3. **三个各自独立的 upstream 替身**：`tests/integration/gateway.test.ts:52-75` 的
   `createUpstream`、`tests/upstream-session.test.ts:38-88` 的 `fakeUpstream`，加上集成测试里
   两处手写的 `{peek,cookie,invalidate}` 字面量（`608-612`、`642-646`）。后两者结构相似却零共享。
   若采纳 C5，字面量替身会自然收缩。
4. **文件名与内容不符**：`tests/gateway.test.ts` 从不 import `src/gateway.ts`，它测的是
   `auth.ts` 加 `state.ts`；真正的网关测试在 `tests/integration/gateway.test.ts`。
   按文件名找网关测试会找错文件。
5. **测试触及内部的几处**：`tests/gateway.test.ts:359-362` 把 `RateLimiter` 强转以读私有
   `buckets`；`tests/integration/gateway.test.ts:584-586` 绕过 `listen()` 直接调
   `gateway.server.listen(...)`，把 public 字段当测试接缝；`classifySource` 注入口
   （`src/gateway.ts:82-83`）是生产代码里的测试专用参数。三处需要分别判断：读私有 buckets 耦合实现；直接 server.listen 绕过生产入口；
   classifier 注入则是合理的依赖替换，不能把它与前两项一并当成缺陷。
6. **时钟与真实资源**：`tests/tls.test.ts:87-104` 在 fake timers 下铸造真实证书（vitest 会
   patch `Date`，而证书 `notBefore`/`notAfter` 取自 `new Date()`）；`tests/x509.test.ts` 生成
   3 张 RSA-2048 证书，`tests/tls.test.ts` 另有 4 处。这些文件并行时争 CPU。

## 首要建议

1. **先补会话与生命周期回归测试，修 D9/D10**：可控异步屏障覆盖改密码/轮换、登出、关闭
   与在途登录/握手的交叉；保留必要的真实 socket 测试。
2. **修 C1/D8，补管理面往返测试**：覆盖工具与卡片交替启停、保留未编辑字段、未知键、
   清空后继承配置、失败时的状态反馈。无需等待 C2 重构。
3. **收拢生命周期并补 WS 错误路径（D11/D12）**，定义首个密码设置后的行为（D13）。
4. 再按收益处理 C2–C5 与 D1/D3/D5 的结构清理，补 C6/D7/D14 的用户提示与部署说明。

## 需要明确的设计语义

- 工具启停是否持久化，以及 settings 动态挂载/卸载时如何迁移运行意图。
- 配置 POST 是完整替换还是字段补丁；不可编辑字段与未知字段怎样处理。
- 代理后共享限流桶的额度与提示，以及登录跨站请求的拒绝策略。
- TLS SAN/有效期是否只影响下次显式换发，卡片如何提示。

这些是实现时需要明确的契约，不是本次核查或文档更新的前置审批。
共享零依赖模块也不违反「卡片零服务注入」原则。
