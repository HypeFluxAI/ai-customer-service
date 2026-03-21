#!/usr/bin/env node
/**
 * KB 清理脚本 — 归档重复/过时/低质量条目
 * 用法: MONGO_URI=mongodb://... node scripts/cleanup_kb.js [--dry-run]
 */
const mongoose = require('mongoose');
const MONGO_URI = process.env.MONGO_URI || 'mongodb://122.99.183.50:31017/deeplinkgame';
const DRY_RUN = process.argv.includes('--dry-run');

const KBSchema = new mongoose.Schema({}, { strict: false, collection: 'knowledge_base' });
const KB = mongoose.model('KB', KBSchema);

async function main() {
  await mongoose.connect(MONGO_URI);
  const all = await KB.find({ isActive: true }).lean();
  console.log('当前活跃 KB:', all.length);

  const archiveSet = {};

  // === 1. 기기 부족/증설 重复 — 只保留 top5 引用 + admin_teach/manual ===
  const deviceShortage = all.filter(function(e) {
    var t = (e.title || '') + ' ' + (e.contentHtml || '');
    return t.indexOf('기기') >= 0 && (t.indexOf('임대 중') >= 0 || t.indexOf('증설') >= 0);
  });
  deviceShortage.sort(function(a, b) { return (b.referenceCount || 0) - (a.referenceCount || 0); });

  var keepDevice = {};
  deviceShortage.slice(0, 5).forEach(function(e) { keepDevice[e._id.toString()] = true; });
  deviceShortage.forEach(function(e) {
    if (e.source === 'admin_teach' || e.source === 'manual' || e.source === 'qna_sync') {
      keepDevice[e._id.toString()] = true;
    }
  });
  deviceShortage.forEach(function(e) {
    if (!keepDevice[e._id.toString()]) archiveSet[e._id.toString()] = e._id;
  });
  var deviceArchived = Object.keys(archiveSet).length;
  console.log('기기 부족 归档:', deviceArchived, '(总', deviceShortage.length, ', 保留', Object.keys(keepDevice).length, ')');

  // === 2. 리니지 이용가능 重复 — 保留 top3 ===
  var lineage = all.filter(function(e) {
    var t = e.title || '';
    return t.indexOf('리니지') >= 0 && (t.indexOf('이용 가능') >= 0 || t.indexOf('이용가능') >= 0)
      && e.source === 'auto_learn' && !keepDevice[e._id.toString()] && !archiveSet[e._id.toString()];
  });
  lineage.sort(function(a, b) { return (b.referenceCount || 0) - (a.referenceCount || 0); });
  var lineageKeep = {};
  lineage.slice(0, 3).forEach(function(e) { lineageKeep[e._id.toString()] = true; });
  var lineageCount = 0;
  lineage.forEach(function(e) {
    if (!lineageKeep[e._id.toString()]) { archiveSet[e._id.toString()] = e._id; lineageCount++; }
  });
  console.log('리니지 重复归档:', lineageCount);

  // === 3. 过时版本/日期信息 ===
  var outdatedCount = 0;
  all.forEach(function(e) {
    if (archiveSet[e._id.toString()]) return;
    var t = (e.title || '') + ' ' + (e.contentHtml || '');
    if (e.source === 'auto_learn' && (
      t.indexOf('1.1.0.49') >= 0 || t.indexOf('0.40 버전') >= 0 ||
      t.indexOf('2025년') >= 0
    )) {
      archiveSet[e._id.toString()] = e._id;
      outdatedCount++;
    }
  });
  console.log('过时信息归档:', outdatedCount);

  // === 4. Meta/确认类（不是真正的答案）===
  var metaCount = 0;
  all.forEach(function(e) {
    if (archiveSet[e._id.toString()]) return;
    var t = e.title || '';
    if (e.source === 'auto_learn' && (
      t.indexOf('확인 필요') >= 0 || t.indexOf('먼저 확인') >= 0 ||
      t.indexOf('우선 확인') >= 0 || t.indexOf('안내 방법') >= 0
    )) {
      archiveSet[e._id.toString()] = e._id;
      metaCount++;
    }
  });
  console.log('Meta/不实用归档:', metaCount);

  // === 5. 신규 유저 안내 重复 — 保留 top2 ===
  var newUser = all.filter(function(e) {
    var t = e.title || '';
    return t.indexOf('신규') >= 0 && (t.indexOf('유저') >= 0 || t.indexOf('이용') >= 0 || t.indexOf('회원') >= 0)
      && e.source === 'auto_learn' && !archiveSet[e._id.toString()];
  });
  newUser.sort(function(a, b) { return (b.referenceCount || 0) - (a.referenceCount || 0); });
  var newUserKeep = {};
  newUser.slice(0, 2).forEach(function(e) { newUserKeep[e._id.toString()] = true; });
  var newUserCount = 0;
  newUser.forEach(function(e) {
    if (!newUserKeep[e._id.toString()]) { archiveSet[e._id.toString()] = e._id; newUserCount++; }
  });
  console.log('신규 유저 重复归档:', newUserCount);

  // === 执行 ===
  var ids = Object.values(archiveSet);
  console.log('\n总计归档:', ids.length, '条');

  if (DRY_RUN) {
    console.log('(dry-run 模式, 未实际执行)');
  } else if (ids.length > 0) {
    var result = await KB.updateMany(
      { _id: { $in: ids } },
      { $set: { isActive: false, reviewStatus: 'archived', updatedAt: new Date() } }
    );
    console.log('已归档:', result.modifiedCount, '条');
  }

  var remaining = await KB.countDocuments({ isActive: true });
  console.log('剩余活跃 KB:', remaining, '条');
  await mongoose.disconnect();
}

main().catch(function(e) { console.error(e.message); process.exit(1); });
