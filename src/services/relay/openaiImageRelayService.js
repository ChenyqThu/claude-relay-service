const axios = require('axios')
const fs = require('fs/promises')
const formidable = require('formidable')
const config = require('../../../config/config')
const logger = require('../../utils/logger')
const ProxyHelper = require('../../utils/proxyHelper')
const { filterForOpenAI } = require('../../utils/headerFilter')
const { IncrementalSSEParser } = require('../../utils/sseParser')
const {
  createRequestDetailMeta,
  extractOpenAICacheReadTokens
} = require('../../utils/requestDetailHelper')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const { updateRateLimitCounters } = require('../../utils/rateLimitHelper')
const apiKeyService = require('../apiKeyService')
const openaiAccountService = require('../account/openaiAccountService')
const openaiResponsesAccountService = require('../account/openaiResponsesAccountService')
const unifiedOpenAIScheduler = require('../scheduler/unifiedOpenAIScheduler')

const DEFAULT_IMAGES_MAIN_MODEL = 'gpt-5.4-mini'
const DEFAULT_IMAGES_TOOL_MODEL = 'gpt-image-2'
const DEFAULT_RESPONSE_FORMAT = 'b64_json'
const CODEX_IMAGES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const MAX_IMAGE_FORM_BYTES = 100 * 1024 * 1024

class ImageRequestError extends Error {
  constructor(statusCode, message, type = 'invalid_request_error') {
    super(message)
    this.statusCode = statusCode
    this.type = type
  }
}

function normalizeHeaders(headers = {}) {
  const normalized = {}
  Object.entries(headers || {}).forEach(([key, value]) => {
    if (key) {
      normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value
    }
  })
  return normalized
}

function toNumberSafe(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function extractCodexUsageHeaders(headers) {
  const normalized = normalizeHeaders(headers)
  const snapshot = {
    primaryUsedPercent: toNumberSafe(normalized['x-codex-primary-used-percent']),
    primaryResetAfterSeconds: toNumberSafe(normalized['x-codex-primary-reset-after-seconds']),
    primaryWindowMinutes: toNumberSafe(normalized['x-codex-primary-window-minutes']),
    secondaryUsedPercent: toNumberSafe(normalized['x-codex-secondary-used-percent']),
    secondaryResetAfterSeconds: toNumberSafe(normalized['x-codex-secondary-reset-after-seconds']),
    secondaryWindowMinutes: toNumberSafe(normalized['x-codex-secondary-window-minutes']),
    primaryOverSecondaryPercent: toNumberSafe(
      normalized['x-codex-primary-over-secondary-limit-percent']
    )
  }
  return Object.values(snapshot).some((value) => value !== null) ? snapshot : null
}

function firstValue(value) {
  if (Array.isArray(value)) {
    return value[0]
  }
  return value
}

function toTrimmedString(value) {
  const first = firstValue(value)
  if (first === undefined || first === null) {
    return ''
  }
  return String(first).trim()
}

function parseBoolean(value, fallback = false) {
  const first = firstValue(value)
  if (typeof first === 'boolean') {
    return first
  }
  if (first === undefined || first === null || first === '') {
    return fallback
  }
  const normalized = String(first).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }
  return fallback
}

function parseInteger(value) {
  const first = firstValue(value)
  if (first === undefined || first === null || first === '') {
    return null
  }
  const num = Number(first)
  return Number.isFinite(num) ? Math.trunc(num) : null
}

function normalizeResponseFormat(value) {
  const format = toTrimmedString(value).toLowerCase()
  return format || DEFAULT_RESPONSE_FORMAT
}

function isMultipartRequest(req) {
  const contentType = req.headers?.['content-type'] || ''
  return contentType.toLowerCase().startsWith('multipart/form-data')
}

function isJsonRequest(req) {
  const contentType = req.headers?.['content-type'] || ''
  return !contentType || contentType.toLowerCase().startsWith('application/json')
}

function normalizeFileList(value) {
  if (!value) {
    return []
  }
  return Array.isArray(value) ? value.filter(Boolean) : [value]
}

