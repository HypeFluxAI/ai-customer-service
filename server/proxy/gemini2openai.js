#!/usr/bin/env node
/**
 * Gemini → OpenAI API 代理服务器
 *
 * 将 Gemini API 格式的请求转换成 OpenAI 格式，发送到 ZenMux (Claude API)。
 * 这样 Gemini CLI 以为在和 Gemini API 通信，实际上用的是 Claude。
 *
 * 原理:
 *   Gemini CLI → http://localhost:3002 (Gemini 格式)
 *              → 本代理转换格式
 *              → https://zenmux.ai/api/v1 (OpenAI 格式)
 *              → Claude 回复
 *              → 本代理转换回 Gemini 格式
 *              → Gemini CLI 收到回复
 *
 * 使用:
 *   ZENMUX_API_KEY=xxx node server/proxy/gemini2openai.js
 *   然后设置: GOOGLE_GEMINI_BASE_URL=http://localhost:3002
 *
 * Gemini API 端点 (需要支持):
 *   POST /v1beta/models/{model}:generateContent
 *   POST /v1beta/models/{model}:streamGenerateContent?alt=sse
 *   POST /v1beta/models/{model}:countTokens
 */

const http = require('http')
const https = require('https')
const { URL } = require('url')

// ── 配置 ────────────────────────────────────────────────
const PORT = process.env.PROXY_PORT || 3002
const ZENMUX_BASE = process.env.ZENMUX_BASE_URL || 'https://zenmux.ai/api/v1'
const ZENMUX_KEY = process.env.ZENMUX_API_KEY || ''
const DEFAULT_MODEL = process.env.ZENMUX_CHAT_MODEL || 'anthropic/claude-sonnet-4.5'

if (!ZENMUX_KEY) {
  console.error('Error: ZENMUX_API_KEY is required')
  process.exit(1)
}

// ── Gemini → OpenAI 格式转换 ─────────────────────────────

/** Gemini Content[] → OpenAI messages[] */
function convertContents(contents, systemInstruction) {
  const messages = []

  // System instruction
  if (systemInstruction) {
    const sysText = typeof systemInstruction === 'string'
      ? systemInstruction
      : extractText(systemInstruction)
    if (sysText) messages.push({ role: 'system', content: sysText })
  }

  for (const content of contents || []) {
    const role = content.role === 'model' ? 'assistant' : 'user'
    const parts = content.parts || []

    // Check for function calls (tool use)
    const funcCalls = parts.filter(p => p.functionCall)
    const funcResponses = parts.filter(p => p.functionResponse)
    const textParts = parts.filter(p => p.text !== undefined)

    if (funcCalls.length > 0) {
      // Assistant with tool calls
      const msg = {
        role: 'assistant',
        content: textParts.map(p => p.text).join('') || null,
        tool_calls: funcCalls.map((fc, i) => ({
          id: `call_${i}_${Date.now()}`,
          type: 'function',
          function: {
            name: fc.functionCall.name,
            arguments: JSON.stringify(fc.functionCall.args || {}),
          },
        })),
      }
      messages.push(msg)
    } else if (funcResponses.length > 0) {
      // Tool responses
      for (const fr of funcResponses) {
        messages.push({
          role: 'tool',
          tool_call_id: `call_0_${Date.now()}`,
          content: JSON.stringify(fr.functionResponse.response || {}),
        })
      }
    } else {
      // Regular text message
      const text = textParts.map(p => p.text).join('')
      if (text) messages.push({ role, content: text })
    }
  }

  return messages
}

/** Gemini tools[] → OpenAI tools[] */
function convertTools(tools) {
  if (!tools || tools.length === 0) return undefined

  const result = []
  for (const tool of tools) {
    if (tool.functionDeclarations) {
      for (const fd of tool.functionDeclarations) {
        result.push({
          type: 'function',
          function: {
            name: fd.name,
            description: fd.description || '',
            parameters: fd.parameters || { type: 'object', properties: {} },
          },
        })
      }
    }
  }
  return result.length > 0 ? result : undefined
}

/** Extract text from Gemini Content object */
function extractText(content) {
  if (typeof content === 'string') return content
  if (content.parts) return content.parts.map(p => p.text || '').join('')
  if (content.text) return content.text
  return ''
}

// ── OpenAI → Gemini 格式转换 (响应) ─────────────────────

/** OpenAI completion → Gemini response */
function convertResponse(openaiResp) {
  const choice = openaiResp.choices?.[0]
  if (!choice) {
    return { candidates: [] }
  }

  const message = choice.message || {}
  const parts = []

  // Text content
  if (message.content) {
    parts.push({ text: message.content })
  }

  // Tool calls
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      parts.push({
        functionCall: {
          name: tc.function.name,
          args: JSON.parse(tc.function.arguments || '{}'),
        },
      })
    }
  }

  const finishReason = {
    stop: 'STOP',
    tool_calls: 'STOP',
    length: 'MAX_TOKENS',
    content_filter: 'SAFETY',
  }[choice.finish_reason] || 'STOP'

  const resp = {
    candidates: [{
      content: { role: 'model', parts },
      finishReason,
    }],
    modelVersion: openaiResp.model || DEFAULT_MODEL,
  }

  // Usage metadata
  if (openaiResp.usage) {
    resp.usageMetadata = {
      promptTokenCount: openaiResp.usage.prompt_tokens,
      candidatesTokenCount: openaiResp.usage.completion_tokens,
      totalTokenCount: openaiResp.usage.total_tokens,
    }
  }

  return resp
}

