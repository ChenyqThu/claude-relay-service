/**
 * OpenAI Responses API ↔ Chat Completions 桥接（opencode 专用）
 *
 * opencode zen 的 /responses 端点只有少数模型支持，其余模型报
 * "not supported for format openai"。此时把 Responses 请求降级成
 * /chat/completions 请求发给上游，再把 chat 的响应还原成 Responses 格式，
 * 让 Codex 这类 Responses 客户端能用上全部模型。
 *
 * 事件形状对齐 opencode zen /responses 端点的真实输出。
 */

const crypto = require('crypto')

const newId = () => crypto.randomUUID()

class OpencodeResponsesBridge {
  // ==========================================================
  // 请求方向：Responses → Chat Completions
  // ==========================================================

  /**
   * @param {Object} responsesBody - Responses API 请求体
   * @returns {Object} Chat Completions 请求体
   */
  buildChatRequest(responsesBody = {}) {
    const chat = {
      model: responsesBody.model,
      messages: this._buildMessages(responsesBody)
    }

    if (responsesBody.stream !== undefined) {
      chat.stream = responsesBody.stream
      if (responsesBody.stream) {
        // 桥接后仍要拿到 usage，否则无法还原 response.completed 里的 token 统计
        chat.stream_options = { include_usage: true }
      }
    }
    if (responsesBody.max_output_tokens !== undefined) {
      chat.max_tokens = responsesBody.max_output_tokens
    }
    if (responsesBody.temperature !== undefined) {
      chat.temperature = responsesBody.temperature
    }
    if (responsesBody.top_p !== undefined) {
      chat.top_p = responsesBody.top_p
    }
    if (responsesBody.parallel_tool_calls !== undefined) {
      chat.parallel_tool_calls = responsesBody.parallel_tool_calls
    }
    if (responsesBody.reasoning?.effort) {
      chat.reasoning_effort = responsesBody.reasoning.effort
    }

    const tools = this._convertTools(responsesBody.tools)
    if (tools.length > 0) {
      chat.tools = tools
    }

    const toolChoice = this._convertToolChoice(responsesBody.tool_choice)
    if (toolChoice !== undefined) {
      chat.tool_choice = toolChoice
    }

    const responseFormat = this._convertTextFormat(responsesBody.text)
    if (responseFormat) {
      chat.response_format = responseFormat
    }

    return chat
  }

