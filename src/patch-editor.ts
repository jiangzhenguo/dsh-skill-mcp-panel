/**
 * dsh-skill-mcp-panel —— profile cordis.patch.yml 编辑器。
 *
 * 每一条 `@deepseek-ai/dsh-mcp-client` 行都归面板管（启停、表单编辑、删除、原文编辑），
 * 不再用受管块或 `panel-mcp-*` 前缀区分「受管 / 外部」。对这些行的改动都是就地拼接：
 * 只替换目标 entry 的字节跨度，文件其余部分逐字节保留。
 *
 * begin/end 受管块仍然是「面板新建的行」落点，也仍然是非 MCP 外来行的字节保真边界
 * （ADR-0003）：重写受管块时，块里不属于面板的非 MCP 条目原样搬回去。
 *
 * 写入使用同目录临时文件 + rename，并通过锁文件避免 Web 宿主与 CLI 并发写。
 */
import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMap, isPair, isScalar, isSeq, parseDocument, stringify } from "yaml";

export const PANEL_MCP_BLOCK_BEGIN = "# >>> dsh-skill-mcp-panel:mcp:begin";
export const PANEL_MCP_BLOCK_END = "# <<< dsh-skill-mcp-panel:mcp:end";
export const MCP_PLUGIN_NAME = "@deepseek-ai/dsh-mcp-client";
export const MANAGED_ROW_ID_PREFIX = "panel-mcp-";

/**
 * cordis 配置层的 !!js 标签：值是 JS 表达式，由宿主装载时求值
 * （@deepseek-ai/cordis-plugin-loader 的 interpolate → new Function + eval）。
 * DSH 官方给的环境变量写法就是它，例如：
 *   Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
 *
 * 面板必须原样往返这个标签：只把值当普通字符串读、再整块重写，表达式就会降级成
 * 字面量字符串——用户的令牌从此变成一个永远发不出去的值，而且没有任何提示。
 */
const JS_EXPR_TAG = "tag:yaml.org,2002:js";

/** 表达式里的换行无法用单引号标量安全往返，退回双引号（JSON 转义）。 */
function quoteJsExpr(expression: string): string {
  if (/[\n\r]/.test(expression)) return JSON.stringify(expression);
  return "'" + expression.replace(/'/g, "''") + "'";
}

/**
 * 自定义 !!js 标签：读时还原成 { __jsExpr } 标记对象（不再有 TAG_RESOLVE_FAILED），
 * 写时按原标签回写。identify 只认「恰好一个 __jsExpr 字符串键」的对象，
 * 不会误伤普通配置对象。
 */
const jsExprTag: any = {
  tag: JS_EXPR_TAG,
  resolve: (value: string) => ({ __jsExpr: value }),
  identify: (value: unknown): boolean =>
    value !== null &&
    typeof value === "object" &&
    Object.keys(value as Record<string, unknown>).length === 1 &&
    typeof (value as { __jsExpr?: unknown }).__jsExpr === "string",
  stringify: (node: any) => quoteJsExpr(String(node.value.__jsExpr))
};

/** 全部解析与序列化共用同一份标签定义，读到的 !!js 才能原样写回。 */
const YAML_CUSTOM_TAGS = [jsExprTag];

/** !!js 表达式节点的标记形状。 */
export interface JsExprValue {
  __jsExpr: string;
}

/** 判断一个 YAML 值是否是面板保留的 !!js 表达式节点。 */
export function isJsExprValue(value: unknown): value is JsExprValue {
  return jsExprTag.identify(value);
}

/** Loader patch 行（宽松形状；受管块只包含 insert 列表）。 */
export interface PatchRow {
  id?: string;
  name?: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

const delay = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));

/** 读取 patch 文件；缺失/读失败统一带路径报错。 */
export async function readPatchFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new Error("无法读取 cordis.patch.yml（" + path + "）：" + (error instanceof Error ? error.message : String(error)));
  }
}

/** 校验整份 patch 文本：可解析且顶层是数组。不解出/写回任何值。 */
export function assertPatchText(raw: string): void {
  const doc = parseDocument(raw, { logLevel: "silent", customTags: YAML_CUSTOM_TAGS });
  if (doc.errors.length > 0) {
    throw new Error("cordis.patch.yml 解析失败：" + String(doc.errors[0]?.message ?? doc.errors[0]));
  }
  const parsed = doc.toJS();
  if (!Array.isArray(parsed)) throw new Error("cordis.patch.yml 顶层必须是 YAML 数组");
}

/** 校验整份 patch 文本：可解析且顶层是数组。不解出/写回任何值。 */
export async function validatePatchText(raw: string): Promise<void> {
  assertPatchText(raw);
}

/** 把 YAML 解析出的单个条目收成 patch 行；`id`/`name` 都不是字符串的条目返回 undefined。 */
function rowFromValue(value: unknown): PatchRow | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" && typeof row.name !== "string") return undefined;
  const normalized: PatchRow = { ...row };
  if (typeof row.id !== "string") delete normalized.id;
  if (typeof row.name !== "string") delete normalized.name;
  if (typeof row.disabled !== "boolean") delete normalized.disabled;
  if (row.config === null || typeof row.config !== "object" || Array.isArray(row.config)) delete normalized.config;
  return normalized;
}

