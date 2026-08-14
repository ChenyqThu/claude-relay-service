/**
 * Anthropic Messages API ↔ Chat Completions 桥接（opencode 专用）
 *
 * opencode zen 的 /messages 端点只有部分模型的 SSE 合规（kimi/glm 等会返回
 * 无 data: 前缀的裸 JSON），此时把 Anthropic 请求降级成 /chat/completions，
 * 再把 chat 的响应还原成标准 Anthropic SSE，让 Claude Code 能用上全部模型。
 */

const crypto = require('crypto')

const newMessageId = () => `msg_${crypto.randomBytes(12).toString('hex')}`

// chat 的 finish_reason → Anthropic 的 stop_reason
const STOP_REASON_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'stop_sequence',
  function_call: 'tool_use'
}

class OpencodeAnthropicBridge {
  // ==========================================================
  // 请求方向：Anthropic → Chat Completions
  // ==========================================================

  buildChatRequest(anthropicBody = {}) {
    const chat = {
      model: anthropicBody.model,
      messages: this._buildMessages(anthropicBody)
    }

    if (anthropicBody.stream !== undefined) {
      chat.stream = anthropicBody.stream
      if (anthropicBody.stream) {
        // 桥接后仍要拿到 usage，否则 message_delta 里没有 output_tokens
        chat.stream_options = { include_usage: true }
      }
    }
    if (anthropicBody.max_tokens !== undefined) {
      chat.max_tokens = anthropicBody.max_tokens
    }
    if (anthropicBody.temperature !== undefined) {
      chat.temperature = anthropicBody.temperature
    }
    if (anthropicBody.top_p !== undefined) {
      chat.top_p = anthropicBody.top_p
    }
    if (Array.isArray(anthropicBody.stop_sequences) && anthropicBody.stop_sequences.length > 0) {
      chat.stop = anthropicBody.stop_sequences
    }

    const tools = this._convertTools(anthropicBody.tools)
    if (tools.length > 0) {
      chat.tools = tools
    }

    const toolChoice = this._convertToolChoice(anthropicBody.tool_choice)
    if (toolChoice !== undefined) {
      chat.tool_choice = toolChoice
    }

    return chat
  }

