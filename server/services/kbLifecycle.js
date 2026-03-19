/**
 * KB Lifecycle Management
 *
 * Daily 03:00 KST job:
 * 1. Flag stale auto_learn entries (no references in 30 days)
 * 2. Flag low-quality entries (avg qualityScore < 40)
 * 3. Auto-archive flagged entries after 14 days unresolved
 */

const { KnowledgeBase } = require('../models/KnowledgeBase');
const { AiSuggestion } = require('../models/AiSuggestion');
const { removeKBFromCache } = require('./embedding');

let dailyTimer = null;

/**
 * Run all lifecycle checks
 */
async function runLifecycle() {
    console.log('[KBLifecycle] starting daily run...');
    let flagged = 0, archived = 0, expired = 0;

    try {
        // 0. 过期 KB 自动归档（expiresAt 已过）
        const now = new Date();
        const expiredEntries = await KnowledgeBase.find({
            isActive: true,
            expiresAt: { $ne: null, $lt: now },
        }).lean();

        for (const entry of expiredEntries) {
            await KnowledgeBase.updateOne(
                { _id: entry._id },
                { $set: { isActive: false, reviewStatus: 'archived', updatedAt: now } }
            );
            removeKBFromCache(entry._id);
            expired++;
        }

        // 1. Flag stale auto_learn entries: no references in 30+ days
        const staleThreshold = new Date(Date.now() - 30 * 86400000);
        const staleResult = await KnowledgeBase.updateMany(
            {
                source: 'auto_learn',
                isActive: true,
                reviewStatus: 'active',
                referenceCount: 0,
                createdAt: { $lt: staleThreshold },
            },
            { $set: { reviewStatus: 'flagged', updatedAt: now } }
        );
        flagged += staleResult.modifiedCount;

        // 2. Flag low-quality entries: source evaluations avg score < 40
        const autoLearnEntries = await KnowledgeBase.find({
            source: 'auto_learn',
            isActive: true,
            reviewStatus: 'active',
            sourceEvaluationId: { $ne: null },
        }).lean();

        for (const entry of autoLearnEntries) {
            const evalDoc = await AiSuggestion.findById(entry.sourceEvaluationId).select('qualityScore').lean();
            if (evalDoc && evalDoc.qualityScore != null && evalDoc.qualityScore < 40) {
                await KnowledgeBase.updateOne(
                    { _id: entry._id },
                    { $set: { reviewStatus: 'flagged', updatedAt: now } }
                );
                flagged++;
            }
        }

        // 3. 清理长期无用 KB：60天未引用 + 低置信度 + 非手动创建 → 直接归档
        const unusedThreshold = new Date(Date.now() - 60 * 86400000);
        const unusedResult = await KnowledgeBase.updateMany(
            {
                isActive: true,
                reviewStatus: 'active',
                source: { $in: ['auto_learn', 'admin_backfill'] },
                referenceCount: 0,
                confidence: { $lt: 0.8 },
                createdAt: { $lt: unusedThreshold },
            },
            { $set: { isActive: false, reviewStatus: 'archived', updatedAt: now } }
        );
        archived += unusedResult.modifiedCount;

        // 4. Auto-archive: flagged for 14+ days with no manual resolution
        const archiveThreshold = new Date(Date.now() - 14 * 86400000);
        const toArchive = await KnowledgeBase.find({
            reviewStatus: 'flagged',
            isActive: true,
            updatedAt: { $lt: archiveThreshold },
        }).lean();

        for (const entry of toArchive) {
            await KnowledgeBase.updateOne(
                { _id: entry._id },
                { $set: { isActive: false, reviewStatus: 'archived', updatedAt: now } }
            );
            removeKBFromCache(entry._id);
            archived++;
        }

        console.log(`[KBLifecycle] done: expired=${expired}, flagged=${flagged}, archived=${archived}`);
    } catch (err) {
        console.error('[KBLifecycle] error:', err.message);
    }
}

/**
 * Calculate ms until next 03:00 KST (UTC+9)
 */
function msUntilNextRun() {
    const now = new Date();
    const target = new Date(now);
    target.setUTCHours((24 - 9 + 3) % 24, 0, 0, 0); // 03:00 KST = 18:00 UTC
    if (now >= target) {
        target.setDate(target.getDate() + 1);
    }
    return target.getTime() - now.getTime();
}

function startKBLifecycle() {
    const msToNext = msUntilNextRun();
    console.log(`[KBLifecycle] next run in ${Math.round(msToNext / 3600000)}h`);

    // Schedule first run
    setTimeout(() => {
        runLifecycle();
        // Then every 24 hours
        dailyTimer = setInterval(runLifecycle, 24 * 60 * 60 * 1000);
    }, msToNext);
}

function stopKBLifecycle() {
    if (dailyTimer) {
        clearInterval(dailyTimer);
        dailyTimer = null;
    }
}

module.exports = { startKBLifecycle, stopKBLifecycle, runLifecycle };