/** 把 YAML 解析出的顶层条目拍平成 patch 行。 */
function flattenPatchRows(entries: unknown): PatchRow[] {
  const rows: PatchRow[] = [];
  if (!Array.isArray(entries)) return rows;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (Array.isArray(record.insert)) {
      for (const member of record.insert) {
        const row = rowFromValue(member);
        if (row !== undefined) rows.push(row);
      }
    } else {
      const row = rowFromValue(record);
      if (row !== undefined) rows.push(row);
    }
  }
  return rows;
}

/**
 * 面板自己的行：`id` 以 `panel-mcp-` 开头。这是「面板拥有这一行」的唯一判据
 * （与行级操作 isManagedRow / findRowByServerName 一致）。
 *
 * 关键：判据只能看**这一行**。受管块里允许存在别的工具、旧版本或用户手写的
 * 条目，它们不是我们的，一律原样保留（见 ManagedBlockForeign）。
 */
export function isManagedRow(row: PatchRow): boolean {
  return typeof row.id === "string" && row.id.startsWith(MANAGED_ROW_ID_PREFIX);
}

/**
 * 受管块里**不属于面板**的部分。面板必须原样保留它们：顶层的 `- id:` 条目是
 * 「按 id 定向覆盖」，`insert` 成员是「追加」——把前者折叠进 insert 会改掉语义，
 * 并让同一个 loader id 出现两行（dsh-market 的试算按 id 计数，直接判重复而回滚
 * 整批更新，见 ADR-0003）。
 */
export interface ManagedBlockForeign {
  /** 外来顶层条目的原始文本（逐字节，含 `- ` 前缀与行尾换行）。 */
  top: string;
  /** 外来 `insert` 条目的原始文本（逐字节）。面板不认领放进外来 insert 里的行。 */
  insert: string;
  /** 外来部分里认出 id / name 的条目，供界面提示「块内还有哪些行不属于面板」。 */
  entries: { id?: string; name?: string; managed: boolean }[];
}

const EMPTY_FOREIGN: ManagedBlockForeign = { top: "", insert: "", entries: [] };

/**
 * 受管块里每个顶层条目的完整文本跨度（含 `- ` 前缀、行尾换行、以及条目之间的注释）。
 *
 * 跨度按「下一个条目的行首」界定并**首尾相接铺满整块**（第一段从 0 开始，最后一段
 * 到块尾），而不是按节点自身的 range：嵌套块集合（如 `insert:` 下面的列表）的 range
 * 末尾不覆盖自己的内容，而注释与空行不属于任何节点。铺满之后块内每个字节都有着落，
 * 外来部分才能真正逐字节搬运。
 */
function blockItemSpans(text: string, nodes: any[]): { start: number; end: number }[] {
  const starts = nodes.map((node) => text.lastIndexOf("\n", node.range[0] - 1) + 1);
  return nodes.map((_, index) => ({
    start: index === 0 ? 0 : starts[index],
    end: index + 1 < nodes.length ? starts[index + 1] : text.length
  }));
}

/** 条目是不是 `insert:` 列表；是则返回成员节点。 */
function insertMembers(node: any): any[] | undefined {
  if (!isMap(node) || node.items.length !== 1) return undefined;
  const pair = node.items[0];
  const key = pair?.key as { value?: unknown } | undefined;
  if (key === undefined || key === null || typeof key !== "object" || key.value !== "insert") return undefined;
  return isSeq(pair.value) ? pair.value.items : undefined;
}

/**
 * 读受管块：面板自己的行 + 块内不属于面板的部分。
 * 无标记时返回空结果；标记不完整、块内容解析失败则抛错。
 */
export function readManagedBlock(raw: string): { managed: PatchRow[]; foreign: ManagedBlockForeign } {
  const begin = raw.indexOf(PANEL_MCP_BLOCK_BEGIN);
  const end = raw.indexOf(PANEL_MCP_BLOCK_END);
  if (begin < 0 && end < 0) return { managed: [], foreign: EMPTY_FOREIGN };
  if (begin < 0 || end < 0 || end < begin) throw new Error("cordis.patch.yml 中 dsh-skill-mcp-panel 受管块标记不完整（begin/end 必须成对）");
  const blockStart = raw.indexOf("\n", begin);
  if (blockStart < 0) throw new Error("cordis.patch.yml 受管块格式损坏");
  const text = raw.slice(blockStart + 1, end);
  const doc = parseDocument(text, { logLevel: "silent", customTags: YAML_CUSTOM_TAGS });
  if (doc.errors.length > 0) throw new Error("受管块解析失败：" + String(doc.errors[0]?.message ?? doc.errors[0]));
  const parsed = doc.toJS();
  if (!Array.isArray(parsed)) throw new Error("受管块内容必须是 YAML 数组");

  const managed: PatchRow[] = [];
  const topParts: string[] = [];
  const insertParts: string[] = [];
  const entries: ManagedBlockForeign["entries"] = [];
  const nodes: any[] = isSeq(doc.contents) ? doc.contents.items : [];
  const spans = blockItemSpans(text, nodes);
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const value: any = parsed[index];
    const members = insertMembers(node);
    if (members !== undefined) {
      // 只有「成员全是面板行」的 insert 条目才归面板所有。混着外来成员的整条原样
      // 保留——认领其中长得像面板行的那几条会同时触发重复写入。
      const rows: (PatchRow | undefined)[] = (Array.isArray(value?.insert) ? value.insert : []).map(rowFromValue);
      const owned = rows.length > 0 && rows.every((row) => row !== undefined && isManagedRow(row));
      if (owned) {
        for (const row of rows) managed.push(row as PatchRow);
        continue;
      }
      for (const row of rows) if (row !== undefined) entries.push({ id: row.id, name: row.name, managed: isManagedRow(row) });
      insertParts.push(text.slice(spans[index].start, spans[index].end));
      continue;
    }
    const row = rowFromValue(value);
    if (row !== undefined && isManagedRow(row)) {
      managed.push(row);
      continue;
    }
    if (row !== undefined) entries.push({ id: row.id, name: row.name, managed: false });
    topParts.push(text.slice(spans[index].start, spans[index].end));
  }
  return { managed, foreign: { top: topParts.join(""), insert: insertParts.join(""), entries } };
}

