jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  performance: jest.fn()
}))

jest.mock('../config/config', () => ({
  claude: {
    apiVersion: '2023-06-01',
    betaHeader: '',
    systemPrompt: ''
  }
}))

jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({}))
jest.mock('../src/services/claudeCodeHeadersService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/services/userMessageQueueService', () => ({}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))
jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(),
  getProxyDescription: jest.fn(() => 'proxy')
}))
jest.mock('../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForStream: jest.fn(),
  getHttpsAgentForNonStream: jest.fn(),
  getPricingData: jest.fn(() => null)
}))

const claudeRelayService = require('../src/services/relay/claudeRelayService')

const countCacheControlBlocks = (body) => {
  let total = body.cache_control ? 1 : 0

  if (Array.isArray(body.tools)) {
    total += body.tools.filter((tool) => tool?.cache_control).length
  }

  if (Array.isArray(body.system)) {
    total += body.system.filter((item) => item?.cache_control).length
  }

  if (Array.isArray(body.messages)) {
    body.messages.forEach((message) => {
      if (Array.isArray(message.content)) {
        total += message.content.filter((item) => item?.cache_control).length
      }
    })
  }

  return total
}

describe('claudeRelayService cache_control handling', () => {
  it('treats known model-family 429 as model-level even without reset header', () => {
    expect(claudeRelayService._shouldUseModelLevelRateLimit('opus', {}, null)).toBe(true)
    expect(
      claudeRelayService._shouldUseModelLevelRateLimit(
        'opus',
        { 'anthropic-ratelimit-unified-5h-status': 'rejected' },
        null
      )
    ).toBe(false)
  })

  it('defaults existing cache_control blocks to 1h TTL without adding new cache_control', () => {
    const processed = claudeRelayService._processRequestBody(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        cache_control: { type: 'ephemeral' },
        tools: [
          {
            name: 'lookup',
            description: 'Lookup data',
            input_schema: { type: 'object' },
            cache_control: { type: 'ephemeral' }
          }
        ],
        system: [
          {
            type: 'text',
            text: 'stable system prompt',
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'hello',
                cache_control: { type: 'ephemeral' }
              },
              {
                type: 'text',
                text: 'uncached suffix'
              }
            ]
          }
        ]
      },
      null,
      true
    )

    expect(processed.cache_control.ttl).toBe('1h')
    expect(processed.tools[0].cache_control.ttl).toBe('1h')
    expect(processed.system[0].cache_control.ttl).toBe('1h')
    expect(processed.messages[0].content[0].cache_control.ttl).toBe('1h')
    expect(processed.messages[0].content[1]).not.toHaveProperty('cache_control')
  })

  it('preserves explicit cache_control TTL values', () => {
    const processed = claudeRelayService._processRequestBody(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'use shorter cache',
                cache_control: { type: 'ephemeral', ttl: '5m' }
              }
            ]
          }
        ]
      },
      null,
      true
    )

    expect(processed.messages[0].content[0].cache_control.ttl).toBe('5m')
  })

  it('preserves cached system blocks when non-Claude-Code requests are migrated to messages', () => {
    const processed = claudeRelayService._processRequestBody(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        system: [
          {
            type: 'text',
            text: 'large stable instruction',
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'question' }]
          }
        ]
      },
      null,
      false
    )

    const instructionBlock = processed.messages[0].content.find(
      (block) => block.text === 'large stable instruction'
    )

    expect(processed.system).toBe("You are Claude Code, Anthropic's official CLI for Claude.")
    expect(instructionBlock.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('keeps cache_control breakpoints within the Anthropic limit including top-level and tools', () => {
    const processed = claudeRelayService._processRequestBody(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        cache_control: { type: 'ephemeral' },
        tools: [
          {
            name: 'lookup',
            description: 'Lookup data',
            input_schema: { type: 'object' },
            cache_control: { type: 'ephemeral' }
          }
        ],
        system: [
          {
            type: 'text',
            text: 'stable system prompt',
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'first cached message',
                cache_control: { type: 'ephemeral' }
              },
              {
                type: 'text',
                text: 'second cached message',
                cache_control: { type: 'ephemeral' }
              }
            ]
          }
        ]
      },
      null,
      true
    )

    expect(countCacheControlBlocks(processed)).toBe(4)
    expect(processed.messages[0].content[0]).not.toHaveProperty('cache_control')
    expect(processed.messages[0].content[1]).toHaveProperty('cache_control')
    expect(processed.tools[0]).toHaveProperty('cache_control')
    expect(processed).toHaveProperty('cache_control')
  })
})
