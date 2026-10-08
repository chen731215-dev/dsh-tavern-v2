// 总结生成：提示词构造、LLM 调用、结果解析、拒答识别
//
// 本文件由 S2 服务端分层从 lib/index.js 整块搬来，内容逐字未改。
// 真源规范见仓库根目录 AGENTS.md §5。

import { json } from './util.js'

function callLLM(apiUrl, apiKey, model, messages, maxTokens) {
  return new Promise((resolve, reject) => {
    if (!apiUrl) return reject(new Error('未配置 API 地址'))
    // 兼容：如果用户只填了域名，自动补全 /v1/chat/completions
    let fullUrl = apiUrl
    try {
      const u = new URL(apiUrl)
      if (!u.pathname || u.pathname === '/' || !u.pathname.includes('completions')) {
        // 如果路径以 /v1 结尾，只补 /chat/completions
        if (u.pathname.endsWith('/v1')) {
          fullUrl = apiUrl.replace(/\/+$/, '') + '/chat/completions'
        } else {
          fullUrl = apiUrl.replace(/\/+$/, '') + '/v1/chat/completions'
        }
      }
    } catch {}
    const payload = { model: model || 'deepseek-chat', messages, ...(maxTokens ? { max_tokens: maxTokens } : {}) }
    const url = new URL(fullUrl)
    const transport = url.protocol === 'https:' ? https : http
    const data = JSON.stringify(payload)
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
    if (apiKey) headers.authorization = 'Bearer ' + apiKey
    const req = transport.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, method: 'POST', headers
    }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw)
          const text = parsed.choices?.[0]?.message?.content
          if (typeof text === 'string') return resolve(text)
          reject(new Error('未从模型获得文本：' + raw.slice(0, 300)))
        } catch (e) { reject(new Error('响应不是 JSON：' + raw.slice(0, 300))) }
      })
    })
    req.on('error', reject)
    req.setTimeout(120000, () => { req.destroy(new Error('LLM 调用超时（120秒）')) })
    req.write(data)
    req.end()
  })
}

/**
 * 判断一条回复是不是「模型拒绝」。
 *
 * 为什么要做得这么小心：角色扮演正文里出现「我不能」是**完全正常**的
 * ——角色在台词里拒绝某件事。所以不能只做子串匹配，要抓的是
 * **元语言**（提到 AI 身份 / 政策 / 无法协助）和**篇幅特征**（拒绝通常很短）。
 *
 * 命中的关键词会一并返回，界面上摊开给用户看，让人自己判断，而不是只丢一个徽标。
 * @param {string} text 助手回复正文
 * @returns {{verdict: 'ok'|'suspect'|'refusal', score: number, hits: string[], length: number, excerpt: string}}
 */
