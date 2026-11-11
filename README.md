# dsh-bridge-tunnel-hub

把每台机器上 [dsh-bridge](https://github.com/wenbin-wb/dsh-bridge) 的公网隧道地址汇总到一个私有 Gist：地址变了自动更新，任何一台机器随时查得到。

## 解决什么问题

dsh-bridge 默认的 Cloudflare 免登录临时隧道每次重启都会换一个 `*.trycloudflare.com` 域名。人在外面、或者有第二台机器时，就不知道现在该连哪个地址了。

本插件在每个 DSH 进程里做三件事：

1. 从 dsh-bridge 的落盘状态里采到本机当前的公网地址；
2. 对这个地址做一次端到端探活，通了才上报；
3. 写进一个 Gist：一行一台机器，`机器名:地址`。

于是无论在哪台机器上，都能用 `tunnel_list` 拿到全部机器当前的地址与可达性，也可以直接打开 Gist 看。

## 安装

```powershell
dsh plugin --profile <profile> add github:NEVSTOP-LAB/dsh-bridge-tunnel-hub
```

装好后会出现在设置页的插件列表里（标题「隧道地址汇总」）。

## 首次运行

1. 插件启动后自动扫描 `~/.dsh-bridge/cloudflared.log`（或 dsh-bridge 的固定域名配置）拿到本机地址；
2. 探活通过后，用一个有 `gist` 权限的 GitHub token 创建 secret Gist，Gist 描述就是本插件名；
3. Gist ID 记在本机状态文件里，后续只做读改写。

token 的取用顺序：插件设置里的 `token` → 环境变量 `GH_TOKEN` / `GITHUB_TOKEN` → `gh auth token`。本机装了 gh 并登录过就不需要额外配置。

> [!NOTE]
> Gist 属于创建它的那个 GitHub 账号。多台机器要写入同一个 Gist，就必须使用同一个账号的 token；只读的机器不需要 token。

## Gist 里有什么

| 文件 | 内容 |
|---|---|
| `tunnels.txt` | 一行一台机器：`thinkcentre-yao:https://xxx.trycloudflare.com` |
| `status.json` | 每台机器最近一次更新时间、机器 ID、隧道类型、bridge 版本等 |

`status.json` 里记的是"这台机器最后一次地址变化的时间"，不是心跳。判断某台机器现在通不通，看 `tunnel_list` 的 `reachable` 字段——它对每个地址现场探活。

## 工具

| 工具 | 用途 |
|---|---|
| `tunnel_self` | 本机当前的隧道地址、采集来源、最近一次上报结果、Gist 位置 |
| `tunnel_list` | 汇总里所有机器的地址、最后更新时间、当前是否可达 |
| `tunnel_publish` | 立即把本机地址重新写一遍（手动纠错或验证链路） |

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `machineName` | 空（用主机名） | 本机在 Gist 里显示的名字 |
| `gistUrl` / `gistId` | 空 | 手填已有 Gist；留空则首次启动自动创建 |
| `token` | 空 | 写入用的 GitHub token；留空回退到环境变量与 gh |
| `logPath` | 自动探测 | dsh-bridge 的 `cloudflared.log` 路径 |
| `bridgeConfigPath` | 自动探测 | dsh-bridge 的 `config.json` 路径 |
| `scanIntervalSec` | 20 | 扫描间隔（最小 5 秒） |
| `probeTimeoutMs` | 8000 | 探活超时 |
| `autoPublish` | true | 关掉后只采集不上报，`tunnel_publish` 仍可手动写 |
| `manualUrl` | 空 | 读不到日志时手填本机地址 |

改机器名后，旧名字那一行会在下一次上报时被删除，不会留下孤儿条目。

## 采集规则

1. `manualUrl` 有值就用它；
2. dsh-bridge 配了固定域名（`config.json` 的 `cloudflared.hostname`）时用固定域名；
3. 否则取 `cloudflared.log` 里**最后一次**出现的 `*.trycloudflare.com` 地址。

对外地址一律收敛成 `scheme://host`：查询串、片段、路径全部丢弃，所以带 `?auth=` 的扫码免密地址不会被写进 Gist。

## 安全边界

> [!WARNING]
> GitHub 的 secret Gist 不是私有仓库：它不搜索、不列出，但持有链接的人可以读取。
>
> 本插件的设计把这条边界算进去了：
> - 只写裸地址，绝不写 `?auth=` 免密凭据；
> - 地址本身仍受 dsh-bridge 的访问认证保护；
> - 别把 Gist 链接贴到公开渠道。
>
> 需要真正私有的登记处时，把 `gistUrl` 指到一个私有仓库同样可行（本插件只依赖读写一个文本文件的位置，尚未实现仓库后端）。

## 排障

| 现象 | 检查 |
|---|---|
| `tunnel_self` 显示 `没有找到隧道地址` | dsh-bridge 的 Cloudflare 隧道是否开着；`logPath` 是否指对 |
| `隧道地址暂不可用` | 隧道刚重启尚未就绪，或本机出网不通；插件会自动重试 |
| `没有可用的 GitHub token` | 配置 `token`，或 `gh auth login` |
| `GitHub 401/403` | token 缺 `gist` 权限 |
| `GitHub 404` | Gist 被删：插件会自动重建；也可能是 token 看不到它 |

## 开发

```powershell
node --test test/*.test.mjs
```

测试用内存版 Gist（`test/fake-github.mjs`），不访问网络，也不需要先安装依赖。
