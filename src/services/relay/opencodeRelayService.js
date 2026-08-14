const https = require('https')
const axios = require('axios')
const ProxyHelper = require('../../utils/proxyHelper')
const opencodeScheduler = require('../scheduler/opencodeScheduler')
const opencodeAccountService = require('../account/opencodeAccountService')
const apiKeyService = require('../apiKeyService')
const opencodeResponsesBridge = require('../opencodeResponsesBridge')
const opencodeAnthropicBridge = require('../opencodeAnthropicBridge')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const config = require('../../../config/config')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const { createRequestDetailMeta } = require('../../utils/requestDetailHelper')

// 上游明确拒绝某个协议格式时的错误特征
const FORMAT_UNSUPPORTED_PATTERN = /not supported for format\s+(\w+)/i

/**
 * opencode zen API 转发服务
 *
 * 上游同一个 base URL 下挂三种协议格式，本服务全部直通：
 * - /responses        OpenAI Responses API（内置搜索等原生能力只在此端点可用）
 * - /messages         Anthropic Messages API
 * - /chat/completions OpenAI Chat Completions API（模型覆盖最广）
 */
class OpencodeRelayService {
  constructor() {
    this.endpoints = {
      responses: '/responses',
      messages: '/messages',
      chat: '/chat/completions'
    }

    this.defaultUserAgent = 'claude-relay-service/1.0.0'
  }

  _normalizeFormat(format) {
    const normalized = String(format || 'chat').toLowerCase()
    return Object.prototype.hasOwnProperty.call(this.endpoints, normalized) ? normalized : 'chat'
  }

  _isStreamRequested(requestBody) {
    return requestBody?.stream === true || requestBody?.stream === 'true'
  }

  // 🔑 按协议格式选择认证头：/messages 只认 x-api-key，其余只认 Bearer
  _buildHeaders(account, format, clientHeaders = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': account.userAgent || clientHeaders?.['user-agent'] || this.defaultUserAgent,
      Accept: 'text/event-stream, application/json'
    }

    if (format === 'messages') {
      headers['x-api-key'] = account.apiKey
      headers['anthropic-version'] = clientHeaders?.['anthropic-version'] || '2023-06-01'
      if (clientHeaders?.['anthropic-beta']) {
        headers['anthropic-beta'] = clientHeaders['anthropic-beta']
      }
    } else {
      headers['Authorization'] = `Bearer ${account.apiKey}`
    }

