const express = require('express');
const router = express.Router();
const { AiSuggestion } = require('../models/AiSuggestion');
const { KnowledgeBase } = require('../models/KnowledgeBase');

// GET /api/chat/ai-quality/stats — aggregate KPI data
router.get('/stats', async (req, res) => {
    try {
        const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
        const since = new Date(Date.now() - days * 86400000);

        const [total, linked, autoLearnedCount, flaggedKbCount] = await Promise.all([
            AiSuggestion.countDocuments({ createdAt: { $gte: since } }),
            AiSuggestion.find({ createdAt: { $gte: since }, adminReplyId: { $ne: null } })
                .select('similarity qualityScore evaluationCategory')
                .lean(),
            KnowledgeBase.countDocuments({ source: 'auto_learn' }),
            KnowledgeBase.countDocuments({ reviewStatus: 'flagged', isActive: true }),
        ]);

        let avgSimilarity = 0;
        let highCount = 0;
        let lowCount = 0;
        let avgQualityScore = 0;
        let qualityScoreCount = 0;
        const categoryBreakdown = { new_knowledge: 0, correction: 0, style_improvement: 0, no_learn: 0 };

        if (linked.length > 0) {
            let simSum = 0;
            let qualSum = 0;
            for (const doc of linked) {
                const s = doc.similarity || 0;
                simSum += s;
                if (s >= 70) highCount++;
                if (s < 30) lowCount++;
                if (doc.qualityScore != null) {
                    qualSum += doc.qualityScore;
                    qualityScoreCount++;
                }
                if (doc.evaluationCategory && categoryBreakdown[doc.evaluationCategory] !== undefined) {
                    categoryBreakdown[doc.evaluationCategory]++;
                }
            }
            avgSimilarity = Math.round(simSum / linked.length);
            avgQualityScore = qualityScoreCount > 0 ? Math.round(qualSum / qualityScoreCount) : 0;
        }

        res.json({
            success: true,
            data: {
                totalSuggestions: total,
                linkedCount: linked.length,
                avgSimilarity,
                highSimilarityRate: linked.length > 0 ? Math.round((highCount / linked.length) * 100) : 0,
                lowSimilarityCount: lowCount,
                autoLearnedCount,
                avgQualityScore,
                categoryBreakdown,
                flaggedKbCount,
                days,
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/chat/ai-quality/comparisons — paginated comparison list
router.get('/comparisons', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const skip = (page - 1) * limit;

        const sortField = req.query.sort === 'createdAt' ? 'createdAt' : 'similarity';
        const sortOrder = req.query.order === 'desc' ? -1 : 1;

        const filter = { adminReplyId: { $ne: null } };

        if (req.query.minSimilarity) {
            filter.similarity = { ...filter.similarity, $gte: parseInt(req.query.minSimilarity) };
        }
        if (req.query.maxSimilarity) {
            filter.similarity = { ...filter.similarity, $lte: parseInt(req.query.maxSimilarity) };
        }

        const [data, total] = await Promise.all([
            AiSuggestion.find(filter)
                .sort({ [sortField]: sortOrder })
                .skip(skip)
                .limit(limit)
                .select('sessionId userMessage suggestion adminReply similarity qualityScore evaluationCategory adminFeedback language createdAt')
                .lean(),
            AiSuggestion.countDocuments(filter),
        ]);

        res.json({
            success: true,
            data,
            pagination: { page, limit, total },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/chat/ai-quality/trend — daily trend data
router.get('/trend', async (req, res) => {
    try {
        const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));
        const since = new Date(Date.now() - days * 86400000);

        const pipeline = [
            { $match: { createdAt: { $gte: since }, adminReplyId: { $ne: null } } },
            {
                $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                    count: { $sum: 1 },
                    avgSimilarity: { $avg: '$similarity' },
                    avgQualityScore: { $avg: '$qualityScore' },
                },
            },
            { $sort: { _id: 1 } },
            {
                $project: {
                    _id: 0,
                    date: '$_id',
                    count: 1,
                    avgSimilarity: { $round: ['$avgSimilarity', 0] },
                    avgQualityScore: { $round: ['$avgQualityScore', 0] },
                },
            },
        ];

        const data = await AiSuggestion.aggregate(pipeline);

        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/chat/ai-quality/flagged-kb — list flagged KB entries for review
router.get('/flagged-kb', async (req, res) => {
    try {
        const data = await KnowledgeBase.find({
            reviewStatus: 'flagged',
            isActive: true,
        }).sort({ updatedAt: -1 }).lean();

        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/chat/ai-quality/knowledge-gaps — 知识覆盖缺口分析
// 聚合 new_knowledge + correction 类别的问题，找出高频未覆盖话题
router.get('/knowledge-gaps', async (req, res) => {
    try {
        const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 14));
        const since = new Date(Date.now() - days * 86400000);

        // 获取 AI 不知道或答错的建议，连带管理员的正确回复
        const gaps = await AiSuggestion.find({
            createdAt: { $gte: since },
            evaluationCategory: { $in: ['new_knowledge', 'correction'] },
            adminReply: { $ne: null },
        })
            .select('userMessage adminReply suggestion evaluationCategory qualityScore createdAt')
            .sort({ createdAt: -1 })
            .lean();

        // 按关键词聚类，找出高频问题模式
        const clusterMap = new Map(); // keyword → { count, examples[] }
        for (const gap of gaps) {
            const msg = (gap.userMessage || '').toLowerCase().replace(/[^\w\s가-힣一-龥]/g, ' ').trim();
            if (!msg) continue;

            // 提取 2+ 字符的关键词
            const words = [...new Set(msg.split(/\s+/).filter(w => w.length >= 2))];
            // 用前两个关键词组合作为聚类键（更精确）
            const key = words.slice(0, 3).sort().join('+') || msg.substring(0, 30);

            if (!clusterMap.has(key)) {
                clusterMap.set(key, { keywords: key, count: 0, examples: [] });
            }
            const cluster = clusterMap.get(key);
            cluster.count++;
            if (cluster.examples.length < 3) {
                cluster.examples.push({
                    userMessage: gap.userMessage,
                    adminReply: gap.adminReply,
                    category: gap.evaluationCategory,
                    qualityScore: gap.qualityScore,
                });
            }
        }

        // 按频次排序，返回 top 30
        const clusters = [...clusterMap.values()]
            .filter(c => c.count >= 2) // 至少出现 2 次
            .sort((a, b) => b.count - a.count)
            .slice(0, 30);

        res.json({
            success: true,
            data: {
                totalGaps: gaps.length,
                clusters,
                days,
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/chat/ai-quality/knowledge-gaps/learn — 一键将管理员回复写入 KB
router.post('/knowledge-gaps/learn', async (req, res) => {
    try {
        const { items } = req.body; // [{ userMessage, adminReply, language }]
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, error: 'items array required' });
        }

        const created = [];
        for (const item of items.slice(0, 20)) { // 最多 20 条
            const { userMessage, adminReply, language } = item;
            if (!userMessage || !adminReply) continue;

            // 去重：检查是否已有相似 KB
            const existing = await KnowledgeBase.findOne({
                title: userMessage.substring(0, 100),
                isActive: true,
            });
            if (existing) continue;

            const entry = await KnowledgeBase.create({
                title: userMessage.substring(0, 100),
                contentHtml: `<p>${adminReply}</p>`,
                keywords: [...new Set(
                    userMessage.toLowerCase()
                        .replace(/[^\w\s가-힣一-龥]/g, ' ')
                        .split(/\s+/)
                        .filter(w => w.length >= 2)
                )].slice(0, 10),
                language: language || 'ko',
                source: 'admin_teach',
                confidence: 0.9,
                isActive: true,
            });
            created.push(entry._id);
        }

        res.json({
            success: true,
            data: { created: created.length, ids: created },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/chat/ai-quality/kb/:id/resolve — admin review (keep or archive)
router.post('/kb/:id/resolve', async (req, res) => {
    try {
        const { action } = req.body; // 'keep' or 'archive'
        if (action !== 'keep' && action !== 'archive') {
            return res.status(400).json({ success: false, error: 'action must be keep or archive' });
        }

        const update = action === 'keep'
            ? { reviewStatus: 'active', updatedAt: new Date() }
            : { reviewStatus: 'archived', isActive: false, updatedAt: new Date() };

        const result = await KnowledgeBase.updateOne({ _id: req.params.id }, { $set: update });
        if (result.matchedCount === 0) {
            return res.status(404).json({ success: false, error: 'KB entry not found' });
        }

        if (action === 'archive') {
            const { removeKBFromCache } = require('../services/embedding');
            removeKBFromCache(req.params.id);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