function detectRefusal(text) {
  const raw = String(text || '')
  const t = raw.trim()
  const out = { verdict: 'ok', score: 0, hits: [], length: t.length, excerpt: '' }
  if (!t) return out
  const lower = t.toLowerCase()
  // 强证据：只有「跳出角色谈自身/政策」的话术才会出现
  const STRONG = [
    '作为ai', '作为人工智能', 'ai助手', '人工智能助手', '内容政策', '安全准则', '使用政策',
    '平台政策', '无法协助', '不能协助', '无法提供', '无能为力', '不适合我来',
    "as an ai", 'as an artificial intelligence', "i can't assist", 'i cannot assist',
    "i'm unable to", 'i am unable to', "i can't help with", 'i cannot help with',
  ]
  // 中等证据：拒绝写/描写的直接表述
  const MEDIUM = [
    '我不能写', '不能写这样', '无法描写', '不能描写', '不便描写', '拒绝生成', '不能生成',
    '我不太适合', '换个话题', '寻求专业', '心理咨询', '不建议我',
    "i won't write", 'i will not write', 'cannot write this',
  ]
  const META = ['你要求', '你的请求', '你想让我', '你希望我', '你让我写']
  for (const k of STRONG) if (lower.includes(k)) out.hits.push('强「' + k + '」')
  for (const k of MEDIUM) if (lower.includes(k)) out.hits.push('中「' + k + '」')
  // 「抱歉……我不能」这种以道歉开头的拒绝
  if (/^(很?抱歉|对不起|不好意思)[，,、]?[^。\n]{0,40}(不能|无法|不便|不会|拒绝)/.test(t)) {
    out.hits.push('中「道歉开头＋否定」')
  }
  // 「你要求……但我不能」这种把你和否定连起来的句式
  for (const k of META) {
    const i = t.indexOf(k)
    if (i < 0) continue
    if (/(不能|无法|不便|不会|拒绝)/.test(t.slice(i, i + 80))) { out.hits.push('中「' + k + '…否定」'); break }
  }
  const strong = out.hits.filter((h) => h.startsWith('强')).length
  const medium = out.hits.length - strong
  out.score = strong * 45 + medium * 25
  // 拒绝通常很短：短回复里出现任何一条证据，基本就是这个了
  if (out.score > 0 && t.length < 500) out.score += 15
  out.verdict = out.score >= 60 ? 'refusal' : out.score >= 30 ? 'suspect' : 'ok'
  // 截一段证据给人看：优先给第一个命中词周围
  const first = out.hits.length ? out.hits[0].replace(/^(强|中)/, '') : ''
  const key = first.replace(/[「」]/g, '')
  const at = key ? lower.indexOf(key.toLowerCase()) : -1
  out.excerpt = at >= 0
    ? t.slice(Math.max(0, at - 60), at + 90).replace(/\s+/g, ' ').trim()
    : t.slice(0, 150).replace(/\s+/g, ' ').trim()
  return out
}

function buildSummaryPrompt(messages) {
  const body = messages.slice(-60).join('\n')
  return [
    { role: 'system', content: '你是角色扮演酒馆的记忆管家。请只输出一个 JSON 对象，不要任何多余文字，格式为：\n' +
      '{"summary":"对这段对话的详细记忆总结（中文，200-300字，第二人称概括当前剧情进展、角色状态、重要事件、未完成的线索）",\n' +
      '"relations":[{"source":"人物A","target":"人物B","label":"关系描述/发生了什么事件"}]}\n\n' +
      '【重要要求】\n' +
      '1. summary 要详细记录剧情进展、角色状态变化、重要事件、人物关系变化、未完成的线索和伏笔\n' +
       '   - 【重要】每个关系只能涉及两个角色，禁止把多个角色合并成一个名字（如提宝提宁必须拆成提宝和提宁两个独立角色）\n' +
      '   - 角色之间的关系（朋友、敌人、恋人、亲人等）\n' +
      '   - 发生的重要事件（谁对谁做了什么）\n' +
      '   - 情感变化（谁对谁产生了什么感情）\n' +
      '3. 即使关系不明确，也要根据对话内容推断并列出\n' +
      '4. relations 不能为空数组，除非对话中完全没有出现任何角色\n' +
      '5. 只输出 JSON，不要 markdown 代码块，不要任何解释文字\n' +
      '6. 【重要】所有文字必须使用简体中文，禁止使用繁体字、日文、英文（角色名原文除外）' },
    { role: 'user', content: '以下是最近的对话：\n\n' + body }
  ]
}