/** 提取 begin/end 标记之间的受管行（只含面板自己的行）；无标记返回空数组。 */
export function extractManagedRows(raw: string): PatchRow[] {
  return readManagedBlock(raw).managed;
}

/** 解析整份 patch 并返回其中所有 MCP 客户端行（不区分是否受管）。 */
export function listMcpPatchRows(raw: string): PatchRow[] {
  const doc = parseDocument(raw, { logLevel: "silent", customTags: YAML_CUSTOM_TAGS });
  if (doc.errors.length > 0) return [];
  const parsed = doc.toJS();
  if (!Array.isArray(parsed)) return [];
  return flattenPatchRows(parsed).filter((row) => row.name === MCP_PLUGIN_NAME);
}

/**
 * 生成受管块文本（三部分都为空时返回空字符串）。
 *
 * 顺序：外来顶层条目 → 外来 insert 条目 → 面板自己的 `insert` 列表。外来部分逐字节
 * 原样搬运，面板只重建自己那一段。
 */
export function generateManagedBlock(rows: PatchRow[], foreign: ManagedBlockForeign = EMPTY_FOREIGN, baseIndent = ""): string {
  const parts: string[] = [];
  if (foreign.top !== "") parts.push(foreign.top.replace(/\s*$/, "\n"));
  if (foreign.insert !== "") parts.push(foreign.insert.replace(/\s*$/, "\n"));
  if (rows.length > 0) {
    const body = stringify([{ insert: rows }], { indent: 2, lineWidth: 0, customTags: YAML_CUSTOM_TAGS });
    parts.push(baseIndent === "" ? body : body.split("\n").map((line) => (line === "" ? line : baseIndent + line)).join("\n"));
  }
  if (parts.length === 0) return "";
  return PANEL_MCP_BLOCK_BEGIN + "\n" + parts.join("") + PANEL_MCP_BLOCK_END + "\n";
}

/** 块内顶层条目的基准缩进（正常是空字符串；整块被缩进时按原样对齐）。 */
function blockBaseIndent(raw: string): string {
  const begin = raw.indexOf(PANEL_MCP_BLOCK_BEGIN);
  if (begin < 0) return "";
  const end = raw.indexOf(PANEL_MCP_BLOCK_END);
  const blockStart = raw.indexOf("\n", begin);
  if (blockStart < 0) return "";
  const text = raw.slice(blockStart + 1, end < 0 ? undefined : end);
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.trimStart().startsWith("-")) continue;
    return /^[ \t]*/.exec(line)?.[0] ?? "";
  }
  return "";
}

/**
 * 替换受管块；无标记且要写入行时追加到文件末尾。标记之外的所有字节原样保留，
 * 标记之内的**外来条目也原样保留**（不传 `foreign` 时自动从 `raw` 里读一遍）。
 */
export function replaceManagedBlock(raw: string, rows: PatchRow[], foreign?: ManagedBlockForeign): string {
  const begin = raw.indexOf(PANEL_MCP_BLOCK_BEGIN);
  const end = raw.indexOf(PANEL_MCP_BLOCK_END);
  const foreignPart = foreign ?? (begin >= 0 || end >= 0 ? readManagedBlock(raw).foreign : EMPTY_FOREIGN);
  const block = generateManagedBlock(rows, foreignPart, blockBaseIndent(raw));

  if (begin >= 0 || end >= 0) {
    if (begin < 0 || end < 0 || end < begin) throw new Error("cordis.patch.yml 中 dsh-skill-mcp-panel 受管块标记不完整（begin/end 必须成对）");
    const lineStart = raw.lastIndexOf("\n", begin - 1) + 1;
    const afterEnd = raw.indexOf("\n", end);
    const lineEnd = afterEnd < 0 ? raw.length : afterEnd + 1;
    const next = raw.slice(0, lineStart) + block + raw.slice(lineEnd);
    if (block !== "") return next;
    // 删除最后一批受管行后，原文件可能只剩注释（或原先就是 `[]` 模板）；
    // 此时必须补回流式空数组，否则 patch 文件不再是合法顶层数组。
    const meaningful = next.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
    if (meaningful.length === 0) return next.replace(/\s*$/, "") + "\n[]\n";
    return next;
  }

  if (block === "") return raw;
  // 空 profile 模板是流式空数组 `[]`：直接追加块序列会变成 `[] - insert`，
  // 必须在追加前把 `[]` 替换为受管块序列。
  const lines = raw.split(/\r?\n/);
  const meaningful = lines.map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  if (meaningful.length === 1 && meaningful[0] === "[]") {
    const index = raw.lastIndexOf("[]");
    return raw.slice(0, index) + block + raw.slice(index + 2);
  }
  const prefix = raw.length === 0 ? "" : raw.endsWith("\n") ? "\n" : "\n\n";
  return raw + prefix + block;
}

