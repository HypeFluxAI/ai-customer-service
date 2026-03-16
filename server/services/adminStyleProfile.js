/**
 * Admin style profile — analyzes historical admin replies to extract style patterns
 *
 * Pure string analysis, computed once on startup from adminReplyCache data.
 * Provides getStyleDirectives() for system prompt injection.
 */

const { AiSuggestion } = require('../models/AiSuggestion')

let styleDirectives = null
let initialized = false

/**
 * Analyze admin replies and extract style patterns
 */
async function analyze() {
  const docs = await AiSuggestion.find({
    adminReply: { $ne: null },
    language: 'ko',
  }).select('adminReply suggestion').lean()

  if (docs.length < 10) {
    console.log(`[StyleProfile] not enough data (${docs.length} replies), skipping`)
    return
  }

  const replies = docs.map(d => d.adminReply).filter(r => r && r.length >= 5)
  const suggestions = docs.map(d => d.suggestion).filter(s => s && s.length >= 5)

  // Average reply length
  const avgLen = Math.round(replies.reduce((sum, r) => sum + r.length, 0) / replies.length)
  const maxLen = Math.min(Math.round(avgLen * 1.6), 120)

  // Greeting patterns (first 10 chars)
  const greetingCounts = {}
  for (const r of replies) {
    const start = r.substring(0, 10).trim()
    for (const pattern of ['안녕하세요', '안녕하세요~', '안녕하세요!', '안녕하세요~!', '네', '네,', '네!']) {
      if (start.startsWith(pattern)) {
        greetingCounts[pattern] = (greetingCounts[pattern] || 0) + 1
        break
      }
    }
  }
  const topGreetings = Object.entries(greetingCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([p, c]) => `"${p}" (${Math.round(c / replies.length * 100)}%)`)

  // Closing patterns (last 15 chars)
  const closingCounts = {}
  for (const r of replies) {
    const end = r.substring(Math.max(0, r.length - 15)).trim()
    for (const pattern of ['감사합니다', '감사합니다~', '감사합니다!', '감사합니다~!', '부탁드립니다', '드릴게요', '드리겠습니다']) {
      if (end.includes(pattern)) {
        closingCounts[pattern] = (closingCounts[pattern] || 0) + 1
        break
      }
    }
  }
  const topClosings = Object.entries(closingCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([p, c]) => `"${p}" (${Math.round(c / replies.length * 100)}%)`)

  // Avoid phrases: expressions AI uses frequently but admin never uses
  const aiPhrases = ['가능해요!', '물론이죠!', '물론입니다!', '걱정 마세요!', '도움이 되셨으면', '추가 질문이 있으시면', '문의해 주셔서 감사합니다']
  const avoidPhrases = []
  for (const phrase of aiPhrases) {
    const aiCount = suggestions.filter(s => s.includes(phrase)).length
    const adminCount = replies.filter(r => r.includes(phrase)).length
    if (aiCount >= 3 && adminCount <= 1) {
      avoidPhrases.push(`"${phrase}"`)
    }
  }

  styleDirectives = `말투 규칙 (실제 상담원 ${replies.length}개 답변 데이터 기반):
- 답변 길이: 평균 ${avgLen}자, 최대 ${maxLen}자로 간결하게
${topGreetings.length > 0 ? `- 인사: ${topGreetings.join(', ')} 스타일` : ''}
${topClosings.length > 0 ? `- 마무리: ${topClosings.join(', ')} 스타일` : ''}
${avoidPhrases.length > 0 ? `- 금지 표현: ${avoidPhrases.join(', ')} — 상담원이 실제로 사용하지 않는 표현` : ''}
- 권장: "다만 현재...", "확인 후 안내드릴게요" 등 현실 반영 표현`

  console.log(`[StyleProfile] analyzed ${replies.length} replies, avgLen=${avgLen}`)
}

async function initStyleProfile() {
  try {
    await analyze()
    initialized = true
  } catch (err) {
    console.error('[StyleProfile] init error:', err.message)
  }

  // Refresh every 30 minutes
  setInterval(async () => {
    try {
      await analyze()
    } catch (err) {
      console.error('[StyleProfile] refresh error:', err.message)
    }
  }, 30 * 60 * 1000)
}

function getStyleDirectives() {
  return styleDirectives
}

function isReady() {
  return initialized
}

module.exports = {
  initStyleProfile,
  getStyleDirectives,
  isReady,
}
