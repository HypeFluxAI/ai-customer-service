#!/usr/bin/env node
/**
 * 修复 KB 内容：把 LLM 改写的答案替换回客服原文
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); } catch(e) {}
const mongoose = require('mongoose');

let MONGO_URI = process.env.MONGO_URI || 'mongodb://122.99.183.50:31017/deeplinkgame';
if (MONGO_URI.indexOf('svc.cluster.local') < 0 && MONGO_URI.indexOf('directConnection') < 0) {
  MONGO_URI += (MONGO_URI.indexOf('?') >= 0 ? '&' : '?') + 'directConnection=true';
}

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  await mongoose.connect(MONGO_URI);
  const KB = mongoose.connection.db.collection('knowledge_base');
  const AI = mongoose.connection.db.collection('ai_suggestions');

  const kbs = await KB.find({
    isActive: true,
    source: 'auto_learn',
    sourceEvaluationId: { $ne: null },
  }).toArray();

  console.log('auto_learn KB with source:', kbs.length);

  let fixed = 0, skipped = 0;
  for (const kb of kbs) {
    const ai = await AI.findOne({ _id: kb.sourceEvaluationId });
    if (!ai || !ai.adminReply) { skipped++; continue; }

    const adminReply = ai.adminReply.trim();
    const currentContent = (kb.contentHtml || '').replace(/<[^>]+>/g, '').trim();

    // 如果已经是客服原文就跳过
    if (currentContent === adminReply) { skipped++; continue; }

    // 客服原文太短的跳过
    if (adminReply.length < 10) { skipped++; continue; }

    const newHtml = '<p>' + adminReply.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>';

    if (DRY_RUN) {
      console.log('  [FIX] ' + (kb.title || '').substring(0, 40));
      console.log('    旧: ' + currentContent.substring(0, 60));
      console.log('    新: ' + adminReply.substring(0, 60));
      console.log('');
    } else {
      await KB.updateOne(
        { _id: kb._id },
        { $set: { contentHtml: newHtml, updatedAt: new Date() } }
      );
    }
    fixed++;
  }

  console.log('修复:', fixed, '| 跳过:', skipped);
  if (DRY_RUN) console.log('(dry-run)');

  await mongoose.disconnect();
}

main().catch(function(e) { console.error(e.message); process.exit(1); });