    return headers
  }

  // 🔄 应用账户的模型映射
  _applyModelMapping(requestBody, account) {
    const requestedModel = requestBody?.model
    if (!requestedModel) {
      return { body: requestBody, model: requestedModel }
    }

    const mappedModel = opencodeAccountService.getMappedModel(
      account.supportedModels,
      requestedModel
    )

    if (mappedModel === requestedModel) {
      return { body: requestBody, model: requestedModel }
    }

    logger.info(`🔄 Opencode 模型映射: ${requestedModel} -> ${mappedModel}`)
    return { body: { ...requestBody, model: mappedModel }, model: mappedModel }
  }

  // 🧭 上游拒绝该协议格式时写入负缓存，供后续请求判断是否需要回落
  async _detectFormatUnsupported(accountId, model, format, responseBody) {
    if (!responseBody || typeof responseBody !== 'string') {
      return false
    }

    const match = responseBody.match(FORMAT_UNSUPPORTED_PATTERN)
    if (!match) {
      return false
    }

    await opencodeAccountService.markFormatUnsupported(accountId, model, format)
    logger.warn(
      `🧭 Opencode 上游拒绝协议格式: model=${model}, format=${format}（已记入负缓存，后续请求将走回落）`
    )
    return true
  }

  async relayRequest(
    requestBody,
    apiKeyData,
    clientRequest,
    clientResponse,
    clientHeaders,
    options = {}
  ) {
    const { format = 'chat', sessionHash = null, skipUsageRecord = false } = options
    const normalizedFormat = this._normalizeFormat(format)
    const keyInfo = apiKeyData || {}
    let account = null

    try {
      logger.info(
        `📤 Processing Opencode request for key: ${keyInfo.name || keyInfo.id || 'unknown'}, format: ${normalizedFormat}${sessionHash ? `, session: ${sessionHash}` : ''}`
      )

      // 选不到账户属于配置问题（模型未在映射表内 / 账户全部不可调度），不是上游故障
      let schedulerFailure = null
      try {
        account = await opencodeScheduler.selectAccount(keyInfo, sessionHash, requestBody?.model)
      } catch (schedulerError) {
        schedulerFailure = schedulerError.message
      }

      if (!account) {
        const message = schedulerFailure || 'No available Opencode account'
        logger.warn(`⚠️ Opencode 账户调度失败: ${message}`)
        return {
          statusCode: 503,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: { type: 'no_available_account', message }
          })
        }
      }

      const { body: mappedBody, model } = this._applyModelMapping(requestBody, account)

      // 已知该模型不支持此协议格式：直接以桥接模式发起，省掉一次注定失败的上游往返
      const knownUnsupported =
        normalizedFormat !== 'chat' &&
        (await opencodeAccountService.isFormatUnsupported(account.id, model, normalizedFormat))

      if (knownUnsupported) {
        logger.info(
          `🧭 Opencode model ${model} 已知不支持 ${normalizedFormat} 格式，直接走 chat/completions 桥接`
        )
      }

      const sendOptions = {
        account,
        apiKeyData: keyInfo,
        clientRequest,
        clientResponse,
        clientHeaders,
        requestBody: mappedBody,
        model,
        format: normalizedFormat,
        skipUsageRecord
      }

      const result = await this._send({ ...sendOptions, useBridge: knownUnsupported })

      // 首次遇到「上游不支持该协议格式」：负缓存已写入，立即用桥接重试一次
      if (result?.fallbackRequired) {
        logger.info(`🔁 Opencode ${normalizedFormat} 请求回落到 chat/completions 桥接: ${model}`)
        return await this._send({ ...sendOptions, useBridge: true })
      }

      return result
    } catch (error) {
      if (error.message === 'Client disconnected') {
        logger.info('🔌 Opencode relay ended: Client disconnected')
      } else {
        logger.error(`❌ Opencode relay error: ${error.message}`, error)
      }

      const status = error?.response?.status
      const autoProtectionDisabled =
        account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'

      if (status >= 500 && account?.id && !autoProtectionDisabled) {
        await upstreamErrorHelper
          .markTempUnavailable(account.id, 'opencode', status)
          .catch(() => {})
      } else if (
        !status &&
        account?.id &&
        error.message !== 'Client disconnected' &&
        !autoProtectionDisabled
      ) {
        await upstreamErrorHelper.markTempUnavailable(account.id, 'opencode', 503).catch(() => {})
      }

      if (error.response) {
        return {
          statusCode: error.response.status,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            error.response.data || { error: 'upstream_error', message: error.message }
          )
        }
      }

      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: { type: 'upstream_error', message: error.message }
        })
      }
    }
  }

  /**
   * 🔬 判断上游流的开头是否符合目标协议
   *
   * opencode zen 上部分模型会返回 200 但流不合规：有的直接吐无 `data:` 前缀的
   * 裸 JSON，有的只发一个 response.completed 就结束。两者都要在写给客户端之前
   * 识别出来，改走桥接。
   *
   * @returns {'conforming'|'malformed'|'pending'}
   */
  _classifyStreamOpening(buffer, format) {
    const opener = format === 'messages' ? 'message_start' : 'response.created'

    // 跳过开头的空行与 `:` 注释行（部分模型先发 `: keep-alive`）
    let rest = buffer
    for (;;) {
      const newline = rest.indexOf('\n')
      const line = (newline === -1 ? rest : rest.slice(0, newline)).trim()
      if (line && line[0] !== ':') {
        break
      }
      if (newline === -1) {
        rest = ''
        break
      }
      rest = rest.slice(newline + 1)
    }

    if (!rest) {
      return buffer.length > 8192 ? 'malformed' : 'pending'
    }

    if (!rest.startsWith('event:') && !rest.startsWith('data:')) {
      return 'malformed'
    }

    if (rest.includes(opener)) {
      return 'conforming'
    }

    // 首个事件已完整送达却不是开场事件 → 不合规
    return rest.includes('\n\n') || buffer.length > 8192 ? 'malformed' : 'pending'
  }

  // 🌉 取协议桥接器（用于把 responses/messages 请求降级成 chat/completions）
  _getBridge(format) {
    if (format === 'responses') {
      return opencodeResponsesBridge
    }
    if (format === 'messages') {
      return opencodeAnthropicBridge
    }
    return null
  }

  // 📮 实际发起上游请求（useBridge 为 true 时转换成 chat/completions 收发）
  async _send({
    account,
    apiKeyData,
    clientRequest,
    clientResponse,
    clientHeaders,
    requestBody,
    model,
    format,
    skipUsageRecord,
    useBridge = false
  }) {
    const bridge = useBridge ? this._getBridge(format) : null
    const upstreamFormat = bridge ? 'chat' : format
    const upstreamBody = bridge ? bridge.buildChatRequest(requestBody) : requestBody

    const apiUrl = `${account.baseUrl}${this.endpoints[upstreamFormat]}`
    logger.info(
      `🌐 Forwarding to opencode zen: ${apiUrl}${bridge ? ` (bridged from ${format})` : ''}`
    )

    const proxyAgent = ProxyHelper.createProxyAgent(account.proxy)
    if (proxyAgent) {
      logger.info(`🌐 Using proxy: ${ProxyHelper.getProxyDescription(account.proxy)}`)
    }

    const headers = this._buildHeaders(account, upstreamFormat, clientHeaders)

    if (this._isStreamRequested(upstreamBody)) {
      return await this._handleStreamRequest({
        apiUrl,
        headers,
        body: upstreamBody,
        proxyAgent,
        clientRequest,
        clientResponse,
        account,
        apiKeyData,
        model,
        format,
        upstreamFormat,
        bridge,
        originalBody: requestBody,
        skipUsageRecord
      })
    }

    const response = await axios({
      method: 'POST',
      url: apiUrl,
      headers,
      data: upstreamBody,
      timeout: config.requestTimeout || 600000,
      responseType: 'json',
      validateStatus: () => true,
      ...(proxyAgent && {
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent,
        proxy: false
      })
    })

    return await this._handleNonStreamResponse({
      response,
      account,
      apiKeyData,
      clientRequest,
      requestBody: upstreamBody,
      model,
      format,
      upstreamFormat,
      bridge,
      originalBody: requestBody,
      skipUsageRecord
    })
  }

  // 📦 非流式响应处理
  async _handleNonStreamResponse({
    response,
    account,
    apiKeyData,
    clientRequest,
    requestBody,
    model,
    format,
    upstreamFormat = format,
    bridge = null,
    originalBody = null,
    skipUsageRecord
  }) {
    const statusCode = response.status
    const rawBody =
      typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? {})

    if (statusCode >= 400) {
      // 桥接模式下已经是 chat 请求了，再报格式不支持就不是协议问题，不再回落
      if (!bridge) {
        const isFormatIssue = await this._detectFormatUnsupported(
          account.id,
          model,
          format,
          rawBody
        )

        if (isFormatIssue && format !== 'chat') {
          return { fallbackRequired: true, format, model, accountId: account.id }
        }
      }

      await this._handleUpstreamError(statusCode, account)

      return {
        statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: rawBody
      }
    }

    if (!skipUsageRecord) {
      const usage = this._extractUsageFromJson(response.data, upstreamFormat)
      await this._recordUsage(
        apiKeyData,
        account,
        model,
        usage,
        createRequestDetailMeta(clientRequest, {
          requestBody,
          stream: false,
          statusCode
        })
      )
    }

    // 桥接模式：把 chat 响应还原成客户端请求的协议格式
    const body = bridge
      ? JSON.stringify(bridge.convertChatResponse(response.data, originalBody || {}))
      : rawBody

    return {
      statusCode,
      headers: { 'Content-Type': 'application/json' },
      body
    }
  }

  // 🌊 流式响应处理（原生 https，便于精确控制转发与断开）
  async _handleStreamRequest({
    apiUrl,
    headers,
    body,
    proxyAgent,
    clientRequest,
    clientResponse,
    account,
    apiKeyData,
    model,
    format,
    upstreamFormat = format,
    bridge = null,
    originalBody = null,
    skipUsageRecord
  }) {
    return new Promise((resolve, reject) => {
      const url = new URL(apiUrl)
      const bodyString = JSON.stringify(body)
      const requestHeaders = {
        ...headers,
        'content-length': Buffer.byteLength(bodyString).toString()
      }

      let responseStarted = false
      let responseCompleted = false
      let settled = false
      let hasForwardedData = false

      const resolveOnce = (value) => {
        if (settled) {
          return
        }
        settled = true
        resolve(value)
      }

      const rejectOnce = (error) => {
        if (settled) {
          return
        }
        settled = true
        reject(error)
      }

      const handleStreamError = (error) => {
        // 结果已落定（例如合规探测失败后主动断开），后续错误不再处理
        if (settled) {
          return
        }

        if (!responseStarted) {
          rejectOnce(error)
          return
        }

        const isConnectionReset =
          error && (error.code === 'ECONNRESET' || error.message === 'aborted')

        // 上游有些模型不发 [DONE]/message_stop，直接以连接结束收尾，属正常情况
        if (isConnectionReset && (responseCompleted || hasForwardedData)) {
          logger.debug('🔁 Opencode stream 在响应阶段被重置，视为正常结束')
          if (!clientResponse.destroyed && !clientResponse.writableEnded) {
            clientResponse.end()
          }
          resolveOnce({ statusCode: 200, streaming: true })
          return
        }

        logger.error('❌ Opencode stream error:', error)
        if (!clientResponse.destroyed && !clientResponse.writableEnded) {
          const payload = JSON.stringify({
            error: { type: 'upstream_error', message: error.message }
          })
          if (hasForwardedData) {
            clientResponse.write(`event: error\ndata: ${payload}\n\n`)
          } else if (typeof clientResponse.setHeader === 'function') {
            clientResponse.setHeader('Content-Type', 'application/json')
            clientResponse.write(payload)
          }
          clientResponse.end()
        }

        resolveOnce({ statusCode: 502, streaming: true, error })
      }

      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search || ''}`,
          method: 'POST',
          headers: requestHeaders,
          agent: proxyAgent,
          timeout: config.requestTimeout || 600000
        },
        (res) => {
          logger.info(`✅ Opencode stream response status: ${res.statusCode}`)

          if (res.statusCode !== 200) {
            const chunks = []
            res.on('data', (chunk) => chunks.push(chunk))
            res.on('end', async () => {
              const errorBody = Buffer.concat(chunks).toString()
              logger.error(`❌ Opencode error response body: ${errorBody || '(empty)'}`)

              // 桥接模式下已经是 chat 请求，不再触发回落
              if (!bridge) {
                const isFormatIssue = await this._detectFormatUnsupported(
                  account.id,
                  model,
                  format,
                  errorBody
                )

                if (isFormatIssue && format !== 'chat' && !clientResponse.headersSent) {
                  resolveOnce({ fallbackRequired: true, format, model, accountId: account.id })
                  return
                }
              }

              await this._handleUpstreamError(res.statusCode, account)

              if (!clientResponse.headersSent) {
                clientResponse.status(res.statusCode).json({
                  error: 'upstream_error',
                  details: errorBody
                })
              }
              resolveOnce({ statusCode: res.statusCode, streaming: true })
            })
            res.on('error', handleStreamError)
            return
          }

          responseStarted = true

          clientResponse.setHeader('Content-Type', 'text/event-stream')
          clientResponse.setHeader('Cache-Control', 'no-cache')
          clientResponse.setHeader('Connection', 'keep-alive')
          clientResponse.setHeader('X-Accel-Buffering', 'no')

          let buffer = ''
          const usageData = {}

          // 桥接模式：逐条解析上游 chat SSE，转成客户端请求的协议格式再写出
          const bridgeState = bridge ? bridge.createStreamState(model, originalBody || {}) : null
          let sseBuffer = ''

          const writeBridged = (chunkStr) => {
            sseBuffer += chunkStr
            const segments = sseBuffer.split('\n\n')
            sseBuffer = segments.pop() || ''

            for (const segment of segments) {
              for (const line of segment.split('\n')) {
                if (!line.startsWith('data:')) {
                  continue
                }
                const payload = line.slice(5).trim()
                if (!payload || payload === '[DONE]') {
                  continue
                }

                let parsed
                try {
                  parsed = JSON.parse(payload)
                } catch {
                  continue
                }

                for (const event of bridge.convertChatChunk(parsed, bridgeState)) {
                  clientResponse.write(event)
                  hasForwardedData = true
                }
              }
            }
          }

          // 直通模式下先探测上游流是否协议合规：部分模型会返回 200 + 畸形流
          // （裸 JSON、或只发 response.completed），此时切到桥接重来
          const needsProbe = !bridge && format !== 'chat'
          let probeSettled = !needsProbe
          let probeFailed = false
          let probeBuffer = ''

          const flushProbeBuffer = () => {
            if (probeBuffer) {
              clientResponse.write(probeBuffer)
              hasForwardedData = true
              probeBuffer = ''
            }
          }

          const failProbe = async () => {
            await opencodeAccountService.markFormatUnsupported(account.id, model, format)
            logger.warn(
              `🧭 Opencode 上游返回了不合规的 ${format} 流: model=${model}（已记入负缓存，回落到桥接）`
            )
            // 先落定结果再断开上游，避免 destroy 触发的 error 事件误写客户端
            resolveOnce({ fallbackRequired: true, format, model, accountId: account.id })
            req.destroy()
          }

          res.on('data', (chunk) => {
            if (probeFailed) {
              return
            }

            const chunkStr = chunk.toString()

            if (!probeSettled) {
              probeBuffer += chunkStr
              const verdict = this._classifyStreamOpening(probeBuffer, format)

              if (verdict === 'pending') {
                return
              }

              probeSettled = true
              if (verdict === 'malformed') {
                probeFailed = true
                failProbe()
                return
              }
              flushProbeBuffer()
            } else if (bridge) {
              writeBridged(chunkStr)
            } else {
              hasForwardedData = true
              clientResponse.write(chunk)
            }

            // 用量始终按上游实际协议解析
            if (upstreamFormat === 'messages') {
              this._parseAnthropicUsage(chunkStr, buffer, usageData)
            } else {
              this._parseOpenAIUsage(chunkStr, buffer, usageData)
            }

            buffer = (buffer + chunkStr).slice(-8192)
          })

          res.on('end', async () => {
            if (probeFailed) {
              return
            }
            responseCompleted = true

            // 流太短，探测还没定论：按已收到的内容判定
            if (!probeSettled) {
              probeSettled = true
              if (this._classifyStreamOpening(probeBuffer, format) === 'malformed') {
                probeFailed = true
                await failProbe()
                return
              }
              flushProbeBuffer()
            }

            if (bridge && !clientResponse.writableEnded) {
              for (const event of bridge.finish(bridgeState)) {
                clientResponse.write(event)
              }
              // Responses 协议以 [DONE] 收尾，Anthropic 协议以 message_stop 收尾
              if (format === 'responses') {
                clientResponse.write('data: [DONE]\n\n')
              }
            }

            if (!clientResponse.writableEnded) {
              clientResponse.end()
            }

            if (!skipUsageRecord) {
              await this._recordUsage(
                apiKeyData,
                account,
                model,
                usageData,
                createRequestDetailMeta(clientRequest, {
                  requestBody: body,
                  stream: true,
                  statusCode: 200
                })
              )
            }

            logger.success(`Opencode stream completed - Account: ${account.name}`)
            resolveOnce({ statusCode: 200, streaming: true })
          })

          res.on('error', handleStreamError)

          res.on('close', () => {
            if (settled) {
              return
            }
            if (responseCompleted) {
              if (!clientResponse.destroyed && !clientResponse.writableEnded) {
                clientResponse.end()
              }
              resolveOnce({ statusCode: 200, streaming: true })
            } else {
              handleStreamError(new Error('Upstream stream closed unexpectedly'))
            }
          })
        }
      )

      clientResponse.on('close', () => {
        if (req && !req.destroyed) {
          req.destroy(new Error('Client disconnected'))
        }
      })

      req.on('error', handleStreamError)

      req.on('timeout', () => {
        req.destroy()
        handleStreamError(new Error('Request timeout'))
      })

      req.end(bodyString)
    })
  }

  // 📊 从 Anthropic SSE 中解析 usage
  _parseAnthropicUsage(chunkStr, buffer, usageData) {
    try {
      const lines = (buffer + chunkStr).split('\n')

      for (const line of lines) {
        if (!line.startsWith('data: ') || line.length <= 6) {
          continue
        }
        try {
          const data = JSON.parse(line.slice(6))

          if (data.type === 'message_start' && data.message?.usage) {
            usageData.input_tokens = data.message.usage.input_tokens || 0
            usageData.cache_creation_input_tokens =
              data.message.usage.cache_creation_input_tokens || 0
            usageData.cache_read_input_tokens = data.message.usage.cache_read_input_tokens || 0
          }

          if (data.type === 'message_delta' && data.usage) {
            usageData.output_tokens = data.usage.output_tokens || 0
          }
        } catch {
          // 忽略解析错误（分片行）
        }
      }
    } catch (error) {
      logger.debug('Error parsing Opencode Anthropic usage:', error)
    }
  }

  // 📊 从 OpenAI（chat/completions 与 responses 共用）SSE 中解析 usage
  _parseOpenAIUsage(chunkStr, buffer, usageData) {
    try {
      const lines = (buffer + chunkStr).split('\n')

      for (const line of lines) {
        if (!line.startsWith('data: ') || line.length <= 6) {
          continue
        }
        const jsonStr = line.slice(6).trim()
        if (jsonStr === '[DONE]') {
          continue
        }

        try {
          const data = JSON.parse(jsonStr)
          const usage = data.usage || data.response?.usage
          if (!usage) {
            continue
          }

          usageData.input_tokens = usage.prompt_tokens ?? usage.input_tokens ?? 0
          usageData.output_tokens = usage.completion_tokens ?? usage.output_tokens ?? 0
          usageData.total_tokens = usage.total_tokens ?? 0
          usageData.cache_read_input_tokens =
            usage.prompt_tokens_details?.cached_tokens ??
            usage.input_tokens_details?.cached_tokens ??
            usage.cached_tokens ??
            0
        } catch {
          // 忽略解析错误（分片行）
        }
      }
    } catch (error) {
      logger.debug('Error parsing Opencode OpenAI usage:', error)
    }
  }

  // 📊 从非流式响应体中提取 usage
  _extractUsageFromJson(data, format) {
    if (!data || typeof data !== 'object') {
      return {}
    }

    if (format === 'messages') {
      const usage = data.usage || {}
      return {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0
      }
    }

    const usage = data.usage || {}
    return {
      input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      cache_read_input_tokens:
        usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0
    }
  }

  // 🧮 标准化 usage 字段
  _normalizeUsage(usageData = {}) {
    const toNumber = (value) => {
      const num = Number(value)
      return Number.isFinite(num) && num > 0 ? num : 0
    }

    const inputTokens = toNumber(usageData.input_tokens)
    const totalTokens = toNumber(usageData.total_tokens)
    let outputTokens = toNumber(usageData.output_tokens)

    if (outputTokens === 0 && totalTokens > inputTokens) {
      outputTokens = totalTokens - inputTokens
    }

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: toNumber(usageData.cache_creation_input_tokens),
      cache_read_input_tokens: toNumber(usageData.cache_read_input_tokens)
    }
  }

  // 📈 记录用量
  // 注意：opencode 是包月套餐，上游返回的 cost 恒为 0，单次请求没有 token 边际成本。
  // 统计时把模型记为 opencode/<model>（与 opencode 官方模型命名一致），
  // CostCalculator 据此走零价路径，避免落到 unknown 的 $3/$15 兜底价。
  async _recordUsage(apiKeyData, account, model, rawUsage, requestMeta = null) {
    const statsModel = model ? `opencode/${model}` : 'opencode/unknown'
    const usage = this._normalizeUsage(rawUsage)
    const totalTokens =
      usage.input_tokens +
      usage.output_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens

    if (totalTokens <= 0) {
      logger.debug('🪙 Opencode usage 数据为空，跳过记录')
      return
    }

    try {
      const keyId = apiKeyData?.id
      const accountId = account?.id

      if (keyId) {
        await apiKeyService.recordUsageWithDetails(
          keyId,
          usage,
          statsModel,
          accountId,
          'opencode',
          requestMeta
        )
      } else if (accountId) {
        await redis.incrementAccountUsage(
          accountId,
          totalTokens,
          usage.input_tokens,
          usage.output_tokens,
          usage.cache_creation_input_tokens,
          usage.cache_read_input_tokens,
          0,
          0,
          statsModel,
          false
        )
      }

      logger.debug(
        `📊 Opencode usage recorded - Model: ${statsModel}, Input: ${usage.input_tokens}, Output: ${usage.output_tokens}, CacheRead: ${usage.cache_read_input_tokens}`
      )
    } catch (error) {
      logger.error('❌ Failed to record Opencode usage:', error)
    }
  }

  // 🚨 上游异常处理（限流 / 鉴权 / 服务端错误）
  async _handleUpstreamError(statusCode, account) {
    if (!account?.id) {
      return
    }

    const autoProtectionDisabled =
      account.disableAutoProtection === true || account.disableAutoProtection === 'true'

    try {
      if (statusCode === 429) {
        await opencodeAccountService.markAccountRateLimited(account.id)
      } else if (statusCode === 401 || statusCode === 403) {
        await opencodeAccountService.markAccountUnauthorized(account.id)
      } else if (statusCode >= 500 && !autoProtectionDisabled) {
        await upstreamErrorHelper
          .markTempUnavailable(account.id, 'opencode', statusCode)
          .catch(() => {})
      }
    } catch (error) {
      logger.error(`❌ 处理 Opencode 上游 ${statusCode} 异常失败:`, error)
    }
  }

  // 📋 拉取上游模型列表（该端点无需鉴权）
  async fetchModels(account) {
    const proxyAgent = ProxyHelper.createProxyAgent(account.proxy)
    const response = await axios({
      method: 'GET',
      url: `${account.baseUrl}/models`,
      headers: {
        'User-Agent': account.userAgent || this.defaultUserAgent,
        Authorization: `Bearer ${account.apiKey}`
      },
      timeout: 30000,
      validateStatus: () => true,
      ...(proxyAgent && {
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent,
        proxy: false
      })
    })

    return { statusCode: response.status, data: response.data }
  }
}

module.exports = new OpencodeRelayService()
