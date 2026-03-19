/**
 * Admin reply cache + similar reply retrieval
 *
 * Loads all evaluated AI suggestions with admin replies into memory,
 * provides findSimilarReplies() for few-shot examples in AI suggestion generation.
 */

const { AiSuggestion } = require('../models/AiSuggestion')

let replyCache = []  // { userMessage, adminReply, qualityScore, category, keywords[] }
let recentReplies = [] // 管理员回复后立即加入，不等评估完成
let initialized = false
let refreshTimer = null

// Callback registration for evaluateQuality
let _onEvaluatedCallbacks = []

function normalizeText(value) {
  if (!value) return ''
  return String(value).toLowerCase().replace(/[^\w\s가-힣一-龥]/g, ' ').replace(/\s+/g, ' ').trim()
}

function extractKeywords(text) {
  const normalized = normalizeText(text)
  if (!normalized) return []
  return [...new Set(normalized.split(/\s+/).filter(w => w.length >= 2))]
}

function buildCacheEntry(doc) {
  return {
    userMessage: doc.userMessage || '',
    adminReply: doc.adminReply || '',
    qualityScore: doc.qualityScore || 0,
    category: doc.evaluationCategory || 'no_learn',
    keywords: extractKeywords((doc.userMessage || '') + ' ' + (doc.adminReply || '')),
  }
}

async function loadCache() {
  const docs = await AiSuggestion.find({
    adminReply: { $ne: null },
    evaluatedAt: { $ne: null },
  }).select('userMessage adminReply qualityScore evaluationCategory').lean()

  replyCache = docs.map(buildCacheEntry)
  console.log(`[AdminReplyCache] loaded ${replyCache.length} entries`)
}

/**
 * 查找与用户问题高度匹配的管理员历史回复（直接复用，不走 LLM 自由生成）
 * 返回: { match: true, reply: '...', confidence: 0.9 } 或 null
 */
function findDirectMatch(userMessage) {
  if (!userMessage) return null
  const queryNorm = normalizeText(userMessage)
  if (!queryNorm || queryNorm.length < 3) return null

  const queryKeywords = extractKeywords(userMessage)
  if (queryKeywords.length === 0) return null

  const allEntries = [
    ...replyCache,
    ...recentReplies.map(e => ({ ...e, qualityScore: 60, category: 'recent' })),
  ]

  let bestMatch = null
  let bestScore = 0

  for (const entry of allEntries) {
    if (!entry.adminReply || entry.adminReply.length < 10) continue
    if (!entry.userMessage) continue

    const entryNorm = normalizeText(entry.userMessage)
    if (!entryNorm) continue

    // 精确匹配: 归一化后完全相同
    if (queryNorm === entryNorm) {
      return { match: true, reply: entry.adminReply, confidence: 1.0, source: 'exact' }
    }

    // 高相似度匹配: 关键词覆盖率
    const entryKeywords = extractKeywords(entry.userMessage)
    if (entryKeywords.length === 0) continue

    // 计算双向覆盖率
    const queryHits = queryKeywords.filter(qw =>
      entryKeywords.some(ew => ew === qw || (ew.length >= 3 && qw.length >= 3 && (ew.includes(qw) || qw.includes(ew))))
    ).length
    const entryHits = entryKeywords.filter(ew =>
      queryKeywords.some(qw => ew === qw || (ew.length >= 3 && qw.length >= 3 && (ew.includes(qw) || qw.includes(ew))))
    ).length

    const queryCoverage = queryKeywords.length > 0 ? queryHits / queryKeywords.length : 0
    const entryCoverage = entryKeywords.length > 0 ? entryHits / entryKeywords.length : 0
    const coverage = (queryCoverage + entryCoverage) / 2

    // 高质量回复额外加分
    let qualityBoost = 0
    if (entry.qualityScore >= 70) qualityBoost = 0.05
    if (entry.category === 'no_learn') qualityBoost += 0.05 // AI 本来就对的，说明管理员认可

    const score = coverage + qualityBoost

    if (score > bestScore && score >= 0.7) {
      bestScore = score
      bestMatch = { match: true, reply: entry.adminReply, confidence: Math.min(score, 1.0), source: 'similar' }
    }
  }

  return bestMatch
}