/** 同目录临时文件 + rename 原子写；Windows 上 rename 覆盖失败时退化为 rm+rename。 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), ".dsh-panel-tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 8));
  try {
    await writeFile(temp, content, "utf8");
    try {
      await rename(temp, path);
    } catch (error) {
      if (error === null || typeof error !== "object" || !["EPERM", "EEXIST", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await rm(path, { force: true });
      await rename(temp, path);
    }
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * 以 `<path>.panel.lock` 为锁执行 fn。锁文件记录 pid + 时间；超过 30 秒视为
 * 陈旧锁自动清理。获取超时 5 秒。
 */
export async function withPatchLock<T>(path: string, fn: () => Promise<T> | T): Promise<T> {
  const lockPath = path + ".panel.lock";
  const started = Date.now();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (handle === undefined) {
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (error === null || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > 30000) await rm(lockPath, { force: true }).catch(() => {});
      } catch {
        // 锁在检查间隙被释放：继续重试。
      }
      if (Date.now() - started > 5000) throw new Error("等待 cordis.patch.yml 写锁超时（可能有其他 dsh-panel 进程正在写入）");
      await delay(50);
    }
  }
  try {
    await handle.writeFile(process.pid + "\n" + Date.now() + "\n", "utf8");
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

/**
 * 把受管块内的外来**顶层**条目原样搬到 begin 标记之前（仍在标记外，语义不变）。
 *
 * 背景：DSH 自己的配置编辑器（`dsh-config-editor`）在给某个插件首次写配置时，
 * 会往 patch 数组末尾 `document.add()` 一行；而我们的 end 注释正好是文件最后一行，
 * YAML 序列化时新行被排在尾注释之前，于是落进受管块里（Issue #46 的后续）。
 *
 * 只搬顶层行：`insert:` 里的外来成员搬出去会改变「插入哪些插件」的语义，留原样。
 * 异常输入（标记不成对、块被整体缩进、解析失败）一律原样返回，绝不半途改文件。
 */
export function evacuateForeignRows(raw: string): { raw: string; moved: number } {
  const begin = raw.indexOf(PANEL_MCP_BLOCK_BEGIN);
  const end = raw.indexOf(PANEL_MCP_BLOCK_END);
  if (begin < 0 || end < 0) return { raw, moved: 0 };
  // 整块被缩进时（嵌在别的结构里），搬出去会改变层级语义，宁可不做。
  if (blockBaseIndent(raw) !== "") return { raw, moved: 0 };
  let block;
  try {
    block = readManagedBlock(raw);
  } catch {
    return { raw, moved: 0 };
  }
  if (block.foreign.top === "") return { raw, moved: 0 };
  // 只统计顶层条目：把 foreign.top 本身再解析一遍。
  let moved = 0;
  try {
    const doc = parseDocument(block.foreign.top, { logLevel: "silent", customTags: YAML_CUSTOM_TAGS });
    moved = isSeq(doc.contents) ? doc.contents.items.length : 0;
  } catch {
    return { raw, moved: 0 };
  }
  if (moved === 0) return { raw, moved: 0 };
  const withoutTop = replaceManagedBlock(raw, block.managed, { ...block.foreign, top: "" });
  const lineStart = withoutTop.lastIndexOf("\n", withoutTop.indexOf(PANEL_MCP_BLOCK_BEGIN) - 1) + 1;
  const blockText = block.foreign.top.replace(/\s*$/, "\n");
  return { raw: withoutTop.slice(0, lineStart) + blockText + withoutTop.slice(lineStart), moved };
}

/**
 * 读取 patch 文件、把受管块内的外来顶层条目搬出去、校验、加锁原子写回。
 * 返回搬走的条数与写回后的完整文本。
 */
export async function writeEvacuatedForeign(path: string): Promise<{ moved: number; raw: string }> {
  return withPatchLock(path, async () => {
    const raw = await readPatchFile(path);
    const result = evacuateForeignRows(raw);
    if (result.moved === 0) return { moved: 0, raw };
    await validatePatchText(result.raw);
    await writeFileAtomic(path, result.raw);
    return { moved: result.moved, raw: result.raw };
  });
}

/**
 * 读取 patch 文件、替换受管块、校验、加锁原子写回。
 * 返回写回后的完整文本。
 */
export async function writeManagedRows(path: string, rows: PatchRow[]): Promise<string> {
  return withPatchLock(path, async () => {
    const raw = await readPatchFile(path);
    const next = replaceManagedBlock(raw, rows);
    await validatePatchText(next);
    await writeFileAtomic(path, next);
    return next;
  });
}

// ── 单条 MCP entry 的就地编辑（字节级）──────────────────────────────────────
//
// 启停、删除、原文替换、表单落盘都只动目标 entry 的文本跨度。loader 会热应用
// `disabled` 的翻转（disabled → fiber.dispose()，删掉键 → entry.init()），
// 所以就地改这一键就是热启停。!!js 表达式、注释、键序、未建模字段
// （例如 maxInstructionBytes）在不改写它们的操作里逐字节保留。

/** 定位一条 MCP 行：有 id 时按 id，否则按 config.serverName。 */
export interface McpEntryLocator {
  id?: string;
  serverName?: string;
}

const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 取某个映射里指定标量键的 pair。 */
function scalarPairOf(map: any, key: string): any | undefined {
  for (const pair of map.items ?? []) {
    if (!isPair(pair)) continue;
    if (isScalar(pair.key) && pair.key.value === key) return pair;
  }
  return undefined;
}

/** entry 映射的 id 值（非标量返回 undefined）。 */
function entryIdOfNode(map: any): string | undefined {
  const pair = scalarPairOf(map, "id");
  return pair !== undefined && isScalar(pair.value) && typeof pair.value.value === "string" ? pair.value.value : undefined;
}

/** entry 映射的 config.serverName（非字符串返回 undefined）。 */
function serverNameOfNode(map: any): string | undefined {
  const config = scalarPairOf(map, "config");
  if (config === undefined || !isMap(config.value)) return undefined;
  const name = scalarPairOf(config.value, "serverName");
  return name !== undefined && isScalar(name.value) && typeof name.value.value === "string" ? name.value.value : undefined;
}

/** 映射的 name 标量是不是 MCP 客户端插件。 */
function isMcpMap(map: any): boolean {
  const pair = scalarPairOf(map, "name");
  return pair !== undefined && isScalar(pair.value) && pair.value.value === MCP_PLUGIN_NAME;
}

/** pair 的行首位置：Pair 节点本身不带 range，以 key 标量的 range 为准。 */
function pairStartOf(pair: any): number | undefined {
  return isScalar(pair.key) && typeof pair.key.range?.[0] === "number" ? pair.key.range[0] : undefined;
}

/** pair 内容结束位置（value 标量末尾；无 value 时到 key 末尾）。 */
function pairContentEndOf(pair: any): number | undefined {
  if (isScalar(pair.value) && typeof pair.value.range?.[1] === "number") return pair.value.range[1];
  return isScalar(pair.key) && typeof pair.key.range?.[1] === "number" ? pair.key.range[1] : undefined;
}

/** index 处字符所在行的行首。 */
function lineStartOf(text: string, index: number): number {
  return text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
}

/** index 处字符所在行之后的位置（下一行行首；无换行则到文末）。 */
function lineEndAfter(text: string, index: number): number {
  const newline = text.indexOf("\n", index);
  return newline < 0 ? text.length : newline + 1;
}

/**
 * 序列条目的完整文本跨度：从所在行行首（含缩进与 `- `）到节点 range 末尾
 * （含条目自己的换行，不含下一条目前的空行和注释）。
 */
function itemSpan(raw: string, node: any): { start: number; end: number } {
  const rangeStart = node?.range?.[0];
  const rangeEnd = node?.range?.[2] ?? node?.range?.[1];
  if (typeof rangeStart !== "number" || typeof rangeEnd !== "number") {
    throw new Error("这条 MCP 行的 YAML 结构不支持就地编辑，请检查 cordis.patch.yml");
  }
  return { start: lineStartOf(raw, rangeStart), end: rangeEnd };
}

interface FoundMcpEntry {
  node: any;
  /** 要替换 / 展示的序列条目（顶层行，或 insert 列表成员）。 */
  item: any;
  /** insert 列表里只剩这一条时，删除应拿掉整个 `- insert:` 条目。 */
  soleInsertItem?: any;
}

/** 收集整份 patch 里的 MCP 映射（顶层条目与 insert 成员）。 */
function collectMcpEntries(doc: any): FoundMcpEntry[] {
  const found: FoundMcpEntry[] = [];
  if (!isSeq(doc.contents)) return found;
  for (const item of doc.contents.items) {
    if (!isMap(item)) continue;
    const members = insertMembers(item);
    if (members !== undefined) {
      const mcpMembers = members.filter((member) => isMap(member) && isMcpMap(member));
      for (const member of mcpMembers) {
        found.push({
          node: member,
          item: member,
          soleInsertItem: members.length === 1 ? item : undefined
        });
      }
      continue;
    }
    if (isMcpMap(item)) found.push({ node: item, item });
  }
  return found;
}

function parsePatchDocument(raw: string): any {
  const doc = parseDocument(raw, { logLevel: "silent", customTags: YAML_CUSTOM_TAGS });
  if (doc.errors.length > 0) {
    throw new Error("cordis.patch.yml 解析失败：" + String(doc.errors[0]?.message ?? doc.errors[0]));
  }
  return doc;
}

/** 在整份 patch 里定位一条 MCP entry。多条命中或找不到都抛错。 */
function findMcpEntry(raw: string, locator: McpEntryLocator): FoundMcpEntry {
  const doc = parsePatchDocument(raw);
  const all = collectMcpEntries(doc);
  const id = typeof locator.id === "string" && locator.id !== "" ? locator.id : undefined;
  let hits = id !== undefined ? all.filter((entry) => entryIdOfNode(entry.node) === id) : [];
  if (hits.length === 0 && typeof locator.serverName === "string" && locator.serverName !== "") {
    hits = all.filter((entry) => serverNameOfNode(entry.node) === locator.serverName);
  }
  if (hits.length === 0) {
    const label = id ?? locator.serverName ?? "";
    throw new Error('cordis.patch.yml 中找不到 MCP 行 "' + label + '"');
  }
  if (hits.length > 1) {
    throw new Error('serverName "' + String(locator.serverName ?? id) + '" 对应多条 MCP 行，请先用原文编辑消掉重名');
  }
  return hits[0];
}

/** 在整份 patch 的顶层数组里按 id 定位一个 entry 映射（含 insert 列表成员）。 */
function findEntryNode(doc: any, entryId: string): any | undefined {
  return collectMcpEntries(doc).find((entry) => entryIdOfNode(entry.node) === entryId)?.node;
}

function assertUniqueMcpRows(raw: string): void {
  const rows = listMcpPatchRows(raw);
  const ids = new Map<string, number>();
  const names = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.id === "string" && row.id !== "") ids.set(row.id, (ids.get(row.id) ?? 0) + 1);
    const name = typeof row.config?.serverName === "string" ? row.config.serverName : undefined;
    if (name !== undefined && name !== "") names.set(name, (names.get(name) ?? 0) + 1);
  }
  for (const [id, count] of ids) {
    if (count > 1) throw new Error('id "' + id + '" 在 cordis.patch.yml 里重复');
  }
  for (const [name, count] of names) {
    if (count > 1) throw new Error('serverName "' + name + '" 在 cordis.patch.yml 里重复');
  }
}

