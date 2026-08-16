<p align="center">
  <img src="assets/banner.webp" alt="dsh-lan-gateway — 把 DeepSeek Harness 的 Web GUI 安全地开放到局域网 / 公网" />
</p>

<h1 align="center">dsh-lan-gateway — LAN / 公网网关插件</h1>

<p align="center">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-4d6bfe?logo=deepseek&logoColor=fff&style=flat-square" alt="DeepSeek Harness" />
  <img src="https://img.shields.io/badge/version-0.3.0-2b7fff?style=flat-square" alt="version 0.3.0" />
  <img src="https://img.shields.io/badge/TLS-8b5cf6?logo=lock&logoColor=fff&style=flat-square" alt="TLS" />
  <img src="https://img.shields.io/github/license/rice-awa/dsh-lan-gateway?style=flat-square" alt="MIT license" />
</p>

> 把 DeepSeek Harness 的 Web GUI 安全地开放到局域网 / 公网。
> 附带**不安全源 UUID shim**：网关以纯 HTTP 局域网地址服务页面时，浏览器不提供
> `crypto.randomUUID`，本插件的 client bundle 会在页面加载早期自动补上
> `getRandomValues` 版实现，让工作区（含其他设备打开的工作区）在网关下正常打开。
> 附带**TLS 支持**：可用自动生成并持久化的**自签名证书**，或挂载**自己申请/签发的
> PEM 证书**，让网关以 HTTPS 服务（自签名证书首次访问会看到浏览器警告，属预期行为）。

`dsh` 的 web CLI 会硬拒绝 `--host 0.0.0.0`（避免把远程代码执行暴露到网络），所以本插件
让 dsh 继续只绑 `127.0.0.1`，自己另起一个 `0.0.0.0` 反向代理网关转发到 loopback 端口，
改写 `Host`/`Origin` 以通过 `/api` 信任围栏。**LAN 与 loopback 来源免密代理；非 LAN 来源
必须先完成登录页并出示 HMAC cookie。**

## 特性

- **双端一体**：host 端是反向代理网关（登录 / HMAC cookie / 信任围栏 / TLS）；client 端是
  不安全源 UUID shim + **官方设置页卡片**（DSH Settings → Plugins → 可配置插件，网关的
  端口 / 网段 / 认证 / TLS 全部可视化调整，保存即热生效）。
- **TLS 双模式**：`self-signed` 自动生成自签名证书（首次启动生成并持久化到
  `~/.dsh/lan-gateway/tls/`，重启复用；`lan_gateway tls-regenerate` 可换新证书），或
  `custom` 直接挂载你自己的 PEM 证书与私钥（如 Let's Encrypt / 自建 CA 签发）。
- **默认关闭（安全）**：bundle patch 里 `enabled: false`，只有运行 `lan_gateway enable`
  后才监听网络端口。
- **密钥不进配置**：密码哈希、cookie secret 存 `~/.dsh/lan-gateway/state.json`。

## 快速安装（推荐）

请把下面这段话发送给你的 agent：

> 帮我从 `https://github.com/rice-awa/dsh-lan-gateway` 安装这个 dsh 插件，遵循
> `https://github.com/rice-awa/dsh-lan-gateway/blob/main/INSTALL.md`

## 配套 skill