/**
 * 落库边界净化（2026-10-08 议题落地，2.7.15）。
 *
 * 为什么在**这里**做：`parseSummaryOutput` 的产物会被两个消费者读 ——
 *   ① DOM 路：`relations[].label/source/target` → 客户端 `innerHTML`；
 *   ② 提示词路：`summary` 正文 + 记忆正文 → 系统提示段（且被框成"高优先级参考"）。
 * 渲染层已各自防守（`esc()` + 结构化棘轮），但**数据本身从没净化过** ——
 * 任何新增的消费点都得自己再防一次。在落库前净化一次，两条路同时受益；
 * 尤其提示词路，`esc()` 对它**毫无作用**（文字即指令），只能在这里削。
 *
 * 口径（三条已定，见 docs/issues/2026-10-08-parseSummaryOutput-边界净化.md）：
 *   · **只做字符级 / 标签 / 协议剥离**，不做"指令性文本"识别 —— 后者误伤剧情文本、且无法穷举；
 *   · **只在写入时净化**（旧数据不动）；
 *   · 不删 `relations[]` 的语义字段，只做字符级处理。
 *
 * ⚠️ 这是**纵深防御**，不是渲染层转义的替代：两者叠加才叫纵深。
 * @param {string} s 原始文本
 * @returns {string} 净化后的文本（正常剧情文本应当**逐字节不变**）
 */
