# clawkit

Claude Desktop / Claude Code 本机补丁工具链。四件事：

1. **repack.js** — Bun standalone 可执行文件（`__BUN` 段）通用重打包器：提取 → 修改模块源码 → 塞回单文件 exe
2. **repatch-claude-code.ps1/.bat** — 全自动流水线：Claude Desktop 更新捆绑的 Claude Code 后一键重打 ClawGod 补丁（自动发现 node/引擎/数据目录/最新版本，可在线同步上游补丁引擎）
3. **docs/** — 逆向文档：`__BUN` 容器格式、Desktop 完整性校验链真相、ClawGod 调研
4. **claude-privacy-guard.ps1** — Claude Desktop 应用层隐私守卫：hosts 屏蔽 Sentry/Statsig/Amplitude/Segment 遥测、清本地 Crashpad/sentry 队列、claude.ai 断网开关、定时自动重扫；不碰安装目录免疫更新，与 ClawGod 进程内补丁互补（一个管 DNS 层一个管 claude.exe 内部）

实测环境：Claude Desktop 3.6556.2.0（MSIX 商店版，第三方 API 模式）/ Claude Code 2.1.308 / Bun v1.4.4 运行时 / Windows 11。

## 快速使用

```powershell
# Desktop 更新了 Code 之后：重打补丁（自动选最新版本，全自动发现路径）
.\repatch-claude-code.bat

# 顺带同步 ClawGod 上游最新补丁引擎（推荐偶尔跑）
.\repatch-claude-code.bat -UpdateEngine

# 还原官方原始 exe
.\repatch-claude-code.bat -Rollback

# 指定版本 / 不自动重启 Desktop
.\repatch-claude-code.bat -Version 2.1.308 -SkipRestart
```

单独使用重打包器（三个参数：原始 exe、补丁工作目录、输出 exe）：

```
node repack.js <original.exe> <scan-dir> <output.exe>
```

`<scan-dir>` 需包含 ClawGod 引擎产物：`cli.original.cjs`、`bunfs\*`、`pathmap.json`
（由 [ClawGod](https://github.com/0Chencc/clawgod) 的 `extract-natives.mjs` + `patch.mjs` 生成）。

## 它是怎么工作的（30 秒版）

- Claude Desktop 对捆绑 claude.exe 的"完整性校验"，spawn 时只做
  `.verified` 文件内容 === 服务端 manifest 校验值的**字符串比对**，从不重新哈希二进制，
  `.payload` 写完即无人读 → **就地替换 exe 字节零检测**（详见 docs/desktop-integrity-chain.md）
- Bun standalone exe 把全部 JS 模块装在 PE `.bun` 节里；格式含 NUL 终止、JSC 字节码指针、
  链式可选记录等坑，repack.js 全部处理（详见 docs/bun-section-format.md）
- 改过源码的模块必须同时清零其 bytecode 指针与源哈希槽，否则旧字节码会遮蔽新代码（静默失效）

## 仓库内容

| 路径 | 说明 |
|---|---|
| `repack.js` | `__BUN` 容器重打包器（核心，参数化，自校验） |
| `repatch-claude-code.ps1` | 全自动重打流水线（UTF-8 BOM，PS 5.1 兼容） |
| `repatch-claude-code.bat` | 双击入口（绕过执行策略） |
| `tools/inspect-pe.js` | PE 节表 / 证书 / `.bun` 布局检查器 |
| `tools/inspect-struct.js` | `__BUN` Offsets 结构 / 模块表检查器 |
| `localization/apply-fast.js` | DD05-SR 汉化引擎的 Node 复刻（见文首说明） |
| `docs/bun-section-format.md` | `__BUN` 容器格式与重打包配方 |
| `docs/desktop-integrity-chain.md` | Desktop 完整性校验链逆向 |
| `docs/clawgod-research.md` | ClawGod×Desktop 可行性调研 |
| `claude-privacy-guard.ps1` | Desktop 遥测/隐私守卫（hosts sinkhole + 断网开关 + 登录/6h 自动重扫，UTF-8 BOM，PS 5.1 兼容） |

## 依赖

- Node.js ≥ 18（脚本自动发现：PATH → 常规路径 → AutoClaw vendor）
- PowerShell 5.1+（`.ps1` 带 BOM；如手工运行请加 `-ExecutionPolicy Bypass`）
- 网络（仅 `-UpdateEngine` 时访问 GitHub codeload）

## 注意

- ClawGod 补丁引擎为 GPLv3 第三方项目，本仓库**不包含**其代码，运行时按需从上游拉取
- `update-redirect` 与 `theme` 补丁随引擎一并烙入（无 wrapper 时门控默认开）：前者把 `claude update` 重定向到 ClawGod 安装器，后者 TUI 绿色主题；介意可自备 feature-gates
- Desktop 升级 Code 后版本 hash 目录会变，重跑 `repatch-claude-code.bat` 即可
- 原始 exe 备份 `claude.orig-<ver>.exe` 保留在本机脚本目录（不入库），`-Rollback` 依赖它
- 仅供本机学习研究，自担风险

## 致谢

- [0Chencc/clawgod](https://github.com/0Chencc/clawgod)（补丁引擎，GPL-3.0）
- [javaht/claude-desktop-zh-cn](https://github.com/javaht/claude-desktop-zh-cn)（Desktop 汉化，与本工具链互补）
- [DD05-SR/claude-desktop-zh-cn](https://github.com/DD05-SR/claude-desktop-zh-cn)（`localization/apply-fast.js` 的参照实现）
- [oven-sh/bun](https://github.com/oven-sh/bun)（`standalone_graph/StandaloneModuleGraph.rs` 是格式逆向的权威来源）
