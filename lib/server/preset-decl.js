// 预设声明块（agent.cordis.yml 里的受管片段）渲染与修补
//
// 本文件由 S2 服务端分层从 lib/index.js 整块搬来，内容逐字未改。
// 真源规范见仓库根目录 AGENTS.md §5。

import { PRESET_DECL_BEGIN, PRESET_DECL_END } from './constants.js'

/** YAML 双引号标量转义（名/描述是外部文本，绝不能让引号把 YAML 撕开）。 */
function yamlDoubleQuote(value) {
  const s = String(value == null ? '' : value)
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"'
}

/** 把顶层 YAML 序列整体缩进 n 个空格（空行保持空行）。 */
function indentYamlBlock(text, spaces) {
  const pad = ' '.repeat(spaces)
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => (line.trim() === '' ? '' : pad + line))
    .join('\n')
    .replace(/\n+$/, '')
}

/**
 * 把若干声明拼成受管块（含界标）。纯函数。
 * @param {Array<{ok:boolean, yaml?:string, error?:string}>} declarations
 * @param {{timestamp?:string}} [opts]
 * @returns {{text:string, ok:number, failed:Array}}
 */
function composePresetDeclarationBlock(declarations, opts) {
  const list = Array.isArray(declarations) ? declarations : []
  const good = list.filter(d => d && d.ok && d.yaml)
  const failed = list.filter(d => !d || !d.ok).map(d => ({ id: (d && d.id) || '', error: (d && d.error) || 'unknown' }))
  const stamp = (opts && opts.timestamp) || new Date().toISOString()
  const text = [
    PRESET_DECL_BEGIN,
    '# 由 dsh-tavern 生成：把酒馆预设声明成 DSH 原生 agent 预设（顶部选择器可见、可按会话绑定）。',
    '# 生成时间：' + stamp,
    '# 手改无效：下次生成会整块替换（只替换本块，块外内容一律不动）。',
    ...good.map(d => d.yaml),
    PRESET_DECL_END,
  ].join('\n')
  return { text, ok: good.length, failed }
}

/**
 * 去掉受管块里那行「生成时间」后再比较文本 —— 判断「声明内容真的变了吗」。
 *
 * 为什么需要它：每次渲染都会盖一个新的时间戳，拿全文比较等于永远"变了"。
 * 保存预设几乎每次都调用 applyPresetDeclarations，真按"变了"写盘就会：
 *   ① backups/ 每次多一个 .bak；② patch 文件 mtime 一直跳（DSH 的 HMR 会跟着重载整个 profile）。
 * 纯函数，只用于判等，不参与写盘。
 *
 * @param {string} text 文件或待写文本
 * @returns {string} 滤掉时间戳行的文本（统一换行）
 */
