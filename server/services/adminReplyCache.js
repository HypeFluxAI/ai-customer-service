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
 * Find similar admin replies for few-shot examples
 */
function findSimilarReplies(userMessage, language, topK = 3) {
  if (replyCache.length === 0) return []

  const queryKeywords = extractKeywords(userMessage)
  if (queryKeywords.length === 0) return getRandomGolden(2)

  // Score each cached entry by keyword overlap
  const scored = []
  for (const entry of replyCache) {
    if (!entry.adminReply || entry.adminReply.length < 5) continue

    let score = 0
    for (const qw of queryKeywords) {
      for (const ew of entry.keywords) {
        if (ew === qw) score += 3
        else if (ew.length >= 3 && qw.length >= 3 && (ew.includes(qw) || qw.includes(ew))) score += 1
      }
    }

    if (score > 0) {
      // Boost corrections (teach AI what NOT to do) and high-quality golden examples
      if (entry.category === 'correction') score += 5
      else if (entry.qualityScore >= 70) score += 2
      scored.push({ ...entry, score })
    }
  }

  if (scored.length === 0) return getRandomGolden(2)

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK).map(e => ({
    userMessage: e.userMessage,
    adminReply: e.adminReply,
  }))
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
  findSimilarReplies,
  onAdminReply,
  onNewEvaluation,
  isReady,
}
