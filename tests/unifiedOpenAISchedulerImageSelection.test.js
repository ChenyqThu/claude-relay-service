jest.mock('../src/services/account/openaiAccountService', () => ({
  getAllAccounts: jest.fn(),
  getAccount: jest.fn(),
  isTokenExpired: jest.fn(() => false),
  refreshAccountToken: jest.fn(),
  recordUsage: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAllAccounts: jest.fn(),
  getAccount: jest.fn(),
  isSubscriptionExpired: jest.fn(() => false),
  checkAndClearRateLimit: jest.fn().mockResolvedValue(true),
  recordUsage: jest.fn()
}))

jest.mock('../src/services/accountGroupService', () => ({
  getGroup: jest.fn(),
  getGroupMembers: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  isTempUnavailable: jest.fn().mockResolvedValue(false)
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const redis = require('../src/models/redis')
const scheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')

const imageSelectionOptions = {
  purpose: 'image-generation',
  preferAccountTypes: ['openai', 'openai-responses'],
  requireOpenAICodexImageGeneration: true
}

function createRedisClient() {
  return {
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(-2)
  }
}

function createOpenAIAccount(overrides = {}) {
  return {
    id: 'openai-1',
    name: 'ChatGPT Plus',
    isActive: true,
    status: 'active',
    accountType: 'shared',
    schedulable: 'true',
    priority: 1,
    lastUsedAt: '',
    ...overrides
  }
}

function createResponsesAccount(overrides = {}) {
  return {
    id: 'responses-1',
    name: 'CPA Latest',
    isActive: 'true',
    status: 'active',
    accountType: 'shared',
    schedulable: 'true',
    priority: 99,
    lastUsedAt: '',
    ...overrides
  }
}

describe('unifiedOpenAIScheduler image selection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    redis.getClientSafe.mockReturnValue(createRedisClient())
    openaiAccountService.getAccount.mockResolvedValue(null)
  })

  test('prefers Codex OAuth accounts for image requests even when Responses has higher priority', async () => {
    const codexDirectAccount = createOpenAIAccount({ priority: 99 })
    const responsesAccount = createResponsesAccount({ priority: 1 })

    openaiAccountService.getAllAccounts.mockResolvedValue([codexDirectAccount])
    openaiResponsesAccountService.getAllAccounts.mockResolvedValue([responsesAccount])

    const selected = await scheduler.selectAccountForApiKey(
      { id: 'key-1', name: 'image key' },
      null,
      'gpt-5',
      imageSelectionOptions
    )

    expect(selected).toEqual({
      accountId: 'openai-1',
      accountType: 'openai'
    })
  })

  test('falls back to OpenAI-Responses when no Codex OAuth account is available', async () => {
    const responsesAccount = createResponsesAccount({ priority: 99 })

    openaiAccountService.getAllAccounts.mockResolvedValue([])
    openaiResponsesAccountService.getAllAccounts.mockResolvedValue([responsesAccount])

    const selected = await scheduler.selectAccountForApiKey(
      { id: 'key-1', name: 'image key' },
      null,
      'gpt-5',
      imageSelectionOptions
    )

    expect(selected).toEqual({
      accountId: 'responses-1',
      accountType: 'openai-responses'
    })
  })

  test('allows ordinary OpenAI OAuth accounts for Codex image requests', async () => {
    openaiAccountService.getAllAccounts.mockResolvedValue([createOpenAIAccount()])
    openaiResponsesAccountService.getAllAccounts.mockResolvedValue([])

    const selected = await scheduler.selectAccountForApiKey(
      { id: 'key-1', name: 'image key' },
      null,
      'gpt-5',
      imageSelectionOptions
    )

    expect(selected).toEqual({
      accountId: 'openai-1',
      accountType: 'openai'
    })
  })

  test('skips free Codex accounts that do not expose image generation', async () => {
    const freeAccount = createOpenAIAccount({
      id: 'openai-free',
      name: 'ChatGPT Free',
      planType: 'free',
      priority: 1
    })
    const teamAccount = createOpenAIAccount({
      id: 'openai-team',
      name: 'ChatGPT Team',
      planType: 'team',
      priority: 99
    })

    openaiAccountService.getAllAccounts.mockResolvedValue([freeAccount, teamAccount])
    openaiResponsesAccountService.getAllAccounts.mockResolvedValue([])

    const selected = await scheduler.selectAccountForApiKey(
      { id: 'key-1', name: 'image key' },
      null,
      'gpt-5',
      imageSelectionOptions
    )

    expect(selected).toEqual({
      accountId: 'openai-team',
      accountType: 'openai'
    })
  })
})