function stripDeclarationStamp(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(l => !/^#\s*生成时间[:：]/.test(l.trim()))
    .join('\n')
}

/**
 * 把受管块并入既有文本：有旧块就整块替换，没有就追加到末尾。纯函数、幂等。
 *
 * ⚠️ 边界（界标行）必须完整保留原样；块外一个字节都不动 —— 那是用户手写的
 *    providers / 模型配置，弄丢它等于弄丢用户的 DSH 配置。
 *
 * @param {string} existing 目标文件原文
 * @param {string} block composePresetDeclarationBlock 的产物
 * @returns {{text:string, replaced:boolean}}
 */
function mergeManagedPresetBlock(existing, block) {
  const src = String(existing == null ? '' : existing).replace(/\r\n/g, '\n')
  const begin = src.indexOf(PRESET_DECL_BEGIN)
  const endMark = src.indexOf(PRESET_DECL_END)
  if (begin >= 0 && endMark > begin) {
    const end = endMark + PRESET_DECL_END.length
    const head = src.slice(0, begin)
    const tail = src.slice(end)
    return { text: head + String(block || '').replace(/\n+$/, '') + tail, replaced: true }
  }
  const blockText = String(block || '').replace(/\n+$/, '')
  // ★ 空数组占位符：profile 刚建出来时 cordis.patch.yml 里就一行 `[]`。
  //   若把我们的条目**追加**在它后面，文件就成了「[] 之后再跟顶层节点」——
  //   那不是顶层数组，DSH 会直接拒绝启动（dshmarket 的 patch.ts 里就写了这个坑：
  //   "Appending the first row comments the template's `[]` out … dsh refuses to boot"）。
  //   做法与它一致：把未注释的 `[]` 那行**注释掉**，再追加我们的块 ——
  //   既不删用户内容，结果也仍是合法的顶层数组。
  if (/^[ \t]*\[[ \t]*\][ \t]*$/m.test(src)) {
    const commented = src.replace(/^([ \t]*)\[[ \t]*\]([ \t]*)$/m, '$1# []$2')
    const base = commented.replace(/\n+$/, '')
    const sep = base.length ? '\n' : ''
    return { text: (base + sep + blockText + '\n'), replaced: false, placeholderCommented: true }
  }
  const base = src.replace(/\n+$/, '')
  const sep = base.length ? '\n' : ''
  return { text: (base + sep + blockText + '\n'), replaced: false }
}

/** 取受管块**之外**的文本（用于「除我这一块，其它一个字节都没动」的自检）。 */
function outsideManagedBlock(text) {
  const src = String(text == null ? '' : text)
  const b = src.indexOf(PRESET_DECL_BEGIN)
  const e = src.indexOf(PRESET_DECL_END)
  if (b < 0 || e <= b) return src
  return src.slice(0, b) + src.slice(e + PRESET_DECL_END.length)
}

/** 从文本里整块摘掉受管块（含界标）—— 回滚 / 关闭用。纯函数。 */
function stripManagedPresetBlock(text) {
  const src = String(text == null ? '' : text).replace(/\r\n/g, '\n')
  const b = src.indexOf(PRESET_DECL_BEGIN)
  const e = src.indexOf(PRESET_DECL_END)
  if (b < 0 || e <= b) return src
  const head = src.slice(0, b).replace(/\n+$/, '\n')
  const tail = src.slice(e + PRESET_DECL_END.length).replace(/^\n+/, '')
  return (head + tail).replace(/\n+$/, '\n')
}

/**
 * 写盘前的自检：**在我们无法完整解析 YAML 的前提下**，只做能确定性判定的检查，
 * 任何一条不过就绝不下笔（宁可让人看到问题，也不让 DSH 起不来）。
 *
 * @param {string} text 目标文件合并后的全文
 * @param {{expectBlock?:boolean}} [opts] expectBlock=false 表示这是一次「摘除」
 *        （remove 之后应当**没有**受管块），此时按「零界标」判定。
 * @returns {string[]} 问题列表（空 = 可以写）
 */
function validatePresetPatchText(text, opts) {
  const expectBlock = !(opts && opts.expectBlock === false)
  const problems = []
  const src = String(text == null ? '' : text)
  if (!src.trim()) problems.push('empty-file：文件为空')
  const begins = src.split(PRESET_DECL_BEGIN).length - 1
  const ends = src.split(PRESET_DECL_END).length - 1
  const b = src.indexOf(PRESET_DECL_BEGIN)
  const e = src.indexOf(PRESET_DECL_END)
  if (expectBlock) {
    if (begins !== 1) problems.push('marker-begin-count：受管块开始界标出现 ' + begins + ' 次（应为 1）')
    if (ends !== 1) problems.push('marker-end-count：受管块结束界标出现 ' + ends + ' 次（应为 1）')
    if (b >= 0 && e >= 0 && e < b) problems.push('marker-order：结束界标在开始界标之前')
  } else if (begins !== 0 || ends !== 0) {
    problems.push('marker-left：摘除后仍残留受管块界标（' + begins + '/' + ends + '）')
  }
  if (src.includes('\t')) problems.push('tab-character：YAML 不允许制表符缩进')
  if (expectBlock && b >= 0 && e > b) {
    const block = src.slice(b, e)
    if (!block.includes('- insert:')) problems.push('block-no-insert：受管块里没有插入条目')
    if (!block.includes("name: '@deepseek-ai/dsh-agent-preset'")) {
      problems.push('block-no-preset-row：受管块里没有 @deepseek-ai/dsh-agent-preset 行')
    }
  }
  return problems
}

export { yamlDoubleQuote, indentYamlBlock, composePresetDeclarationBlock, stripDeclarationStamp, mergeManagedPresetBlock, outsideManagedBlock, stripManagedPresetBlock, validatePresetPatchText }
