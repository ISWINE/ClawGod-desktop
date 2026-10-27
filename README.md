# clawkit

> Claude Desktop 补丁工具箱。

** 自动拉取最新- [0Chencc/clawgod](https://github.com/0Chencc/clawgod)

测试环境：Claude Desktop 3.6556.2.0（MSIX 商店版，API 模式）/ Claude Code 2.1.308 / Windows 11。

## 使用
```powershell
# 打补丁
.\repatch-claude-code.bat
# 同步最新ClawGod补丁
.\repatch-claude-code.bat -UpdateEngine
# 还原
.\repatch-claude-code.bat -Rollback
# 指定版本 / 不自动重启 Desktop
.\repatch-claude-code.bat -Version 2.1.308 -SkipRestart
```

### 隐私守卫

`claude-privacy-guard.ps1` 
| 遥测屏蔽 || 队列清理 | 


## 

- [0Chencc/clawgod](https://github.com/0Chencc/clawgod)（补丁引擎，GPL-3.0）
- [javaht/claude-desktop-zh-cn](https://github.com/javaht/claude-desktop-zh-cn)（Desktop 汉化，与本工具链互补）
- [DD05-SR/claude-desktop-zh-cn](https://github.com/DD05-SR/claude-desktop-zh-cn)（`localization/apply-fast.js` 的参照实现）
- [oven-sh/bun](https://github.com/oven-sh/bun)（`standalone_graph/StandaloneModuleGraph.rs` 是格式逆向的权威来源）