function sanitizeModelText(s) {
  let t = String(s == null ? '' : s)
  // ① HTML 标签（`</?名字 ...>`）——注意要求标签名以字母开头，所以 `3 < 5`、`a <b 的情况` 会被保留
  t = t.replace(/<\/?[a-zA-Z][^>]{0,300}>/g, '')
  // ② 内联事件处理器（`onerror="…"` / `onclick=alert(1)`）
  t = t.replace(/\bon[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  // ③ 危险协议（javascript: / vbscript: / data:）
  t = t.replace(/\b(?:javascript|vbscript|data)\s*:/gi, '[已移除协议]')
  // ④ 控制字符（保留 \n \t \r）
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  return t
}

/** 只对 relations 的语义字段做字符级净化（不删字段）。 */
function sanitizeRelations(rels) {
  if (!Array.isArray(rels)) return []
  return rels.map((r) => ({
    source: sanitizeModelText(r && r.source),
    target: sanitizeModelText(r && r.target),
    label: sanitizeModelText(r && r.label),
  }))
}

function parseSummaryOutput(text, sessionId) {
  let summary = '', rels = []
  try {
    // 去除 markdown 代码块标记
    let cleaned = String(text || '').replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim()
    const start = (cleaned || '').indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
      let jsonStr = cleaned.slice(start, end + 1)
      try {
        const obj = JSON.parse(jsonStr)
        summary = String(obj.summary || '').trim()
        if (Array.isArray(obj.relations)) rels = obj.relations
      } catch {
        // JSON 解析失败，尝试提取 summary 字段（截断修复）
        const sumMatch = cleaned.match(/"summary"\s*:\s*"([^"]*)/)
        if (sumMatch) summary = sumMatch[1].trim()
        // 尝试提取 relations
        const relMatch = cleaned.match(/"relations"\s*:\s*\[([\s\S]*?)\]/)
        if (relMatch) {
          try {
            const relArr = JSON.parse('[' + relMatch[1] + ']')
            if (Array.isArray(relArr)) rels = relArr
          } catch {}
        }
      }
    }
  } catch {}
  if (!summary) summary = String(text || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim()
  // 繁简转换（确保关系网用简体中文）
  const T2S = {'風':'风','雲':'云','電':'电','車':'车','馬':'马','龍':'龙','門':'门','見':'见','貝':'贝','頁':'页','鳥':'鸟','魚':'鱼','長':'长','來':'来','東':'东','國':'国','學':'学','會':'会','書':'书','畫':'画','劇':'剧','愛':'爱','慾':'欲','體':'体','膚':'肤','腳':'脚','陰':'阴','陽':'阳','裡':'里','裏':'里','後':'后','從':'从','眾':'众','們':'们','妳':'你','麼':'么','這':'这','邊':'边','過':'过','還':'还','對':'对','將':'将','應':'应','該':'该','讓':'让','給':'给','與':'与','為':'为','於':'于','並':'并','個':'个','點':'点','樣':'样','時':'时','間':'间','開':'开','關':'关','聽':'听','說':'说','讀':'读','寫':'写','覺':'觉','觀':'观','視':'视','親':'亲','屬':'属','歲':'岁','萬':'万','億':'亿','錢':'钱','銀':'银','鐵':'铁','鋼':'钢','燈':'灯','機':'机','樓':'楼','橋':'桥','園':'园','藝':'艺','術':'术','樂':'乐','歡':'欢','慶':'庆','禮':'礼','謝':'谢','請':'请','問':'问','講':'讲','話':'话','語':'语','詞':'词','詩':'诗','聲':'声','響':'响','靜':'静','動':'动','進':'进','遠':'远','舊':'旧','壞':'坏','醜':'丑','強':'强','軟':'软','輕':'轻','熱':'热','溫':'温','濕':'湿','乾':'干','淨':'净','髒':'脏','亂':'乱','齊':'齐','簡':'简','難':'难','鳴':'鸣','雞':'鸡','貓':'猫','豬':'猪','蟲':'虫','龜':'龟','靈':'灵','聖':'圣','藥':'药','醫':'医','療':'疗','傷':'伤','氣':'气','齒':'齿','髮':'发','頸':'颈','脣':'唇','齶':'腭','鱗':'鳞','殼':'壳','蓮':'莲','蘭':'兰','楓':'枫','櫻':'樱','蘋':'苹','檸':'柠','蔥':'葱','薑':'姜','醬':'酱','鹽':'盐','磚':'砖','牆':'墙','戶':'户','宮':'宫','樹':'树','葉':'叶','幹':'干','種':'种','養':'养','兒':'儿','孫':'孙','爺':'爷','敵':'敌','戀':'恋','憶':'忆','夢':'梦','懼':'惧','驚':'惊','穩':'稳','飛':'飞','遊':'游','潛':'潜','臥':'卧','擁':'拥','撫':'抚','牽':'牵','擊':'击','殺':'杀','殘':'残','廢':'废','復':'复','狀':'状','態':'态','勢':'势','勁':'劲','夠':'够','願':'愿','恥':'耻','榮':'荣','紅':'红','黃':'黄','綠':'绿','藍':'蓝','銅':'铜','錫':'锡','鉛':'铅','鋅':'锌','鎳':'镍','鉻':'铬','錳':'锰','鈷':'钴','鈦':'钛','鎢':'钨','鉬':'钼','釩':'钒','鈮':'铌','鉭':'钽','鈹':'铍','鋰':'锂','鈉':'钠','鉀':'钾','銣':'铷','銫':'铯','鈣':'钙','鍶':'锶','鋇':'钡','鐳':'镭','鈧':'钪','釔':'钇','鑭':'镧','鈰':'铈','鐠':'镨','釹':'钕','鉕':'钷','釤':'钐','銪':'铕','釓':'钆','鋱':'铽','鏑':'镝','鈥':'钬','鉺':'铒','銩':'铥','鐿':'镱','鎦':'镥','鋯':'锆','鉿':'铪','釷':'钍','鏷':'镤','鈾':'铀','錼':'镎','鈈':'钚','鎇':'镅','鋦':'锔','錇':'锫','鐦':'锎','鑀':'锿','鍆':'钔','鍩':'锘','鐒':'铹','鑪':'𬬻','鏌':'镆','鳳':'凤','堇':'堇'}
  const _t2s = (s) => { if (!s) return s; let r = ''; for (const c of String(s)) r += T2S[c] || c; return r }
  rels = rels.map(r => ({ source: _t2s(r.source), target: _t2s(r.target), label: _t2s(r.label) }))
  summary = _t2s(summary)
  // ★ 落库边界净化（2.7.15）：让**写进库里的数据本身就是干净的** ——
  //   DOM 路（relations → innerHTML）与提示词路（summary/记忆 → 系统提示）同时受益；
  //   渲染层的 esc() 对提示词路完全无效（文字即指令），只能在这里削。
  summary = sanitizeModelText(summary)
  rels = sanitizeRelations(rels)
  return { summary, rels, source: sessionId || '' }
}

export { buildSummaryPrompt, parseSummaryOutput, callLLM, detectRefusal, sanitizeModelText, sanitizeRelations }
