# 面板接管每一条 mcp-client 行，并提供原文编辑

Issue #67。维护者 Fishquito7 与提出者 jiangzhenguo 一致：不要只给块外行加一个开关。

## 背景

面板原先把 `@deepseek-ai/dsh-mcp-client` 分成两类：受管块内且 `id` 以 `panel-mcp-` 开头的行可以启停、编辑、删除；其余（手写、从别的 profile 迁来、或 id 不是这个前缀）在 MCP 页标成「外部管理」/「受管块外」，卡片上没有任何操作。现实里多数配置恰恰是手写的。

只给外部行加 `disabled` 开关能解决「临时关掉省上下文」，但编辑、删除、OAuth 仍然要去改文件，而且「先收编进受管块才能编辑」会整段重写、破坏手写字节。

## 决策

1. **全接管**。文件里每一条 `name: @deepseek-ai/dsh-mcp-client` 的行都能启停、用表单编辑、删除、做 OAuth。不再用受管块或 `panel-mcp-*` 区分能不能操作。
2. **就地改，不搬家**。已有行留在原地。启停只翻转这一条的 `disabled`（无键则按 id 行对齐插入，启用且独占一行则整行删除；`!!js` 拒绝代写）。删除只剪掉这一条的文本跨度。表单保存和 OAuth 写 Authorization 也只重写这一条。文件其余字节不动。
3. **表单与原文并存**。表单继续管 transport / command / env / headers 等已建模字段，并保留表单不认识的键（例如 `maxInstructionBytes`）和手写 id。卡片上的「原文」（CLI：`dsh-panel mcp raw` / `--set`）把这一条的 YAML 按字节交还给用户。
4. **不迁移**。旧受管块里的行本来就是普通 mcp-client 行，改完之后只是不再被特殊对待。新建的服务器仍追加进受管块，id 仍是 `panel-mcp-<serverName>`。
5. **非 MCP 行仍按 ADR-0003**。受管块里不属于 MCP 的条目不被折叠、不被改写；界面继续提示它们。

## Considered Options

- **只加外部行开关**（issue 原文的实现建议）：本地已验证热启停和字节往返，但编辑/删除仍断档，也保留了「受管 / 外部」两套卡片。维护者明确要求不要停在这一步。
- **收编进受管块再编辑**：整段重写会吃掉注释、键序和 `!!js`，与「手写和面板管理不再二选一」相反。
- **表单保存仍整块重写所有面板行**：会把没被这次编辑碰到的行也规范化。改为只替换目标 entry。

## Consequences

- `externalServers` 仍留在 wire schema 里，但列表现在始终是空数组；全部 MCP 行都在 `servers`。
- 手写 id 在表单保存后保持不变。只有 id 恰好是 `panel-mcp-<旧 serverName>` 时，改名才会把 id 换成新的 `panel-mcp-*`。
- 表单保存会重排**这一条**的键序（未知键留在 config 末尾）。要逐字节保留注释和键序，用原文编辑。启停本身不重排。已有的 `!!js` `disabled` 在表单和 OAuth 写回时保留表达式，不会被收成布尔值。
- `serverName` 一律先看非空的 `config.serverName`，没有时才用 `panel-mcp-*` 的 id 后缀。CLI 和网关用同一规则。
- `dsh-panel mcp list` 不再打印「受管 / 外部」。
