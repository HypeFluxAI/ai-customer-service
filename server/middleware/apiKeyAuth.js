const crypto = require('crypto');

/**
 * API Key 认证中间件
 * 支持从 X-API-Key header 或 api_key query 参数获取
 */
function apiKeyAuth(req, res, next) {
    const apiKey = process.env.API_KEY;

    // 如果未配置 API_KEY，跳过认证
    if (!apiKey) {
        return next();
    }

    // 从 Header 获取 API Key
    let providedKey = req.headers['x-api-key'];

    // 也支持从 Query 参数获取（向后兼容）
    if (!providedKey) {
        providedKey = req.query.api_key;
    }

    if (!providedKey) {
        return res.status(401).json({
            error: 'Unauthorized',
            msg: '缺少 API Key'
        });
    }

    // 使用常量时间比较防止时序攻击
    const isValid = crypto.timingSafeEqual(
        Buffer.from(providedKey),
        Buffer.from(apiKey)
    );

    if (!isValid) {
        return res.status(401).json({
            error: 'Unauthorized',
            msg: '无效的 API Key'
        });
    }

    next();
}

module.exports = apiKeyAuth;
