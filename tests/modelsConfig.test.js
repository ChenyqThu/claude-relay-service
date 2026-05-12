const { CLAUDE_MODELS, OPENAI_MODELS } = require('../config/models')
const modelService = require('../src/services/modelService')
const { getEffectiveModel, stripLongContextSuffix } = require('../src/utils/modelHelper')

describe('models config', () => {
  it('places Claude Sonnet 4.6 as the second Claude model option', () => {
    expect(CLAUDE_MODELS[1]).toEqual({
      value: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6'
    })
  })

  it('includes the latest Claude Opus and OpenAI models', () => {
    expect(CLAUDE_MODELS.map((model) => model.value)).toEqual(
      expect.arrayContaining([
        'claude-opus-4-7',
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
        'claude-opus-4-7',
        'claude-opus-4-7[1m]',
        'claude-sonnet-4-6[1m]',
        'gpt-5.5',
        'gpt-image-2'
      ])
    )
    expect(apiModels.find((model) => model.id === 'claude-opus-4-7[1m]')).toMatchObject({
      max_input_tokens: 1000000,
      max_tokens: 128000
    })
    expect(apiModels.find((model) => model.id === 'claude-sonnet-4-6[1m]')).toMatchObject({
      max_input_tokens: 1000000,
      max_tokens: 64000
    })
  })

  it('normalizes Claude Code 1M model variants before scheduling and forwarding', () => {
    expect(stripLongContextSuffix('claude-opus-4-7[1m]')).toBe('claude-opus-4-7')
    expect(getEffectiveModel('ccr,claude-sonnet-4-6[1m]')).toBe('claude-sonnet-4-6')
  })
})