/** 删光 MCP 行后，空的受管块收成合法顶层数组（通常是 `[]`）。 */
function stripEmptyManagedBlock(raw: string): string {
  const begin = raw.indexOf(PANEL_MCP_BLOCK_BEGIN);
  const end = raw.indexOf(PANEL_MCP_BLOCK_END);
  if (begin < 0 || end < 0 || end < begin) return raw;
  const blockStart = raw.indexOf("\n", begin);
  if (blockStart < 0 || blockStart > end) return raw;
  const body = raw.slice(blockStart + 1, end);
  const meaningful = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  if (meaningful.length > 0) return raw;
  return replaceManagedBlock(raw, [], EMPTY_FOREIGN);
}

/** 删除后若文件不再是数组、又只剩注释，补回 `[]`。 */
function ensurePatchArray(raw: string): string {
  try {
    assertPatchText(raw);
    return raw;
  } catch (error) {
    const meaningful = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
    if (meaningful.length === 0) return raw.replace(/\s*$/, "") + "\n[]\n";
    throw error;
  }
}

/**
 * 就地翻转单个 entry 的 `disabled` 键，返回新文本；已是目标状态时原样返回。
 *
 *   停用：无键 → 在 id（或首个）键的下一行按对齐插入 `disabled: true`；
 *         有键且值为 false → 原位把值改成 true；
 *   启用：有键且独占一行 → 整行删除；与别的内容同行 → 原位把值改成 false；
 *   disabled 值是 !!js 表达式 → 抛错让用户手动处理（绝不在表达式上动刀）。
 *
 * 只接受 @deepseek-ai/dsh-mcp-client 行，避免把别人的插件行关掉。
 */
