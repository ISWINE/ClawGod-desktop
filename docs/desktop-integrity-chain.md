# Claude Desktop 捆绑 Claude Code 的完整性校验链（逆向结论）

> 代码位置：`app.asar → .vite/build/index.chunk-CIsKxfLj.js`（Desktop 3.6556.2.0，
> 其 compile-cache 字节码 `index.chunk-CIsKxfLj.js.x64.jsc` 同样含相关字面量）。
> 磁盘落点：`%LOCALAPPDATA%\Claude-3p\claude-code\<版本>\<hash>\`。

## 目录里的三个角色

```
claude.exe   283.6MB  Bun standalone（真正的 Code 运行时）
.payload     JSON {"sha256": <exe 的 sha256>, "size": <字节数>}
.verified    一段文本 = 服务端 manifest 里该版本的 checksum；目录名 <hash> 即其前 12 位
```

## 校验的真实时机（关键结论）

| 时机 | 做了什么 | 会不会抓到改 exe |
|---|---|---|
| 下载安装时 | 下载 `.zst` → 边解压边哈希 → 必须等于服务端 checksum → 落盘 exe → 写 `.payload`（本地实测哈希）+ `.verified`（服务端值） | 改不了（还没落地） |
| **spawn 会话时** | `binaryExistsForTarget()`：取 exe 路径 → `access(X_OK)` → **读 `.verified` 内容.trim() 与 manifest checksum 字符串全等比较** | **不会**。二进制本体从不重新哈希 |
| 任何时刻 | `.payload` 被读取 | **从未**。写完即死档 |

## 结论与推论

1. **就地替换 claude.exe 字节、`.payload`/`.verified` 原封不动 → 校验天然通过**。
   不需要 patch 校验代码，不需要 jmp 跳转，不需要伪造标记。
2. 哈希链是"下载时一次、之后只信标记"的信任模型——它防的是下载损坏/截断，不是防篡改。
3. 风险余量（均实测未触发）：
   - 服务端 manifest 若在启动时重新拉取且版本 checksum 变化 → `.verified` 比对失败 → 触发重下（重新跑 repatch 即可）
   - Desktop 未来版本可能加 spawn 前哈希（届时需补"跳过校验"补丁）
4. `cleanupOldVersionsForTarget` 会在装新版本后清旧版本目录——旧补丁随目录消失，
   与"更新后重打"的维护流程一致。

## 相关环境变量（建议用户级设置）

```
DISABLE_AUTOUPDATER=1                # 防 Code 自带后台更新器"修复" exe（同版本也会覆写）
CLAUDE_CODE_ATTRIBUTION_HEADER=0     # 第三方 Anthropic 兼容代理下 cch 字段会击穿 prompt
                                     # cache 前缀哈希（命中归零）；官方端点无此问题
```

## 版本目录发现

Desktop 按目录扫描发现已装版本（无集中指针配置）：`claude-code\<版本号>\<hash-dir>\claude.exe`，
`.verified` 存在与否决定目录有效性。repatch 脚本用同一规则自动定位 + 按 `[version]`
数值排序取最新。
