#!/usr/bin/env node
/**
 * QnA → KB 同步脚本
 * 将高质量人工编写的 QnA 条目同步为 KB 条目，提升 AI 建议的知识覆盖率
 *
 * 用法: node scripts/sync_qna_to_kb.js [--dry-run]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') })
const mongoose = require('mongoose')
const QnA = require('../server/models/QnA')
const { KnowledgeBase } = require('../server/models/KnowledgeBase')

const DRY_RUN = process.argv.includes('--dry-run')

async function main() {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ai-customer-service'
  await mongoose.connect(MONGO_URI)
  console.log(`[MongoDB] Connected: ${MONGO_URI}`)

  const qnaList = await QnA.find({ isActive: true }).lean()
  console.log(`[QnA] Found ${qnaList.length} active QnA entries`)

  let created = 0, skipped = 0

  for (const qna of qnaList) {
    for (const lang of ['ko', 'zh', 'en']) {
      const question = qna.question?.[lang]
      const answer = qna.answer?.[lang]
      if (!question || !answer) continue

      // 检查是否已存在
      const existing = await KnowledgeBase.findOne({
        title: question,
        language: lang,
        isActive: true,
      })
      if (existing) {
        skipped++
        continue
      }

      // 从问题中提取关键词
      const keywords = [...new Set(
        question.toLowerCase()
          .replace(/[^\w\s가-힣一-龥]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length >= 2)
      )].slice(0, 10)

      if (DRY_RUN) {
        console.log(`  [DRY-RUN] Would create: "${question}" (${lang})`)
      } else {
        await KnowledgeBase.create({
          title: question,
          contentHtml: `<p>${answer}</p>`,
          keywords,
          language: lang,
          source: 'qna_sync',
          confidence: 0.95,
          isActive: true,
        })
        console.log(`  [Created] "${question}" (${lang})`)
      }
      created++
    }
  }

  console.log()
  console.log(`=== 完成 ===`)
  console.log(`  创建: ${created} 条 KB`)
  console.log(`  跳过: ${skipped} 条 (已存在)`)
  if (DRY_RUN) console.log('  (dry-run 模式，未实际写入)')

  await mongoose.disconnect()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
