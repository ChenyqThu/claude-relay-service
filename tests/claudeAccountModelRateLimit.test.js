jest.useFakeTimers()

jest.mock('../src/models/redis', () => ({
  getClaudeAccount: jest.fn(),
  setClaudeAccount: jest.fn(),
  client: {
    hdel: jest.fn()
  }
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  success: jest.fn(),
  warn: jest.fn()
}))

const redis = require('../src/models/redis')
const claudeAccountService = require('../src/services/account/claudeAccountService')

describe('Claude account model-level rate limits', () => {
  let storedAccount

  beforeEach(() => {
    storedAccount = {
      id: 'account-1',
      name: 'Kevin-Claude',
      isActive: 'true',
      schedulable: 'true',
      status: 'active'
    }

    redis.getClaudeAccount.mockImplementation(async () => storedAccount)
    redis.setClaudeAccount.mockImplementation(async (_accountId, nextAccount) => {
      storedAccount = { ...nextAccount }
    })
    redis.client.hdel.mockClear()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  afterAll(() => {
    jest.useRealTimers()
  })

  it('marks only the requested model family without stopping account scheduling', async () => {
    const resetTimestamp = Math.floor(Date.now() / 1000) + 3600

    await claudeAccountService.markAccountModelRateLimited('account-1', 'sonnet', resetTimestamp)

    expect(storedAccount.sonnetRateLimitedAt).toEqual(expect.any(String))
    expect(storedAccount.sonnetRateLimitEndAt).toBe(new Date(resetTimestamp * 1000).toISOString())
    expect(storedAccount.opusRateLimitedAt).toBeUndefined()
    expect(storedAccount.opusRateLimitEndAt).toBeUndefined()
    expect(storedAccount.schedulable).toBe('true')
    expect(storedAccount.rateLimitStatus).toBeUndefined()
    expect(storedAccount.rateLimitAutoStopped).toBeUndefined()
  })

  it('checks and clears model families independently', async () => {
    const resetTimestamp = Math.floor(Date.now() / 1000) + 3600
    await claudeAccountService.markAccountModelRateLimited('account-1', 'sonnet', resetTimestamp)

    await expect(
      claudeAccountService.isAccountModelRateLimited('account-1', 'sonnet')
    ).resolves.toBe(true)
    await expect(claudeAccountService.isAccountModelRateLimited('account-1', 'opus')).resolves.toBe(
      false
    )

    await claudeAccountService.clearAccountModelRateLimit('account-1', 'sonnet')

    expect(storedAccount.sonnetRateLimitedAt).toBeUndefined()
    expect(storedAccount.sonnetRateLimitEndAt).toBeUndefined()
    expect(redis.client.hdel).toHaveBeenCalledWith(
      'claude:account:account-1',
      'sonnetRateLimitedAt',
      'sonnetRateLimitEndAt'
    )
  })
})
