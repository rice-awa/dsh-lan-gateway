# dsh-lan-gateway 安装指南

本插件把 DeepSeek Harness 的 Web GUI 安全地开放到局域网 / 公网，并附赠一个管理用
skill。功能与用法见 [README](README.md)，本文件只讲安装。

## 前提

- 一个可用的 dsh profile（下文以 `web` 为例，换成你的 profile 名即可）。
- pnpm（dsh profile 的插件管理基于 pnpm，`dsh plugin ... add` 会把参数转发给
  profile 目录下的 `pnpm`）。若你用的 dsh 发行版自带 pnpm，可跳过全局安装。

## 方式一：让 agent 安装（推荐）

把下面这段话原样发给你的 dsh agent：

> 帮我从 `https://github.com/rice-awa/dsh-lan-gateway` 安装这个 dsh 插件，遵循
> `https://github.com/rice-awa/dsh-lan-gateway/blob/main/INSTALL.md`

agent 会按本文件执行：用 `dsh plugin --profile web add` 装进 profile、处理
`allowBuilds` 审批、把插件加进 bundle 列表，并回答你的后续问题。

## 方式二：官方 CLI 手动安装

```bash
dsh plugin --profile web add github:rice-awa/dsh-lan-gateway
```

### 处理 allowBuilds 审批

`dsh plugin add` 安装的包带 `prepack` 构建脚本（tsdown 构建 host + client 两个
bundle），pnpm 11 默认会拦截。首次安装时你会看到：

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

（条目里的 `<提交>` 会随版本变化，以你实际收到的报错为准；或者运行
`pnpm approve-builds` 交互选择。）保存后重新执行上一条 `dsh plugin add` 命令即可。

> 为什么会有这一步：git 安装会在 pnpm 的临时目录里重建依赖并运行该包的构建脚本，
> pnpm 11 的安全机制要求先批准包自身的构建，再批准其依赖（如 esbuild）的构建。
> 两条都按报错提示补进 `allowBuilds` 即可。

### 装配进 bundle 列表

`dsh plugin add` 会更新 `~/.dsh/profiles/web/package.json` 的依赖并安装。插件默认
**不自动启动**（`enabled: false`），需把 `@dsh-external/dsh-lan-gateway` 加进
`dsh.profile.bundles` 列表（`package.json` 内），并在 `~/.dsh/profiles/web/cordis.patch.yml`
中把 `enabled` 改成 `true` 才会在启动时监听。如果不打算开机自启，只想按需手动开启，
也可以只加进 bundles、保持 `enabled: false`，之后在对话里用 `lan_gateway enable` 开启。

然后重启 dsh：

```bash
dsh --profile web
```

## 方式三：从源码构建（开发 / 贡献）

```bash
git clone https://github.com/rice-awa/dsh-lan-gateway.git
cd dsh-lan-gateway
pnpm install
pnpm build          # host：lib/index.js + lib/index.d.ts
pnpm build:client   # client：lib/client.js（window.__ModuleLoader__ 格式）
pnpm test           # 26 项测试
```

构建产物在 `lib/`（已被 `.gitignore` 排除，不随仓库提交）。

### 以本地链接装进 profile

```bash
# 在 profile 里以 link: 方式引用本地仓库（等价于 npm link）
cd ~/.dsh/profiles/web
pnpm add "link:/path/to/dsh-lan-gateway"
```

## 安装配套 skill（可选但推荐）

仓库里的 [skills/lan-gateway.md](skills/lan-gateway.md) 是一个 dsh 技能：让 agent
在对话中直接管理网关（开/关、设密码、轮换密钥、查状态）。插件本体装好后，把它
复制到任一 skill 发现根即可（有 watcher，放进去即生效，无需重启）：

```bash
# 用户级（推荐，对所有项目生效）：$DSH_HOME/skills/
mkdir -p ~/.dsh/skills

# 从已安装的包拷贝（git / npm 安装的用户，包里已带 skills/）
cp ~/.dsh/profiles/web/node_modules/@dsh-external/dsh-lan-gateway/skills/lan-gateway.md \
   ~/.dsh/skills/

# 或从源码仓库拷贝（开发用户）
# cp <仓库路径>/skills/lan-gateway.md ~/.dsh/skills/

# 其他发现根（按需）：${DSH_AGENTS_HOME:-~/.agents}/skills/、<项目根>/.agents/skills/
```

装好后在对话里说「设置网关密码为 …」「开启远程访问」「网关状态」即可，agent 会
自动调用 `lan_gateway` 工具完成。

> dsh 官方对 skill 的要求（已核实）：frontmatter 需含 `name` 与 `description`
> （本技能均已提供）；`user-invocable` 默认即可用。旧式驼峰键（如
> `userInvocable`）会被拒绝，必须以 kebab-case 编写。

## 安装后验证

```bash
# 确认包已就位（应看到 lib/index.js、lib/client.js 等）
ls ~/.dsh/profiles/web/node_modules/@dsh-external/dsh-lan-gateway/lib

# 启动后确认网关监听
dsh --profile web
# 在对话里让 agent 执行：lan_gateway enable
# 日志应出现：dsh-lan-gateway: listening on 0.0.0.0:3081 -> 127.0.0.1:<dsh端口>
```

## 首次使用：设置密码

网关默认 `authRequired: true`——非 LAN 来源必须登录。因此首次开启前需要先设密码
（≥ 8 位）。最简单的方式是直接在 dsh 对话里说：

> 设置网关密码为 `<你的密码>`

agent 会调用 `lan_gateway set-password` 完成设置（密码以参数传入、不会写入配置文件、
不会回显），然后执行 `lan_gateway enable` 开启监听。也可以随时在对话里说“查看网关
状态”“关闭网关”“重置会话密钥”。

> 未设密码时 `lan_gateway enable` 会拒绝监听并提示先设密码（防止把 RCE 门户开放给
> 非 LAN 来源）；只有把 `authRequired` 配成 `false` 才会允许无密码监听（仅适合完全
> 受信的 LAN 环境）。

## 常见问题

- **`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`**：见上文“处理 allowBuilds 审批”。
- **`dsh plugin --profile <名> add ...` 报 `required option '--profile <name>'`**：
  `--profile` 是必填项；先确认 profile 存在（`~/.dsh/profiles/<名>/`）。
- **端口 3081 被占用**：网关监听端口可在 bundle patch 的 config 里改
  `gatewayPort`。
- **局域网设备打开页面报 `crypto.randomUUID is not a function`**：client bundle
  （UUID shim）未加载。确认插件在 bundles 列表里、`lib/client.js` 存在、并重启了
  dsh。

## 卸载

```bash
# 按包名移除（pnpm 不接受 github: 源标识，会报 no such dependency）
dsh plugin --profile web remove @dsh-external/dsh-lan-gateway
```

同时清理：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 列表、
`cordis.patch.yml` 里相关条目，以及 `~/.dsh/lan-gateway/state.json`（含密码哈希与
cookie secret，确认不需要后删除）。

## 许可

[MIT](./LICENSE)
