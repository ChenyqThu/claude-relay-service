const crypto = require('crypto')

const mockRouter = {
  get: jest.fn(),
  post: jest.fn()
}

jest.mock(
  'express',
  () => ({
    Router: () => mockRouter
  }),
  { virtual: true }
)

jest.mock('../config/config', () => ({
  requestTimeout: 1000
}))

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: jest.fn((_req, _res, next) => next())
}))

jest.mock('axios', () => ({
  post: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  markAccountRateLimited: jest.fn(),
  isAccountRateLimited: jest.fn().mockResolvedValue(false),
  removeAccountRateLimit: jest.fn(),
  markAccountUnauthorized: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  decrypt: jest.fn(),
  isTokenExpired: jest.fn(() => false),
  refreshAccountToken: jest.fn(),
  updateCodexUsageSnapshot: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/relay/openaiResponsesRelayService', () => ({
  handleRequest: jest.fn()
}))

jest.mock('../src/services/relay/openaiImageRelayService', () => ({
  handleGeneration: jest.fn(),
  handleEdit: jest.fn(),
  passthroughOpenAIResponses: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(() => true),
  recordUsage: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getUsageStats: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'none')
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/utils/sseParser', () => ({
  IncrementalSSEParser: jest.fn().mockImplementation(() => ({
    feed: jest.fn(() => []),
    getRemaining: jest.fn(() => '')
  }))
}))

jest.mock('../src/utils/errorSanitizer', () => ({
  getSafeMessage: jest.fn((error) => error?.message || 'error')
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn(() => null),
  extractOpenAICacheReadTokens: jest.fn(() => 0)
}))

const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const openaiImageRelayService = require('../src/services/relay/openaiImageRelayService')
const openaiRoutes = require('../src/routes/openaiRoutes')

function createHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function createReq({ path = '/v1/images/generations', body = {}, headers = {} } = {}) {
  return {
    method: 'POST',
    path,
    originalUrl: `/openai${path}`,
    headers: {
      'user-agent': 'test-client/1.0',
      ...headers
    },
    body: JSON.parse(JSON.stringify(body)),
    apiKey: {
      id: 'key_1',
      name: 'test key',
      permissions: ['openai']
    }
  }
}

function createRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((payload) => {
      res.payload = payload
      return res
    }),
    end: jest.fn()
  }
  return res
}

describe('openai image routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    openaiAccountService.decrypt.mockReturnValue('decrypted-token')
  })

  test('selects an image-capable OpenAI account and dispatches image generations', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'Codex Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-id'
    })
    openaiImageRelayService.handleGeneration.mockResolvedValue({ ok: true })

    const req = createReq({
      body: {
        prompt: 'draw a workstation',
        model: 'gpt-image-2',
        prompt_cache_key: 'image-session'
      }
    })
    const res = createRes()

    await openaiRoutes.handleImageGeneration(req, res)

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('image:image-session'),
      'gpt-5',
      {
        purpose: 'image-generation',
        preferAccountTypes: ['openai', 'openai-responses']
      }
    )
    expect(openaiImageRelayService.handleGeneration).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({
        accessToken: 'decrypted-token',
        accountId: 'openai-1',
        accountType: 'openai',
        sessionHash: createHash('image:image-session'),
        apiKeyData: req.apiKey
      })
    )
  })

  test('retries Codex image requests with another OpenAI account on retryable failures', async () => {
    const retryableError = new Error('Upstream did not return image output')
    retryableError.statusCode = 502
    retryableError.type = 'api_error'

    unifiedOpenAIScheduler.selectAccountForApiKey
      .mockResolvedValueOnce({
        accountId: 'openai-1',
        accountType: 'openai'
      })
      .mockResolvedValueOnce({
        accountId: 'openai-2',
        accountType: 'openai'
      })
    openaiAccountService.getAccount.mockImplementation(async (accountId) => ({
      id: accountId,
      name: `Codex Account ${accountId}`,
      accessToken: 'encrypted-token',
      accountId: `chatgpt-${accountId}`
    }))
    openaiImageRelayService.handleGeneration
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValueOnce({ ok: true })

    const req = createReq({
      body: {
        prompt: 'draw a fallback diagram',
        model: 'gpt-image-2'
      }
    })
    const res = createRes()

    await openaiRoutes.handleImageGeneration(req, res)

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenNthCalledWith(
      1,
      req.apiKey,
      null,
      'gpt-5',
      {
        purpose: 'image-generation',
        preferAccountTypes: ['openai', 'openai-responses']
      }
    )
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenNthCalledWith(
      2,
      req.apiKey,
      null,
      'gpt-5',
      {
        purpose: 'image-generation',
        preferAccountTypes: ['openai', 'openai-responses'],
        excludedAccountIds: ['openai-1']
      }
    )
    expect(openaiImageRelayService.handleGeneration).toHaveBeenCalledTimes(2)
    expect(openaiImageRelayService.handleGeneration).toHaveBeenNthCalledWith(
      2,
      req,
      res,
      expect.objectContaining({
        accessToken: 'decrypted-token',
        accountId: 'openai-2',
        accountType: 'openai',
        throwOnImageRelayError: true
      })
    )
  })

  test('passes OpenAI-Responses image requests through compatible providers', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'resp-1',
      accountType: 'openai-responses'
    })
    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'resp-1',
      name: 'CPA Latest',
      apiKey: 'sk-responses'
    })
    openaiImageRelayService.passthroughOpenAIResponses.mockResolvedValue({ ok: true })

    const req = createReq({
      body: {
        prompt: 'draw a diagram',
        model: 'gpt-image-2'
      }
    })
    const res = createRes()

    await openaiRoutes.handleImageGeneration(req, res)

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      null,
      'gpt-5',
      {
        purpose: 'image-generation',
        preferAccountTypes: ['openai', 'openai-responses']
      }
    )
    expect(openaiImageRelayService.passthroughOpenAIResponses).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({
        accountId: 'resp-1',
        accountType: 'openai-responses',
        apiKeyData: req.apiKey
      })
    )
    expect(openaiImageRelayService.handleGeneration).not.toHaveBeenCalled()
  })
})
