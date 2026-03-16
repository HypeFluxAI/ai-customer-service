const WebSocket = require('ws')
const { ChatSession, ChatMessage } = require('../models/Chat')
const { AiSuggestion, calculateSimilarity } = require('../models/AiSuggestion')

let wss = null

const safeSend = (client, payload) => {
  if (!client || client.readyState !== WebSocket.OPEN) return
  client.send(JSON.stringify(payload))
}

const broadcast = (payload, filterFn = null) => {
  if (!wss) return
  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return
    if (filterFn && !filterFn(client)) return
    safeSend(client, payload)
  })
}

const sendSessionsSnapshot = async (client) => {
  try {
    const sessions = await ChatSession.find({})
      .sort({ lastMessageTime: -1 })
      .limit(50)
    safeSend(client, { type: 'sessions', sessions })
  } catch (error) {
    safeSend(client, { type: 'error', message: 'Failed to load sessions' })
  }
}

const handleAdminMessage = async (socket, data) => {
  switch (data.type) {
    case 'auth': {
      // Optional token validation via CHAT_ADMIN_TOKEN env var (backward compatible)
      const adminToken = process.env.CHAT_ADMIN_TOKEN
      if (adminToken && data.token !== adminToken) {
        safeSend(socket, { type: 'error', message: 'Invalid auth token' })
        return
      }
      socket.isAuthed = true
      safeSend(socket, { type: 'auth_success' })
      await sendSessionsSnapshot(socket)
      break
    }
    case 'join_session':
      if (!socket.isAuthed) {
        safeSend(socket, { type: 'error', message: 'Not authenticated' })
        return
      }
      if (data.sessionId) {
        socket.subscriptions.add(data.sessionId)
      }
      break
    case 'typing':
      if (!socket.isAuthed) {
        safeSend(socket, { type: 'error', message: 'Not authenticated' })
        return
      }
      if (data.sessionId) {
        broadcast(
          { type: 'typing', sessionId: data.sessionId, isTyping: !!data.isTyping },
          (client) => client !== socket
        )
      }
      break
    case 'ping':
      safeSend(socket, { type: 'pong', timestamp: Date.now() })
      break
    case 'send_message': {
      if (!socket.isAuthed) {
        safeSend(socket, { type: 'error', message: 'Not authenticated' })
        return
      }
      const { sessionId, text, imageUrl, sender, tempId } = data
      if (!sessionId || (!text && !imageUrl)) {
        safeSend(socket, { type: 'error', message: 'sessionId and text (or imageUrl) are required' })
        return
      }
      const session = await ChatSession.findById(sessionId)
      if (!session) {
        safeSend(socket, { type: 'error', message: 'Session not found' })
        return
      }

      const msgData = { sessionId, sender: sender || 'admin' }
      if (text) msgData.text = text
      if (imageUrl) msgData.imageUrl = imageUrl
      const message = await ChatMessage.create(msgData)

      const lastMsgPreview = text ? text.substring(0, 100) : '[Image]'
      const updateData = {
        lastMessage: lastMsgPreview,
        lastMessageTime: new Date(),
        updatedAt: new Date(),
      }

      if ((sender || 'admin') === 'user') {
        updateData.$inc = { unreadCount: 1 }
      }

      const updatedSession = await ChatSession.findByIdAndUpdate(
        sessionId,
        updateData,
        { new: true }
      )

      // Link admin reply to most recent unlinked AI suggestion
      if ((sender || 'admin') === 'admin' && text) {
        try {
          const unlinked = await AiSuggestion.findOne({
            sessionId, adminReplyId: null
          }).sort({ createdAt: -1 })
          if (unlinked) {
            unlinked.adminReplyId = message._id
            unlinked.adminReply = text
            unlinked.similarity = calculateSimilarity(unlinked.suggestion, text)
            unlinked.linkedAt = new Date()
            await unlinked.save()
          }
        } catch (linkErr) {
          console.error('[AI Quality] WS link error:', linkErr.message)
        }
      }

      broadcast({ type: 'new_message', sessionId, message, tempId })
      if (updatedSession) {
        broadcast({ type: 'session_update', session: updatedSession })
      }
      if (tempId) {
        safeSend(socket, { type: 'message_sent', tempId, messageId: message._id })
      }
      break
    }
    default:
      safeSend(socket, { type: 'error', message: 'Unknown message type' })
      break
  }
}

const initChatWebSocket = (server) => {
  wss = new WebSocket.Server({ server, path: '/ws/chat' })

  wss.on('connection', (socket) => {
    socket.isAuthed = false
    socket.subscriptions = new Set()

    socket.on('message', async (raw) => {
      try {
        const data = JSON.parse(raw.toString())
        await handleAdminMessage(socket, data)
      } catch (error) {
        safeSend(socket, { type: 'error', message: 'Invalid message format' })
      }
    })

    socket.on('close', () => {
      socket.subscriptions.clear()
    })

    socket.on('error', () => {
      socket.subscriptions.clear()
    })
  })

  return wss
}

const broadcastToAdmins = (payload) => {
  broadcast(payload)
}

module.exports = {
  initChatWebSocket,
  broadcastToAdmins,
}
