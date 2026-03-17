const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { ChatSession, ChatMessage } = require('../models/Chat');
const { KnowledgeBase } = require('../models/KnowledgeBase');
const { broadcastToAdmins } = require('../realtime/chatRealtime');
const crypto = require('crypto');
const { AiSuggestion, calculateSimilarity } = require('../models/AiSuggestion');
const { enqueueEvaluation } = require('../services/evaluateQuality');
const createRateLimiter = require('../middleware/rateLimit');

// Debounce admin reply linking: collect consecutive admin messages before linking
const ADMIN_REPLY_DEBOUNCE_MS = 30000; // 30 seconds
const adminReplyTimers = new Map(); // sessionId -> { timer, texts[] }

// Image upload configuration
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'chat');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

const CHAT_COOKIE_NAME = 'deeplink_chat_visitor';
const CHAT_COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 30;

const getVisitorToken = (req, res) => {
    let token = req.cookies?.[CHAT_COOKIE_NAME];
    if (!token) {
        token = crypto.randomUUID();
        res.cookie(CHAT_COOKIE_NAME, token, {
            httpOnly: true,
            sameSite: 'lax',
            maxAge: CHAT_COOKIE_MAX_AGE
        });
    }
    return token;
};

const normalizeText = (value) => {
    if (!value) return '';
    return String(value).toLowerCase().replace(/[^\w\s가-힣一-龥]/g, ' ').replace(/\s+/g, ' ').trim();
};

const resolveLanguage = (value) => {
    if (value === 'ko' || value === 'zh' || value === 'en') return value;
    return 'ko';
};

const stripHtml = (html) => {
    if (!html) return '';
    return html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
};

const findKnowledgeMatch = async (messageText, language) => {
    const normalized = normalizeText(messageText);
    if (!normalized) return null;
    const entries = await KnowledgeBase.find({ isActive: true, language: resolveLanguage(language) });
    let best = null;
    let bestScore = 0;

    for (const entry of entries) {
        let score = 0;
        const title = normalizeText(entry.title);
        if (title && normalized.includes(title)) score += 3;
        const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];
        for (const keyword of keywords) {
            if (keyword && normalized.includes(keyword)) {
                score += 2;
            }
        }
        if (score > bestScore) {
            bestScore = score;
            best = entry;
        }
    }

    return bestScore > 0 ? best : null;
};

