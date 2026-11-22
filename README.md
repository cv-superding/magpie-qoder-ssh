# qoder-ssh

![qoder-ssh banner](docs/assets/banner-qoder-ssh.png)

<img src="docs/assets/icon-qoder-ssh.png" alt="qoder-ssh icon" width="96" align="right">
![license](https://img.shields.io/badge/license-MIT-blue) ![magpie](https://img.shields.io/badge/magpie-plugin-brightgreen) ![SSH](https://img.shields.io/badge/SSH-tunnel-purple) ![node](https://img.shields.io/badge/node-%3E%3D22-grey) ![PRs](https://img.shields.io/badge/PRs-welcome-orange)


一个 [magpie](https://github.com/) 插件，通过 SSH 管理远端机器上的 [qoderclicn](https://qoder.com/)：连通性检测、一键安装配置、以及一条 SSH 远程转发隧道。

> **v3.0.0 起，网关桥接已拆到独立插件 [magpie-gateway](https://github.com/cv-superding/magpie-gateway)**。本插件不再注册 provider，只负责 SSH 管理。两个插件互相独立，按需安装。

适用于这类场景：

- 你有多台 SSH 服务器，需要在上面统一部署 qoderclicn
- 远端服务器没有公网 IP，需要一个反向隧道访问本机网关
- 需要批量检测远端的 qoderclicn 安装与配置状态

若只是想把网关接进 magpie 给 agent 用，装 [magpie-gateway](https://github.com/cv-superding/magpie-gateway) 即可，不需要本插件。

## 特性

| 能力 | 说明 |
|---|---|
| 服务器管理 | 页面增删改 SSH 服务器，密码存在独立密钥文件，不写进配置 |
| 逐项检测 | 检测 SSH / 系统 / 下载工具 / qoderclicn / 配置 / 网关连通性 |
| 一键配置 | 远端自动安装 qoderclicn，写入带完整能力声明的 `settings.json`，带分步进度 |
| 状态持久化 | 检测与配置结果落盘，magpie 重启后仍在 |
| SSH 隧道 | 内置 `ssh -R` 隧道，把本机网关暴露给远端，进程由插件守护、断线自动重启 |
| 非侵入 | 插件**从不写回 `plugins.json`**，不会触发 magpie 重载 |

## 工作原理

```
┌─────────────────┐         SSH -R 隧道          ┌──────────────────┐
│  远端服务器      │  127.0.0.1:23425 ──────────→ │  本机 magpie 网关  │
│  qoderclicn     │                              │  127.0.0.1:3425  │
└─────────────────┘                              └──────────────────┘
         ↑                                                ↑
         │ 检测 / 配置（SSH 一次性命令）                      │
         └────────────── 插件后端 ←──────────────────────────┘
                    (Bun 宿主)  ← 页面通过 options 提交任务
```

**页面与后端的分工**：magpie 的页面 sandbox 是 `connect-src 'none'`，不能发网络请求。因此：

- 页面只能读写插件自己的 options，以及用 `<script src>` 读插件目录里的文件
- 后端（Bun 宿主）执行真正的 SSH 操作，把状态写进 `page/snapshot.js`
- 页面把用户操作写进 options 里的任务队列，后端每 5 秒轮询执行

## 安装

```bash
# 方式一：magpie CLI
magpie plugin add /path/to/qoder-ssh

# 方式二：magpie 界面
Plugins → Add a plugin → 选择本目录
```

插件**不安装任何 npm 依赖**，所有代码用 Node/Bun 内置模块，直接以文件夹形式加载。

安装后打开插件页面 `qoder-ssh`，配置**部署目标**（远端能访问到的网关地址）并添加 SSH 服务器。

如果需要把网关接进 magpie 给 agent 用，另装 [magpie-gateway](https://github.com/cv-superding/magpie-gateway) 插件。

## 配置

所有配置存在插件自己的 options 里（magpie 的 `plugins.json` 中该插件条目的 `options`），也可用同名环境变量覆盖。

### SSH 服务器

页面里添加，数据结构：

```json
{
  "servers": [
    { "id": "srv1", "name": "myserver", "host": "example.com", "port": 22, "user": "root" }
  ]
}
```

**密码不存这里**，通过页面输入后由 `lib/secrets.mjs` 写到独立的密钥文件，不与配置混在一起。

### 部署地址

| 配置项 | 说明 |
|---|---|
| `deployUrl` | 远端服务器上能访问到的网关地址。若使用隧道，填 `http://127.0.0.1:23425` |
| `deployKey` | 部署到远端 `settings.json` 的 API key |

⚠️ 填内网地址（如 `http://192.168.x.x:3426`）在公网服务器上访问不到，部署后远端会连不上网关。使用隧道时填隧道地址。

### 隧道

```json
{
  "tunnel": {
    "enabled": true,
    "serverId": "srv1",
    "remotePort": 23425,
    "localPort": 3426
  }
}
```

含义：在 `srv1` 上建立 `ssh -R 23425:127.0.0.1:3426`，即远端的 `127.0.0.1:23425` 转发到本机的 `3426`。

后端每 5 秒检查一次：

- 已启用且进程存活 → 不动
- 已启用但进程不在 → 先探测远端端口；已有隧道则认领（标记为 `external`），否则重新拉起
- 关闭开关 → 停掉本插件启动的隧道

隧道进程由 `lib/tunnel.mjs` 管理，stdout/stderr 追加写入 `logFile`，可以在页面日志卡片里看到。

**已知限制**：magpie host 重启后，之前 spawn 的 ssh 进程会变孤儿。新 host 通过远端端口探测认领它，功能不中断，但无法从页面停止。彻底解决需要 pidfile 管理。

### 日志

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `logFile` | 插件目录下的 `qoder-ssh-tunnel.log` | 隧道日志路径 |
| `logLines` | `30` | 页面显示的尾部行数 |

注意日志路径必须是 magpie 进程有权限读写的目录。例如在容器/NAS 里，`/home/user/config` 这类目录可能只有宿主用户能访问，magpie 用户会报 `EACCES`；应放到 magpie 自己的配置目录下。

## 页面功能

### 服务器列表

每台服务器显示状态灯与操作按钮：

| 按钮 | 出现条件 | 行为 |
|---|---|---|
| 检测 | 从未检测 | 对该服务器跑一遍检测 |
| 检查中… | 检测进行中 | 禁用，防止重复提交 |
| 配置 qoderclicn | 检测完且缺 qoderclicn 或配置 | 打开配置流程 |
| 重新配置 | 检测全通过 | 重新走一遍配置 |
| 删除 | 始终 | 删除服务器及密钥 |

检测项：

1. SSH 连接
2. 操作系统
3. 下载工具（curl / wget / python3，任一即可）
4. qoderclicn 版本
5. `~/.qoder-cn/settings.json`
6. 远端 → 网关连通性

### 配置进度

配置期间显示进度条，分 4 步：环境检查 → 下载安装 → 写入配置 → 验证版本。每一步完成即刷新快照，页面实时显示。

安装脚本的下载方式按远端实际有的工具选择：`curl` → `wget` → `python3 urllib` 三级回退。

写入的 `settings.json` 会包含**完整的模型能力声明**（不只是 `model` / `displayName`）：

```json
{
  "model": "group/xxx",
  "displayName": "...",
  "contextWindow": 1000000,
  "capabilities": {
    "thinking": {
      "supportsEffort": true,
      "supportedEffortLevels": ["high", "max"],
      "modes": ["enabled"],
      "requiresBudgetForEnabled": false
    },
    "tools": true,
    "vision": true
  }
}
```

信息来自网关 `/v1/models` 的 `context_window` / `reasoning_levels` / `tool_call` / `modalities` 字段。缺这些字段时，qoder 界面会显示"上下文 128k""不可调思考档位"。

注意两个 ID 形态不能混：

- `model.name` = **全限定**：`magpie/group/xxx`
- `providers.magpie.model` = **裸 id**：`group/xxx`

### 任务去重

页面提交的任务带毫秒时间戳。后端把已处理的戳记持久化到插件目录下的 `qoder-ssh-tests.json`：

```json
{
  "tests": { "srv1": { "...": "..." } },
  "seenTests": [1795309880819],
  "seenDeploys": []
}
```

这样 magpie host 重启后不会重跑历史任务。曾经用"进程启动时间"过滤，但 magpie 的 host 是懒加载的，启动时刻可能晚于用户提交任务的时间，会误杀真实任务。

## 代码结构

```
qoder-ssh/
├── index.mjs          # 主入口：provider hooks + 后台 worker + 任务处理
├── agent.mjs          # agent 声明（magpie 的 Agent 页面用）
├── lib/
│   ├── ssh.mjs        # 远端命令执行（askpass 传密码，不落盘）
│   ├── secrets.mjs    # 服务器密码的独立存储
│   └── tunnel.mjs     # ssh -R 隧道的 spawn / 状态 / 停止
├── page/
│   ├── index.html     # 页面骨架
│   ├── app.js         # 页面逻辑（轮询快照、提交任务）
│   ├── style.css      # 样式
│   └── snapshot.js    # 后端写入的状态快照（自动生成）
├── package.json
└── README.md
```

## 几个关键设计决策

这些都是踩过坑之后定下来的，改动前请先看这里。

**1. 插件绝不写回 `plugins.json`**

早期版本在清空任务队列时写回配置文件，magpie 监听到配置变化后重载 plugin host，正在跑的任务被打断，队列又没清干净，形成无限重启循环。日志特征：

```
testing qdai
testing qdai
worker started     ← 重载
testing qdai       ← 又跑
```

现在只靠持久化戳记去重，不碰宿主配置。

**2. 不要用进程启动时间过滤任务**

magpie 的 plugin host 是懒加载的，`bootAt` 可能晚于用户提交任务的时间，会把真实任务误判成历史任务跳过。

**3. worker 必须有防重入锁**

tick 是 5 秒，但一次检测/配置要几十秒。没有 `workerBusy` 锁会并发叠加。

**4. bun 不会重装同路径的 tgz**

改了代码、升了版本号，`node_modules/qoder-ssh` 可能仍是旧代码。发布时要确认 node_modules 里真的有新符号，必要时 `rm -rf node_modules/qoder-ssh && bun install --force`，并确认 tgz 已放进 `plugins/dist/`。

**5. agent 插件不能 import `node:` 内置模块**

magpie 会报：

```
an agent plugin imports only files beside it; bundle packages into it
```

所以 `agent.mjs` 里不能出现 `import ... from "node:fs"`，config 路径必须是静态字符串。

**6. 检测项要测实际用的地址**

"远端 → 网关"这一项优先测 `settings.json` 里已配置的 baseUrl，而不是部署地址——后者是内网地址时公网机永远不通，会误导用户。

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| magpie 提示 "plugins.json 已损坏" | 该提示来自 magpie 进程内存里的历史事件。文件本身合法时重启 magpie 即可清除 |
| 页面显示 `EACCES ... magpie.log` | 日志路径所在目录 magpie 用户无权访问，换到 magpie 自己的配置目录 |
| 按钮一直"检查中…" | 后端 worker 没在跑，看 magpie 日志里有没有 `qoder-ssh: worker started` |
| 检测全 OK 但配置失败，报 `Unable to connect` | 检查远端是否能访问 `deployUrl`；有隧道时应填 `http://127.0.0.1:<remotePort>` |
| 模型界面显示"上下文 128k / 不可调档位" | `settings.json` 里缺 `contextWindow` / `capabilities`，重新点"配置 qoderclicn" |
| `does not support reasoning effort "medium"` | 客户端请求的档位不在模型声明里。先看响应体确认真实错误，不要猜上下文大小 |
| 远端 `401 sign-in has expired` | 上游 provider 登录过期。可用 `magpie provider fallback <id> <provider/model>` 配置备用模型，无需改动账号 |
| 隧道反复掉线 | 检查 `logFile`；如果是从 CI/工具会话启动的进程，会话结束会被回收，需要手工启动或用系统服务 |

## 开发

代码是纯 ESM，用 Node 22+ 或 Bun 均可做语法检查：

```bash
node --check index.mjs
node --check agent.mjs
node --check lib/*.mjs
node --check page/app.js
```

打包（需要 magpie 自带的 bun）：

```bash
magpie-bun pm pack
```

产物是 `qoder-ssh-<version>.tgz`。

## License

MIT
