# ClawGod × Claude Desktop 可行性调研（实测）

> 结论：**可行且已落地**。ClawGod 是 Claude Code（Bun standalone）的运行时补丁，
> Desktop 第三方 API 模式（Claude-3p）捆绑的 claude.exe 与独立版完全同构，
> 同一套引擎直接可用。

## 实测数据（Claude Code 2.1.308，win-x64）

- 提取：`extract-natives.mjs` 直接认 PE `.bun` 节，2753 分块共 49MB
- 补丁扫描（`patch.mjs --dry-run`）：**34 命中 / 0 失败 / 15 版本不适用**

### 命中清单

| 类别 | 补丁 |
|---|---|
| 解锁 | USER_TYPE→ant（内部模式/24+隐藏命令）、Ultraplan、Ultrareview(rQt)、Agent Teams(graph)、auto-mode 第三方解锁(inline)、classifier 调参×3、GrowthBook config overrides |
| 去限制 | CYBER_RISK_INSTRUCTION、URL 猜测禁令、谨慎操作强制确认、未登录提醒 |
| 过滤 | attachment-filter-bypass、message-filter(s_8) |
| 隐私 | wiggly-dove 阻断（Git origin/环境元数据不再收集）、remote-settings-off |
| 视觉 | theme×12（对 Desktop 无意义但无害） |

### 无命中（无损失）

Computer Use×3（Windows 本无）、Voice Mode、geo-stego-date（2.1.308 形状已变）；
geo-detect-probe 显示已中性。

## 与"独立安装 ClawGod"的差异

| 项 | 独立版 | Desktop 捆绑版（本项目） |
|---|---|---|
| 运行方式 | launcher(`clawgod.cmd`) 用 stock Bun 跑补丁后 cli.js | 直接 repack 回单文件 exe，Desktop 无感 spawn |
| Bun 私有 API | 需 bun-ant-shim（Bun.ant.CellSegmenter） | 原生 Anthropic Bun 自带，无需 shim |
| feature 门控 | wrapper 加载 feature-gates.cjs 读 patches.json | 无 wrapper → 门控默认全开（含 update-redirect/theme） |
| 自更新 | clawgod 接管 `claude update` | Desktop 自己管理版本；Code 自更新器用 env 关掉 |

## 无需安装 ClawGod 即可用的知识

- `CLAUDE_CODE_ATTRIBUTION_HEADER=0`：官方内置开关，修第三方代理缓存击穿
- 隐私遥测清单（审计中转请求时看什么）：日期字符串四态 Unicode 撇号
  （U+0027/2019/02BC/02B9）地理隐写；三轴探测（Asia/Shanghai|Urumqi 时区、XOR
  混淆 100+ 代理域名黑名单、baseURL CN-LLM 关键词）；`x-claude-code-wiggly-dove`
  自动收集 Git origin + 容器/沙箱元数据
- GrowthBook flag 覆盖思路（`tengu_prompt_cache_1h_config` 等）；Desktop 侧对应物
  是 statsig 门控

## 端到端验证状态

- `--version` / `--help` 烟测通过；`__clawgodPatches` 门控 16 处烙入
- Desktop 正常拉起补丁版（8 进程）；**Cowork 会话实测正常**（用户确认）
- 标记文件 `.payload`/`.verified` 原封，Desktop 未触发重下