  _buildMessages(responsesBody) {
    const messages = []

    if (responsesBody.instructions) {
      messages.push({ role: 'system', content: String(responsesBody.instructions) })
    }

    const { input } = responsesBody
    if (typeof input === 'string') {
      messages.push({ role: 'user', content: input })
      return messages
    }
    if (!Array.isArray(input)) {
      return messages
    }

    for (const item of input) {
      if (!item || typeof item !== 'object') {
        continue
      }

      switch (item.type) {
        case 'function_call': {
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: item.call_id || item.id,
                type: 'function',
                function: {
                  name: item.name,
                  arguments:
                    typeof item.arguments === 'string'
                      ? item.arguments
                      : JSON.stringify(item.arguments ?? {})
                }
              }
            ]
          })
          break
        }

        case 'function_call_output': {
          messages.push({
            role: 'tool',
            tool_call_id: item.call_id,
            content:
              typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
          })
          break
        }

        // reasoning 项没有对应的 chat 消息，直接丢弃
        case 'reasoning':
          break

        case 'message':
        default: {
          const role = item.role === 'developer' ? 'system' : item.role || 'user'
          const content = this._flattenContent(item.content)
          if (content !== null) {
            messages.push({ role, content })
          }
          break
        }
      }
    }

    return messages
  }

  // Responses 的 content 数组 → chat 的 content（字符串或多模态数组）
  _flattenContent(content) {
    if (content === undefined || content === null) {
      return null
    }
    if (typeof content === 'string') {
      return content
    }
    if (!Array.isArray(content)) {
      return String(content)
    }

    const parts = []
    let hasImage = false

    for (const part of content) {
      if (!part || typeof part !== 'object') {
        continue
      }
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
        parts.push({ type: 'text', text: part.text || '' })
      } else if (part.type === 'input_image' && part.image_url) {
        hasImage = true
        parts.push({
          type: 'image_url',
          image_url: {
            url: typeof part.image_url === 'string' ? part.image_url : part.image_url.url
          }
        })
      }
    }

    if (parts.length === 0) {
      return null
    }
    if (!hasImage) {
      return parts.map((p) => p.text || '').join('')
    }
    return parts
  }

  _convertTools(tools) {
    if (!Array.isArray(tools)) {
      return []
    }

    const converted = []
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') {
        continue
      }
      // Responses 的 function tool 是扁平结构；内置工具（web_search 等）在
      // chat/completions 上没有对应实现，只能丢弃
      if (tool.type === 'function' && tool.name) {
        converted.push({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.parameters || { type: 'object', properties: {} }
          }
        })
      } else if (tool.type === 'function' && tool.function?.name) {
        converted.push(tool)
      }
    }
    return converted
  }

  _convertToolChoice(toolChoice) {
    if (toolChoice === undefined || toolChoice === null) {
      return undefined
    }
    if (typeof toolChoice === 'string') {
      return toolChoice
    }
    if (toolChoice.type === 'function' && toolChoice.name) {
      return { type: 'function', function: { name: toolChoice.name } }
    }
    return toolChoice
  }

  _convertTextFormat(text) {
    const format = text?.format
    if (!format || !format.type || format.type === 'text') {
      return null
    }
    if (format.type === 'json_schema') {
      return {
        type: 'json_schema',
        json_schema: {
          name: format.name || 'response',
          schema: format.schema,
          strict: format.strict
        }
      }
    }
    if (format.type === 'json_object') {
      return { type: 'json_object' }
    }
    return null
  }

  // ==========================================================
  // 响应方向：Chat Completions → Responses
  // ==========================================================

  createStreamState(model, requestBody = {}) {
    return {
      responseId: newId(),
      createdAt: Math.floor(Date.now() / 1000),
      model,
      requestBody,
      sequence: 0,
      startSent: false,
      outputIndex: -1,
      // 推理块
      reasoningItemId: null,
      reasoningText: '',
      // 文本块
      textItemId: null,
      textContent: '',
      // 工具调用：index -> {itemId, callId, name, args, outputIndex}
      toolCalls: new Map(),
      finishReason: null,
      usage: null,
      completed: false
    }
  }

  _event(state, type, payload) {
    const data = { type, sequence_number: state.sequence++, ...payload }
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  }

  /** 首个 chunk 到达时补发 response.created / response.in_progress */
  _start(state) {
    if (state.startSent) {
      return []
    }
    state.startSent = true

    const response = this._buildResponseObject(state, 'in_progress')
    return [
      this._event(state, 'response.created', { response }),
      this._event(state, 'response.in_progress', { response })
    ]
  }

  /**
   * 单个 chat.completion.chunk → Responses SSE 字符串数组
   * @param {Object} chunk - 已解析的 chat chunk
   * @param {Object} state - createStreamState() 的返回
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
      out.push(...this._handleReasoningDelta(state, delta.reasoning_content))
    }

    if (delta?.content) {
      out.push(...this._handleTextDelta(state, delta.content))
    }

    if (Array.isArray(delta?.tool_calls)) {
      for (const toolCall of delta.tool_calls) {
        out.push(...this._handleToolCallDelta(state, toolCall))
      }
    }

    if (choice.finish_reason) {
      state.finishReason = choice.finish_reason
    }

    return out
  }

  _handleReasoningDelta(state, text) {
    const out = []

    if (!state.reasoningItemId) {
      state.reasoningItemId = newId()
      state.outputIndex += 1
      state.reasoningOutputIndex = state.outputIndex
      out.push(
        this._event(state, 'response.output_item.added', {
          output_index: state.reasoningOutputIndex,
          item: {
            id: state.reasoningItemId,
            type: 'reasoning',
            status: 'in_progress',
            content: [],
            summary: []
          }
        })
      )
      out.push(
        this._event(state, 'response.content_part.added', {
          output_index: state.reasoningOutputIndex,
          content_index: 0,
          item_id: state.reasoningItemId,
          part: { type: 'reasoning_text', text: '' }
        })
      )
    }

    state.reasoningText += text
    out.push(
      this._event(state, 'response.reasoning_text.delta', {
        output_index: state.reasoningOutputIndex,
        content_index: 0,
        item_id: state.reasoningItemId,
        delta: text
      })
    )

    return out
  }

  _closeReasoning(state) {
    if (!state.reasoningItemId || state.reasoningClosed) {
      return []
    }
    state.reasoningClosed = true

    return [
      this._event(state, 'response.reasoning_text.done', {
        output_index: state.reasoningOutputIndex,
        content_index: 0,
        item_id: state.reasoningItemId,
        text: state.reasoningText
      }),
      this._event(state, 'response.content_part.done', {
        output_index: state.reasoningOutputIndex,
        content_index: 0,
        item_id: state.reasoningItemId,
        part: { type: 'reasoning_text', text: state.reasoningText }
      }),
      this._event(state, 'response.output_item.done', {
        output_index: state.reasoningOutputIndex,
        item: {
          id: state.reasoningItemId,
          type: 'reasoning',
          status: 'completed',
          content: [{ type: 'reasoning_text', text: state.reasoningText }],
          summary: []
        }
      })
    ]
  }

  _handleTextDelta(state, text) {
    const out = []

    if (!state.textItemId) {
      // 文本开始前先收掉推理块
      out.push(...this._closeReasoning(state))

      state.textItemId = newId()
      state.outputIndex += 1
      state.textOutputIndex = state.outputIndex
      out.push(
        this._event(state, 'response.output_item.added', {
          output_index: state.textOutputIndex,
          item: {
            id: state.textItemId,
            type: 'message',
            status: 'in_progress',
            role: 'assistant',
            content: []
          }
        })
      )
      out.push(
        this._event(state, 'response.content_part.added', {
          output_index: state.textOutputIndex,
          content_index: 0,
          item_id: state.textItemId,
          part: { type: 'output_text', text: '', annotations: [] }
        })
      )
    }

    state.textContent += text
    out.push(
      this._event(state, 'response.output_text.delta', {
        output_index: state.textOutputIndex,
        content_index: 0,
        item_id: state.textItemId,
        delta: text,
        logprobs: []
      })
    )

    return out
  }

  _closeText(state) {
    if (!state.textItemId || state.textClosed) {
      return []
    }
    state.textClosed = true

    const part = { type: 'output_text', text: state.textContent, annotations: [] }
    return [
      this._event(state, 'response.output_text.done', {
        output_index: state.textOutputIndex,
        content_index: 0,
        item_id: state.textItemId,
        text: state.textContent,
        logprobs: []
      }),
      this._event(state, 'response.content_part.done', {
        output_index: state.textOutputIndex,
        content_index: 0,
        item_id: state.textItemId,
        part
      }),
      this._event(state, 'response.output_item.done', {
        output_index: state.textOutputIndex,
        item: {
          id: state.textItemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [part]
        }
      })
    ]
  }

  _handleToolCallDelta(state, toolCall) {
    const out = []
    const index = toolCall.index ?? 0

    let entry = state.toolCalls.get(index)
    if (!entry) {
      // 工具调用开始前先收掉推理块和文本块
      out.push(...this._closeReasoning(state))
      out.push(...this._closeText(state))

      state.outputIndex += 1
      entry = {
        itemId: newId(),
        callId: toolCall.id || `call_${newId()}`,
        name: toolCall.function?.name || '',
        args: '',
        outputIndex: state.outputIndex
      }
      state.toolCalls.set(index, entry)

      out.push(
        this._event(state, 'response.output_item.added', {
          output_index: entry.outputIndex,
          item: {
            id: entry.itemId,
            type: 'function_call',
            status: 'in_progress',
            call_id: entry.callId,
            name: entry.name,
            arguments: ''
          }
        })
      )
    }

    // 后续分片可能补上 id / name
    if (toolCall.id && !entry.callId.startsWith('call_')) {
      entry.callId = toolCall.id
    }
    if (toolCall.function?.name) {
      entry.name = toolCall.function.name
    }

    const argsDelta = toolCall.function?.arguments
    if (argsDelta) {
      entry.args += argsDelta
      out.push(
        this._event(state, 'response.function_call_arguments.delta', {
          output_index: entry.outputIndex,
          item_id: entry.itemId,
          delta: argsDelta
        })
      )
    }

    return out
  }

  _closeToolCalls(state) {
    const out = []
    for (const entry of state.toolCalls.values()) {
      if (entry.closed) {
        continue
      }
      entry.closed = true
      out.push(
        this._event(state, 'response.function_call_arguments.done', {
          output_index: entry.outputIndex,
          item_id: entry.itemId,
          arguments: entry.args || '{}'
        })
      )
      out.push(
        this._event(state, 'response.output_item.done', {
          output_index: entry.outputIndex,
          item: {
            id: entry.itemId,
            type: 'function_call',
            status: 'completed',
            call_id: entry.callId,
            name: entry.name,
            arguments: entry.args || '{}'
          }
        })
      )
    }
    return out
  }

  /** 流结束时的收尾事件（含 response.completed） */
  finish(state) {
    if (state.completed) {
      return []
    }
    state.completed = true

    // 上游一个 chunk 都没发时补上开场事件，保证协议完整
    const out = [
      ...this._start(state),
      ...this._closeReasoning(state),
      ...this._closeText(state),
      ...this._closeToolCalls(state)
    ]

    const status = state.finishReason === 'length' ? 'incomplete' : 'completed'
    const response = this._buildResponseObject(state, status)

    out.push(this._event(state, 'response.completed', { response }))
    return out
  }

  _buildOutputItems(state) {
    const output = []

    if (state.reasoningItemId) {
      output.push({
        id: state.reasoningItemId,
        type: 'reasoning',
        status: 'completed',
        content: state.reasoningText ? [{ type: 'reasoning_text', text: state.reasoningText }] : [],
        summary: []
      })
    }

    if (state.textItemId) {
      output.push({
        id: state.textItemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: state.textContent, annotations: [] }]
      })
    }

    for (const entry of state.toolCalls.values()) {
      output.push({
        id: entry.itemId,
        type: 'function_call',
        status: 'completed',
        call_id: entry.callId,
        name: entry.name,
        arguments: entry.args || '{}'
      })
    }

    return output
  }

  _buildResponseObject(state, status) {
    const isTerminal = status !== 'in_progress'

    return {
      id: state.responseId,
      object: 'response',
      created_at: state.createdAt,
      completed_at: isTerminal ? Math.floor(Date.now() / 1000) : null,
      status,
      error: null,
      incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
      model: state.model,
      output: isTerminal ? this._buildOutputItems(state) : [],
      parallel_tool_calls: state.requestBody?.parallel_tool_calls ?? true,
      max_output_tokens: state.requestBody?.max_output_tokens ?? null,
      previous_response_id: null,
      instructions: state.requestBody?.instructions ?? null,
      temperature: state.requestBody?.temperature ?? 1,
      top_p: state.requestBody?.top_p ?? 1,
      tool_choice: state.requestBody?.tool_choice ?? 'auto',
      tools: state.requestBody?.tools ?? [],
      reasoning: state.requestBody?.reasoning ?? { effort: null, summary: null },
      text: state.requestBody?.text ?? { format: { type: 'text' } },
      usage: isTerminal ? this._mapUsage(state.usage) : null
    }
  }

  _mapUsage(usage) {
    if (!usage) {
      return null
    }
    return {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      input_tokens_details: {
        cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0
      },
      output_tokens_details: {
        reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0
      }
    }
  }

  /** 非流式：chat.completion → Responses 对象 */
  convertChatResponse(chatResponse, requestBody = {}) {
    const choice = chatResponse?.choices?.[0]
    const message = choice?.message || {}
    const state = this.createStreamState(chatResponse?.model, requestBody)

    state.responseId = chatResponse?.id || state.responseId
    state.createdAt = chatResponse?.created || state.createdAt
    state.usage = chatResponse?.usage || null
    state.finishReason = choice?.finish_reason || null

    if (message.reasoning_content) {
      state.reasoningItemId = newId()
      state.reasoningText = message.reasoning_content
    }
    if (message.content) {
      state.textItemId = newId()
      state.textContent = message.content
    }
    if (Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach((tc, index) => {
        state.toolCalls.set(index, {
          itemId: newId(),
          callId: tc.id,
          name: tc.function?.name || '',
          args:
            typeof tc.function?.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments ?? {})
        })
      })
    }

    const status = state.finishReason === 'length' ? 'incomplete' : 'completed'
    return this._buildResponseObject(state, status)
  }
}

module.exports = new OpencodeResponsesBridge()
