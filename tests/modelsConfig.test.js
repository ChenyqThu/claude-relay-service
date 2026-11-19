const { CLAUDE_MODELS, GEMINI_MODELS, OPENAI_MODELS } = require('../config/models')
const fallbackModelPricing = require('../resources/model-pricing/model_prices_and_context_window.json')
const modelService = require('../src/services/modelService')
const antigravityClient = require('../src/services/antigravityClient')
const {
  getAntigravityModelAlias,
  getAntigravityModelMetadata,
  mapAntigravityUpstreamModel
} = require('../src/utils/antigravityModel')
const {
  getEffectiveModel,
  stripLongContextSuffix,
  getRateLimitModelFamily
} = require('../src/utils/modelHelper')

describe('models config', () => {
  it('places Claude Opus 5.5 at the top of Claude model options', () => {
    expect(CLAUDE_MODELS.slice(0, 2)).toEqual([
      {
        value: 'claude-opus-5-5',
        label: 'Claude Opus 5.5'
      },
      {
        value: 'claude-opus-5-5[1m]',
        label: 'Claude Opus 5.5 (1M)'
      }
    ])
    expect(CLAUDE_MODELS.slice(4, 6)).toEqual([
      {
        value: 'claude-fable-5-2',
        label: 'Claude Fable 5.2'
      },
      {
        value: 'claude-fable-5-2[1m]',
        label: 'Claude Fable 5.2 (1M)'
      }
    ])
    expect(CLAUDE_MODELS.slice(6, 8)).toEqual([
      {
        value: 'claude-fable-5-1',
        label: 'Claude Fable 5.1'
      },
      {
        value: 'claude-fable-5-1[1m]',
        label: 'Claude Fable 5.1 (1M)'
      }
    ])
    expect(CLAUDE_MODELS.slice(8, 10)).toEqual([
      {
        value: 'claude-fable-5',
        label: 'Claude Fable 5'
      },
      {
        value: 'claude-fable-5[1m]',
        label: 'Claude Fable 5 (1M)'
      }
    ])
    expect(CLAUDE_MODELS[11]).toEqual({
      value: 'claude-sonnet-5-5',
      label: 'Claude Sonnet 5.5'
    })
  })

  it('includes the latest Claude Opus and OpenAI models', () => {
    expect(CLAUDE_MODELS.map((model) => model.value)).toEqual(
      expect.arrayContaining([
        'claude-opus-5-5',
        'claude-opus-5-5[1m]',
        'claude-opus-5',
        'claude-opus-5[1m]',
        'claude-fable-5-2',
        'claude-fable-5-2[1m]',
        'claude-fable-5-1',
        'claude-fable-5-1[1m]',
        'claude-fable-5',
        'claude-fable-5[1m]',
        'claude-opus-4-7',
        'claude-opus-4-8',
        'claude-opus-4-8[1m]',
        'claude-opus-4-7[1m]',
        'claude-sonnet-4-6',
        'claude-sonnet-5-5',
        'claude-sonnet-5-5[1m]',
        'claude-haiku-5-5',
        'claude-haiku-5-5[1m]',
        'claude-sonnet-4-6[1m]'
      ])
    )
    expect(OPENAI_MODELS.map((model) => model.value)).toEqual(
      expect.arrayContaining([
        'gpt-5.5',
        'gpt-6.2-sol',
        'gpt-6.2-astra',
        'gpt-6.1-sol',
        'gpt-6.1-terra',
        'gpt-6-sol',
        'gpt-6-luna',
        'gpt-6-astra',
        'gpt-6.2-astra-law',
        'gpt-6-astra-law',
        'gpt-6-cyber',
        'gpt-6-rosalind',
        'gpt-image-2',
        'gpt-image-2-2026-04-21'
      ])
    )
  })

  it('includes the current Gemini generateContent model family', () => {
    expect(GEMINI_MODELS.map((model) => model.value)).toEqual(
      expect.arrayContaining([
        'gemini-3.8-flash',
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-3.5-flash-lite',
        'gemini-3.1-pro-preview',
        'gemini-3.1-pro-preview-customtools',
        'gemini-3.1-flash-lite',
        'gemini-3.1-flash-image',
        'gemini-3.1-flash-lite-image',
        'gemini-3-pro-image'
      ])
    )
    expect(GEMINI_MODELS.map((model) => model.value)).not.toContain('gemini-3-pro-preview')
  })

  it('maps current Gemini model names to Antigravity upstream variants', () => {
    expect(mapAntigravityUpstreamModel('gemini-3.8-flash')).toBe('gemini-3.8-flash-tiered')
    expect(mapAntigravityUpstreamModel('gemini-3.7-flash')).toBe('gemini-3.7-flash-tiered')
    expect(mapAntigravityUpstreamModel('gemini-3.6-flash')).toBe('gemini-3.6-flash-tiered')
    expect(getAntigravityModelAlias('gemini-3.8-flash-tiered')).toBe('gemini-3.8-flash')
    expect(getAntigravityModelAlias('gemini-3.5-flash-low')).toBe('')
    expect(getAntigravityModelAlias('gemini-3.5-flash-extra-low')).toBe('')
    expect(getAntigravityModelMetadata('gemini-3.8-flash-tiered')).toMatchObject({
      name: 'models/gemini-3.8-flash'
    })
  })

  it('preserves thinkingLevel for dotted Gemini 3 model versions', () => {
    const { envelope } = antigravityClient.buildAntigravityEnvelope({
      requestData: {
        model: 'gemini-3.8-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { thinkingConfig: { thinkingLevel: 'high' } }
        }
      }
    })

    expect(envelope.model).toBe('gemini-3.8-flash-tiered')
    expect(envelope.request.generationConfig.thinkingConfig.thinkingLevel).toBe('high')
  })

  it('normalizes nested non-string tool enum values for Antigravity', () => {
    const { envelope } = antigravityClient.buildAntigravityEnvelope({
      requestData: {
        model: 'gemini-3.8-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'nested_enum',
                  parameters: {
                    type: 'object',
                    properties: {
                      value: {
                        anyOf: [
                          { type: 'integer', enum: [1, 2] },
                          { type: 'boolean', enum: [true, false] }
                        ]
                      }
                    }
                  }
                }
              ]
            }
          ]
        }
      }
    })

    const alternatives =
      envelope.request.tools[0].functionDeclarations[0].parameters.properties.value.anyOf
    expect(alternatives[0].enum).toEqual(['1', '2'])
    expect(alternatives[1].enum).toEqual(['true', 'false'])
  })

  it('preserves the native Gemini function-calling mode', () => {
    const { envelope } = antigravityClient.buildAntigravityEnvelope({
      requestData: {
        model: 'gemini-3.8-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'optional_tool',
                  parameters: { type: 'object', properties: {} }
                }
              ]
            }
          ],
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
        }
      }
    })

    expect(envelope.request.toolConfig.functionCallingConfig.mode).toBe('AUTO')
  })

  it('keeps the native Gemini default when toolConfig is omitted', () => {
    const { envelope } = antigravityClient.buildAntigravityEnvelope({
      requestData: {
        model: 'gemini-3.8-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'optional_tool',
                  parameters: { type: 'object', properties: {} }
                }
              ]
            }
          ]
        }
      }
    })

    expect(envelope.request.toolConfig).toBeUndefined()
  })

  it('keeps the API models endpoint source aligned with admin model config', () => {
    const apiModels = modelService.getAllModels()
    const apiModelIds = apiModels.map((model) => model.id)

    expect(apiModelIds).toEqual(
      expect.arrayContaining([
        'claude-opus-5-5',
        'claude-opus-5-5[1m]',
        'claude-opus-5',
        'claude-opus-5[1m]',
        'claude-fable-5-2',
        'claude-fable-5-2[1m]',
        'claude-fable-5-1',
        'claude-fable-5-1[1m]',
        'claude-fable-5',
        'claude-fable-5[1m]',
        'claude-opus-4-7',
        'claude-opus-4-8',
        'claude-opus-4-8[1m]',
        'claude-opus-4-7[1m]',
        'claude-sonnet-5-5',
        'claude-sonnet-5-5[1m]',
        'claude-haiku-5-5',
        'claude-haiku-5-5[1m]',
        'claude-sonnet-4-6[1m]',
        'gpt-5.5',
        'gpt-6.2-sol',
        'gpt-6.2-astra',
        'gpt-6.1-sol',
        'gpt-6.1-terra',
        'gpt-6-sol',
        'gpt-6-luna',
        'gpt-6-astra',
        'gpt-6.2-astra-law',
        'gpt-6-astra-law',
        'gpt-6-cyber',
        'gpt-6-rosalind',
        'gpt-image-2.6-flare',
        'gpt-image-2.6-sunburst',
        'gpt-image-2.5-flare',
        'gpt-image-2.5-sunburst',
        'gpt-image-2'
      ])
    )
    expect(apiModels.find((model) => model.id === 'claude-opus-5')).toMatchObject({
      max_input_tokens: 1000000,
      max_tokens: 128000
    })
    expect(apiModels.find((model) => model.id === 'claude-opus-5[1m]')).toMatchObject({
      max_input_tokens: 1000000,
      max_tokens: 128000
    })
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
      max_tokens: 128000
    })
    expect(apiModels.find((model) => model.id === 'claude-fable-5')).toMatchObject({
      max_input_tokens: 1000000,
      max_tokens: 128000
    })
    expect(apiModels.find((model) => model.id === 'claude-fable-5-2')).toMatchObject({
      max_input_tokens: 1000000,
      max_tokens: 128000
    })
    expect(apiModels.find((model) => model.id === 'claude-fable-5-2[1m]')).toMatchObject({
      max_input_tokens: 1000000,
      max_tokens: 128000
    })
    expect(apiModels.find((model) => model.id === 'claude-fable-5-1')).toMatchObject({
      max_input_tokens: 1000000,
      max_tokens: 128000
    })
    expect(apiModels.find((model) => model.id === 'claude-fable-5-1[1m]')).toMatchObject({
      max_input_tokens: 1000000,
      max_tokens: 128000
    })
    expect(apiModels.find((model) => model.id === 'claude-fable-5[1m]')).toMatchObject({
      max_input_tokens: 1000000,
      max_tokens: 128000
    })
  })

  it('prices Claude Opus 5 at the official standard and fast-mode rates', () => {
    expect(fallbackModelPricing['claude-opus-5']).toMatchObject({
      input_cost_per_token: 0.000005,
      output_cost_per_token: 0.000025,
      cache_creation_input_token_cost: 0.00000625,
      cache_read_input_token_cost: 0.0000005,
      provider_specific_entry: {
        fast: 2
      }
    })
  })

  it('prices Claude Fable 5.2 at the official standard and fast-mode rates', () => {
    expect(fallbackModelPricing['claude-fable-5-2']).toMatchObject({
      input_cost_per_token: 0.000008,
      output_cost_per_token: 0.00004,
      cache_creation_input_token_cost: 0.00001,
      cache_creation_input_token_cost_above_1hr: 0.000016,
      cache_read_input_token_cost: 0.0000002,
      provider_specific_entry: {
        fast: 2
      }
    })
  })

  it('normalizes Claude Code 1M model variants before scheduling and forwarding', () => {
    expect(stripLongContextSuffix('claude-opus-5[1m]')).toBe('claude-opus-5')
    expect(stripLongContextSuffix('claude-fable-5-2[1m]')).toBe('claude-fable-5-2')
    expect(stripLongContextSuffix('claude-fable-5-1[1m]')).toBe('claude-fable-5-1')
    expect(stripLongContextSuffix('claude-fable-5[1m]')).toBe('claude-fable-5')
    expect(stripLongContextSuffix('claude-opus-4-8[1m]')).toBe('claude-opus-4-8')
    expect(stripLongContextSuffix('claude-opus-4-7[1m]')).toBe('claude-opus-4-7')
    expect(getEffectiveModel('ccr,claude-sonnet-4-6[1m]')).toBe('claude-sonnet-4-6')
  })

  it('detects Claude model families for model-level scheduling limits', () => {
    expect(getRateLimitModelFamily('claude-opus-5[1m]')).toBe('opus')
    expect(getRateLimitModelFamily('claude-fable-5-2[1m]')).toBe('fable')
    expect(getRateLimitModelFamily('claude-fable-5-1[1m]')).toBe('fable')
    expect(getRateLimitModelFamily('claude-fable-5[1m]')).toBe('fable')
    expect(getRateLimitModelFamily('claude-sonnet-4-6[1m]')).toBe('sonnet')
    expect(getRateLimitModelFamily('ccr,claude-opus-4-8')).toBe('opus')
    expect(getRateLimitModelFamily('us.anthropic.claude-3-5-haiku-20241022-v1:0')).toBe('haiku')
    expect(getRateLimitModelFamily('gpt-5.5')).toBeNull()
  })
})
