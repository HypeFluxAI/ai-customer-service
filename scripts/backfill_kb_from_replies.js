#!/usr/bin/env node
/**
 * 高质量管理员回复 → KB 批量回填
 * 将 no_learn + style_improvement 类别中质量分 ≥60 的管理员回复写入 KB
 * 这些是管理员写得好但 AI 没学到的内容
 *
 * 用法: node scripts/backfill_kb_from_replies.js [--dry-run] [--min-score 60]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') })
const mongoose = require('mongoose')
const { AiSuggestion } = require('../server/models/AiSuggestion')
const { KnowledgeBase } = require('../server/models/KnowledgeBase')

const DRY_RUN = process.argv.includes('--dry-run')
const MIN_SCORE = parseInt(process.argv.find(a => a.match(/--min-score/))?.split('=')?.[1] || '60')

// 过滤无意义的短回复
const SKIP_PATTERNS = [
  /^네[.!]?$/,
  /^감사합니다[.!]?$/,
  /^안녕하세요[.!]?$/,
  /^넵[.!]?$/,
  /^확인/,
]

function extractKeywords(text) {
  return [...new Set(
    text.toLowerCase()
      .replace(/[^\w\s가-힣一-龥]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2)
  )].slice(0, 10)
}

async function main() {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ai-customer-service'
  await mongoose.connect(MONGO_URI)
  console.log(`[MongoDB] Connected: ${MONGO_URI}`)
  console.log(`[Config] min-score=${MIN_SCORE}, dry-run=${DRY_RUN}`)

  // 高质量回复: no_learn(AI 本来就对) 或 style_improvement(风格更好)
  const replies = await AiSuggestion.find({
    evaluationCategory: { $in: ['no_learn', 'style_improvement'] },
    qualityScore: { $gte: MIN_SCORE },
    adminReply: { $ne: null },
    userMessage: { $ne: null },
  })
    .select('userMessage adminReply qualityScore evaluationCategory language')
    .sort({ qualityScore: -1 })
    .lean()

  console.log(`[Replies] Found ${replies.length} high-quality admin replies (score ≥ ${MIN_SCORE})`)

  let created = 0, skipped = 0, filtered = 0
  const seenTitles = new Set()

  for (const r of replies) {
    const reply = r.adminReply.trim()
    const question = r.userMessage.trim()

    // 跳过太短的回复
    if (reply.length < 20 || question.length < 5) { filtered++; continue }

    // 跳过无意义模式
    if (SKIP_PATTERNS.some(p => p.test(reply))) { filtered++; continue }

    // 本地去重
    const titleKey = question.substring(0, 60)
    if (seenTitles.has(titleKey)) { skipped++; continue }

    // DB 去重
    const existing = await KnowledgeBase.findOne({
      title: question.substring(0, 100),
      isActive: true,
    })
    if (existing) { skipped++; continue }

    seenTitles.add(titleKey)

    if (DRY_RUN) {
      console.log(`  [DRY-RUN] Q: "${question.substring(0, 50)}" → A: "${reply.substring(0, 50)}" (score=${r.qualityScore})`)
    } else {
      await KnowledgeBase.create({
        title: question.substring(0, 100),
        contentHtml: `<p>${reply}</p>`,
        keywords: extractKeywords(question + ' ' + reply),
        language: r.language || 'ko',
        source: 'admin_backfill',
        confidence: Math.min(r.qualityScore / 100, 0.95),
        isActive: true,
      })
    }
    created++

    // 最多创建 200 条，避免一次性太多
    if (created >= 200) {
      console.log('  [Limit] Reached 200 entries, stopping')
      break
    }
  }

  console.log()
  console.log(`=== 完成 ===`)
  console.log(`  创建: ${created} 条 KB`)
  console.log(`  跳过: ${skipped} 条 (已存在/重复)`)
  console.log(`  过滤: ${filtered} 条 (太短/无意义)`)
  if (DRY_RUN) console.log('  (dry-run 模式，未实际写入)')

  await mongoose.disconnect()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
