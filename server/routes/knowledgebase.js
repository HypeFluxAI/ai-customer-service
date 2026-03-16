const express = require('express')
const router = express.Router()
const { KnowledgeBase } = require('../models/KnowledgeBase')
const { refreshKBEntry, removeKBFromCache } = require('../services/embedding')

const normalize = (value) => {
    if (!value) return ''
    return String(value).toLowerCase().replace(/\s+/g, ' ').trim()
}

// GET /api/knowledgebase - list entries
router.get('/', async (req, res) => {
    try {
        const { language, active } = req.query
        const query = {}
        if (language) query.language = language
        if (active !== undefined) query.isActive = active === 'true'

        const entries = await KnowledgeBase.find(query).sort({ updatedAt: -1 })
        res.json({ success: true, data: entries })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// POST /api/knowledgebase - create entry
router.post('/', async (req, res) => {
    try {
        const { language, title, contentHtml, keywords, isActive } = req.body
        if (!title || !contentHtml) {
            return res.status(400).json({ success: false, error: 'title and contentHtml are required' })
        }
        const entry = new KnowledgeBase({
            language: language || 'ko',
            title: title.trim(),
            contentHtml,
            keywords: Array.isArray(keywords)
                ? keywords.map((item) => normalize(item)).filter(Boolean)
                : [],
            isActive: isActive !== false,
        })
        await entry.save()
        // Compute embedding asynchronously
        refreshKBEntry(entry._id).catch(() => {})
        res.json({ success: true, data: entry })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// PUT /api/knowledgebase/:id - update entry
router.put('/:id', async (req, res) => {
    try {
        const { language, title, contentHtml, keywords, isActive } = req.body
        const update = {}
        if (language) update.language = language
        if (title !== undefined) update.title = title.trim()
        if (contentHtml !== undefined) update.contentHtml = contentHtml
        if (keywords !== undefined) {
            update.keywords = Array.isArray(keywords)
                ? keywords.map((item) => normalize(item)).filter(Boolean)
                : []
        }
        if (isActive !== undefined) update.isActive = !!isActive
        update.updatedAt = new Date()

        const entry = await KnowledgeBase.findByIdAndUpdate(req.params.id, update, { new: true })
        if (!entry) {
            return res.status(404).json({ success: false, error: 'Entry not found' })
        }
        // Recompute embedding asynchronously
        refreshKBEntry(entry._id).catch(() => {})
        res.json({ success: true, data: entry })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// DELETE /api/knowledgebase/:id - remove entry
router.delete('/:id', async (req, res) => {
    try {
        const entry = await KnowledgeBase.findByIdAndDelete(req.params.id)
        if (!entry) {
            return res.status(404).json({ success: false, error: 'Entry not found' })
        }
        removeKBFromCache(req.params.id)
        res.json({ success: true, data: entry })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

module.exports = router