  _buildMessages(anthropicBody) {
    const messages = []

    const systemText = this._extractSystemText(anthropicBody.system)
    if (systemText) {
      messages.push({ role: 'system', content: systemText })
    }

    for (const msg of anthropicBody.messages || []) {
      if (!msg || typeof msg !== 'object') {
        continue
      }

      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content })
        continue
      }
      if (!Array.isArray(msg.content)) {
        continue
      }

      if (msg.role === 'assistant') {
        messages.push(...this._buildAssistantMessages(msg.content))
      } else {
        messages.push(...this._buildUserMessages(msg.content))
      }
    }

    return messages
  }

  _extractSystemText(system) {
    if (!system) {
      return ''
    }
    if (typeof system === 'string') {
      return system
    }
    if (Array.isArray(system)) {
      return system
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text || '')
        .join('\n\n')
    }
    return ''
  }

  _buildAssistantMessages(blocks) {
    const textParts = []
    const toolCalls = []

    for (const block of blocks) {
      if (!block || typeof block !== 'object') {
        continue
      }
      if (block.type === 'text') {
        textParts.push(block.text || '')
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {})
          }
        })
      }
      // thinking 块不回传上游（签名对其他厂商无意义）
    }

    const message = { role: 'assistant', content: textParts.join('') || null }
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls
    }
    if (message.content === null && toolCalls.length === 0) {
      return []
    }
    return [message]
  }

  _buildUserMessages(blocks) {
    const messages = []
    const contentParts = []
    let hasImage = false

    for (const block of blocks) {
      if (!block || typeof block !== 'object') {
        continue
      }

      if (block.type === 'text') {
        contentParts.push({ type: 'text', text: block.text || '' })
      } else if (block.type === 'image' && block.source) {
        hasImage = true
        const url =
          block.source.type === 'base64'
            ? `data:${block.source.media_type};base64,${block.source.data}`
            : block.source.url
        contentParts.push({ type: 'image_url', image_url: { url } })
      } else if (block.type === 'tool_result') {
        // tool_result 必须单独成一条 tool 消息
        messages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: this._stringifyToolResult(block.content)
        })
      }
    }

    if (contentParts.length > 0) {
      messages.push({
        role: 'user',
        content: hasImage ? contentParts : contentParts.map((p) => p.text || '').join('')
      })
    }

    return messages
  }

  _stringifyToolResult(content) {
    if (typeof content === 'string') {
      return content
    }
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (typeof block === 'string') {
            return block
          }
          if (block?.type === 'text') {
            return block.text || ''
          }
          return JSON.stringify(block)
        })
        .join('\n')
    }
    return JSON.stringify(content ?? '')
  }

  _convertTools(tools) {
    if (!Array.isArray(tools)) {
      return []
    }
    return tools
      .filter((tool) => tool && tool.name)
      .map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.input_schema || { type: 'object', properties: {} }
        }
      }))
  }

  _convertToolChoice(toolChoice) {
    if (!toolChoice || typeof toolChoice !== 'object') {
      return undefined
    }
    if (toolChoice.type === 'auto') {
      return 'auto'
    }
    if (toolChoice.type === 'any') {
      return 'required'
    }
    if (toolChoice.type === 'none') {
      return 'none'
    }
    if (toolChoice.type === 'tool' && toolChoice.name) {
      return { type: 'function', function: { name: toolChoice.name } }
    }
    return undefined
  }

  // ==========================================================
  // 响应方向：Chat Completions → Anthropic
  // ==========================================================

  createStreamState(model) {
    return {
      messageId: newMessageId(),
      model,
      startSent: false,
      blockIndex: -1,
      // 当前打开的块类型：'thinking' | 'text' | 'tool_use' | null
      openBlock: null,
      // 工具调用：chat 的 index -> 我们分配的块索引
      toolBlocks: new Map(),
      usage: null,
      finishReason: null,
      finished: false
    }
  }

  _event(type, payload) {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
  }

  /** message_start（首个 chunk 到达时发出，以便带上真实 input_tokens） */
  _start(state) {
    if (state.startSent) {
      return []
    }
    state.startSent = true

    return [
      this._event('message_start', {
        message: {
          id: state.messageId,
          type: 'message',
          role: 'assistant',
          model: state.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: state.usage?.prompt_tokens ?? 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens:
              state.usage?.prompt_tokens_details?.cached_tokens ?? state.usage?.cached_tokens ?? 0
          }
        }
      })
    ]
  }

  _closeOpenBlock(state) {
    if (state.openBlock === null) {
      return []
    }
    state.openBlock = null
    return [this._event('content_block_stop', { index: state.blockIndex })]
  }

  _openBlock(state, type, contentBlock) {
    const out = this._closeOpenBlock(state)
    state.blockIndex += 1
    state.openBlock = type
    out.push(
      this._event('content_block_start', {
        index: state.blockIndex,
        content_block: contentBlock
      })
    )
    return out
  }

  /**
   * 单个 chat.completion.chunk → Anthropic SSE 字符串数组
   */
  convertChatChunk(chunk, state) {
    const out = []

    if (chunk.usage) {
      state.usage = chunk.usage
    }

    const choice = chunk.choices?.[0]
    if (!choice) {
      return out
    }

    out.push(...this._start(state))

    const { delta } = choice

    if (delta?.reasoning_content) {
      if (state.openBlock !== 'thinking') {
        out.push(
          ...this._openBlock(state, 'thinking', { type: 'thinking', thinking: '', signature: '' })
        )
      }
      out.push(
        this._event('content_block_delta', {
          index: state.blockIndex,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_content }
        })
      )
    }

    if (delta?.content) {
      if (state.openBlock !== 'text') {
        out.push(...this._openBlock(state, 'text', { type: 'text', text: '' }))
      }
      out.push(
        this._event('content_block_delta', {
          index: state.blockIndex,
          delta: { type: 'text_delta', text: delta.content }
        })
      )
    }

    if (Array.isArray(delta?.tool_calls)) {
      for (const toolCall of delta.tool_calls) {
        const toolIndex = toolCall.index ?? 0

        if (!state.toolBlocks.has(toolIndex)) {
          out.push(
            ...this._openBlock(state, 'tool_use', {
              type: 'tool_use',
              id: toolCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`,
              name: toolCall.function?.name || '',
              input: {}
            })
          )
          state.toolBlocks.set(toolIndex, state.blockIndex)
        }

        const argsDelta = toolCall.function?.arguments
        if (argsDelta) {
          out.push(
            this._event('content_block_delta', {
              index: state.toolBlocks.get(toolIndex),
              delta: { type: 'input_json_delta', partial_json: argsDelta }
            })
          )
        }
      }
    }

    if (choice.finish_reason) {
      state.finishReason = choice.finish_reason
    }

    return out
  }

  /** 流结束时的收尾事件 */
  finish(state) {
    if (state.finished) {
      return []
    }
    state.finished = true

    // 上游可能一个 chunk 都没发（异常收尾），这里补一个 message_start 保证协议完整
    const out = this._start(state)
    out.push(...this._closeOpenBlock(state))

    out.push(
      this._event('message_delta', {
        delta: {
          stop_reason: STOP_REASON_MAP[state.finishReason] || 'end_turn',
          stop_sequence: null
        },
        usage: {
          output_tokens: state.usage?.completion_tokens ?? 0
        }
      })
    )
    out.push(this._event('message_stop', {}))

    return out
  }

  /** 非流式：chat.completion → Anthropic message 对象 */
  convertChatResponse(chatResponse) {
    const choice = chatResponse?.choices?.[0]
    const message = choice?.message || {}
    const content = []

    if (message.reasoning_content) {
      content.push({ type: 'thinking', thinking: message.reasoning_content, signature: '' })
    }
    if (message.content) {
      content.push({ type: 'text', text: message.content })
    }
    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        let input = {}
        try {
          input = JSON.parse(toolCall.function?.arguments || '{}')
        } catch {
          input = {}
        }
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function?.name || '',
          input
        })
      }
    }

    const usage = chatResponse?.usage || {}

    return {
      id: chatResponse?.id || newMessageId(),
      type: 'message',
      role: 'assistant',
      model: chatResponse?.model,
      content,
      stop_reason: STOP_REASON_MAP[choice?.finish_reason] || 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens:
          usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0
      }
    }
  }
}

module.exports = new OpencodeAnthropicBridge()