/**
 * Find similar admin replies for few-shot examples
 * 合并 replyCache（评估后）+ recentReplies（即时），过滤低质量
 */
function findSimilarReplies(userMessage, language, topK = 5) {
  const allEntries = [
    ...replyCache,
    ...recentReplies.map(e => ({ ...e, qualityScore: 60, category: 'recent' })),
  ]
  if (allEntries.length === 0) return []

  const queryKeywords = extractKeywords(userMessage)
  if (queryKeywords.length === 0) return getRandomGolden(3)

  const scored = []
  for (const entry of allEntries) {
    if (!entry.adminReply || entry.adminReply.length < 10) continue
    // 过滤纯短回复（"네", "감사합니다" 等没有参考价值）
    if (entry.adminReply.length < 15 && !entry.adminReply.includes(' ')) continue

    let score = 0
    for (const qw of queryKeywords) {
      for (const ew of entry.keywords) {
        if (ew === qw) score += 3
        else if (ew.length >= 3 && qw.length >= 3 && (ew.includes(qw) || qw.includes(ew))) score += 1
      }
    }

    if (score > 0) {
      // correction 示例教 AI 不要犯同样的错
      if (entry.category === 'correction') score += 5
      // 高质量黄金示例加分
      else if (entry.qualityScore >= 70) score += 3
      // 近期回复微加分（更贴近当前风格）
      else if (entry.category === 'recent') score += 1
      scored.push({ ...entry, score })
    }
  }

  if (scored.length === 0) return getRandomGolden(3)

  scored.sort((a, b) => b.score - a.score)

  // 去重：避免多条回复内容相似
  const result = []
  const seen = new Set()
  for (const e of scored) {
    if (result.length >= topK) break
    const key = e.adminReply.substring(0, 40)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ userMessage: e.userMessage, adminReply: e.adminReply })
  }
  return result
}

/**
 * Get random high-quality (golden) examples for style teaching
 */
function getRandomGolden(count) {
  const golden = replyCache.filter(e =>
    e.qualityScore >= 70 && e.adminReply && e.adminReply.length >= 10
  )
  if (golden.length === 0) return []

  const shuffled = golden.sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count).map(e => ({
    userMessage: e.userMessage,
    adminReply: e.adminReply,
  }))
}

/**
 * 管理员回复后立即加入近期缓存（不等评估完成），用于 few-shot 示例
 */
function onAdminReply(doc) {
  if (!doc.adminReply || doc.adminReply.trim().length < 10) return
  const reply = doc.adminReply.trim()

  // 去重
  if (recentReplies.some(e => e.adminReply === reply)) return

  recentReplies.unshift({
    userMessage: doc.userMessage || '',
    adminReply: reply,
    keywords: extractKeywords((doc.userMessage || '') + ' ' + reply),
    timestamp: new Date(),
  })

  // 保留最近 200 条
  if (recentReplies.length > 200) recentReplies.pop()
}

/**
 * Called when a new evaluation completes — append to cache immediately
 */
function onNewEvaluation(doc) {
  if (!doc.adminReply || !doc.evaluatedAt) return
  replyCache.push(buildCacheEntry(doc))
}

async function initAdminReplyCache() {
  await loadCache()
  initialized = true

  // Refresh every 30 minutes
  refreshTimer = setInterval(async () => {
    try {
      await loadCache()
    } catch (err) {
      console.error('[AdminReplyCache] refresh error:', err.message)
    }
  }, 30 * 60 * 1000)
}

function isReady() {
  return initialized
}

module.exports = {
  initAdminReplyCache,
  findDirectMatch,
  findSimilarReplies,
  onAdminReply,
  onNewEvaluation,
  isReady,
}
