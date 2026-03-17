const express = require('express');
const router = express.Router();
const { Admin, SiteSettings, NotificationSettings } = require('../models/Settings');
const createRateLimiter = require('../middleware/rateLimit');

// =============================================
// 管理员认证
// =============================================

// POST /api/settings/admin/login — 管理员登录
router.post('/admin/login', createRateLimiter('10-M'), async (req, res) => {
    try {
        const username = req.body.username?.trim();
        const { password } = req.body;
        console.log(`[Login] Attempt for [${username}]`);

        let admin = await Admin.findOne({ username });

        // 首次启动: 默认管理员自动创建
        if (!admin && username === 'admin' && password === 'Game@2026supper') {
            admin = await Admin.create({
                username: 'admin',
                password: 'Game@2026supper',
                role: 'superadmin'
            });
        }

        if (!admin || admin.password !== password) {
            console.log(`[Login] Failed: admin_exists=${!!admin}`);
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        admin.lastLogin = new Date();
        await admin.save();

        res.json({
            success: true,
            data: {
                username: admin.username,
                role: admin.role,
                lastLogin: admin.lastLogin
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT /api/settings/admin/password — 修改密码
router.put('/admin/password', async (req, res) => {
    try {
        const { username, currentPassword, newPassword } = req.body;

        if (!newPassword || newPassword.length < 4) {
            return res.status(400).json({ success: false, error: 'New password must be at least 4 characters' });
        }

        const admin = await Admin.findOne({ username });
        if (!admin) {
            return res.status(404).json({ success: false, error: 'Admin not found' });
        }

        if (admin.password !== currentPassword) {
            return res.status(401).json({ success: false, error: 'Current password is incorrect' });
        }

        admin.password = newPassword;
        admin.updatedAt = new Date();
        await admin.save();

        res.json({ success: true, message: 'Password updated successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/settings/admin/list — 管理员列表
router.get('/admin/list', async (req, res) => {
    try {
        const admins = await Admin.find({}, { password: 0 }).sort({ createdAt: -1 });
        res.json({ success: true, data: admins });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/settings/admin/create — 创建管理员
router.post('/admin/create', async (req, res) => {
    try {
        const username = req.body.username?.trim();
        const { password, role } = req.body;

        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Username and password are required' });
        }

        const existing = await Admin.findOne({ username });
        if (existing) {
            return res.status(400).json({ success: false, error: 'Username already exists' });
        }

        const admin = await Admin.create({
            username,
            password,
            role: role || 'admin'
        });

        res.json({
            success: true,
            data: {
                username: admin.username,
                role: admin.role,
                createdAt: admin.createdAt
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/settings/admin/:username — 删除管理员
router.delete('/admin/:username', async (req, res) => {
    try {
        const { username } = req.params;

        const superadmins = await Admin.countDocuments({ role: 'superadmin' });
        const targetAdmin = await Admin.findOne({ username });

        if (targetAdmin?.role === 'superadmin' && superadmins <= 1) {
            return res.status(400).json({ success: false, error: 'Cannot delete the last superadmin' });
        }

        await Admin.deleteOne({ username });
        res.json({ success: true, message: 'Admin deleted successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// =============================================
// 站点配置
// =============================================

// GET /api/settings/site — 全部配置
router.get('/site', async (req, res) => {
    try {
        const settings = await SiteSettings.find({});
        const settingsMap = {};
        settings.forEach(s => { settingsMap[s.key] = s.value; });
        res.json({ success: true, data: settingsMap });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT /api/settings/site — 批量更新配置
router.put('/site', async (req, res) => {
    try {
        const { settings, updatedBy } = req.body;

        for (const [key, value] of Object.entries(settings)) {
            await SiteSettings.findOneAndUpdate(
                { key },
                { key, value, updatedAt: new Date(), updatedBy: updatedBy || 'admin' },
                { upsert: true }
            );
        }

        res.json({ success: true, message: 'Settings updated successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/settings/site/:key — 单个配置
router.get('/site/:key', async (req, res) => {
    try {
        const setting = await SiteSettings.findOne({ key: req.params.key });
        if (!setting) {
            return res.status(404).json({ success: false, error: 'Setting not found' });
        }
        res.json({ success: true, data: setting });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// =============================================
// 通知配置
// =============================================

router.get('/notifications', async (req, res) => {
    try {
        const notifications = await NotificationSettings.find({});
        res.json({ success: true, data: notifications });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put('/notifications/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const { enabled, config, events } = req.body;

        const notification = await NotificationSettings.findOneAndUpdate(
            { type },
            {
                type,
                enabled: enabled !== undefined ? enabled : false,
                config: config || {},
                events: events || [],
                updatedAt: new Date()
            },
            { upsert: true, new: true }
        );

        res.json({ success: true, data: notification });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/notifications/test', async (req, res) => {
    try {
        const { type } = req.body;
        const notification = await NotificationSettings.findOne({ type });
        if (!notification || !notification.enabled) {
            return res.status(400).json({ success: false, error: 'Notification not enabled' });
        }
        res.json({ success: true, message: `Test ${type} notification sent (simulated)` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// =============================================
// 系统信息
// =============================================

// GET /api/settings/system — 系统状态
router.get('/system', async (req, res) => {
    try {
        const { ChatSession } = require('../models/Chat');
        const { KnowledgeBase } = require('../models/KnowledgeBase');
        const { AiSuggestion } = require('../models/AiSuggestion');

        const [chatCount, kbCount, suggestionCount, adminCount] = await Promise.all([
            ChatSession.countDocuments({}),
            KnowledgeBase.countDocuments({}),
            AiSuggestion.countDocuments({}),
            Admin.countDocuments({})
        ]);

        res.json({
            success: true,
            data: {
                database: {
                    chatSessions: chatCount,
                    knowledgeBase: kbCount,
                    aiSuggestions: suggestionCount,
                    admins: adminCount
                },
                server: {
                    nodeVersion: process.version,
                    uptime: Math.floor(process.uptime()),
                    memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
                }
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