async function multipartFileToDataURL(file) {
  if (!file) {
    throw new ImageRequestError(400, 'Invalid request: upload file is required')
  }

  const filePath = file.filepath || file.path
  if (!filePath) {
    throw new ImageRequestError(400, 'Invalid request: upload file path is missing')
  }

  const data = await fs.readFile(filePath)
  const mediaType = file.mimetype || file.type || 'application/octet-stream'
  return `data:${mediaType};base64,${data.toString('base64')}`
}

function getImageURL(value) {
  if (typeof value === 'string') {
    return value.trim()
  }
  if (!value || typeof value !== 'object') {
    return ''
  }
  if (typeof value.image_url === 'string') {
    return value.image_url.trim()
  }
  if (typeof value.image_url?.url === 'string') {
    return value.image_url.url.trim()
  }
  if (typeof value.url === 'string') {
    return value.url.trim()
  }
  return ''
}

function extractImageURLsFromJSON(body = {}) {
  const images = []
  const pushImage = (value) => {
    const url = getImageURL(value)
    if (url) {
      images.push(url)
    }
  }

  if (Array.isArray(body.images)) {
    body.images.forEach(pushImage)
  }
  if (Array.isArray(body.image)) {
    body.image.forEach(pushImage)
  } else {
    pushImage(body.image)
  }

  return images
}

function buildImageTool(action, source = {}, maskImageURL = null) {
  const tool = {
    type: 'image_generation',
    action,
    model: toTrimmedString(source.model) || DEFAULT_IMAGES_TOOL_MODEL
  }

  const stringFields = [
    'size',
    'quality',
    'background',
    'output_format',
    'input_fidelity',
    'moderation'
  ]

  stringFields.forEach((field) => {
    const value = toTrimmedString(source[field])
    if (value) {
      tool[field] = value
    }
  })
  ;['output_compression', 'partial_images'].forEach((field) => {
    const value = parseInteger(source[field])
    if (value !== null) {
      tool[field] = value
    }
  })

  if (maskImageURL) {
    tool.input_image_mask = {
      image_url: maskImageURL
    }
  }

  return tool
}

function buildImagesResponsesRequest({ prompt, images = [], action, source = {}, maskImageURL }) {
  const content = [
    {
      type: 'input_text',
      text: prompt
    }
  ]

  images.forEach((imageURL) => {
    if (imageURL) {
      content.push({
        type: 'input_image',
        image_url: imageURL
      })
    }
  })

  return {
    instructions: '',
    stream: true,
    reasoning: {
      effort: 'medium',
      summary: 'auto'
    },
    parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'],
    model: DEFAULT_IMAGES_MAIN_MODEL,
    store: false,
    tool_choice: {
      type: 'image_generation'
    },
    input: [
      {
        type: 'message',
        role: 'user',
        content
      }
    ],
    tools: [buildImageTool(action, source, maskImageURL)]
  }
}

function mimeTypeFromOutputFormat(outputFormat) {
  const normalized = toTrimmedString(outputFormat).toLowerCase()
  if (!normalized) {
    return 'image/png'
  }
  if (normalized.includes('/')) {
    return normalized
  }
  if (normalized === 'jpg' || normalized === 'jpeg') {
    return 'image/jpeg'
  }
  if (normalized === 'webp') {
    return 'image/webp'
  }
  return 'image/png'
}

function extractImageResultsFromCompleted(eventData = {}) {
  if (eventData.type !== 'response.completed' || !eventData.response) {
    throw new Error('unexpected event type')
  }

  const { response } = eventData
  const results = []
  let firstMeta = null

  if (Array.isArray(response.output)) {
    response.output.forEach((item) => {
      if (item?.type !== 'image_generation_call' || !item.result) {
        return
      }

      const entry = {
        result: String(item.result).trim(),
        revisedPrompt: toTrimmedString(item.revised_prompt),
        outputFormat: toTrimmedString(item.output_format),
        size: toTrimmedString(item.size),
        background: toTrimmedString(item.background),
        quality: toTrimmedString(item.quality)
      }

      if (entry.result) {
        if (!firstMeta) {
          firstMeta = entry
        }
        results.push(entry)
      }
    })
  }

  return {
    results,
    createdAt: Number(response.created_at) || Math.floor(Date.now() / 1000),
    usage: response.tool_usage?.image_gen || response.usage || null,
    firstMeta: firstMeta || {}
  }
}