export function setEntryDisabledInText(raw: string, entryId: string, disabled: boolean): string {
  const doc = parsePatchDocument(raw);
  const map = findEntryNode(doc, entryId);
  if (map === undefined) throw new Error('cordis.patch.yml 中找不到 id 为 "' + entryId + '" 的 entry');
  const namePair = scalarPairOf(map, "name");
  const pluginName = namePair !== undefined && isScalar(namePair.value) ? namePair.value.value : undefined;
  if (pluginName !== MCP_PLUGIN_NAME) {
    throw new Error('entry "' + entryId + '" 不是 ' + MCP_PLUGIN_NAME + " 行，面板只能开关 MCP 服务器");
  }
  const pair = scalarPairOf(map, "disabled");
  const valueNode = pair?.value;
  const valueStart = isScalar(valueNode) && typeof valueNode.range?.[0] === "number" ? valueNode.range[0] : undefined;
  const valueEnd = isScalar(valueNode) && typeof valueNode.range?.[1] === "number" ? valueNode.range[1] : undefined;
  const valueSource = valueStart !== undefined && valueEnd !== undefined
    ? raw.slice(valueStart, valueEnd).trim()
    : "";
  // `!!js` 的标签在标量 range 之外（range 只覆盖表达式本身），所以既看节点标签，
  // 也看 range 前紧挨着的原文。表达式绝不能被改写成 true/false。
  const tagPrefix = valueStart !== undefined ? raw.slice(Math.max(0, valueStart - 80), valueStart) : "";
  const jsExpr = isJsExprValue(isScalar(valueNode) ? valueNode.value : undefined)
    || (isScalar(valueNode) && valueNode.tag === JS_EXPR_TAG)
    || /(?:!!\S+|!<[^>\n]+>)\s*$/.test(tagPrefix);
  if (jsExpr || valueSource.startsWith("!!")) {
    throw new Error('entry "' + entryId + '" 的 disabled 是 !!js 表达式，请在原文里手动处理');
  }
  if (disabled) {
    if (pair !== undefined && valueSource === "true") return raw;
    if (pair !== undefined) {
      const vStart = isScalar(valueNode) && typeof valueNode.range?.[0] === "number" ? valueNode.range[0] : undefined;
      const vEnd = isScalar(valueNode) && typeof valueNode.range?.[1] === "number" ? valueNode.range[1] : undefined;
      if (vStart === undefined || vEnd === undefined) {
        throw new Error('entry "' + entryId + '" 的 disabled 写法不支持就地开关，请用原文编辑');
      }
      return raw.slice(0, vStart) + "true" + raw.slice(vEnd);
    }
    const anchor = scalarPairOf(map, "id") ?? (isPair(map.items[0]) ? map.items[0] : undefined);
    const anchorStart = anchor !== undefined ? pairStartOf(anchor) : undefined;
    const anchorEnd = anchor !== undefined ? pairContentEndOf(anchor) : undefined;
    if (anchorStart === undefined || anchorEnd === undefined) {
      throw new Error('entry "' + entryId + '" 没有可插入 disabled 的锚点，请用原文编辑');
    }
    const anchorLineStart = lineStartOf(raw, anchorStart);
    const indent = " ".repeat(anchorStart - anchorLineStart);
    const insertion = indent + "disabled: true\n";
    const position = lineEndAfter(raw, anchorEnd);
    if (position >= raw.length) return raw.endsWith("\n") ? raw + insertion : raw + "\n" + insertion;
    return raw.slice(0, position) + insertion + raw.slice(position);
  }
  if (pair === undefined || valueSource === "false") return raw;
  const pairStart = pairStartOf(pair);
  const pairEnd = pairContentEndOf(pair);
  if (pairStart === undefined || pairEnd === undefined) {
    throw new Error('entry "' + entryId + '" 的 disabled 写法不支持就地开关，请用原文编辑');
  }
  const pairLineStart = lineStartOf(raw, pairStart);
  const pairLineEnd = lineEndAfter(raw, pairEnd);
  const before = raw.slice(pairLineStart, pairStart);
  const newlineAt = raw.indexOf("\n", pairEnd);
  const after = raw.slice(pairEnd, newlineAt < 0 ? raw.length : newlineAt);
  if (/^[ \t]*$/.test(before) && /^[ \t]*$/.test(after)) return raw.slice(0, pairLineStart) + raw.slice(pairLineEnd);
  const vStart = isScalar(valueNode) && typeof valueNode.range?.[0] === "number" ? valueNode.range[0] : undefined;
  const vEnd = isScalar(valueNode) && typeof valueNode.range?.[1] === "number" ? valueNode.range[1] : undefined;
  if (vStart === undefined || vEnd === undefined) {
    throw new Error('entry "' + entryId + '" 的 disabled 写法不支持就地开关，请用原文编辑');
  }
  return raw.slice(0, vStart) + "false" + raw.slice(vEnd);
}

