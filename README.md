# dsh-bridge-tunnel-hub

把每台机器上 [dsh-bridge](https://github.com/wenbin-wb/dsh-bridge) 的公网隧道地址汇总到一个 secret Gist：地址变了自动更新，每 4 小时整点刷新一次在线状态，任何一台机器随时查得到。

## 解决什么问题

dsh-bridge 默认的 Cloudflare 免登录临时隧道每次重启都会换一个 `*.trycloudflare.com` 域名。人在外面、或者有第二台机器时，就不知道现在该连哪个地址了。

本插件在每个 DSH 进程里做三件事：

1. 从 dsh-bridge 的落盘状态里采到本机当前的公网地址；
2. 对这个地址做一次端到端探活，通了才上报；
3. 写进一个 Gist：一行一台机器，Markdown 链接可直接点开。

此外每 4 小时整点做一次同样的采集与探活，只刷新"最后在线时间"——超过间隔没刷新的机器就说明可能离线了。

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
| `tunnels.md` | 一行一台机器，Markdown 链接：`- [thinkcentre-yao](https://xxx.trycloudflare.com)` |
| `status.json` | 每台机器最后一次确认在线的时间、机器 ID 与隧道类型 |

`status.json` 里只保留判断在线所需的最小信息：

```json
{
  "name": "ThinkCentre-Yao",
  "machineId": "938b1ddf-...",
  "url": "https://xxx.trycloudflare.com",
  "kind": "quick",
  "updatedAt": "2026-11-12T00:00:00.000Z"
}
```

不写 Node 版本、bridge 版本、平台这类信息——汇总文件会长期留在云端，少一项就少一项泄露面。

## 整点刷新与在线判断

- 默认每 4 小时整点（00:00 / 04:00 / 08:00 / 12:00 / 16:00 / 20:00，本地时区）刷新一次：采集 → 探活 → 更新 `updatedAt`。
- 探活不过就不刷新：宁可让时间停在旧值，也不把离线机器显示成在线。
- `tunnel_list` 会把 `updatedAt` 超过「间隔 + 1 小时」的机器标成 `stale: true`（可能离线）。
- 地址变化时不等整点，立刻上报。
- 间隔可改：`heartbeatHours`，设为 `0` 关闭整点刷新。

> [!NOTE]
> 断网、DSH 没运行、机器关机都会让 `updatedAt` 停住——这正是判断在线的依据。多台机器如果恰好同一整点写 Gist，极小概率互相覆盖一次，下一次刷新会恢复。

## 工具

| 工具 | 用途 |
|---|---|
| `tunnel_self` | 本机当前的隧道地址、采集来源、最近一次上报结果、下一次整点刷新时间、Gist 位置 |
| `tunnel_list` | 汇总里所有机器的地址、最后在线时间、当前是否可达、是否可能离线 |
| `tunnel_publish` | 立即把本机地址重新写一遍（手动纠错或验证链路） |

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `machineName` | 空（用主机名） | 本机在 Gist 里显示的名字 |
| `gistUrl` / `gistId` | 空 | 手填已有 Gist；留空则首次启动自动创建 |
| `token` | 空 | 写入用的 GitHub token；留空回退到环境变量与 gh |
| `logPath` | 自动探测 | dsh-bridge 的 `cloudflared.log` 路径 |
| `bridgeConfigPath` | 自动探测 | dsh-bridge 的 `config.json` 路径 |
| `scanIntervalSec` | 20 | 地址变化检测间隔（最小 5 秒） |
| `probeTimeoutMs` | 8000 | 探活超时 |
| `autoPublish` | true | 关掉后只采集不上报，`tunnel_publish` 仍可手动写 |
| `manualUrl` | 空 | 读不到日志时手填本机地址 |
| `heartbeatHours` | 4 | 整点刷新间隔（小时），`0` 关闭 |

改机器名后，旧名字那一行会在下一次上报时被删除，不会留下孤儿条目。

## 采集规则

1. `manualUrl` 有值就用它；
2. dsh-bridge 配了固定域名（`config.json` 的 `cloudflared.hostname`）时用固定域名；
3. 否则取 `cloudflared.log` 里**最后一次**出现的 `*.trycloudflare.com` 地址。

对外地址一律收敛成 `scheme://host`：查询串、片段、路径全部丢弃，所以带 `?auth=` 的扫码免密地址不会被写进 Gist。

升级自 0.1.x 时，旧的 `tunnels.txt` 会在下一次上报时并入 `tunnels.md` 并自动删除，不需要手工迁移。

## 安全边界

> [!WARNING]
> GitHub 的 secret Gist 不是私有仓库：它不搜索、不列出，但持有链接的人可以读取。
>
> 本插件的设计把这条边界算进去了：
> - 只写裸地址，绝不写 `?auth=` 免密凭据；
> - 状态里只保留机器名、机器 ID、地址、隧道类型与最后在线时间；
> - 地址本身仍受 dsh-bridge 的访问认证保护；
> - 别把 Gist 链接贴到公开渠道。

## 排障

| 现象 | 检查 |
|---|---|
| `tunnel_self` 显示 `没有找到隧道地址` | dsh-bridge 的 Cloudflare 隧道是否开着；`logPath` 是否指对 |
| `隧道地址暂不可用` | 隧道刚重启尚未就绪，或本机出网不通；插件会自动重试 |
| `没有可用的 GitHub token` | 配置 `token`，或 `gh auth login` |
| `GitHub 401/403` | token 缺 `gist` 权限 |
| `GitHub 404` | Gist 被删：插件会自动重建；也可能是 token 看不到它 |
| `tunnel_list` 里 `stale: true` | 该机器超过「心跳间隔 + 1 小时」没有刷新，可能离线或 DSH 没运行 |

## 开发

```powershell
node --test test/*.test.mjs
```

测试用内存版 Gist（`test/fake-github.mjs`），不访问网络，也不需要先安装依赖。