function buildImagesAPIResponse({ results, createdAt, usage, firstMeta, responseFormat }) {
  const normalizedFormat = normalizeResponseFormat(responseFormat)
  const body = {
    created: createdAt,
    data: []
  }

  results.forEach((image) => {
    const item = {}
    if (normalizedFormat === 'url') {
      const mimeType = mimeTypeFromOutputFormat(image.outputFormat)
      item.url = `data:${mimeType};base64,${image.result}`
    } else {
      item.b64_json = image.result
    }

    if (image.revisedPrompt) {
      item.revised_prompt = image.revisedPrompt
    }
    body.data.push(item)
  })

  if (firstMeta.background) {
    body.background = firstMeta.background
  }
  if (firstMeta.outputFormat) {
    body.output_format = firstMeta.outputFormat
  }
  if (firstMeta.quality) {
    body.quality = firstMeta.quality
  }
  if (firstMeta.size) {
    body.size = firstMeta.size
  }
  if (usage && typeof usage === 'object') {
    body.usage = usage
  }

  return body
}

function readStreamToString(stream) {
  return new Promise((resolve) => {
    const chunks = []
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function safeParseJSON(text) {
  if (!text || typeof text !== 'string') {
    return null
  }
  try {
    return JSON.parse(text)
  } catch (_) {
    return null
  }
}

function getRetryAfterSeconds(headers = {}, errorData = null) {
  const direct = toNumberSafe(errorData?.error?.resets_in_seconds)
  if (direct !== null) {
    return direct
  }

  const retryAfter = headers['retry-after'] || headers['Retry-After']
  const retryAfterNumber = toNumberSafe(retryAfter)
  return retryAfterNumber
}

function firstNumber(...values) {
  for (const value of values) {
    const num = toNumberSafe(value)
    if (num !== null) {
      return num
    }
  }
  return 0
}

function passThroughHeaders(res, headers = {}, options = {}) {
  const skipHeaders = new Set([
    'connection',
    'content-length',
    ...(options.skipHeaders || []),
    'keep-alive',
    'transfer-encoding',
    'upgrade',
    'proxy-authenticate',
    'proxy-authorization'
  ])

  Object.entries(headers || {}).forEach(([key, value]) => {
    if (!skipHeaders.has(key.toLowerCase()) && value !== undefined) {
      res.setHeader(key, value)
    }
  })
}

class OpenAIImageRelayService {
  constructor() {
    this.defaultTimeout = config.requestTimeout || 600000
  }

  async handleGeneration(req, res, context) {
    return this._handleCodexImageRequest(req, res, context, 'generate')
  }

  async handleEdit(req, res, context) {
    return this._handleCodexImageRequest(req, res, context, 'edit')
  }

  async passthroughOpenAIResponses(req, res, context) {
    const abortController = new AbortController()
    const handleDisconnect = () => {
      if (!abortController.signal.aborted) {
        abortController.abort()
      }
    }

    req.once('close', handleDisconnect)
    res.once('close', handleDisconnect)

    try {
      const fullAccount = await openaiResponsesAccountService.getAccount(context.account.id)
      if (!fullAccount) {
        throw new ImageRequestError(404, 'OpenAI-Responses account not found', 'not_found')
      }

      const baseApi = fullAccount.baseApi || ''
      let targetPath = req.path
      if (baseApi.endsWith('/v1') && targetPath.startsWith('/v1/')) {
        targetPath = targetPath.slice(3)
      }
      const targetUrl = `${baseApi}${targetPath}`

      const headers = {
        ...filterForOpenAI(req.headers),
        Authorization: `Bearer ${fullAccount.apiKey}`
      }

      if (req.headers['content-type']) {
        headers['Content-Type'] = req.headers['content-type']
      } else {
        headers['Content-Type'] = 'application/json'
      }

      if (fullAccount.userAgent) {
        headers['User-Agent'] = fullAccount.userAgent
      } else if (req.headers['user-agent']) {
        headers['User-Agent'] = req.headers['user-agent']
      }

      const multipart = isMultipartRequest(req)
      const shouldStreamResponse = multipart || parseBoolean(req.body?.stream, false)
      const requestOptions = {
        method: req.method,
        url: targetUrl,
        headers,
        data: multipart ? req : req.body,
        timeout: this.defaultTimeout,
        responseType: shouldStreamResponse ? 'stream' : 'json',
        validateStatus: () => true,
        signal: abortController.signal,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      }

      if (fullAccount.proxy) {
        const proxyAgent = ProxyHelper.createProxyAgent(fullAccount.proxy)
        if (proxyAgent) {
          requestOptions.httpAgent = proxyAgent
          requestOptions.httpsAgent = proxyAgent
          requestOptions.proxy = false
        }
      }

      logger.info('🎨 Forwarding OpenAI image request through OpenAI-Responses account', {
        accountId: fullAccount.id,
        targetUrl,
        stream: shouldStreamResponse
      })

      const response = await axios(requestOptions)

      if (shouldStreamResponse && response.data && typeof response.data.pipe === 'function') {
        res.status(response.status)
        passThroughHeaders(res, response.headers)
        response.data.pipe(res)
        return
      }

      if (response.status >= 400) {
        await this._handleOpenAIResponsesError(context, response)
        return res
          .status(response.status)
          .json(upstreamErrorHelper.sanitizeErrorForClient(response.data))
      }

      await this._recordUsage(req, context, {
        usage: response.data?.usage,
        requestBody: req.body,
        statusCode: response.status,
        stream: false,
        forceRequestRecord: true
      })

      res.status(response.status)
      passThroughHeaders(res, response.headers)
      return res.json(response.data)
    } catch (error) {
      if (res.headersSent) {
        return res.end()
      }
      const status = error.statusCode || error.response?.status || 500
      const message = error.message || 'Image request failed'
      logger.error('OpenAI-Responses image passthrough failed:', {
        status,
        message
      })
      return res.status(status).json({
        error: {
          message,
          type: error.type || 'api_error'
        }
      })
    } finally {
      req.removeListener('close', handleDisconnect)
      res.removeListener('close', handleDisconnect)
    }
  }

  async _handleOpenAIResponsesError(context, response) {
    const accountId = context.account?.id
    if (!accountId) {
      return
    }

    if (response.status === 401 || response.status >= 500) {
      const disabled =
        context.account?.disableAutoProtection === true ||
        context.account?.disableAutoProtection === 'true'
      if (!disabled) {
        await upstreamErrorHelper
          .markTempUnavailable(accountId, 'openai-responses', response.status)
          .catch(() => {})
      }
    }
  }

  async _handleCodexImageRequest(req, res, context, action) {
    let abortController = null
    let handleDisconnect = null
    const requestPayload = await this._prepareImagePayload(req, action)

    try {
      abortController = new AbortController()
      handleDisconnect = () => {
        if (!abortController.signal.aborted) {
          logger.info('🔌 Client disconnected, aborting Codex image request')
          abortController.abort()
        }
      }
      req.once('close', handleDisconnect)
      res.once('close', handleDisconnect)

      const headers = this._buildCodexHeaders(req, context, true)
      const axiosConfig = {
        headers,
        timeout: this.defaultTimeout,
        responseType: 'stream',
        validateStatus: () => true,
        signal: abortController.signal
      }

      const proxyAgent = ProxyHelper.createProxyAgent(context.proxy)
      if (proxyAgent) {
        axiosConfig.httpAgent = proxyAgent
        axiosConfig.httpsAgent = proxyAgent
        axiosConfig.proxy = false
      }

      const upstream = await axios.post(CODEX_IMAGES_ENDPOINT, requestPayload.responsesRequest, {
        ...axiosConfig
      })

      const codexUsageSnapshot = extractCodexUsageHeaders(upstream.headers)
      if (codexUsageSnapshot) {
        await openaiAccountService
          .updateCodexUsageSnapshot(context.accountId, codexUsageSnapshot)
          .catch((error) => logger.error('⚠️ 更新 Codex 图片使用统计失败:', error))
      }

      if (upstream.status < 200 || upstream.status >= 300) {
        return await this._handleCodexErrorResponse(req, res, context, upstream)
      }

      if (requestPayload.stream) {
        return await this._streamImagesFromResponses(req, res, context, upstream, requestPayload)
      }

      return await this._collectImagesFromResponses(req, res, context, upstream, requestPayload)
    } catch (error) {
      if (abortController && !abortController.signal.aborted) {
        abortController.abort()
      }

      if (res.headersSent) {
        return res.end()
      }

      const status = error.statusCode || error.response?.status || 500
      const message = error.message || 'Image request failed'
      logger.error('Codex image relay failed:', {
        status,
        message
      })

      return res.status(status).json({
        error: {
          message,
          type: error.type || 'api_error'
        }
      })
    } finally {
      if (handleDisconnect) {
        req.removeListener('close', handleDisconnect)
        res.removeListener('close', handleDisconnect)
      }
    }
  }

  _buildCodexHeaders(req, context, isStream) {
    const incoming = req.headers || {}
    const headers = {}

    ;['version', 'openai-beta', 'session_id'].forEach((key) => {
      if (incoming[key] !== undefined) {
        headers[key] = incoming[key]
      }
    })

    headers.authorization = `Bearer ${context.accessToken}`
    headers['chatgpt-account-id'] =
      context.account?.accountId || context.account?.chatgptUserId || context.accountId
    headers.host = 'chatgpt.com'
    headers.accept = isStream ? 'text/event-stream' : 'application/json'
    headers['content-type'] = 'application/json'

    return headers
  }

  async _prepareImagePayload(req, action) {
    if (action === 'generate') {
      if (!isJsonRequest(req)) {
        throw new ImageRequestError(400, 'Invalid request: generations require JSON body')
      }
      return this._prepareGenerationPayload(req.body || {})
    }

    if (isMultipartRequest(req)) {
      return await this._prepareEditPayloadFromMultipart(req)
    }

    if (isJsonRequest(req)) {
      return this._prepareEditPayloadFromJSON(req.body || {})
    }

    throw new ImageRequestError(400, 'Invalid request: unsupported Content-Type')
  }

  _prepareGenerationPayload(body) {
    const prompt = toTrimmedString(body.prompt)
    if (!prompt) {
      throw new ImageRequestError(400, 'Invalid request: prompt is required')
    }

    return {
      prompt,
      stream: parseBoolean(body.stream, false),
      responseFormat: normalizeResponseFormat(body.response_format),
      responsesRequest: buildImagesResponsesRequest({
        prompt,
        action: 'generate',
        source: body
      })
    }
  }

  _prepareEditPayloadFromJSON(body) {
    const prompt = toTrimmedString(body.prompt)
    if (!prompt) {
      throw new ImageRequestError(400, 'Invalid request: prompt is required')
    }

    const images = extractImageURLsFromJSON(body)
    if (images.length === 0) {
      throw new ImageRequestError(400, 'Invalid request: image or images[].image_url is required')
    }

    const maskImageURL = getImageURL(body.mask)

    return {
      prompt,
      stream: parseBoolean(body.stream, false),
      responseFormat: normalizeResponseFormat(body.response_format),
      responsesRequest: buildImagesResponsesRequest({
        prompt,
        images,
        action: 'edit',
        source: body,
        maskImageURL
      })
    }
  }

  async _prepareEditPayloadFromMultipart(req) {
    const { fields, files } = await this._parseMultipart(req)
    const source = this._flattenFields(fields)
    const prompt = toTrimmedString(source.prompt)
    if (!prompt) {
      throw new ImageRequestError(400, 'Invalid request: prompt is required')
    }

    const imageFiles = [...normalizeFileList(files.image), ...normalizeFileList(files['image[]'])]
    if (imageFiles.length === 0) {
      throw new ImageRequestError(400, 'Invalid request: image is required')
    }

    const images = []
    for (const file of imageFiles) {
      images.push(await multipartFileToDataURL(file))
    }

    let maskImageURL = null
    const maskFile = normalizeFileList(files.mask)[0]
    if (maskFile) {
      maskImageURL = await multipartFileToDataURL(maskFile)
    }

    return {
      prompt,
      stream: parseBoolean(source.stream, false),
      responseFormat: normalizeResponseFormat(source.response_format),
      responsesRequest: buildImagesResponsesRequest({
        prompt,
        images,
        action: 'edit',
        source,
        maskImageURL
      })
    }
  }

  _parseMultipart(req) {
    const form = formidable({
      multiples: true,
      maxFileSize: MAX_IMAGE_FORM_BYTES
    })

    return new Promise((resolve, reject) => {
      form.parse(req, (error, fields, files) => {
        if (error) {
          reject(new ImageRequestError(400, `Invalid request: ${error.message}`))
          return
        }
        resolve({ fields, files })
      })
    })
  }

  _flattenFields(fields = {}) {
    const flattened = {}
    Object.entries(fields).forEach(([key, value]) => {
      flattened[key] = firstValue(value)
    })
    return flattened
  }

  async _handleCodexErrorResponse(req, res, context, upstream) {
    const rawBody =
      upstream.data && typeof upstream.data.on === 'function'
        ? await readStreamToString(upstream.data)
        : upstream.data
    const errorData = typeof rawBody === 'string' ? safeParseJSON(rawBody) : rawBody
    const payload =
      errorData && typeof errorData === 'object'
        ? errorData
        : {
            error: {
              message: typeof rawBody === 'string' && rawBody ? rawBody : 'Upstream error'
            }
          }

    if (upstream.status === 429) {
      const resetsInSeconds = getRetryAfterSeconds(upstream.headers, payload)
      await unifiedOpenAIScheduler.markAccountRateLimited(
        context.accountId,
        'openai',
        context.sessionHash,
        resetsInSeconds
      )
    } else if (upstream.status === 401 || upstream.status === 402) {
      const label = upstream.status === 401 ? '401错误' : '402错误，可能欠费'
      const message =
        payload?.error?.message || payload?.message || (typeof rawBody === 'string' ? rawBody : '')
      const reason = message
        ? `OpenAI账号认证失败（${label}）：${message}`
        : `OpenAI账号认证失败（${label}）`

      await unifiedOpenAIScheduler
        .markAccountUnauthorized(context.accountId, 'openai', context.sessionHash, reason)
        .catch((error) =>
          logger.error('❌ Failed to mark OpenAI image account unauthorized:', error)
        )
    }

    return res.status(upstream.status).json(upstreamErrorHelper.sanitizeErrorForClient(payload))
  }

  async _collectImagesFromResponses(req, res, context, upstream, requestPayload) {
    const parser = new IncrementalSSEParser()
    let completed = null

    for await (const chunk of upstream.data) {
      const events = parser.feed(chunk.toString())
      for (const event of events) {
        if (event.type === 'data' && event.data?.type === 'response.completed') {
          completed = event.data
          break
        }
      }
      if (completed) {
        break
      }
    }

    if (!completed) {
      const events = parser.feed('\n\n')
      completed = events.find(
        (event) => event.type === 'data' && event.data?.type === 'response.completed'
      )?.data
    }

    if (!completed) {
      throw new ImageRequestError(502, 'Upstream disconnected before image completion', 'api_error')
    }

    const imageData = extractImageResultsFromCompleted(completed)
    if (imageData.results.length === 0) {
      throw new ImageRequestError(502, 'Upstream did not return image output', 'api_error')
    }

    await this._recordUsage(req, context, {
      usage: imageData.usage,
      requestBody: requestPayload.responsesRequest,
      statusCode: upstream.status,
      stream: false,
      forceRequestRecord: true
    })

    res.status(200)
    passThroughHeaders(res, upstream.headers, { skipHeaders: ['content-type'] })
    return res.json(
      buildImagesAPIResponse({
        ...imageData,
        responseFormat: requestPayload.responseFormat
      })
    )
  }

  async _streamImagesFromResponses(req, res, context, upstream, requestPayload) {
    const parser = new IncrementalSSEParser()
    const eventPrefix =
      requestPayload.responsesRequest.tools?.[0]?.action === 'edit'
        ? 'image_edit'
        : 'image_generation'
    let usageRecorded = false

    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    passThroughHeaders(res, upstream.headers)

    const writeEvent = (eventName, data) => {
      if (res.destroyed || res.writableEnded) {
        return
      }
      res.write(`event: ${eventName}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    const processEvent = async (eventData) => {
      if (eventData.type === 'response.image_generation_call.partial_image') {
        const image = toTrimmedString(eventData.partial_image_b64)
        if (!image) {
          return false
        }

        const eventName = `${eventPrefix}.partial_image`
        const data = {
          type: eventName,
          partial_image_index: Number(eventData.partial_image_index) || 0
        }
        if (requestPayload.responseFormat === 'url') {
          data.url = `data:${mimeTypeFromOutputFormat(eventData.output_format)};base64,${image}`
        } else {
          data.b64_json = image
        }
        writeEvent(eventName, data)
        return false
      }

      if (eventData.type !== 'response.completed') {
        return false
      }

      const imageData = extractImageResultsFromCompleted(eventData)
      if (imageData.results.length === 0) {
        writeEvent('error', {
          error: {
            message: 'Upstream did not return image output',
            type: 'api_error'
          }
        })
        return true
      }

      if (!usageRecorded) {
        usageRecorded = true
        await this._recordUsage(req, context, {
          usage: imageData.usage,
          requestBody: requestPayload.responsesRequest,
          statusCode: upstream.status,
          stream: true,
          forceRequestRecord: true
        })
      }

      const eventName = `${eventPrefix}.completed`
      imageData.results.forEach((image) => {
        const data = {
          type: eventName
        }
        if (requestPayload.responseFormat === 'url') {
          data.url = `data:${mimeTypeFromOutputFormat(image.outputFormat)};base64,${image.result}`
        } else {
          data.b64_json = image.result
        }
        if (imageData.usage) {
          data.usage = imageData.usage
        }
        writeEvent(eventName, data)
      })
      return true
    }

    try {
      for await (const chunk of upstream.data) {
        const events = parser.feed(chunk.toString())
        for (const event of events) {
          if (event.type === 'data' && event.data) {
            const done = await processEvent(event.data)
            if (done) {
              res.end()
              return
            }
          }
        }
      }

      const events = parser.feed('\n\n')
      for (const event of events) {
        if (event.type === 'data' && event.data) {
          const done = await processEvent(event.data)
          if (done) {
            res.end()
            return
          }
        }
      }

      res.end()
    } catch (error) {
      logger.error('Error processing Codex image stream:', error)
      if (!res.headersSent) {
        res.status(502).json({ error: { message: 'Upstream stream error' } })
      } else {
        writeEvent('error', {
          error: {
            message: 'Upstream stream error',
            type: 'api_error'
          }
        })
        res.end()
      }
    }
  }

  async _recordUsage(req, context, options = {}) {
    const usage = options.usage || {}
    const totalInputTokens = firstNumber(usage.input_tokens, usage.prompt_tokens)
    let outputTokens = firstNumber(usage.output_tokens, usage.completion_tokens)
    const totalTokens = firstNumber(usage.total_tokens)

    if (!outputTokens && totalTokens > totalInputTokens) {
      outputTokens = totalTokens - totalInputTokens
    }

    const cacheReadTokens = extractOpenAICacheReadTokens(usage)
    const actualInputTokens = Math.max(0, totalInputTokens - cacheReadTokens)

    if (
      !options.forceRequestRecord &&
      totalTokens <= 0 &&
      actualInputTokens <= 0 &&
      outputTokens <= 0
    ) {
      return null
    }

    const model = toTrimmedString(usage.model) || DEFAULT_IMAGES_TOOL_MODEL
    const costs = await apiKeyService.recordUsage(
      context.apiKeyData.id,
      actualInputTokens,
      outputTokens,
      0,
      cacheReadTokens,
      model,
      context.accountId,
      context.accountType,
      null,
      createRequestDetailMeta(req, {
        requestBody: options.requestBody,
        stream: options.stream,
        statusCode: options.statusCode
      })
    )

    if (req.rateLimitInfo) {
      await updateRateLimitCounters(
        req.rateLimitInfo,
        {
          inputTokens: actualInputTokens,
          outputTokens,
          cacheCreateTokens: 0,
          cacheReadTokens
        },
        model,
        context.apiKeyData.id,
        context.accountType,
        costs
      ).catch((error) => logger.error('❌ Failed to update image rate limit counters:', error))
    }

    return costs
  }
}

const service = new OpenAIImageRelayService()

service.DEFAULT_IMAGES_MAIN_MODEL = DEFAULT_IMAGES_MAIN_MODEL
service.DEFAULT_IMAGES_TOOL_MODEL = DEFAULT_IMAGES_TOOL_MODEL
service.buildImagesResponsesRequest = buildImagesResponsesRequest
service.extractImageResultsFromCompleted = extractImageResultsFromCompleted
service.buildImagesAPIResponse = buildImagesAPIResponse

module.exports = service
