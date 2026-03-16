const express = require('express')
const router = express.Router()
const { ChatSession, ChatMessage } = require('../models/Chat')
const { getKakaoBotResponse, formatKakaoResponse } = require('../services/kakaoBot')
const { broadcastToAdmins } = require('../realtime/chatRealtime')

const DEFAULT_QUICK_REPLIES = ['포인트 충전', '게임 접속 오류', '환불 문의']

// Health check
router.get('/webhook', (req, res) => {
  res.json({ status: 'ok', service: 'kakao-skill-server' })
})

// Kakao i Open Builder Skill Server webhook
router.post('/webhook', async (req, res) => {
  try {
    // Optional token verification
    const verifyToken = process.env.KAKAO_SKILL_VERIFY_TOKEN
    if (verifyToken) {
      const authHeader = req.headers['authorization']
      if (authHeader !== `Bearer ${verifyToken}`) {
        return res.status(401).json(formatKakaoResponse('인증에 실패했습니다.'))
      }
    }

    const { userRequest } = req.body || {}
    if (!userRequest) {
      return res.status(400).json(formatKakaoResponse('잘못된 요청입니다.'))
    }

    const utterance = (userRequest.utterance || '').trim()
    const kakaoUserId = userRequest.user?.id || 'unknown'

    if (!utterance) {
      return res.json(formatKakaoResponse('메시지를 입력해주세요~'))
    }

    // Find or create KakaoTalk session
    let session = await ChatSession.findOne({
      channel: 'kakao',
      kakaoUserId,
      status: 'active',
    })

    if (!session) {
      session = await ChatSession.create({
        channel: 'kakao',
        kakaoUserId,
        userName: `KakaoTalk ${kakaoUserId.substring(0, 8)}`,
        language: 'ko',
        status: 'active',
      })
    }

    // Save user message
    const userMsg = await ChatMessage.create({
      sessionId: session._id,
      sender: 'user',
      text: utterance,
    })

    // Update session metadata
    await ChatSession.findByIdAndUpdate(session._id, {
      lastMessage: utterance.substring(0, 100),
      lastMessageTime: new Date(),
      updatedAt: new Date(),
      $inc: { unreadCount: 1 },
    })

    // Broadcast user message to admin panel
    broadcastToAdmins({
      type: 'new_message',
      sessionId: session._id.toString(),
      message: userMsg,
    })

    // Generate bot response
    const { text: replyText, source } = await getKakaoBotResponse(
      session._id,
      utterance,
      session.language || 'ko'
    )

    // Save bot reply
    const botMsg = await ChatMessage.create({
      sessionId: session._id,
      sender: 'bot',
      text: replyText,
    })

    // Update session with bot reply
    const updatedSession = await ChatSession.findByIdAndUpdate(
      session._id,
      {
        lastMessage: replyText.substring(0, 100),
        lastMessageTime: new Date(),
        updatedAt: new Date(),
      },
      { new: true }
    )

    // Broadcast bot reply + session update to admin panel
    broadcastToAdmins({
      type: 'new_message',
      sessionId: session._id.toString(),
      message: botMsg,
    })
    if (updatedSession) {
      broadcastToAdmins({ type: 'session_update', session: updatedSession })
    }

    console.log(`[KakaoBot] user=${kakaoUserId.substring(0, 8)} source=${source} msg="${utterance.substring(0, 30)}"`)

    // Return Open Builder response
    const quickReplies = source === 'fallback' ? [] : DEFAULT_QUICK_REPLIES
    return res.json(formatKakaoResponse(replyText, quickReplies))
  } catch (err) {
    console.error('[KakaoBot] Webhook error:', err)
    return res.json(formatKakaoResponse('일시적인 오류가 발생했어요. 잠시 후 다시 시도해주세요!'))
  }
})

module.exports = router