/**
 * 就地开关单条 MCP entry：读文件、翻转 `disabled`、校验、加锁原子写回。
 * 返回写回后的完整文本与是否真的改动（已是目标状态时不写盘）。
 */
export async function setEntryDisabled(path: string, entryId: string, disabled: boolean): Promise<{ raw: string; changed: boolean }> {
  return withPatchLock(path, async () => {
    const raw = await readPatchFile(path);
    const next = setEntryDisabledInText(raw, entryId, disabled);
    if (next === raw) return { raw, changed: false };
    await validatePatchText(next);
    await writeFileAtomic(path, next);
    return { raw: next, changed: true };
  });
}

/** 读出一条 MCP entry 的原文（含缩进与 `- `，字节与文件中一致）。 */
export function readMcpEntryText(raw: string, locator: McpEntryLocator): string {
  const found = findMcpEntry(raw, locator);
  const span = itemSpan(raw, found.item);
  return raw.slice(span.start, span.end);
}

/** 把用户提交的原文解析成一条 MCP 行；接受「一条序列」或「一个映射」。 */
function rowFromEntrySnippet(text: string): PatchRow {
  const doc = parseDocument(text, { logLevel: "silent", customTags: YAML_CUSTOM_TAGS });
  if (doc.errors.length > 0) {
    throw new Error("原文解析失败：" + String(doc.errors[0]?.message ?? doc.errors[0]));
  }
  let value = doc.toJS();
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error("原文只能包含一条 MCP 配置");
    value = value[0];
  }
  const row = rowFromValue(value);
  if (row === undefined || row.name !== MCP_PLUGIN_NAME) {
    throw new Error("原文必须仍是一条 " + MCP_PLUGIN_NAME + " 配置");
  }
  if (typeof row.id !== "string" || row.id.trim() === "") throw new Error("原文必须保留字符串 id");
  const serverName = row.config?.serverName;
  if (typeof serverName !== "string" || !SERVER_NAME_RE.test(serverName)) {
    throw new Error("config.serverName 必须是 1-32 位字母、数字、下划线或连字符");
  }
  return row;
}

