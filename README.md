# At-Pet 桌宠接入（DeepSeek Harness 插件）

[![npm](https://img.shields.io/npm/v/dsh-atpet.svg)](https://www.npmjs.com/package/dsh-atpet)

把 [At-Pet](https://github.com/At-PetAdmin/At-Pet) 桌宠接到 DeepSeek Harness 上：桌宠跟着回合思考、挖土、庆祝，权限询问和 `ask_user_question` 直接弹到桌宠窗口，在桌宠上点完就回到 Harness。

与上游 `integrations/agent-plugins/deepseek-harness/` 的 hook 方案相比，本插件是**进程内**实现：

| | hook 方案（上游） | 本插件 |
| --- | --- | --- |
| 运行方式 | 每次事件 `spawn node bridge.mjs` | 无子进程，Host 内直接发包 |
| 事件来源 | 5 个 Codex hook 点 | `session/event` 持久日志 + 原生拦截点 |
| 权限回传 | 随附配置未订阅 `PermissionRequest` | 原生 `approval/request` 水位，失败自动回退 |
| 提问转发 | 不支持 | `user-questions/request` → `/question` |
| 需要改配置的 | `hooks.json` + `dsh-hooks.yml` + 绝对路径 | 只有本补丁行 |

## 前提

- Windows 10/11，At-Pet 已启动（默认监听 `127.0.0.1:8765`）。
- DeepSeek Harness（`dsh`）0.2.x（包内 `engines.dsh` 声明 `>=0.2.0 <0.3.0-0`）。插件只用 Host 侧公开的 Cordis 事件，无第三方依赖，也没有安装期构建脚本。

## 安装

已发布到 npm：**`dsh-atpet`**（<https://www.npmjs.com/package/dsh-atpet>）。

### Harness 内（推荐）

```js
// Agent 工具 / 会话里安装最新版
plugin_manager({ action: 'install_bundle', target: 'dsh-atpet' })
```

也可以打开 Web 侧边栏的**插件**页，在安装框输入 `dsh-atpet`（或固定版本 `dsh-atpet@1.0.0`）。确认之前它会先从 registry 读出包名、版本、描述与图标。

安装后 Harness 立刻通过 HMR 激活，无需重启。`desktop` profile 由桌面端持有，用上面两条（Agent 工具 / Web 插件页）即可，`dsh plugin` CLI 不适用于它。

### 命令行 profile（web / headless / sdk 等）

```bash
dsh plugin --profile web add dsh-atpet
```

`dsh plugin` 会把参数转给 profile 目录里的 pnpm；安装成功后自动把 `dsh-atpet` 加进 `dsh.profile.bundles`。

### 不经过 npm

包尚未发布到 registry、或需要离线安装时，用下面两种方式：

```js
plugin_manager({ action: 'install_bundle', target: 'github:At-PetAdmin/dsh-atpet' })  // 直接从 GitHub 装
plugin_manager({ action: 'install_bundle', target: '<本仓库克隆路径>' })              // 本地克隆目录（dev 链接）
```

从 `< 1.0.0` 的旧本地链接安装（包名 `@local/dsh-atpet`）迁移时，先卸掉旧的再装新的——两者是同一个 bundle 行，不能并存：

```js
plugin_manager({ action: 'remove_bundle', target: '@local/dsh-atpet' })
```

卸载：`plugin_manager({ action: 'remove_bundle', target: 'dsh-atpet' })`。

At-Pet 没开也不会报错：插件先探测 `/health`，不可达就静默跳过，权限与提问回退到 Harness 原生界面。

## 行为

### 1. 活动镜像（`POST /event`）

| Harness 事件 | At-Pet 事件 | 桌宠表现 |
| --- | --- | --- |
| `turn/start` | `thinking` | 思考 |
| `user/message`（用户本人） | `user_prompt_submit` | 思考，气泡显示提问摘要 |
| `tool/call` | `tool_start` | 干活，气泡显示工具名 |
| `tool/result` | `tool_end` | 回到思考 |
| `turn/end` · `completed` / `max-tokens` | `done` | 庆祝（5 秒后收工） |
| `turn/end` · `aborted` / `blocked` / `interrupted` | `cancelled` | 中止 |
| `turn/end` · `error` | `error` | 报错，气泡显示失败原因 |
| `session/disposed` | `session_end` | 移除该会话桌宠 |

- 读的是**已提交的会话日志**，所以重试、重放、子代理都不会让桌宠错位；工具失败不算回合失败，桌宠不会因此提前退场。
- `agentApp` 默认 `deepseek-harness`，At-Pet 归一化成注册键 `deepseekharness`，显示为「DeepSeek Harness」。
- 模型名取自会话的请求上下文，子代理会话带 `parentSessionId` 单独开一只桌宠（`reportSubagents: false` 可关闭）。

### 2. 权限转接（`/permission`）

Harness 需要批准某个工具时，插件把请求发到桌宠窗口（标题 = 工具名，详情 = Harness 给出的理由）。桌宠上点「Allow once」→ 工具放行；点「Deny」或关窗 → 拒绝。

这条通路**只在 At-Pet 应答 `/health` 时**才接管，且以下情况一律 `next()` 交回 Harness 原生批准界面：

- At-Pet 未启动 / 端口不可达 / 请求发不出去；
- 超时（`approvalTimeoutMs`，默认 120 秒）没人点；
- 桌宠那边请求被取消（`DELETE`）。

所以「桌宠挂着没人管」不会把会话锁死，最多是晚一点在 Harness 里再问一次。

### 3. 提问转接（`/question`）

`ask_user_question` 只问**一个问题**且带选项时，插件把它发到桌宠：选项变成下拉框，选中的那一项就是答案。多问题、纯开放问题、以及 plan-review 提示（`intent`）都留在 Harness 里，避免把复杂的交互压扁成一个气泡。

## 配置

全部可选。默认值写在本包的 `cordis.patch.yml`（安装后即 profile 里的那一行 `dsh-atpet`），直接改这个文件即可；也可以在 profile 的 `cordis.patch.yml` 里按 id 覆盖同一行：

```yaml
- id: dsh-atpet
  config:
    bridgeApprovals: false
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8765` | At-Pet 本地 API 地址 |
| `agentApp` | `deepseek-harness` | 上报给桌宠的 Agent 标识 |
| `reportEvents` | `true` | 是否镜像回合与工具活动 |
| `reportSubagents` | `true` | 子代理是否单独开窗 |
| `includePromptText` | `true` | 气泡里是否显示提问摘要 |
| `bridgeApprovals` | `true` | 是否把权限询问转给桌宠 |
| `bridgeQuestions` | `true` | 是否把单问题提问转给桌宠 |
| `requestTimeoutMs` | `1200` | 单次 HTTP 超时 |
| `healthTtlMs` | `5000` | `/health` 探测缓存时间 |
| `pollIntervalMs` | `250` | 等待用户在桌宠上作答的轮询间隔 |
| `approvalTimeoutMs` | `120000` | 权限等待上限，超时回退 Harness |
| `questionTimeoutMs` | `180000` | 提问等待上限，超时回退 Harness |
| `maxMessageChars` | `160` | 气泡文字截断长度 |

非法值按单键回退默认值，不会让插件或 Harness 起不来。

## 设计要点

- **不写会话日志**：插件不 `append` 任何事件、不注入上下文，纯观察者，卸载即干净。
- **不阻塞工具**：镜像上报是 fire-and-forget，桌宠不可达只消耗一次本地连接。
- **事件不乱序**：同一会话的 `/event` 走一条串行队列（不同会话互不排队）。桌宠只认最后到达的事件，并发发送会让 `done` 抢在 `tool_end` 前面，或让终端事件被后到的 `tool_start` 复活。
- **只接管能回退的东西**：权限与提问两条水位都在失败时 `next()`，绝不替用户做决定，也不静默吞掉询问。
- **上报不抛错**：桌宠是外设，任何网络异常都不会冒泡成 Harness 错误。

## 与旧 hook 桥接共存

如果 profile 里还留着 `atpet-hooks-codex`（`@deepseek-ai/dsh-hooks-codex` + `hooks.json` + `bridge.mjs`），两个发送端会同时往 `127.0.0.1:8765` 报同一批工具调用：桌宠状态会在两者之间来回跳，而且每个 hook 事件仍会 `spawn` 一个 node 进程。

本插件可以单独工作，确认它跑通后建议把旧行停掉：

```js
plugin_manager({ action: 'set_plugin', target: 'atpet-hooks-codex', enabled: false })
```

旧行的 patch 内容不会被删除，`enabled: true` 即可恢复。

## 排错

| 现象 | 检查 |
| --- | --- |
| 桌宠完全不动 | At-Pet 是否在跑：`curl http://127.0.0.1:8765/health`；`/state` 里有没有 `DeepSeek Harness` 会话 |
| 桌宠动了但显示别的 agent | `agentApp` 被改成了别的值 |
| 权限弹在 Harness 而不是桌宠 | At-Pet 没启动，或 `bridgeApprovals: false`，或 120 秒超时已过 |
| 桌宠里选了答案但 Harness 仍弹窗 | 该提问是多问题 / plan-review / 超时，属于设计内回退 |

## 测试

在仓库里零依赖，直接跑：

```bash
node test/bridge.test.mjs
```

15 个用例覆盖事件映射、子代理分窗、失败工具不误报、权限允许/拒绝/超时/离线回退、提问选项与自定义答案、多问题让位、卸载后停止上报。测试用桩实现 At-Pet 的 `/health`、`/event`、`/permission`、`/question` 协议。
