# Bun Standalone `__BUN` 容器格式与重打包配方

> 逆向来源：oven-sh/bun `src/standalone_graph/StandaloneModuleGraph.rs`（Bun v1.4.4）+
> ClawGod `extract-natives.mjs` + 实测验证（Claude Code 2.1.308 / win-x64）。
> 本文是 repack.js 的实现笔记。

## 总体布局（PE；ELF/Mach-O 同构，节名/定位不同）

```
PE 文件
├─ ...常规节 (.text/.rdata/.../.bunblt/.reloc)
├─ .bun 节 (PE 节表 rawOffset/rawSize)          ← 通常是最后一个节
│   ├─ u64 LE  payloadSize
│   └─ payload[payloadSize]
│       ├─ 数据区 [0, byte_count)
│       │   ├─ names blob / sourcemaps / bytecode / module_info ...
│       │   ├─ 各模块 contents（源码文本）
│       │   ├─ 模块表 (52B × N 记录)
│       │   └─ 链式可选记录（按 Offsets.flags 位序，紧跟表后）
│       ├─ Offsets 结构 (32B)
│       └─ trailer: "\n---- Bun! ----\n" (16B)
└─ [签名覆盖层（Authenticode cert，若有）]        ← 修改即失效，可整体摘除
```

## Offsets 结构（32B，位于 trailer 前）

```
+0  u64  byte_count            数据区总长（= payload 长度 - 32 - 16）
+8  u32  modules_ptr.offset    模块表在 payload 内的偏移
+12 u32  modules_ptr.length    模块表字节数（52 的倍数）
+16 u32  entry_point_id        入口模块记录下标
+20 u32  compile_exec_argv.offset ┐ 可为 (data_end-1, 0) 的空串；保留原值即可
+24 u32  compile_exec_argv.length ┘
+28 u32  flags                 位图（见下）
```

## flags 位序（链式可选记录的排列顺序 = 位序）

```
bit0-3  DISABLE_DEFAULT_ENV_FILES / AUTOLOAD_BUNFIG / TSCONFIG / PACKAGE_JSON
bit4    SOURCE_TEXT_CONTIGUOUS   （仅影响 mac/linux madvise，Windows 无效果）
bit5    HAS_SOURCE_HASHES        [u32 × N] 各模块源文本 WTF 哈希（0=无），紧贴表后
bit6    HAS_BUILTIN_BYTECODE     u32 count + count×{u32 id, StringPointer bytes}
bit7    HAS_BYTECODE_STRING_TABLE 一个 StringPointer
bit8    HAS_STARTUP_MODULE_COUNT u32
bit9    HAS_MODULE_INFO_STRING_TABLE 一个 StringPointer
bit10   CROSS_COMPILED_BYTECODE
bit11   HAS_PRELINKED_MODULE_GRAPH
bit12   HAS_RUNTIME_OPTIONS      u32 flags + u32 value
bit13   HAS_LINKED_BYTECODE_PAYLOAD
```

实测 Claude Code 2.1.308：flags = 0x1BFF（bit0-8,10,12），链式区 22,693B。

## 模块记录（52B）

```
+0/4   name        StringPointer{offset,length}   （相对 payload 起点）
+8/12  contents    StringPointer
+16/20 sourcemap   StringPointer
+24/28 bytecode    StringPointer                  （JSC 字节码）
+32/36 module_info StringPointer
+40/44 bytecode_origin_path StringPointer
+48    encoding u8  (0=Binary, 1=Latin1, ...)
+49    loader  u8  (0 jsx,1 js,2 ts,...,10 napi,20 md)
+50    module_format u8
+51    side u8
```

模块名形如 `B:/~BUN/root/chunk-xxxx.js`（win）或 `/$bunfs/root/...`（posix）。

## 四个致命坑（重打包必踩）

1. **NUL 终止**：每个模块 contents 之后必须有一个 `\0`（`appendCountZ` 契约，
   `slice_to_z`）。缺失 → `Corrupted module graph: module contents are out of range`。
2. **字节码遮蔽**：绝大多数 js 模块带 JSC 字节码指针（实测 2504/2755）。改了源码
   却不清零该记录的 `bytecode`/`module_info`/`bytecode_origin_path` 指针 + 链式区
   源哈希槽 → 运行时直接用旧字节码，补丁静默失效。
3. **Latin1 模块**：`encoding=Latin1` 且含高位字节的模块（chart.umd / hljsBundle /
   mermaid.min）不能按 UTF-8 文本往返（会膨胀出 U+FFFD 三字节序列）。跳过不补。
4. **链式记录必须随新表搬移**：读取方从 `modules_ptr.offset + length` 开始按位序
   解析可选记录。表挪位置后必须把整段链式区复制到新表之后，否则启动即崩。

## 重打包配方（append-and-repoint）

```
newPayload =
    原数据区 [0, oldDataEnd)            ← 一字节不动（含旧表/旧链，成为死数据）
  + 各补丁模块新内容（各自追加 \0 终止）
  + 新模块表（补丁记录的 contents 指针指向追加区；bytecode 三指针清零）
  + 旧链式区整段复制（补丁模块的源哈希槽清零）
  + Offsets（byte_count / modules_ptr 更新，其余字段保留）
  + trailer
```

PE 侧修改：`.bun` 节 `SizeOfRawData`/`VirtualSize` 增长（对齐 0x200）、
`SizeOfImage` 重算（对齐 0x1000）、Certificate 数据目录清零 + 覆盖层摘除、
`CheckSum` 清零。全部偏移相对 payload 起点，绝对文件偏移不变。

## 校验（repack.js 内置）

- 逐模块字节比对：补丁模块内容 === 磁盘产物；未补丁模块 === 原始字节
- 输出文件重解析：trailer / byte_count / 表长 / entry id 全部复验
- 烟测：`--version` 输出版本号

## 相关事实

- 入口模块（entry_point_id）是一个 ~20KB 的 ESM loader，静态 import 同级 chunk，
  懒加载其余（v2.1.245+ 图布局；更早版本是单文件 bundle）
- ClawGod 引擎产物布局：`cli.original.cjs`（入口）+ `bunfs\flat__name`（分块，
  `/`→`__` 展平）+ `pathmap.json`（模块名 → 展平路径映射）+ `vendor\*.node`
- 提取时切勿用 `Select-Object -First` 截断提取进程输出（PowerShell 管道停止语义会
  掐死写入中的 node，得到残缺目录）