/**
 * 用用户提交的原文替换一条 MCP entry。跨度之外的字节不动。
 * 替换后整份文件仍须是合法 patch，且不能引出重复的 id / serverName。
 */
export function replaceMcpEntryTextInText(raw: string, locator: McpEntryLocator, text: string): { raw: string; row: PatchRow } {
  const found = findMcpEntry(raw, locator);
  const span = itemSpan(raw, found.item);
  let replacement = text.replace(/\r\n/g, "\n");
  if (!replacement.endsWith("\n")) replacement += "\n";
  const row = rowFromEntrySnippet(replacement);
  const before = listMcpPatchRows(raw).length;
  const next = raw.slice(0, span.start) + replacement + raw.slice(span.end);
  assertPatchText(next);
  const afterRows = listMcpPatchRows(next);
  if (afterRows.length !== before) throw new Error("原文只能改这一条 MCP 行，不能增删别的 entry");
  assertUniqueMcpRows(next);
  if (!afterRows.some((item) => item.id === row.id)) throw new Error("原文写回后找不到 id 为 \"" + row.id + "\" 的 MCP 行");
  return { raw: next, row };
}

/** 读文件、替换一条 MCP entry 的原文、校验、加锁原子写回。 */
export async function replaceMcpEntryText(path: string, locator: McpEntryLocator, text: string): Promise<{ raw: string; row: PatchRow }> {
  return withPatchLock(path, async () => {
    const raw = await readPatchFile(path);
    const next = replaceMcpEntryTextInText(raw, locator, text);
    await writeFileAtomic(path, next.raw);
    return next;
  });
}

/** 序列条目所在行、`-` 之前的缩进。 */
function indentOfItem(raw: string, start: number): string {
  const lineEnd = raw.indexOf("\n", start);
  const line = raw.slice(start, lineEnd < 0 ? raw.length : lineEnd);
  return /^([ \t]*)-/.exec(line)?.[1] ?? "";
}

/** 把一行 patch 序列化成与原条目同缩进的列表项文本。 */
function stringifyEntry(row: PatchRow, indent: string): string {
  const body = stringify([row], { indent: 2, lineWidth: 0, customTags: YAML_CUSTOM_TAGS });
  const text = body.endsWith("\n") ? body : body + "\n";
  if (indent === "") return text;
  return text
    .split("\n")
    .map((line, index, all) => (line === "" && index === all.length - 1 ? "" : line === "" ? line : indent + line))
    .join("\n");
}

/**
 * 用结构化行替换一条 MCP entry（表单保存、OAuth 写 Authorization）。
 * 只重写这一条；未知字段由调用方放进行对象后一起写回。跨度之外的字节不动。
 */
export function replaceMcpEntryWithRowInText(raw: string, locator: McpEntryLocator, row: PatchRow): string {
  const found = findMcpEntry(raw, locator);
  const span = itemSpan(raw, found.item);
  const replacement = stringifyEntry(row, indentOfItem(raw, span.start));
  const next = raw.slice(0, span.start) + replacement + raw.slice(span.end);
  assertPatchText(next);
  assertUniqueMcpRows(next);
  return next;
}

/** 读文件、用结构化行替换一条 MCP entry、校验、加锁原子写回。 */
export async function replaceMcpEntryWithRow(path: string, locator: McpEntryLocator, row: PatchRow): Promise<string> {
  return withPatchLock(path, async () => {
    const raw = await readPatchFile(path);
    const next = replaceMcpEntryWithRowInText(raw, locator, row);
    await writeFileAtomic(path, next);
    return next;
  });
}

/**
 * 就地删除一条 MCP entry。insert 列表里只剩它时，连同 `- insert:` 一起删除，
 * 避免留下空列表；受管块因此变空时收掉标记，让文件仍是合法顶层数组。
 */
export function removeMcpEntryInText(raw: string, locator: McpEntryLocator): string {
  const found = findMcpEntry(raw, locator);
  const target = found.soleInsertItem ?? found.item;
  const span = itemSpan(raw, target);
  const next = ensurePatchArray(stripEmptyManagedBlock(raw.slice(0, span.start) + raw.slice(span.end)));
  assertPatchText(next);
  return next;
}

/** 读文件、删除一条 MCP entry、校验、加锁原子写回。 */
export async function removeMcpEntry(path: string, locator: McpEntryLocator): Promise<string> {
  return withPatchLock(path, async () => {
    const raw = await readPatchFile(path);
    const next = removeMcpEntryInText(raw, locator);
    await writeFileAtomic(path, next);
    return next;
  });
}