// GET /api/chat/sessions - Get all chat sessions (for admin)
router.get('/sessions', async (req, res) => {
    try {
        const status = req.query.status; // 'active', 'closed', or undefined for all
        const query = status ? { status } : {};
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
        const skip = (page - 1) * limit;

        const [sessions, total] = await Promise.all([
            ChatSession.find(query)
                .sort({ lastMessageTime: -1 })
                .skip(skip)
                .limit(limit),
            ChatSession.countDocuments(query)
        ]);

        res.json({
            success: true,
            data: sessions,
            pagination: { page, limit, total }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/chat/session/recover - Recover existing session by visitor cookie
// IMPORTANT: Must be before /session/:id to avoid being caught by the :id param
router.get('/session/recover', async (req, res) => {
    try {
        const visitorToken = req.cookies?.[CHAT_COOKIE_NAME];
        if (!visitorToken) {
            return res.json({ success: false, error: 'No visitor token' });
        }

        const session = await ChatSession.findOne({
            visitorToken,
            status: 'active'
        }).sort({ updatedAt: -1 });

        if (!session) {
            return res.json({ success: false, error: 'No active session found' });
        }

        res.json({ success: true, data: session });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/chat/session/:id - Get single session with messages
router.get('/session/:id', async (req, res) => {
    try {
        const session = await ChatSession.findById(req.params.id);
        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        const messages = await ChatMessage.find({ sessionId: req.params.id })
            .sort({ timestamp: 1 });

        res.json({
            success: true,
            data: {
                session,
                messages
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/chat/session/create - Create new chat session (from user)
router.post('/session/create', async (req, res) => {
    try {
        const { visitorId, userName, userLocation, ip, userAgent, language } = req.body;
        const visitorToken = getVisitorToken(req, res);

        // Check if there's an existing active session for this visitor
        let session = await ChatSession.findOne({
            visitorToken,
            status: 'active'
        });

        if (!session) {
            session = new ChatSession({
                visitorToken,
                visitorId,
                userName: (userName || '익명').substring(0, 50),
                userLocation: (userLocation || '').substring(0, 100),
                ip,
                userAgent,
                language: resolveLanguage(language)
            });
            await session.save();
        }

        if (!session.language && language) {
            session.language = resolveLanguage(language);
            await session.save();
        }

        res.json({
            success: true,
            data: session
        });

        broadcastToAdmins({ type: 'new_session', session });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/chat/message/send - Send a message
router.post('/message/send', createRateLimiter('20-M'), async (req, res) => {
    try {
        const { sessionId, sender, text, language } = req.body;

        if (!sessionId || !sender || (!text && !req.body.imageUrl)) {
            return res.status(400).json({
                success: false,
                error: 'sessionId, sender, and text (or imageUrl) are required'
            });
        }

        if (text && text.length > 5000) {
            return res.status(400).json({
                success: false,
                error: 'Message text too long (max 5000 characters)'
            });
        }

        // Verify session exists
        const session = await ChatSession.findById(sessionId);
        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        if (!session.language && language) {
            session.language = resolveLanguage(language);
            await session.save();
        }

        // Create message
        const messageData = { sessionId, sender };
        if (text) messageData.text = text;
        if (req.body.imageUrl) messageData.imageUrl = req.body.imageUrl;
        const message = new ChatMessage(messageData);
        await message.save();

        // Update session
        const lastMsgPreview = text ? text.substring(0, 100) : '[Image]';
        const updateData = {
            lastMessage: lastMsgPreview,
            lastMessageTime: new Date(),
            updatedAt: new Date()
        };

        // Increment unread count if message is from user
        let updatedSession = null;
        if (sender === 'user') {
            updateData.$inc = { unreadCount: 1 };
            updatedSession = await ChatSession.findByIdAndUpdate(sessionId, {
                ...updateData,
                $inc: { unreadCount: 1 }
            }, { new: true });
        } else {
            updatedSession = await ChatSession.findByIdAndUpdate(sessionId, updateData, { new: true });

            // Debounced admin reply linking: collect consecutive messages, link after 5s idle
            if (text) {
                const sid = sessionId.toString();
                const pending = adminReplyTimers.get(sid);
                if (pending) {
                    clearTimeout(pending.timer);
                    pending.texts.push(text);
                    pending.lastMessageId = message._id;
                } else {
                    adminReplyTimers.set(sid, { texts: [text], lastMessageId: message._id });
                }
                const entry = adminReplyTimers.get(sid);
                entry.timer = setTimeout(async () => {
                    adminReplyTimers.delete(sid);
                    const combined = entry.texts.join('\n');
                    try {
                        const unlinked = await AiSuggestion.findOne({
                            sessionId: sid, adminReplyId: null
                        }).sort({ createdAt: -1 });
                        if (unlinked) {
                            unlinked.adminReplyId = entry.lastMessageId;
                            unlinked.adminReply = combined;
                            unlinked.similarity = calculateSimilarity(unlinked.suggestion, combined);
                            unlinked.linkedAt = new Date();
                            await unlinked.save();
                            enqueueEvaluation(unlinked._id);
                        }
                    } catch (linkErr) {
                        console.error('[AI Quality] link error:', linkErr.message);
                    }
                }, ADMIN_REPLY_DEBOUNCE_MS);
            }
        }

        res.json({
            success: true,
            data: message
        });

        broadcastToAdmins({ type: 'new_message', sessionId, message });
        if (updatedSession) {
            broadcastToAdmins({ type: 'session_update', session: updatedSession });
        }

        // AI 建议由 aiSuggestWatcher (Change Stream) 统一生成，此处不再重复触发
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/chat/messages/:sessionId - Get messages for a session
router.get('/messages/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const since = req.query.since; // timestamp for polling

        const query = { sessionId };
        if (since) {
            query.timestamp = { $gt: new Date(since) };
        }

        const messages = await ChatMessage.find(query)
            .sort({ timestamp: 1 });

        res.json({
            success: true,
            data: messages
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT /api/chat/session/:id/read - Mark session as read (admin)
router.put('/session/:id/read', async (req, res) => {
    try {
        const session = await ChatSession.findByIdAndUpdate(
            req.params.id,
            { unreadCount: 0, updatedAt: new Date() },
            { new: true }
        );

        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        res.json({
            success: true,
            data: session
        });

        if (session) {
            broadcastToAdmins({ type: 'session_update', session });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT /api/chat/session/:id/close - Close a session
router.put('/session/:id/close', async (req, res) => {
    try {
        const session = await ChatSession.findByIdAndUpdate(
            req.params.id,
            { status: 'closed', updatedAt: new Date() },
            { new: true }
        );

        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        res.json({
            success: true,
            data: session,
            message: 'Session closed'
        });

        if (session) {
            broadcastToAdmins({ type: 'session_update', session });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/chat/unread-count - Get total unread count (for badge)
router.get('/unread-count', async (req, res) => {
    try {
        const result = await ChatSession.aggregate([
            { $match: { status: 'active', unreadCount: { $gt: 0 } } },
            { $group: { _id: null, total: { $sum: "$unreadCount" }, sessions: { $sum: 1 } } }
        ]);

        res.json({
            success: true,
            data: {
                totalUnread: result.length > 0 ? result[0].total : 0,
                sessionsWithUnread: result.length > 0 ? result[0].sessions : 0
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/chat/message/:id - Delete a single message
router.delete('/message/:id', async (req, res) => {
    try {
        const message = await ChatMessage.findById(req.params.id);
        if (!message) {
            return res.status(404).json({ success: false, error: 'Message not found' });
        }
        const sessionId = message.sessionId;
        await ChatMessage.findByIdAndDelete(req.params.id);

        // Update session's lastMessage to the most recent remaining message
        const lastMsg = await ChatMessage.findOne({ sessionId }).sort({ timestamp: -1 });
        if (lastMsg) {
            await ChatSession.findByIdAndUpdate(sessionId, {
                lastMessage: lastMsg.text,
                lastMessageTime: lastMsg.timestamp,
            });
        } else {
            await ChatSession.findByIdAndUpdate(sessionId, {
                lastMessage: '',
                lastMessageTime: null,
            });
        }

        // Broadcast deletion to admins
        broadcastToAdmins({
            type: 'message_deleted',
            messageId: req.params.id,
            sessionId: sessionId.toString(),
        });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/chat/session/:id/ai-suggestion - Get latest AI suggestion for a session
router.get('/session/:id/ai-suggestion', async (req, res) => {
    try {
        const suggestion = await AiSuggestion.findOne({
            sessionId: req.params.id,
            dismissed: { $ne: true },
        }).sort({ _id: -1 }).lean();

        res.json({ success: true, data: suggestion || null });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/chat/ai-suggestion/:id/dismiss - Dismiss an AI suggestion
router.post('/ai-suggestion/:id/dismiss', async (req, res) => {
    try {
        const result = await AiSuggestion.updateOne(
            { _id: req.params.id },
            { $set: { dismissed: true, dismissedAt: new Date() } }
        );
        if (result.matchedCount === 0) {
            return res.status(404).json({ success: false, error: 'Suggestion not found' });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/chat/ai-suggestion/:id/feedback - Admin explicit feedback
router.post('/ai-suggestion/:id/feedback', async (req, res) => {
    try {
        const { feedback } = req.body;
        if (feedback !== 'positive' && feedback !== 'negative') {
            return res.status(400).json({ success: false, error: 'feedback must be positive or negative' });
        }
        const result = await AiSuggestion.updateOne(
            { _id: req.params.id },
            { $set: { adminFeedback: feedback } }
        );
        if (result.matchedCount === 0) {
            return res.status(404).json({ success: false, error: 'Suggestion not found' });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/chat/upload - Upload an image
router.post('/upload', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No image file provided' });
        }
        // Return path relative to server root — accessible via /gameapi/uploads/... (user side)
        // or /uploads/... (direct server access)
        const imageUrl = `/uploads/chat/${req.file.filename}`;
        res.json({ success: true, data: { imageUrl } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Multer error handling
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ success: false, error: 'File too large (max 5MB)' });
        }
        return res.status(400).json({ success: false, error: err.message });
    }
    next(err);
});

module.exports = router;