仓库还带一个 [lan-gateway](skills/lan-gateway.md) 技能：让 dsh 的 agent 在对话中
自动管理网关——开/关监听、设置或更换远程访问密码、轮换会话密钥、查看状态。装上后
直接说「设置网关密码为 …」「开启远程访问」即可，agent 会调用 `lan_gateway` 工具
完成（密码以参数传入，不写入配置、不回显）。安装方式见
[INSTALL.md](INSTALL.md#for-agents完整安装流程)。

## 移动端访问（推荐）

在手机 / 平板上通过网关访问 GUI 时，桌面布局体验不佳。推荐同时安装
[dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)（移动端 UI 适配），
与本插件配合使用：

```bash
dsh plugin --profile web add github:mexiaosqwq/dsh-web-mobile
```

## 手动安装

### 方式 A：使用官方 CLI 安装

```bash
# 官方装配（重启后由 bundles 列表接管，生产态）
dsh plugin --profile web add github:rice-awa/dsh-lan-gateway
```

> **注意**：`dsh plugin ... add` 把剩余参数转发给 profile 目录里的 pnpm。安装本插件时
> pnpm 会要求先在其构建脚本白名单（`allowBuilds`）中批准本包，否则报
> `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。把报错提示中的条目（或 `pnpm approve-builds`
> 的选项）写进 `~/.dsh/profiles/web/pnpm-workspace.yaml` 再重试即可。完整步骤见
> [INSTALL.md](INSTALL.md#for-agents完整安装流程)。

### 方式 B：从源码构建

```bash
git clone https://github.com/rice-awa/dsh-lan-gateway.git
cd dsh-lan-gateway
pnpm install
pnpm build          # host（lib/index.js）
pnpm build:client   # client（lib/client.js，window.__ModuleLoader__ 格式）
pnpm test           # 38 项（网关 23 + UUID shim 3 + x509 4 + TLS 6）
```

## 使用

```bash
# 开启网关（监听 0.0.0.0:3081，LAN 免密 / 非 LAN 需登录）
lan_gateway enable

# 查看状态
lan_gateway status

# 设置非 LAN 访问密码（≥8 位）
lan_gateway set-password

# 换发自签名 TLS 证书（tlsMode=self-signed 时；换新密钥并热重启监听器）
lan_gateway tls-regenerate

# 关闭
lan_gateway disable
```

> `lan_gateway` 是一个模型可调用的工具，上面的命令不必由你手动敲——**直接在 dsh 对话
> 里说即可**，例如“设置网关密码为 ……”（模型会调用 `lan_gateway set-password`，密码以
> 参数传入、不会回显）、“查看网关状态”、“开启 / 关闭网关”。在对话中设置密码时请直接
> 把密码说给模型，它不会把密码写进任何配置文件。

## 配置项（bundle patch / `--patch` 覆盖，或官方设置页）

所有可调项都同时暴露为 `lan-gateway` 用户设置命名空间：打开 **DSH 的 Settings → Plugins
→ 可配置插件**，展开「LAN 网关」卡片即可修改，保存即生效（监听器会按新配置自动重启）。
下表即卡片字段 / 配置键：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否在启动时监听网络端口 |
| `gatewayPort` | `3081` | 网关监听端口（`0.0.0.0`） |
| `dshTargetPort` | 跟随 `ctx.webServer.port` | 转发到的 dsh loopback 端口 |
| `lanCidrs` | RFC1918 + link-local（见下） | 免密的受信 LAN 网段（逗号分隔） |
| `authRequired` | `true` | 非 LAN 来源是否需要登录 |
| `cookieMaxAgeDays` | `7` | 会话 cookie 有效期（天） |
| `cookieName` | `dsh_gw_auth` | 会话 cookie 名（不进卡片） |
| `tlsEnabled` | `false` | 是否以 HTTPS（TLS）提供服务 |
| `tlsMode` | `self-signed` | 证书来源：`self-signed` 自动生成 / `custom` 用自己的证书 |
| `tlsSelfSignedHosts` | `localhost` | 自签名证书的 SAN（逗号分隔的域名 / IP） |
| `tlsCertPath` | — | `custom` 模式：PEM 证书（或证书链）绝对路径 |
| `tlsKeyPath` | — | `custom` 模式：PEM 私钥绝对路径 |
| `tlsCertMaxAgeDays` | `825` | 自签名证书有效期（天） |

自签名证书在**首次启用 TLS 时生成一次**，持久化于 `~/.dsh/lan-gateway/tls/`
（`selfsigned.crt` / `selfsigned.key`，0600），之后重启复用同一张证书；
`lan_gateway tls-regenerate` 可随时换发新证书（新密钥）并热重启监听器。
配置示例（`--patch`）：

```yaml
- id: dsh-lan-gateway
  config:
    enabled: true
    gatewayPort: 8443
    tlsEnabled: true
    tlsMode: self-signed
    tlsSelfSignedHosts: localhost, 192.168.1.5
```

或用自己的证书（例如 `/etc/letsencrypt/live/example.com/` 下签发的 PEM）：

```yaml
- id: dsh-lan-gateway
  config:
    tlsEnabled: true
    tlsMode: custom
    tlsCertPath: /etc/letsencrypt/live/example.com/fullchain.pem
    tlsKeyPath: /etc/letsencrypt/live/example.com/privkey.pem
```

启用 TLS 后访问 `https://<主机>:<端口>/`；登录 cookie 自动带 `Secure`，网关自身响应
（登录页 / 重定向 / 拒绝）带 HSTS。自签名证书首次访问会看到浏览器警告，属预期行为。

默认 `lanCidrs`：`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`，
IPv6 的 `fe80::/10`（link-local）与回环地址始终免密。

## 安全模型

- **来源分级**：仅依据 `socket.remoteAddress`（IPv4-mapped IPv6 会先解包）把请求分为
  loopback / lan / internet 三档，绝不信任 `X-Forwarded-For`。
- **免密**：LAN 与 loopback 来源直接代理；`internet` 来源（`authRequired: true` 时）
  必须携带有效 HMAC 会话 cookie，否则 302 到 `/__login` 登录页。
- **登录页**：`/__login` 由网关独占、不转发；密码以 scrypt（每写一次重新加盐）校验，
  登录尝试按来源限流（5 次 / 分钟）。
- **会话 cookie**：`payload.signature` 结构（HMAC-SHA256），`HttpOnly; SameSite=Lax`，
  过期后（`cookieMaxAgeDays`）即失效；`lan_gateway rotate-secret` 可作废全部会话。
  启用 TLS 后自动附加 `Secure`。
- **TLS**：监听器为 HTTPS 时，登录成功签发 `Secure` cookie，网关自身响应带 HSTS
  （`max-age=15552000`）；转发到 dsh 的 loopback 连接仍为明文 HTTP（不出本机）。
- **CSRF 围栏**：因为网关把 Origin 改写回 loopback、会蒙蔽 dsh 自身的 CSRF 防线，网关在
  转发前会对 `/api*` 请求自检 `sec-fetch-site` 与 Origin 是否匹配网关的权威来源，
  跨站请求直接 403。
- **密码未设置时拒启**：`authRequired: true` 且未设密码时，`enable` 会拒绝监听——避免
  把远程代码执行的门户开放给非 LAN 来源。
- **WebSocket**：`/api` 升级请求同样过登录校验，再原样拼接转发给 dsh。

## 登录页截图（预期）

非 LAN 来源打开 `http://<主机>:3081/` 时，先看到网关自带的登录表单（`/__login`），
输入正确密码后签发会话 cookie 并跳回 `/`。

<p align="center">
  <img src="assets/login-screenshot.webp" alt="网关登录页截图" width="320" />
</p>

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
# ✓ tests/x509.test.ts      ( 4) 自签名证书 DER/SAN/签名/TLS 握手
# ✓ tests/tls.test.ts       ( 6) 证书持久化 / 重生成 / 自定义证书加载
```

## 许可

[MIT](./LICENSE)
