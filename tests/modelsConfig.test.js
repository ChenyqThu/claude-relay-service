const { CLAUDE_MODELS, OPENAI_MODELS } = require('../config/models')
const modelService = require('../src/services/modelService')
const {
  getEffectiveModel,
  stripLongContextSuffix,
  getClaudeModelFamily
} = require('../src/utils/modelHelper')

describe('models config', () => {
  it('places Claude Fable 5 at the top of Claude model options', () => {
    expect(CLAUDE_MODELS.slice(0, 2)).toEqual([
      {
        value: 'claude-fable-5',
        label: 'Claude Fable 5'
      },
      {
        value: 'claude-fable-5[1m]',
        label: 'Claude Fable 5 (1M)'
      }
    ])
    expect(CLAUDE_MODELS[3]).toEqual({
      value: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6'
    })
  })

  it('includes the latest Claude Opus and OpenAI models', () => {
    expect(CLAUDE_MODELS.map((model) => model.value)).toEqual(
      expect.arrayContaining([
        'claude-fable-5',
        'claude-fable-5[1m]',
        'claude-opus-4-7',
        'claude-opus-4-8',
        'claude-opus-4-8[1m]',
        'claude-opus-4-7[1m]',
        'claude-sonnet-4-6',
        'claude-sonnet-4-6[1m]'
      ])
    )
    expect(OPENAI_MODELS.map((model) => model.value)).toEqual(
      expect.arrayContaining(['gpt-5.5', 'gpt-image-2', 'gpt-image-2-2026-04-21'])
    )
  })

  it('keeps the API models endpoint source aligned with admin model config', () => {
    const apiModels = modelService.getAllModels()
    const apiModelIds = apiModels.map((model) => model.id)

    expect(apiModelIds).toEqual(
      expect.arrayContaining([
        'claude-fable-5',
        'claude-fable-5[1m]',
        'claude-opus-4-7',
        'claude-opus-4-8',
        'claude-opus-4-8[1m]',
        'claude-opus-4-7[1m]',
        'claude-sonnet-4-6[1m]',
        'gpt-5.5',
        'gpt-image-2'
      ])
    )
    expect(apiModels.find((model) => model.id === 'claude-opus-4-8[1m]')).toMatchObject({
      max_input_tokens: 1000000,
      max_tokens: 128000
    })
    expect(apiModels.find((model) => model.id === 'claude-opus-4-7[1m]')).toMatchObject({
      max_input_tokens: 1000000,
      max_tokens: 128000
    })
    expect(apiModels.find((model) => model.id === 'claude-sonnet-4-6[1m]')).toMatchObject({
      max_input_tokens: 1000000,
      max_tokens: 64000
    })
    expect(apiModels.find((model) => model.id === 'claude-fable-5')).toMatchObject({
      max_input_tokens: 1000000,
      max_tokens: 128000
    })
    expect(apiModels.find((model) => model.id === 'claude-fable-5[1m]')).toMatchObject({
      max_input_tokens: 1000000,
      max_tokens: 128000
    })
  })

  it('normalizes Claude Code 1M model variants before scheduling and forwarding', () => {
    expect(stripLongContextSuffix('claude-fable-5[1m]')).toBe('claude-fable-5')
    expect(stripLongContextSuffix('claude-opus-4-8[1m]')).toBe('claude-opus-4-8')
    expect(stripLongContextSuffix('claude-opus-4-7[1m]')).toBe('claude-opus-4-7')
    expect(getEffectiveModel('ccr,claude-sonnet-4-6[1m]')).toBe('claude-sonnet-4-6')
  })

  it('detects Claude model families for model-level scheduling limits', () => {
    expect(getClaudeModelFamily('claude-fable-5[1m]')).toBe('fable')
    expect(getClaudeModelFamily('claude-sonnet-4-6[1m]')).toBe('sonnet')
    expect(getClaudeModelFamily('ccr,claude-opus-4-8')).toBe('opus')
    expect(getClaudeModelFamily('us.anthropic.claude-3-5-haiku-20241022-v1:0')).toBe('haiku')
    expect(getClaudeModelFamily('gpt-5.5')).toBeNull()
  })
})
