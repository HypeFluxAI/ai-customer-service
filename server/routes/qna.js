const express = require('express');
const router = express.Router();
const QnA = require('../models/QnA');

// GET /api/qna/list — Q&A 列表
router.get('/list', async (req, res) => {
    try {
        const includeInactive = req.query.includeInactive === 'true';
        const query = includeInactive ? {} : { isActive: true };

        const qnaList = await QnA.find(query).sort({ order: 1, createdAt: -1 });

        res.json({
            success: true,
            data: qnaList
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/qna/:id — 单个 Q&A
router.get('/:id', async (req, res) => {
    try {
        const qna = await QnA.findById(req.params.id);
        if (!qna) {
            return res.status(404).json({ success: false, error: 'QnA not found' });
        }
        res.json({
            success: true,
            data: qna
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/qna/add — 创建 Q&A
router.post('/add', async (req, res) => {
    try {
        const { question, answer, order } = req.body;

        if (!question || !answer ||
            !question.ko || !question.zh || !question.en ||
            !answer.ko || !answer.zh || !answer.en) {
            return res.status(400).json({
                success: false,
                error: 'Question and answer translations are required for all languages (ko, zh, en)'
            });
        }

        let newOrder = order;
        if (newOrder === undefined) {
            const maxOrder = await QnA.findOne().sort({ order: -1 }).select('order');
            newOrder = maxOrder ? maxOrder.order + 1 : 1;
        }

        const newQnA = new QnA({
            question,
            answer,
            order: newOrder
        });

        await newQnA.save();

        res.json({
            success: true,
            data: newQnA,
            message: 'QnA created successfully'
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT /api/qna/edit/:id — 更新 Q&A
router.put('/edit/:id', async (req, res) => {
    try {
        const { question, answer, order, isActive } = req.body;

        const updateData = { updatedAt: new Date() };
        if (question !== undefined) updateData.question = question;
        if (answer !== undefined) updateData.answer = answer;
        if (order !== undefined) updateData.order = order;
        if (isActive !== undefined) updateData.isActive = isActive;

        const qna = await QnA.findByIdAndUpdate(
            req.params.id,
            updateData,
            { new: true }
        );

        if (!qna) {
            return res.status(404).json({ success: false, error: 'QnA not found' });
        }

        res.json({
            success: true,
            data: qna,
            message: 'QnA updated successfully'
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/qna/delete/:id — 删除 Q&A
router.delete('/delete/:id', async (req, res) => {
    try {
        const qna = await QnA.findByIdAndDelete(req.params.id);

        if (!qna) {
            return res.status(404).json({ success: false, error: 'QnA not found' });
        }

        res.json({
            success: true,
            message: 'QnA deleted successfully'
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT /api/qna/reorder — 批量排序
router.put('/reorder', async (req, res) => {
    try {
        const { items } = req.body;

        if (!Array.isArray(items)) {
            return res.status(400).json({
                success: false,
                error: 'Items array is required'
            });
        }

        const bulkOps = items.map(item => ({
            updateOne: {
                filter: { _id: item.id },
                update: { $set: { order: item.order, updatedAt: new Date() } }
            }
        }));

        await QnA.bulkWrite(bulkOps);

        res.json({
            success: true,
            message: 'QnA order updated successfully'
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
