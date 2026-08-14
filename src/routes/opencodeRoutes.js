const express = require('express')
const { authenticateApiKey } = require('../middleware/auth')
const opencodeRelayService = require('../services/relay/opencodeRelayService')
const opencodeScheduler = require('../services/scheduler/opencodeScheduler')
const apiKeyService = require('../services/apiKeyService')
const sessionHelper = require('../utils/sessionHelper')
const logger = require('../utils/logger')

const router = express.Router()

/**
 * opencode zen API 转发路由
 *
 * 上游三种协议格式全部直通：
 * - /opencode/v1/responses         OpenAI Responses API（内置搜索等原生能力）
 * - /opencode/v1/messages          Anthropic Messages API
 * - /opencode/v1/chat/completions  OpenAI Chat Completions API
 * - /opencode/v1/models            模型列表
 */

function hasOpencodePermission(apiKeyData) {
  return apiKeyService.hasPermission(apiKeyData?.permissions, 'opencode')
}

function denyWithoutPermission(req, res) {
  logger.security(
    `🚫 API Key ${req.apiKey?.id || 'unknown'} 缺少 Opencode 权限，拒绝访问 ${req.originalUrl}`
  )
  res.status(403).json({
    error: 'permission_denied',
    message: '此 API Key 未启用 Opencode 权限'
  })
}

function createRelayHandler(format) {
  return async (req, res) => {
    try {
      if (!hasOpencodePermission(req.apiKey)) {
        return denyWithoutPermission(req, res)
      }

      const sessionHash = sessionHelper.generateSessionHash(req.body)

      const result = await opencodeRelayService.relayRequest(
        req.body,
        req.apiKey,
        req,
        res,
        req.headers,
        { format, sessionHash }
      )

      if (result.streaming) {
        return undefined
      }

      return res.status(result.statusCode).set(result.headers).send(result.body)
    } catch (error) {
      logger.error(`Opencode ${format} relay error:`, error)
      if (!res.headersSent) {
        return res.status(500).json({
          error: 'internal_server_error',
          message: error.message
        })
      }
      return undefined
    }
  }
}

// OpenAI Responses API（直通上游 /responses）
router.post(['/v1/responses', '/responses'], authenticateApiKey, createRelayHandler('responses'))

// Anthropic Messages API（直通上游 /messages）
router.post(['/v1/messages', '/messages'], authenticateApiKey, createRelayHandler('messages'))

// OpenAI Chat Completions API（直通上游 /chat/completions）
router.post(
  ['/v1/chat/completions', '/chat/completions'],
  authenticateApiKey,
  createRelayHandler('chat')
)

// 模型列表
router.get(['/v1/models', '/models'], authenticateApiKey, async (req, res) => {
  try {
    if (!hasOpencodePermission(req.apiKey)) {
      return denyWithoutPermission(req, res)
    }

    const account = await opencodeScheduler.selectAccount(req.apiKey, null)
    const result = await opencodeRelayService.fetchModels(account)

    return res.status(result.statusCode).json(result.data)
  } catch (error) {
    logger.error('Opencode models error:', error)
    return res.status(500).json({
      error: 'internal_server_error',
      message: error.message
    })
  }
})

// 健康检查
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'opencode-relay' })
})

module.exports = router
