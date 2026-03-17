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

  // Track tool call IDs so function responses can reference them
  // Map: functionName → last tool_call_id
  const toolCallIdMap = {}

  for (const content of contents || []) {
    const role = content.role === 'model' ? 'assistant' : 'user'
    const parts = content.parts || []

    // Check for function calls (tool use)
    const funcCalls = parts.filter(p => p.functionCall)
    const funcResponses = parts.filter(p => p.functionResponse)
    const textParts = parts.filter(p => p.text !== undefined)

    if (funcCalls.length > 0) {
      // Assistant with tool calls
      const toolCalls = funcCalls.map((fc, i) => {
        const id = `call_${fc.functionCall.name}_${i}`
        toolCallIdMap[fc.functionCall.name] = id
        return {
          id,
          type: 'function',
          function: {
            name: fc.functionCall.name,
            arguments: JSON.stringify(fc.functionCall.args || {}),
          },
        }
      })
      messages.push({
        role: 'assistant',
        content: textParts.map(p => p.text).join('') || null,
        tool_calls: toolCalls,
      })
    } else if (funcResponses.length > 0) {
      // Tool responses — match to previous tool call IDs
      for (const fr of funcResponses) {
        const name = fr.functionResponse.name || ''
        const id = toolCallIdMap[name] || `call_${name}_0`
        messages.push({
          role: 'tool',
          tool_call_id: id,
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

// ── MCP 工具定义 (注入到每个请求) ──────────────────────────
const MCP_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'mcp_chat_stats',
      description: '查询聊天统计数据。返回指定天数内的会话数、消息数、发送者分布、高峰时段等。',
      parameters: { type: 'object', properties: { days: { type: 'integer', description: '查询天数 (默认 7)', default: 7 } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_chat_logs_query',
      description: '查询最近的聊天消息记录。可按关键词过滤。',
      parameters: { type: 'object', properties: { days: { type: 'integer', default: 7 }, limit: { type: 'integer', default: 50 }, keyword: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_kb_list',
      description: '列出知识库条目。',
      parameters: { type: 'object', properties: { language: { type: 'string', default: 'ko' }, active_only: { type: 'boolean', default: true } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_kb_add',
      description: '向知识库添加新条目。',
      parameters: { type: 'object', properties: { title: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } }, content: { type: 'string' }, language: { type: 'string', default: 'ko' } }, required: ['title', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_qna_list',
      description: '列出 Q&A 对。',
      parameters: { type: 'object', properties: { language: { type: 'string', default: 'ko' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_ai_quality_report',
      description: '生成 AI 建议质量分析报告。包含采纳率、相似度评分、品质分类统计。',
      parameters: { type: 'object', properties: { days: { type: 'integer', default: 7 } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_frequent_questions',
      description: '分析高频问题，找出知识库未覆盖的常见客户提问。',
      parameters: { type: 'object', properties: { days: { type: 'integer', default: 7 }, limit: { type: 'integer', default: 20 } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_kb_search',
      description: '搜索客服知识库（语义检索）。',
      parameters: { type: 'object', properties: { query: { type: 'string' }, n_results: { type: 'integer', default: 5 } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_kb_teach',
      description: '教客服系统新知识 (Q&A)。',
      parameters: { type: 'object', properties: { question: { type: 'string' }, answer: { type: 'string' } }, required: ['question', 'answer'] },
    },
  },
]

const MCP_TOOL_NAMES = new Set(MCP_TOOLS.map(t => t.function.name))

/** Execute MCP tool by calling Python MCP server */
function executeMcpTool(toolName, args) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process')
    const mcpName = toolName.replace('mcp_', '')

    // Determine which MCP server to call
    const kbTools = ['kb_search', 'kb_teach', 'kb_correct', 'kb_add_document', 'kb_stats', 'kb_delete_source', 'kb_import_file']
    const isKbTool = kbTools.includes(mcpName)
    const script = isKbTool ? 'mcp/kb_server.py' : 'mcp/mongo_server.py'
    const cwd = process.env.HOME ? process.env.HOME + '/ai-customer-service' : '/home/dbc/ai-customer-service'

    // Send JSON-RPC request to MCP server via stdin
    const rpcRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: mcpName, arguments: args || {} },
    }) + '\n'

    // First initialize, then call
    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {},
    }) + '\n'

    const input = initRequest + rpcRequest

    const child = execFile('python3', [script], {
      cwd,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve(JSON.stringify({ error: err.message }))
        return
      }
      // Parse last JSON line (tool result)
      const lines = stdout.trim().split('\n').filter(l => l.startsWith('{'))
      if (lines.length >= 2) {
        try {
          const result = JSON.parse(lines[lines.length - 1])
          const content = result.result?.content?.[0]?.text || JSON.stringify(result.result || result)
          resolve(content)
        } catch {
          resolve(stdout)
        }
      } else {
        resolve(stdout || 'No result')
      }
    })
    child.stdin.write(input)
    child.stdin.end()
  })
}

/** Gemini tools[] → OpenAI tools[] (+ inject MCP tools) */
function convertTools(tools) {
  const result = [...MCP_TOOLS] // Always include MCP tools

  if (tools) {
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

// Accumulator for streaming tool calls (they arrive in fragments)
const streamToolCalls = new Map() // requestId → { index → {name, args} }

/** OpenAI streaming chunk → Gemini SSE chunk */
function convertStreamChunk(chunk, requestId) {
  const choice = chunk.choices?.[0]
  if (!choice) return null

  const delta = choice.delta || {}
  const parts = []

  if (delta.content) {
    parts.push({ text: delta.content })
  }

  // Accumulate tool call fragments
  if (delta.tool_calls) {
    if (!streamToolCalls.has(requestId)) {
      streamToolCalls.set(requestId, {})
    }
    const acc = streamToolCalls.get(requestId)

    for (const tc of delta.tool_calls) {
      const idx = tc.index || 0
      if (!acc[idx]) acc[idx] = { name: '', args: '' }
      if (tc.function?.name) acc[idx].name = tc.function.name
      if (tc.function?.arguments) acc[idx].args += tc.function.arguments
    }
  }

  // On finish_reason=tool_calls, emit all accumulated tool calls
  if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
    const acc = streamToolCalls.get(requestId)
    if (acc) {
      for (const idx of Object.keys(acc)) {
        const tc = acc[idx]
        if (tc.name) {
          let args = {}
          try { args = JSON.parse(tc.args || '{}') } catch { args = {} }
          parts.push({
            functionCall: {
              name: tc.name,
              args,
            },
          })
        }
      }
      streamToolCalls.delete(requestId)
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

  // Debug: log tools and contents summary
  if (geminiBody.tools) {
    const toolNames = []
    for (const t of geminiBody.tools) {
      if (t.functionDeclarations) {
        for (const fd of t.functionDeclarations) toolNames.push(fd.name)
      }
    }
    console.log(`[Proxy] Tools: ${toolNames.join(', ')}`)
  }
  if (geminiBody.contents) {
    for (const c of geminiBody.contents) {
      const parts = c.parts || []
      for (const p of parts) {
        if (p.functionCall) console.log(`[Proxy] FunctionCall: ${p.functionCall.name}(${JSON.stringify(p.functionCall.args).substring(0, 100)})`)
        if (p.functionResponse) console.log(`[Proxy] FunctionResponse: ${p.functionResponse.name} -> ${JSON.stringify(p.functionResponse.response).substring(0, 100)}`)
      }
    }
  }

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
    let messages = convertContents(
      geminiBody.contents,
      config.systemInstruction || geminiBody.systemInstruction
    )
    const tools = convertTools(geminiBody.tools)
    const maxTokens = config.maxOutputTokens || 4096
    const temperature = config.temperature ?? 0.3

    // ── MCP Tool Call Loop ──
    // Keep calling Claude until it stops requesting MCP tools
    let maxLoops = 5
    while (maxLoops-- > 0) {
      const openaiBody = {
        model: DEFAULT_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false, // Always non-streaming for tool loop
      }
      if (tools) openaiBody.tools = tools

      const loopResp = await forwardToZenMux('/chat/completions', openaiBody, false)
      let loopBody = ''
      for await (const chunk of loopResp) loopBody += chunk
      const loopData = JSON.parse(loopBody)

      if (loopResp.statusCode !== 200) {
        // API error — break and return
        const geminiResp = { candidates: [{ content: { role: 'model', parts: [{ text: loopData.error?.message || 'API error' }] }, finishReason: 'STOP' }] }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(geminiResp))
        return
      }

      const choice = loopData.choices?.[0]
      if (!choice) break

      // Check if Claude wants to call MCP tools
      const toolCalls = choice.message?.tool_calls || []
      const mcpCalls = toolCalls.filter(tc => MCP_TOOL_NAMES.has(tc.function?.name))

      if (mcpCalls.length === 0) {
        // No MCP tool calls — this is the final response
        // If streaming was requested, convert and stream; otherwise return directly
        if (isStreaming) {
          // Convert non-streaming response to SSE format
          const geminiResp = convertResponse(loopData)
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
          res.write(`data: ${JSON.stringify(geminiResp)}\n\n`)
          res.end()
        } else {
          const geminiResp = convertResponse(loopData)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(geminiResp))
        }
        return
      }

      // Execute MCP tool calls
      console.log(`[Proxy] Executing ${mcpCalls.length} MCP tool call(s): ${mcpCalls.map(tc => tc.function.name).join(', ')}`)

      // Add assistant message with tool calls to conversation
      messages.push({
        role: 'assistant',
        content: choice.message.content || null,
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      })

      // Execute each tool call and add results
      for (const tc of toolCalls) {
        let result
        if (MCP_TOOL_NAMES.has(tc.function.name)) {
          const args = JSON.parse(tc.function.arguments || '{}')
          result = await executeMcpTool(tc.function.name, args)
          console.log(`[Proxy] MCP result (${tc.function.name}): ${result.substring(0, 200)}...`)
        } else {
          // Non-MCP tool — return error (Gemini CLI should handle these)
          result = JSON.stringify({ error: `Tool ${tc.function.name} is not an MCP tool` })
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        })
      }
      // Loop back to get Claude's response with tool results
    }

    // Fallback if loop exhausted
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Tool call loop exhausted' }] }, finishReason: 'STOP' }] }))
    return

    // (old streaming path removed — MCP tool loop handles all cases above)
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