/** OpenAI streaming chunk → Gemini SSE chunk */
function convertStreamChunk(chunk) {
  const choice = chunk.choices?.[0]
  if (!choice) return null

  const delta = choice.delta || {}
  const parts = []

  if (delta.content) {
    parts.push({ text: delta.content })
  }

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc.function?.name) {
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
          },
        })
      }
    }
  }

  if (parts.length === 0) return null

  const finishReason = choice.finish_reason
    ? { stop: 'STOP', tool_calls: 'STOP', length: 'MAX_TOKENS' }[choice.finish_reason] || 'STOP'
    : undefined

  const resp = {
    candidates: [{
      content: { role: 'model', parts },
      ...(finishReason && { finishReason }),
    }],
  }

  if (chunk.usage) {
    resp.usageMetadata = {
      promptTokenCount: chunk.usage.prompt_tokens,
      candidatesTokenCount: chunk.usage.completion_tokens,
      totalTokenCount: chunk.usage.total_tokens,
    }
  }

  return resp
}

// ── HTTP 代理 ────────────────────────────────────────────

/** Forward request to ZenMux */
function forwardToZenMux(path, body, isStreaming) {
  return new Promise((resolve, reject) => {
    const url = new URL(ZENMUX_BASE + path)
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ZENMUX_KEY}`,
      },
    }

    const client = url.protocol === 'https:' ? https : http
    const req = client.request(options, (res) => resolve(res))
    req.on('error', reject)
    req.write(JSON.stringify(body))
    req.end()
  })
}

/** Parse Gemini request path */
function parseGeminiPath(pathname) {
  // /v1beta/models/{model}:generateContent
  // /v1beta/models/{model}:streamGenerateContent
  // /v1beta/models/{model}:countTokens
  const match = pathname.match(/\/v\d+\w*\/models\/([^:]+):(\w+)/)
  if (match) return { model: match[1], method: match[2] }
  return null
}

// ── 请求处理 ─────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-goog-api-key')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  // Read body
  let body = ''
  for await (const chunk of req) body += chunk

  const urlObj = new URL(req.url, `http://localhost:${PORT}`)
  const parsed = parseGeminiPath(urlObj.pathname)

  if (!parsed) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found: ' + req.url }))
    return
  }

  const isStreaming = parsed.method === 'streamGenerateContent'
  const geminiBody = JSON.parse(body || '{}')

  console.log(`[Proxy] ${parsed.method} model=${parsed.model} streaming=${isStreaming}`)

  try {
    if (parsed.method === 'countTokens') {
      // Simple token count estimation
      const text = JSON.stringify(geminiBody.contents || [])
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        totalTokens: Math.ceil(text.length / 4),
      }))
      return
    }

    // Convert Gemini request → OpenAI request
    const config = geminiBody.config || geminiBody.generationConfig || {}
    const openaiBody = {
      model: DEFAULT_MODEL,
      messages: convertContents(
        geminiBody.contents,
        config.systemInstruction || geminiBody.systemInstruction
      ),
      max_tokens: config.maxOutputTokens || 4096,
      temperature: config.temperature ?? 0.3,
      stream: isStreaming,
    }

    // Convert tools
    const tools = convertTools(geminiBody.tools)
    if (tools) openaiBody.tools = tools

    // Forward to ZenMux
    const upstream = await forwardToZenMux('/chat/completions', openaiBody, isStreaming)

    if (isStreaming) {
      // SSE streaming
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })

      let buffer = ''
      upstream.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
            try {
              const openaiChunk = JSON.parse(line.slice(6))
              const geminiChunk = convertStreamChunk(openaiChunk)
              if (geminiChunk) {
                res.write(`data: ${JSON.stringify(geminiChunk)}\n\n`)
              }
            } catch {
              // skip parse errors
            }
          }
        }
      })

      upstream.on('end', () => {
        // Gemini SDK doesn't expect [DONE], just close the stream
        res.end()
      })

      upstream.on('error', (err) => {
        console.error('[Proxy] Stream error:', err.message)
        res.end()
      })
    } else {
      // Non-streaming
      let respBody = ''
      for await (const chunk of upstream) respBody += chunk

      const openaiResp = JSON.parse(respBody)

      if (upstream.statusCode !== 200) {
        console.error('[Proxy] ZenMux error:', upstream.statusCode, respBody.substring(0, 200))
        res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: openaiResp.error?.message || 'API error' } }))
        return
      }

      const geminiResp = convertResponse(openaiResp)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(geminiResp))
    }
  } catch (err) {
    console.error('[Proxy] Error:', err.message)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: err.message } }))
  }
})

server.listen(PORT, () => {
  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log('  Gemini → OpenAI API Proxy')
  console.log('═══════════════════════════════════════════════')
  console.log(`  Listening:  http://localhost:${PORT}`)
  console.log(`  Upstream:   ${ZENMUX_BASE}`)
  console.log(`  Model:      ${DEFAULT_MODEL}`)
  console.log()
  console.log('  Set in Gemini CLI:')
  console.log(`    GOOGLE_GEMINI_BASE_URL=http://localhost:${PORT}`)
  console.log(`    GEMINI_API_KEY=dummy`)
  console.log('═══════════════════════════════════════════════')
  console.log()
})
