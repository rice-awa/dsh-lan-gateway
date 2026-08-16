# dsh-lan-gateway 安装指南

把 DeepSeek Harness 的 Web GUI 安全地开放到局域网 / 公网（含 TLS 与官方设置页
卡片）。功能与用法见 [README](README.md)；本文件只有一件事：**装好它**。

本文件分两条路径：

- **For agents** —— 给 dsh / Claude 等 agent 的完整执行流程（含 allowBuilds 等
  坑位与验证步骤），把这段话发给 agent 让它自己读完照做即可。
- **For humans** —— 给真人用户的两分钟速览（你只需要用一两条命令，不用管细节）。

---

## For agents：完整安装流程

### 1. 安装插件本体

```bash
dsh plugin --profile web add github:rice-awa/dsh-lan-gateway
```

> `dsh plugin ... add` 把剩余参数转发给 profile 目录里的 pnpm；`--profile` 必填。
> 安装成功后插件会自动被加入 `~/.dsh/profiles/web/package.json` 的依赖与
> `dsh.profile.bundles` 列表，无需手工编辑。

### 2. 处理 allowBuilds 审批

git 安装会运行包的 `prepack` 构建脚本（tsdown 构建 host + client 两个 bundle），
pnpm 11 默认拦截，报错形如：

```
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package ...
Add the package to "allowBuilds" in your project's pnpm-workspace.yaml to allow it to run scripts.
```

把报错提示给出的条目（形如 `@dsh-external/dsh-lan-gateway@<来源>#<提交>: true`）原样
追加到 `~/.dsh/profiles/web/pnpm-workspace.yaml`：

```yaml
allowBuilds:
  "@dsh-external/dsh-lan-gateway@https://codeload.github.com/rice-awa/dsh-lan-gateway/tar.gz/<提交>: true"
```

条目里的 `<提交>` 随版本变化，以实际报错为准；也可运行 `pnpm approve-builds`
交互选择。批准后**重新执行第 1 步的 add 命令**。

> 原理：git 安装会在 pnpm 临时目录里重建依赖并运行该包构建脚本。包自身与依赖
> （如 esbuild）的构建可能都需要批准，按报错提示逐条补进 `allowBuilds` 即可。

### 3. 决定启动方式（默认不自动启动）

插件默认 `enabled: false`——**不自动监听**。两种用法：

- **按需开启**（默认推荐）：什么都不改，装好即用。之后在对话里让 agent 执行
  `lan_gateway enable`。
- **开机自启**：在 `~/.dsh/profiles/web/cordis.patch.yml` 把 `enabled` 改为 `true`：

  ```yaml
  - id: dsh-lan-gateway
    config:
      enabled: true
  ```

### 4. 安装配套 skill

让 agent 在对话里直接管理网关（开/关、设密码、轮换密钥、查状态、换 TLS 证书）。
复制到任一 skill 发现根即可（有 watcher，放进去即生效，**无需重启**）：

```bash
mkdir -p ~/.dsh/skills
cp ~/.dsh/profiles/web/node_modules/@dsh-external/dsh-lan-gateway/skills/lan-gateway.md \
   ~/.dsh/skills/
```

> 其他发现根：`${DSH_AGENTS_HOME:-~/.agents}/skills/`、`<项目根>/.agents/skills/`。
> 从源码仓库安装时，源文件在 `<仓库路径>/skills/lan-gateway.md`。
> skill 的 frontmatter 已含 `name` 与 `description`（dsh 解析必需字段）；
> `user-invocable` 用 kebab-case 写法（驼峰旧键会被 dsh 拒绝）。

### 5. 重启 dsh 并验证

```bash
dsh --profile web
```

验证三点：

- **包已就位**：`ls ~/.dsh/profiles/web/node_modules/@dsh-external/dsh-lan-gateway/lib`
  应看到 `index.js`、`client.js`、`index.d.ts`。
- **监听开启**：对话里执行 `lan_gateway enable`（首次需先设密码，见下），日志应出现
  `dsh-lan-gateway: listening on 0.0.0.0:3081 -> 127.0.0.1:<dsh端口>`。
