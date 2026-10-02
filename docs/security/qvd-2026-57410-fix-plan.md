# QVD-2026-57410 修复方案（网关插件 + 部署）

方案日期：2026-09-06。**正文 1–14 是方案文档**（分阶段实施步骤、文件级改动、验收断言与
决策点），写于实施之前，其中「不做任何『已完成修复』的表述」的口径仅适用于正文本身。
**该方案已按 0.5.0 落地**：实施结果与对正文的实际偏差以文末 [§15 实施状态](#15-实施状态050-2026-09-06) 为准。

依据与口径：
- [上游研究](qvd-2026-57410-research.md)（公开通告 / 上游提交与版本 / 证据等级）
- [LAN 网关安全评估](SECURITY-AUDIT.md)（本插件 F1–F5，13 个隔离观察）
- 本地代码审读：`src/gateway.ts`、`src/index.ts`、`src/auth.ts`、`src/state.ts`、`src/login.ts`、`src/tool.ts`、`src/client/*`、`tests/gateway.test.ts`

既定范围（本次已拍板）：
1. **交付物 = 方案文档**，不在此次修改生产源码。
2. **目标认证模型 = 「仅 internet 认证 + 其余加固」**：非 LAN 来源一律必须登录；LAN/loopback 免密保留但**改为显式 opt-in 且默认关闭**；同时修配置路由鉴权（F2）、HTTP/WS 跨站一致性（F3）、TLS/明文默认（F4）、会话撤销（F5），并重述 LAN 免密边界与上游的关系（F1）。

## 1. 结论速览

| SECURITY-AUDIT 发现 | 一句话问题 | 本方案阶段 |
| --- | --- | --- |
| F1 | 免密是默认行为，且网关**替访问者伪造回环身份**通过上游信任围栏 | 阶段 0（上游）+ 阶段 2（默认收紧）+ 阶段 1（定位重构） |
| F2 | `/lan-gateway/config` 只信回环 Host，无真实身份，可改安全策略 | 阶段 3 |
| F3 | HTTP 部分路径有 CSRF 围栏，WebSocket upgrade 完全没有；前缀匹配可被 `..` 绕过 | 阶段 4 |
| F4 | TLS 默认关，密码/会话可走明文 HTTP | 阶段 6 |
| F5 | 改密/清密不撤销已签发会话 | 阶段 5 |

架构性判断（贯穿全文）：**本插件的存在理由——`0.0.0.0` 监听 + 改写 Host/Origin 为回环以通过 dsh `/api` 信任围栏——正是 QVD-2026-57410 所描述的缺陷形态**（把 Host 头当身份 / 缺客户端认证），只是把它从「攻击者自己伪造」变成「网关代劳」。因此本方案的核心不变量是：

> 即使保留「LAN 免密」，网关也不得让任何来源在**未经上游自身鉴权**的情况下到达 harness 敏感 API。LAN 免密只允许豁免「网关自己的登录」，不允许豁免「harness 的授权」。当底座 dsh 是受影响版本时，`lanPasswordless` 类开关必须被拒绝，否则就是把 QVD 原样装回去。

## 2. 问题边界与不变量

三个互相独立的面：

```
浏览器 ──▶ 网关 0.0.0.0:3081          dsh 127.0.0.1:3080
          ├─ /__login                 （网关自持，不转发）
          ├─ 转发:改写 Host/Origin ──▶ /api 信任围栏      ← 面 1:QVD 形态
          └─ /lan-gateway/config ──▶  原生 loopback 路由   ← 面 2:管理面
                                     （插件注册在 ctx.webServer）
```

面 1 与面 2 都在 `/api` 之外、各有独立入口，因此**只给上游 `/api` 加认证并不能保护插件**（上游研究与此一致）。修复必须同时覆盖三个面。

**不变量（验收判据的最高层）：**
1. 网段/来源地址永远不单独构成身份；身份来自「有效会话」或「显式 opt-in 的受信网络」且该 opt-in 只有在底座已鉴权时才允许放宽网关层。
2. 鉴权先于一切转发；匿名例外只允许网关自持且绝不转发的路径（登录页、登录提交，且带限流）。
3. HTTP 与 WebSocket 共享同一套「是否需要会话 + 是否跨站」判定；不允许 upgrade 绕行。
4. 会话撤销立即生效：改密/清密/轮换密钥后旧 Cookie 失效；已建立的长连接有明确销毁策略。
5. 不安全组合（明文暴露、无密码放行、旧的 LAN 免密配置）**拒绝启用并给迁移提示**，而不是静默延续或 fallback 到免密。

## 3. 阶段 0 —— 部署处置（外部，不在本仓库）

先做这些，再做任何网关代码改动。这些都是**现状确认项，不是已入侵证明**。

| 动作 | 为什么 | 验收 |
| --- | --- | --- |
| 关闭网关网络暴露（`lan_gateway disable` / `enabled:false`） | 避免在修复期间继续暴露 | `status` 显示 stopped；外部端口不通 |
| 升级上游 dsh 到含真实浏览器会话鉴权的版本（≥ `0.1.2-alpha.1`，推荐 `0.1.2-rc.1` 及以上） | Host 伪造对已修复底座不再生效；把「伪造本地身份」这条路从根上堵死 | 见「12 上游核对清单」 |
| 确认上游 web 服务仍只绑 `127.0.0.1`，且没有另开转发/隧道直连原生端口 | 原生端口是网关之外的第二入口 | `ss -ltnp` / 防火墙核对 |
| 若实例曾以受影响版本 + 免密/LAN 暴露运行，按「可能已失陷」处置：轮换模型/系统凭据，检查登录会话 | 免密 + 伪造 Host = 未授权工具型访问 | 运维侧完成并留档 |
| 检查并决定是否信任 TLS 终止反代（若有） | 后文阶段 6 需要「可信加密入口」的显式配置 | 记录反代模式与证书来源 |

阶段 0 是**前置条件**：阶段 2/3 的若干 fail-closed 规则会读取「上游是否已鉴权」这一事实来放行 opt-in。上游未升级时，网关仍保持「默认全来源登录」，并把需要放宽的配置项拒绝掉。

## 4. 阶段 1 —— 定位重构：从「信任围栏旁路」到「会话传输层」

**为什么必须显式决策：** 上游加入统一浏览器会话后，仅靠改写 Host/Origin **不再能通过鉴权**——上游要求它自己的、绑定 hostname/port 的签名 Cookie（上游研究已核实：根页面用启动 URL 令牌换取绑定 Cookie，API 不直接接受令牌或 Authorization 头）。因此现状网关对一个**已修复**底座要么 401/跳登录（GUI 打不开），要么需要新机制。继续把网关接到一个**未修复**底座上就是复现 QVD，不是方案。

**决策点 DP-1（必须在实现前拍板）：底座 dsh 是否已升级到含会话鉴权的版本？**
- 是 → 走 DP-2 选架构；否 → 阶段 2 的放宽开关一律拒绝，网关只在「全来源登录」的保守形态下可用。

**决策点 DP-2：网关与上游会话的关系。**
- **选项 A（推荐）：网关作为「已认证单会话中继」。** 网关启动时在回环上完成上游启动令牌→Cookie 交换，得到**一条共享的上游会话**；网关自己的登录决定谁可以骑这条会话。对上游的 Host/Origin 重写仅用于「目标解析/同源路由」，**不再冒充本地身份通过鉴权**——鉴权由网关持有的上游会话本身承担。
  - 语义诚实：与现状一致，是「单密码 = 单用户/工具型访问」，不是多用户授权（上游设计亦如此）。需要一次 spike 确认上游在改回环 Origin 的转发下对 cookie/Origin 的精确校验（见阶段 4 注记）。
- **选项 B（保守冻结）：** 在完成 spike 前，网关只转发匿名安全的静态面与登录之后的明确白名单；`/api` 与未知路径默认拒绝。功能上等效于关闭远程 GUI，优先保安全。
- 本方案按 A 展开；B 只是缩小 A 的放行集合，不改变阶段 2–6 的代码改动。

## 5. 阶段 2 —— 认证策略默认收紧（F1）

**目标：** 把「LAN/loopback 免密」从默认行为改为显式 opt-in；`authRequired:true` 约束所有来源而非仅 `internet`；不安全旧配置拒绝启用。

现状锚点：`src/gateway.ts:175`（只对 `internet` 判 Cookie）、`src/gateway.ts:290`（upgrade 同样只对 `internet`）、`src/auth.ts:84-106`（loopback / `lanCidrs` / `fe80::/10` 自动免密分支）、配置默认 `src/index.ts:131-133`、启停守卫 `src/index.ts:241-250`。

**建议的配置重塑（含迁移，字段名可再议）：**

| 字段 | 现义 | 建议新义 | 默认 |
| --- | --- | --- | --- |
| `authRequired` | 非 LAN 是否需要密码 | **固定为 true；删去设为 false 的能力** | `true` |
| `lanCidrs` | 免密网段 | 仅描述「已知内网」，用于 UI 提示与作为可选免密的匹配集 | `[]` |
| `lanPasswordless`（新） | — | `lanCidrs`/link-local 来源**是否豁免网关登录**的显式开关 | `false` |
| `upstreamSessionAuth`（新） | — | 底座已带真实会话鉴权的自述标记，供 fail-closed 校验 | 默认 `false`，需显式开启 |

**规则：**
1. 鉴权门翻转：`needsAuth(source)` 在**默认**对 loopback/lan/internet 全部返回 true；仅当 `lanPasswordless === true` 且来源命中受信集合时才返回 false。loopback 不再自动豁免——**经网关到达的 loopback 恰恰是反代/隧道转接的外部用户形态**（F1 的实证），真·本机用户直接访问原生 loopback dsh 端口即可，不走网关，无需在网关上加本地豁免。
2. `startGateway` 守卫（`src/index.ts:243`）扩展为 fail-closed：
   - 未设密码 → 拒绝启动（现状已做，保留）；
   - `lanPasswordless === true && upstreamSessionAuth !== true` → **拒绝启动**并提示先升级底座/显式声明（否则等于复现 QVD）；拒绝信息不得诱导降级到 `authRequired:false`（现状错误信息里就有这一句，见 `src/index.ts:249`）。
   - 检测到旧配置残留（`authRequired:false`、旧默认 `lanCidrs` 非空且从未声明 `lanPasswordless`）→ 拒绝并给出迁移文案，**不静默继续**。
3. `listenerKey`（`src/index.ts:158`）与 client 卡片字段模型（`src/client/lan-gateway-card.tsx:34-47`、`FIELDS`）随新字段同步；卡片 UI 文案（`src/client/lan-gateway-card.tsx:107-112` 等）改写「免密 LAN 网段」为「可选的免密网络（默认关闭）」。

**验收（新的预期行为，见阶段 7 回归表）：**
- 无凭据的回环/LAN/公网来源一律 302 登录（默认关闭）；
- `lanPasswordless:true` 且来源命中 → 网关放行，但仅在 `upstreamSessionAuth:true` 时能启动；
- 任何将 `authRequired` 置 false 的提交被拒绝。

## 6. 阶段 3 —— 配置/管理面鉴权（F2）

现状锚点：`src/index.ts:208-226`（`isTrustedRequest`：只验回环 Host；Origin 缺失直接通过）、`src/index.ts:327-405`（路由注册在原生 `ctx.webServer`，经网关转发时 Host 已被改写为回环，未登录即可读写）。

根因：管理路由「可经网关改写 Host 触达」+「只信 Host」= 远程未认证改安全策略。修复必须断开其中一环。

**决策点 DP-3：管理入口归属。**
- **选项 A（推荐，改动最小）：网关拒绝转发本插件自有前缀。** 网关对 `/lan-gateway/*`（含 `/lan-gateway/config`）与 `/__login` 一律不转发——未认证直接 `404`/`403`，不把请求送到上游。于是原生配置路由只剩**真·本地可达**一种路径（原生端口仅绑回环且不再被网关转发），其 Host-only 检查退化为「本地 bootstrap」，可接受（真·本机用户本就拥有 `~/.dsh` 与 CLI）。
  - 代价：远端 GUI 无法改配置；远端管理改走 `lan_gateway` 工具（由本机 dsh 会话的模型 agent 执行，见 `src/tool.ts`）。这符合「改安全策略是高危操作」的原则。
- **选项 B：管理路由迁入已认证网关。** 网关自持 `/lan-gateway/config`，要求与 GUI 相同的已登录会话 + 写操作 CSRF/Origin 校验。保留原生 loopback 路由作本地恢复，但同样收紧（见下）。改动更大，保留远端 GUI 管理。

**两选项都需做的收紧（原生配置路由，`src/index.ts:208-226`）：**
- 状态改变（POST）必须携带 Origin 且 `origin.host === host`；Origin 缺失 → 拒绝（现状 `origin === undefined → true` 是 F2 的漏洞点，删掉）。
  - **0.7.1 起改为「Origin 存在时才比较」**（与 dsh 自己的 `isTrustedApiRequest` 一致）：桌面版把界面挂在 `dsh-app://app` 来源上，其转发桥（`dsh-desktop-host` 的 `forwardWebRequest`）会删掉 `origin` / `sec-fetch-site` 再打回回环，于是「写操作必须带 Origin」让桌面卡片每次保存都 403（能读不能写）。F2 的本体——**经网关**把远端未认证请求改写成回环 Host 后触达该路由——由网关对 `/lan-gateway*` 前缀的 403（本文件第 6 节）与实际回环绑定承担，不受此条影响；本机非浏览器客户端本就能自设 Origin，该条从未拦住它。
- 保留回环 Host 要求（它同时挡掉 DNS rebinding：域名无法以字面回环主机名通过）。
- `sec-fetch-site: cross-site` 拒绝（保留）。
- 体积/频率限制沿用 `readBody(req, 64*1024, res)`（已 64KiB）。

**验收：** 经网关请求 `/lan-gateway/config` → 网关直接 403，不触达上游；原生路由 POST 无 Origin/跨站 Origin → 403（前半条 0.7.1 起改为放行，见上）；GET 同源（卡片正常路径）→ 200；设置服务可用时，卡片保存仍工作（含桌面版）。

## 7. 阶段 4 —— HTTP/WS 统一鉴权与路径处理（F3）

现状锚点：`src/gateway.ts:182-189`（CSRF 只对 `/api`、`/api/` 前缀）、`src/gateway.ts:288-296`（upgrade 完全不查 CSRF，反而直接改写 Origin）、`src/gateway.ts:183`（`startsWith('/api/')` 可被点段路径绕过，如 `/unused/../api/…`）。

**目标：把「需要会话」与「是否跨站」从『按 `/api` 前缀特判』改为『除匿名白名单外全路径默认』。** 这样点段路径、升级路径、其他插件路径都落入同一判定，不再依赖前缀枚举。

统一请求门（HTTP 与 upgrade 共用，放在任何 Host/Origin 改写**之前**）：

1. **匿名白名单（唯一例外，网关自持且不转发）**：`GET/HEAD /__login`、`POST /__login`（带登录限流 `RateLimiter`）。其余一律先鉴权。
2. **会话检查**：`authorized(req)`（`src/gateway.ts:134`）——若策略要求（默认全来源），无有效 Cookie → HTTP `302 /__login` / WS `401` 关闭。
3. **跨站检查（浏览器 CSRF）**：覆盖 HTTP **与** upgrade：
   - `sec-fetch-site: cross-site` → 拒绝；
   - 有 Origin 时必须与「浏览器实际使用的网关 authority（scheme+host+port）」匹配——不是只比 host 字符串（`src/gateway.ts:201-205` 现只比 host，且 `stripDefaultPort` 只剥 80/443）;
   - 状态改变（`POST/PUT/PATCH/DELETE`）与 **WS upgrade** 必须有 Origin 且匹配；缺失即拒。
   - 说明：CSRF 防的是浏览器会话，比较 Origin 与 Host 是标准反代同源判法；对非浏览器客户端，会话 + 来源分类已承担认证，不依赖此层。
4. **路径规范化**：先做 RFC 3986 点段归一（或直接改为上述「默认全鉴权」，前缀匹配不再承担安全职责，`..` 问题随之消失）。不依赖规范化后是否真的路由到 `/api`。
5. **转发**：`forward`/`handleUpgrade` 里的 Host/Origin 改写（`src/gateway.ts:260-263`、`299-302`）只承担目标解析；在选项 A 下还要把网关持有的**上游会话 Cookie** 附加到转发请求（阶段 1 spike 确认上游对 Origin/Cookie 的精确要求后再定）。
6. **upgrade 长连接**：升级成功前完成 1–3；成功后若 `setState`/轮换发生，按阶段 5 的销毁策略处理。

**验收：** 同一组跨站头，普通 HTTP 与 WS upgrade 都被拒；带点段的 API 路径在无会话时同样被拒；持有效会话的同源请求在 HTTP/WS 均放行。

## 8. 阶段 5 —— 会话生命周期与撤销（F5）

现状锚点：`src/state.ts:50-60`（`setPassword` 保留 `cookieSecret`）、`src/index.ts:439-453`（改密/清密不动密钥）、`src/index.ts:454-463`（`rotateSecret` 是唯一吊销手段）、Cookie 签发 `src/gateway.ts:243-252`（无撤销版本）、`src/gateway.ts:134`（只验 HMAC+过期）。

**建议实现：会话代次（epoch）。**
1. `state.json` 增加 `sessionEpoch: number`（`loadState` 缺失时按 0 处理，向后兼容旧文件）。
2. `signCookie(secret, epoch, expiresMs)` 把 epoch 编入 payload；`verifyCookie` 返回时同时校验 `epoch === state.sessionEpoch`（`src/auth.ts:119-147`、`src/gateway.ts:134-137`）。
3. 变更语义：
   - `set-password`（改密或清密，`src/index.ts:439`）→ **递增 epoch**（旧 Cookie 全失效），写盘后 `gateway.setState(...)`；
   - 清空密码 → 递增 epoch **并 `stopGateway()`**（现状允许「清密后继续接受未过期旧 Cookie」，必须关闭入口；错误文案 `src/index.ts:451` 声称清密后非 LAN 变免密，与实际不符，一并改）。
   - `rotate-secret` 保留（换密钥），可同时递增 epoch。
4. **登出路由**：网关自持 `POST /__logout`（`SameSite`/CSRF 校验内）签发立即过期的同名 Cookie；补充进匿名白名单（登录/登出同属匿名例外）。
5. **Cookie 属性**：`HttpOnly; SameSite=Strict; Path=/; Max-Age=…`；TLS 或可信终止入口时追加 `Secure`（现状 `SameSite=Lax` 且 TLS 外无 Secure，`src/gateway.ts:250-251`）。Strict 对本网关自持页面成立（登录/登出/页面同站），比 Lax 更适合给反代做 CSRF 兜底。
6. **长连接撤销**：`LanGateway` 记录每个升级成功的 duplex（`handleUpgrade` 里 `proxySocket`/`socket`）；`setState` 在 epoch 变化时销毁这些 socket（现状 `closeAllConnections` 不覆盖 upgrade 后的连接）。策略需写清：撤销即时断开，客户端重连需重新登录。

**验收：** 改密/清密后旧 Cookie 立即失效（HTTP 302、WS 401）；清密后监听停止；登出后 Cookie 失效；升级后的 WS 在轮换时被关闭。

## 9. 阶段 6 —— 传输安全默认（F4）

现状锚点：`tlsEnabled` 默认 false（`src/index.ts:135`）、`resolveTls`（`src/index.ts:144`）、Secure 仅当网关自持 TLS（`src/gateway.ts:245`）。

**规则（fail-closed 而非默认裸奔）：**
1. 引入「加密入口」判定：`tlsEnabled === true`（自持 HTTPS），**或**显式声明的可信 TLS 终止反代（新配置 `trustedTerminator`，声明反代已做加密）。**绝不**依据来访者可伪造的 `X-Forwarded-Proto` 判断（现状没有依赖它，继续保持不依赖，并明确写死这一点）。
2. 在「加密入口」为假、且策略可能放行任何非 loopback 来源（默认即如此）时，`startGateway` **拒绝启用**，除非显式 `allowInsecurePlaintext: true`（迁移提示 + status 红字）。
3. 加密入口为真时：Cookie 加 `Secure`；自持 HTTPS 加 HSTS（`src/gateway.ts:158-162` 已按 TLS 区分，保留）。自签名属预期（README 已声明），但文案要提示首次访问浏览器警告。
4. 登录页与登录 POST 与 GUI 同源同传输，不存在「明文登录 + 加密浏览」的混合窗口。

**验收：** 无 TLS、无可信终止、无显式 `allowInsecurePlaintext` 时 enable 被拒；配置了可信入口后 Cookie 带 Secure；`X-Forwarded-Proto` 伪造不改变判定。

## 10. 阶段 7 —— 自动化回归（补上真实网关集成测试）

现状测试缺口（SECURITY-AUDIT 已点明）：`tests/gateway.test.ts` 只测纯函数原语，**没有实例化真实 `LanGateway`**，无 HTTP/WS/配置路由集成断言。原 39 项通过不能证明鉴权边界。

**要新增的测试基建：**
1. `LanGateway` 增加**可注入的来源分类器**（构造参数或 setter，注入假 `remoteAddress` 分类），使集成测试能在 `127.0.0.1` 随机端口上真实监听，却能模拟 LAN/公网来源——不必真的做来源地址欺骗。
2. 用仓库现成 `tsx` 起：网关（随机回环端口）+ 假上游 HTTP/WS 服务 + 内存 settings 替身 + 临时 HOME（沿用审计脚本 `/tmp/dsh-gateway-security-audit.mts` 的做法，但作为仓库内正式测试固化）。
3. 新测试目录建议 `tests/integration/gateway.test.ts`。

**回归矩阵：把 SECURITY-AUDIT 的 13 个隔离观察按「修复后预期」固化为断言。**

| # | 场景 | 修复后预期（本方案） |
| --- | --- | --- |
| 1 | 回环来源，无凭据 | 302 → `/__login`，不转发 |
| 2 | 模拟 LAN 来源，无凭据（默认关闭） | 302 → `/__login` |
| 3 | 模拟公网来源，无凭据 | 302 → `/__login` |
| 4 | `lanPasswordless:true`+`upstreamSessionAuth:true`，LAN 来源无凭据 | 放行至上游（豁免仅网关层） |
| 5 | `lanPasswordless:true` 但 `upstreamSessionAuth:false`，enable | 拒绝启动（fail-closed） |
| 6 | LAN，跨站 HTTP API（有会话） | 403（Origin/Host 不匹配） |
| 7 | LAN，同跨站头，WS upgrade | 拒绝（upgrade 不再绕行） |
| 8 | 带点段的 API 路径，无会话 | 302/403（默认全鉴权，无前缀漏洞） |
| 9 | 经网关请求 `/lan-gateway/config` | 网关 403，不触达上游 |
| 10 | 原生配置路由，回环 Host + POST 无 Origin | 403 **（0.7.1 起改为 200：桌面版转发桥会剥掉 Origin，见 6 节；跨站标记与不匹配的 Origin 仍 403）** |
| 11 | 原生配置路由，同源 GET（卡片路径） | 200 |
| 12 | 正确登录 + Cookie（加密入口） | 302 + 200；Cookie `Secure; HttpOnly; SameSite=Strict` |
| 13 | 改密/清密后旧 Cookie | 立即失效；清密后监听停止 |
| 14 | 无 TLS/可信终止/无显式明文开关 | enable 拒绝 |

原单元测试（`tests/gateway.test.ts`、`tests/tls.test.ts`、`tests/x509.test.ts`、`tests/uuid-shim.test.ts`）在字段/函数签名变更处同步更新。

## 11. 文件级改动清单

| 文件 | 改动 |
| --- | --- |
| `src/auth.ts` | `classifySource` 语义改为「仅匹配显式受信集」，移除隐含的 loopback/`fe80`/CIDR 免密含义（或保留分类值但网关不再据此免密）；`signCookie`/`verifyCookie` 增加 `epoch`；CSRF/Origin 比较工具函数。 |
| `src/gateway.ts` | 鉴权门改「默认全来源」；`authorized()` 校验 epoch；HTTP 与 upgrade 共用同一「匿名白名单 + 会话 + 跨站」门；WS upgrade 增加跨站/Origin 检查；登录 Cookie 加 `Secure`(条件)/`SameSite=Strict`/登出路由；跟踪并销毁升级后的 socket；不再转发 `/lan-gateway/*` 与 `/__login`；来源分类器可注入。 |
| `src/index.ts` | 配置重塑与 fail-closed（`authRequired` 恒真、`lanPasswordless`/`upstreamSessionAuth` 新字段、迁移文案）；`listenerKey`/schema/client 字段同步；`setPassword` 递增 epoch 并据清密关停；原生配置路由 POST 要求 Origin；`startGateway` 加密入口判定。 |
| `src/state.ts` | `GatewayState` 增加 `sessionEpoch`；`loadState`/`saveState` 兼容旧文件；`setPassword` 返回新 epoch。 |
| `src/login.ts` | 登出页/处理（或放 `gateway.ts`）；匿名白名单常量集中。 |
| `src/tool.ts` | `lan_gateway` 增加 `logout` 等命令（如需）；`status` 输出新字段；错误/迁移文案同步。 |
| `src/tls.ts` / `src/x509.ts` | 基本不动（证书生命周期已完备）。 |
| `src/client/lan-gateway-card.tsx` + `src/client/index.ts` | 卡片字段/文案/保存契约随新配置与「远端管理走工具」变化；GET 需容忍新 403 语义（只读展示）。 |
| `tests/*` | 原单测同步 + 新增 `tests/integration/gateway.test.ts`（上表回归）。 |
| `cordis.patch.yml` | 只放安全默认（`enabled:false`、`lanPasswordless:false`、无 `lanCidrs` 免密暗示）。 |
| `README.md`、`skills/lan-gateway.md`、`INSTALL.md` | 「LAN/loopback 来源免密代理」等话术改为「默认全来源登录；LAN 免密需显式开启」；补迁移说明与安全模型章节。 |

建议版本：**0.5.0**（安全加固 + 默认行为变化；若按严格 semver，默认鉴权变化可视为破坏性，可考虑 1.0.0——至少是 minor 及以上，并在 changelog 突出迁移）。

## 12. 上游核对清单（阶段 0 的验收细节）

- 升级后**首次以网关为反代做冒烟**：不带任何网关会话的请求应 302；即便把 Host 手工改成 `127.0.0.1:dshPort` 也不应得到已鉴权 API 的 200 —— 证明上游不再把 Host 当身份。
- 记录上游版本的确切 tag/commit，避免「讨论区旧回复」「Context7 新旧混杂」造成误判（口径与 [上游研究](qvd-2026-57410-research.md) 一致）。
- spike 记录项：已修复上游对「改回环 Origin 的转发 + 共享上游 Cookie」的精确校验（cookie Domain/Path 绑定、写操作 Origin 校验、token 交换在启动时的一次性），作为阶段 1 选项 A 的实现依据；未完成 spike 前按选项 B 保守放行。

## 13. 残余风险与明确边界（诚实声明）

- 本方案选定的模型**不是**全面零信任：LAN 免密 opt-in 开启后，网关不再对命中来源校验登录，底座若无独立鉴权（未做阶段 0 升级 + 声明 `upstreamSessionAuth` 前被 fail-closed 挡住）仍是 QVD 形态。fail-closed 把这条路挡住，但**不会**把「运行中且已放宽」的实例自动吊销——放宽是运维显式选择。
- 「单密码 = 单会话 = 完整工具型 Host API」不是多用户授权或审计；引入登录页不等于零信任架构（上游设计同此边界，见上游研究）。
- 原生 loopback 配置路由在「网关不转发 + 原生端口仅回环」下退化为本地 bootstrap；本机恶意进程本就能读写 `~/.dsh`，不在本方案威胁模型内。
- 本方案与上游研究一致：**不声称 QVD-2026-57410 已由本插件或任一发布完全消除**；只列出已核实的加固边界与验收项。

## 14. 实施顺序与完成定义

依赖顺序：阶段 0（上游/处置）→ 阶段 1（DP-1/DP-2 决策 + spike）→ 阶段 2（默认收紧，先做，它挡住其他放宽）→ 阶段 5（会话撤销）→ 阶段 6（传输默认）→ 阶段 4（统一门）→ 阶段 3（管理面）→ 阶段 7（回归全绿）→ 文档/卡片文案同步。

每阶段完成定义 = 该阶段验收断言在集成回归中通过 + 无既有单测回归 + 状态/迁移文案与实际行为一致。全部完成后，以 0.5.0 发布，并在 changelog 与 README 写明默认行为变更与迁移步骤。

**待拍板决策点汇总：** DP-1 底座是否已升级；DP-2 网关=会话中继（A）vs 保守冻结（B）；DP-3 管理入口=网关拒转原生路由（A）vs 迁入已认证网关（B）；另有 DP-4 明文策略是否保留 `allowInsecurePlaintext` 逃生口（建议保留但默认拒绝并红字提示）。

---

## 15. 实施状态（0.5.0，2026-09-06）

本方案已按 0.5.0 实施并回归全绿（72 项）。以下是与「计划文本」的实际差异，以本附录为准：

- **DP-1（底座已升级）**：实际部署 harness 已升级到 dsh `0.1.2-rc.1`。本插件的共享会话中继针对
  0.1.2 的 `connection.requestRejection`（403/401 围栏 + `dsh-auth-*` cookie）与
  `authenticatedUrl` 启动令牌交换实现（见 `docs/security/qvd-2026-57410-research.md`）。
- **DP-2 = 选项 A（网关 = 会话中继）**：新增 `src/upstream-session.ts`（`UpstreamSessionRelay`），
  `src/index.ts` 通过可选 `ctx.inject(['connection'], cb)` 检测底座能力并接线；`LanGateway`
  把 `session.peek()` 中继到每个转发请求，上游 401 时 `invalidate()` 丢弃并重换。
- **对计划的一处字段偏差**：计划设想一个布尔配置 `upstreamSessionAuth`；实现改为**自动探测**
  ——底座提供 `connection` 服务即视为「支持浏览器会话认证」。因此没有 `upstreamSessionAuth`
  配置键；`lanPasswordless` 的 fail-closed 依据是 `connection` 服务是否存在。
- **DP-3 = 选项 A**：`/lan-gateway/*`（含 `/lan-gateway/config`）一律被网关 403、绝不转发；
  原生配置路由只对回环 Host + 同源请求应答（`isTrustedConfigRequest`）；远端管理走 `lan_gateway` 工具。
- **DP-4**：保留 `allowInsecurePlaintext` 逃生口，默认 `false`，启动与卡片保存均 fail-closed。
  卡片保存规则：结构性错误（`authRequired:false`、`lanPasswordless` 无会话底座）一律拒绝；
  明文/无加密这类「启动条件」仅当 `enabled:true` 时才拒绝保存（允许先停着、后开 TLS）。
- **`lanCidrs` 默认保留 RFC1918 + link-local**（计划表建议 `[]`）：分级本身不授予访问，
  仅在 `lanPasswordless` 开启时作为豁免匹配集，故保留默认便于分类展示；不放行语义仍成立。
- **`authRequired` 已移除能力**：配置中显式 `false` 被启动守卫与卡片保存双重重定向到迁移文案
  （不静默继续）。
- **会话撤销（F5）**：`state.sessionEpoch` + `signCookie(…, epoch)`；改密/清密/`rotate-secret`
  递增 epoch；`LanGateway.setState` 检测 epoch 变化即销毁已建立 WebSocket；清密调用
  `stopGateway()` 关闭监听。
- **验收行 4/5 的映射**：行 4（LAN 豁免放行）由 `tests/integration/gateway.test.ts` 覆盖；
  行 5（无会话底座时拒启）由 `tests/start-guard.test.ts`（`gatewayStartProblems`）覆盖。
- **本仓库内的集成回归**新增 `tests/integration/gateway.test.ts`（真实 `LanGateway` + 假上游）
  与 `tests/start-guard.test.ts`；README/skills/INSTALL/package description/cordis.patch 注释已同步。
- **现场冒烟遗留**：需要真实 dsh `0.1.2-rc.1` 会话（交互登录）才能做的「浏览器走网关完成一次
  令牌换取」端到端冒烟不在本会话内执行（沙箱无账号）；静态核对结论：`connection.authenticatedUrl`、
  `settings.register/replace`、`tools.defineTool`、client module id `@deepseek-ai/dsh-client-runtime/client`
  均在 0.1.2-rc.1 运行时存在。升级部署后请跑一遍 README「从 v0.4 升级」第 4 步确认。
