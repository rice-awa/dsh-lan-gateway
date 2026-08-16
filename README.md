# dsh-lan-gateway — LAN / 公网网关插件

> 把 DeepSeek Harness 的 Web GUI 安全地开放到局域网 / 公网。
> 附带**不安全源 UUID shim**：网关以纯 HTTP 局域网地址服务页面时，浏览器不提供
> `crypto.randomUUID`，本插件的 client bundle 会在页面加载早期自动补上
> `getRandomValues` 版实现，让工作区（含其他设备打开的工作区）在网关下正常打开。

`dsh` 的 web CLI 会硬拒绝 `--host 0.0.0.0`（避免把远程代码执行暴露到网络），所以本插件
让 dsh 继续只绑 `127.0.0.1`，自己另起一个 `0.0.0.0` 反向代理网关转发到 loopback 端口，
改写 `Host`/`Origin` 以通过 `/api` 信任围栏。**LAN 与 loopback 来源免密代理；非 LAN 来源
必须先完成登录页并出示 HMAC cookie。**

## 特性

- **双端一体**：host 端是反向代理网关（登录 / HMAC cookie / 信任围栏）；client 端是
  不安全源 UUID shim（LAN 纯 HTTP 页面下 `crypto.randomUUID` 缺失的运行时修复）。
- **默认关闭（安全）**：bundle patch 里 `enabled: false`，只有运行 `lan_gateway enable`
  后才监听网络端口。
- **密钥不进配置**：密码哈希、cookie secret 存 `~/.dsh/lan-gateway/state.json`。

## 快速安装（推荐）
请把下面这段话发送给你的agent：
> 帮我从`https://github.com/rice-awa/dsh-lan-gateway`，安装这个dsh插件，遵循`https://github.com/rice-awa/dsh-lan-gateway/blob/main/INSTALL.md`

## 手动安装

### 方式 A：使用官方cli安装

```bash
# 官方装配（重启后由 bundles 列表接管，生产态）
dsh plugin --profile web add github:rice-awa/dsh-lan-gateway

```

### 方式 B：从源码构建

```bash
git clone https://github.com/rice-awa/dsh-lan-gateway.git
cd dsh-lan-gateway
pnpm install
pnpm build          # host（lib/index.js）
pnpm build:client   # client（lib/client.js，window.__ModuleLoader__ 格式）
pnpm test           # 26 项（网关 23 + UUID shim 3）
```

## 使用

```bash
# 开启网关（监听 0.0.0.0:3081，LAN 免密 / 非 LAN 需登录）
lan_gateway enable

# 查看状态
lan_gateway status

# 设置非 LAN 访问密码（≥8 位）
lan_gateway set-password

# 关闭
lan_gateway disable
```

## UUID shim 说明（v0.2.0 新增）

**问题**：网关以 `http://<LAN-IP>:3081` 服务页面，浏览器视其为不安全源，
`crypto.randomUUID()`（secure-context-only）为 `undefined` → 每次 RPC id 铸造抛
`crypto.randomUUID is not a function` → 打不开工作区。

**原理**：client bundle 在**模块级**（一被浏览器求值、早于任何官方代码铸造 id）给
`Crypto` 原型补一个 `crypto.getRandomValues()` 版 `randomUUID`（RFC 4122 v4；
`getRandomValues` 在所有源都可用）。安全源 / Node ≥19 下为 no-op，不影响任何行为。

**覆盖范围**：对官方所有 `crypto.randomUUID()` 调用点（含未来新增）一律生效，
无需改动 DSH 源码。

## 测试

```bash
pnpm test
# ✓ tests/gateway.test.ts   (23) 网关代理 / 登录 / HMAC / 信任围栏
# ✓ tests/uuid-shim.test.ts ( 3) 不安全源补丁 / 安全源 no-op / v4 正确性
```

## 许可

[MIT](./LICENSE)
