# clawkit

> Claude Desktop 捆绑版 Claude Code 的本机补丁工具箱。

**这不是 ClawGod 的分支或复刻。** clawkit 不包含任何 ClawGod 代码——补丁引擎（GPLv3）运行时按需从 [0Chencc/clawgod](https://github.com/0Chencc/clawgod) 上游拉取。clawkit 做的是另一件事：把 ClawGod 补丁打进 **Claude Desktop（第三方 API 模式）捆绑的 `claude.exe`**，并围绕它维护整套工具链——通用重打包器、逆向检查器、汉化引擎、隐私守卫和格式文档。

**零检测就地替换。** Desktop 对捆绑 claude.exe 的"完整性校验"，spawn 时只做 `.verified` 文件内容 === 服务端 manifest 校验值的字符串比对，从不重新哈希二进制；`.payload` 写完即无人读 → 就地替换 exe 字节零检测，无需跳任何 jmp（逆向过程见 `docs/desktop-integrity-chain.md`）。

实测环境：Claude Desktop 3.6556.2.0（MSIX 商店版，第三方 API 模式）/ Claude Code 2.1.308 / Bun v1.4.4 运行时 / Windows 11。

## 前置依赖

| 工具 | 用途 | 说明 |
|------|------|------|
| **Claude Desktop**（MSIX） | 补丁目标：其捆绑的 Claude Code 二进制 | 第三方 API 模式；数据目录 `Claude-3p\claude-code\<ver>\<hash>\` 自动发现 |
| **Node.js ≥ 18** | repack.js / 检查器 / 汉化引擎使用 | 流水线自动发现：PATH → 常规路径 → AutoClaw vendor → 递归兜底 |
| **PowerShell 5.1+** | 流水线与守卫脚本 | `.ps1` 均带 UTF-8 BOM；手工运行加 `-ExecutionPolicy Bypass` |
| **网络** | 仅 `-UpdateEngine` 时访问 GitHub codeload | 平时完全离线可用 |

## 快速使用

```powershell
# Desktop 更新了捆绑的 Claude Code 之后：一键重打补丁
.\repatch-claude-code.bat

# 顺带同步 ClawGod 上游最新补丁引擎（推荐偶尔跑）
.\repatch-claude-code.bat -UpdateEngine

# 还原官方原始 exe
.\repatch-claude-code.bat -Rollback

# 指定版本 / 不自动重启 Desktop
.\repatch-claude-code.bat -Version 2.1.308 -SkipRestart
```

流水线全自动：发现 node → 定位引擎与数据目录（Claude-3p / Claude / Claude* 通配，按版本目录数择优）→ 按版本排序取最新 hash 目录 → 备份原始版（幂等，防把补丁版当原始版）→ 提取 → 打补丁 → 重打包 → `--version` 烟测 → 停 Desktop 与占用进程 → 换入 → AppX 自动重启。原版备份 `claude.orig-<ver>.exe` 留在本机脚本目录（不入库），`-Rollback` 依赖它。

## 工具一览

### 补丁流水线

| 文件 | 作用 |
|------|------|
| `repatch-claude-code.ps1` | 全自动重打流水线（见上文「快速使用」） |
| `repatch-claude-code.bat` | 双击入口（绕过执行策略） |

### 重打包器与检查器

| 文件 | 作用 |
|------|------|
| `repack.js` | Bun standalone `__BUN` 容器通用重打包器：数据区原样 + 追加 NUL 终止内容 + 新模块表 + 链式记录搬移 + PE 节增长/证书清零 |
| `tools/inspect-pe.js` | PE 节表 / 证书 / `.bun` 布局检查器 |
| `tools/inspect-struct.js` | `__BUN` Offsets 结构 / 模块表检查器 |

单独使用重打包器（三个参数：原始 exe、补丁工作目录、输出 exe）：

```
node repack.js <original.exe> <scan-dir> <output.exe>
```

`<scan-dir>` 需包含 ClawGod 引擎产物：`cli.original.cjs`、`bunfs\*`、`pathmap.json`（由上游 `extract-natives.mjs` + `patch.mjs` 生成）。

### 汉化引擎

| 文件 | 作用 |
|------|------|
| `localization/apply-fast.js` | DD05-SR 汉化引擎的 Node 复刻（与 Desktop 汉化仓库互补） |

### 隐私守卫（Desktop 应用层）

`claude-privacy-guard.ps1` — Claude Desktop Electron 应用的网络层隐私守卫，与 ClawGod 进程内补丁**互补**：一个管 DNS 层（应用遥测），一个管 claude.exe 内部（请求头/远程设置）。不碰安装目录，天然免疫 Desktop 更新。

| 功能 | 说明 |
|------|------|
| 遥测域名屏蔽 | hosts sinkhole（IPv4+IPv6）封 sentry.io / statsig / amplitude / segment 等，可扫描 bundle 自动扩充名单 |
| 本地队列清理 | 清空 sentry 队列与 Crashpad 报告 |
| claude.ai 断网开关 | 整域 sinkhole（chat/登录/更新全断；`api.anthropic.com` 不受影响，Code/API 照常） |
| 自动守卫 | 计划任务：登录 + 每 6h 自动 扫描 → 屏蔽 → 清理 |
| 实时观察 | 监视 claude/cowork 进程的对外连接（3s 刷新） |

## 工作原理

1. **校验链是纸老虎**：Desktop spawn claude.exe 前只比对 `.verified` 文本与 manifest 值；二进制哈希仅在下载解压时算过一次，`.payload` 写后无人读 → 改 exe 字节零检测
2. Desktop 捆绑的 claude.exe 就是标准 Bun standalone PE，与独立版完全同构；用上游 `extract-natives.mjs` 提取全部嵌入模块
3. ClawGod 引擎（`patch.mjs`）对源码打补丁——v2.1.308 实测 34 补丁命中、0 失败
4. `repack.js` 重打包进单文件 exe：模块内容必须 NUL 终止；带 JSC 字节码的模块改源码须同时清零 bytecode 指针与源哈希槽（否则旧字节码静默遮蔽新代码）；flags 位序的链式可选记录随新表搬移；PE 节增长 / SizeOfImage / 证书目录 / 校验和一并处理；Latin1 模块（chart/hljs/mermaid）跳过防 UTF-8 膨胀
5. 烟测（`--version` / `--help`）→ 停 Desktop 与占用进程 → 原位换入（`.payload` / `.verified` 原封不动）→ AppX 自动重启
6. 用户级环境变量 `DISABLE_AUTOUPDATER=1` 防原生更新器回修 exe；`CLAUDE_CODE_ATTRIBUTION_HEADER=0` 修复第三方代理下 prompt-cache 命中归零

格式细节见 `docs/bun-section-format.md`。

## 文档

| 路径 | 内容 |
|------|------|
| `docs/bun-section-format.md` | `__BUN` 容器格式与重打包配方（NUL 终止 / Offsets / 链式记录 / 字节码坑） |
| `docs/desktop-integrity-chain.md` | Desktop 完整性校验链逆向（`.verified` 字符串比对真相） |
| `docs/clawgod-research.md` | ClawGod×Desktop 可行性调研（同源判断、补丁命中清单） |

## 注意

- ClawGod 补丁引擎为 GPLv3 第三方项目，本仓库**不包含**其代码，运行时按需从上游拉取
- `update-redirect` 与 `theme` 补丁随引擎一并烙入（无 wrapper 时门控默认开）：前者把 `claude update` 重定向到 ClawGod 安装器，后者 TUI 绿色主题；介意可自备 feature-gates
- Desktop 升级 Code 后版本 hash 目录会变，重跑 `repatch-claude-code.bat` 即可
- 原始 exe 备份留在本机脚本目录（不入库），`-Rollback` 依赖它
- 仅供本机学习研究，自担风险

## 致谢

- [0Chencc/clawgod](https://github.com/0Chencc/clawgod)（补丁引擎，GPL-3.0）
- [javaht/claude-desktop-zh-cn](https://github.com/javaht/claude-desktop-zh-cn)（Desktop 汉化，与本工具链互补）
- [DD05-SR/claude-desktop-zh-cn](https://github.com/DD05-SR/claude-desktop-zh-cn)（`localization/apply-fast.js` 的参照实现）
- [oven-sh/bun](https://github.com/oven-sh/bun)（`standalone_graph/StandaloneModuleGraph.rs` 是格式逆向的权威来源）