- **skill 生效**：对话里说「网关状态」，agent 应能调用 `lan_gateway` 工具。

### 6. 首次使用：设置密码（必做）

网关默认 `authRequired: true`——非 LAN 来源必须登录。未设密码时 `lan_gateway
enable` 会**拒绝监听**（防止把 RCE 门户开放给非 LAN 来源）。让 agent 执行：

- `lan_gateway set-password` 且 `password: <≥8 位密码>`——设置登录密码。
- `lan_gateway enable`——开启监听。

> 只有把 `authRequired` 配成 `false` 才会允许无密码监听，仅适合完全受信的 LAN
> 环境。

---

## For humans：两分钟速览

### 推荐：让 agent 装

把下面这段话发给你的 dsh agent，剩下的事它都会做：

> 帮我从 `https://github.com/rice-awa/dsh-lan-gateway` 安装这个 dsh 插件，遵循
> `https://github.com/rice-awa/dsh-lan-gateway/blob/main/INSTALL.md`

### 手动装（一条命令）

```bash
dsh plugin --profile web add github:rice-awa/dsh-lan-gateway
```

- 若报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`：按报错提示把那条 `allowBuilds`
  条目补进 `~/.dsh/profiles/web/pnpm-workspace.yaml`，重新执行上面的命令。
  详细说明见 [For agents 第 2 步](#2-处理-allowbuilds-审批)。
- 重启 dsh 后，在对话里说 **「设置网关密码为 …」→「开启远程访问」** 即可。
  （`lan_gateway` 是模型可调用工具，密码以参数传入、不写入配置、不回显。）

### 可选：装配套 skill

```bash
mkdir -p ~/.dsh/skills
cp ~/.dsh/profiles/web/node_modules/@dsh-external/dsh-lan-gateway/skills/lan-gateway.md \
   ~/.dsh/skills/
```

装好后 agent 就能在对话里直接管理网关（开/关、设密码、查状态）。

---

## 开发者：从源码构建

```bash
git clone https://github.com/rice-awa/dsh-lan-gateway.git
cd dsh-lan-gateway
pnpm install
pnpm build          # host：lib/index.js + lib/index.d.ts
pnpm build:client   # client：lib/client.js（window.__ModuleLoader__ 格式）
pnpm test           # 38 项（网关 23 + UUID shim 3 + x509 4 + TLS 6）
```

构建产物在 `lib/`（已被 `.gitignore` 排除，不随仓库提交）。

以本地链接装进 profile（等价于 npm link）：

```bash
cd ~/.dsh/profiles/web
pnpm add "link:/path/to/dsh-lan-gateway"
```

## 常见问题

- **`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`**：见 [For agents 第 2 步](#2-处理-allowbuilds-审批)。
- **`dsh plugin --profile <名> add ...` 报 `required option '--profile <name>'`**：
  `--profile` 是必填项；先确认 profile 存在（`~/.dsh/profiles/<名>/`）。
- **端口 3081 被占用**：改 `gatewayPort`（bundle patch 的 config，或 Settings →
  Plugins 卡片）。
- **局域网设备报 `crypto.randomUUID is not a function`**：client bundle（UUID
  shim）未加载。确认插件在 bundles 列表里、`lib/client.js` 存在、并重启了 dsh。
- **想用 HTTPS**：Settings → Plugins 卡片或配置里开 `tlsEnabled`（默认
  `self-signed` 自动生成证书；或 `custom` 挂你自己的 PEM）。详见 README「配置项」。

## 卸载

```bash
# 按包名移除（pnpm 不接受 github: 源标识，会报 no such dependency）
dsh plugin --profile web remove @dsh-external/dsh-lan-gateway
```

同时清理：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 列表、
`cordis.patch.yml` 里相关条目、`~/.dsh/skills/lan-gateway.md`（如已装），以及
`~/.dsh/lan-gateway/`（state.json 密码哈希、cookie secret、TLS 证书，确认不需要后
删除）。

## 许可

[MIT](./LICENSE)
