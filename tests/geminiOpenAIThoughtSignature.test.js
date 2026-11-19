jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: jest.fn((_req, _res, next) => next())
}))

jest.mock('../src/routes/openaiClaudeRoutes', () => ({
  handleChatCompletion: jest.fn()
}))

jest.mock('../src/handlers/geminiHandlers', () => ({
  ensureGeminiPermissionMiddleware: jest.fn((_req, _res, next) => next()),
  handleLoadCodeAssist: jest.fn(),
  handleOnboardUser: jest.fn(),
  handleCountTokens: jest.fn((_req, res) => res.json({ operation: 'countTokens' })),
  handleGenerateContent: jest.fn(),
  handleStreamGenerateContent: jest.fn(),
  handleStandardGenerateContent: jest.fn((req, res) =>
    res.json({ operation: 'generateContent', model: req.params.modelName })
  ),
  handleStandardStreamGenerateContent: jest.fn((req, res) =>
    res.json({ operation: 'streamGenerateContent', model: req.params.modelName })
  ),
  handleModels: jest.fn(),
  handleModelDetails: jest.fn()
}))

jest.mock('../src/routes/openaiRoutes', () => ({
  handleResponses: jest.fn(),
  CODEX_CLI_INSTRUCTIONS: ''
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(() => true)
}))

const unifiedRoutes = require('../src/routes/unified')
const GeminiToOpenAIConverter = require('../src/services/geminiToOpenAI')
const standardGeminiRoutes = require('../src/routes/standardGeminiRoutes')

describe('Gemini OpenAI thought signature compatibility', () => {
  it('returns thought signatures in OpenAI tool calls', () => {
    const converter = new GeminiToOpenAIConverter()
    const response = converter.convertResponse(
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  thoughtSignature: 'signed-reasoning-state',
                  functionCall: {
                    id: 'call_weather',
                    name: 'get_weather',
                    args: { city: 'Paris' }
                  }
                }
              ]
            }
          }
        ]
      },
      'gemini-3.8-flash'
    )

    expect(response.choices[0].message.tool_calls[0]).toMatchObject({
      id: 'call_weather',
      extra_content: {
        google: { thought_signature: 'signed-reasoning-state' }
      }
    })
  })

  it('returns thought signatures in streaming OpenAI tool call chunks', () => {
    const converter = new GeminiToOpenAIConverter()
    const state = converter.createStreamState()
    const output = converter.convertStreamChunk(
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  thoughtSignature: 'stream-signed-reasoning-state',
                  functionCall: {
                    id: 'call_stream_weather',
                    name: 'get_weather',
                    args: { city: 'Paris' }
                  }
                }
              ]
            }
          }
        ]
      })}\n\n`,
      'gemini-3.8-flash',
      state
    )
    const chunk = JSON.parse(output.match(/^data: (.+)$/m)[1])

    expect(chunk.choices[0].delta.tool_calls[0]).toMatchObject({
      id: 'call_stream_weather',
      extra_content: {
        google: { thought_signature: 'stream-signed-reasoning-state' }
      }
    })
  })

  it('restores signatures, call ids, and grouped tool responses for Gemini', () => {
    const request = unifiedRoutes.buildGeminiRequestFromOpenAI({
      messages: [
        { role: 'user', content: 'Compare Paris and London weather.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_paris',
              type: 'function',
              extra_content: {
                google: { thought_signature: 'signed-reasoning-state' }
              },
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' }
            },
            {
              id: 'call_london',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"London"}' }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_paris',
          content: '{"temperature":15}'
        },
        {
          role: 'tool',
          tool_call_id: 'call_london',
          content: '{"temperature":12}'
        }
      ]
    })

    expect(request.contents[1]).toEqual({
      role: 'model',
      parts: [
        {
          thought: true,
          thoughtSignature: 'signed-reasoning-state',
          functionCall: {
            id: 'call_paris',
            name: 'get_weather',
            args: { city: 'Paris' }
          }
        },
        {
          thought: true,
          thoughtSignature: 'skip_thought_signature_validator',
          functionCall: {
            id: 'call_london',
            name: 'get_weather',
            args: { city: 'London' }
          }
        }
      ]
    })
    expect(request.contents[2]).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'call_paris',
            name: 'get_weather',
            response: { temperature: 15 }
          }
        },
        {
          functionResponse: {
            id: 'call_london',
            name: 'get_weather',
            response: { temperature: 12 }
          }
        }
      ]
    })
  })
})

describe('Google Gemini native base URL compatibility', () => {
  it.each(['generateContent', 'streamGenerateContent', 'countTokens'])(
    'registers the unversioned /models/:model:%s route',
    (action) => {
      const expectedPath = `/models/:modelName\\:${action}`
      const route = standardGeminiRoutes.stack.find(
        (layer) => layer.route?.path === expectedPath && layer.route.methods.post
      )

      expect(route).toBeDefined()
    }
  )

  it('mounts Google Gemini native routes on /api', () => {
    const appSource = require('fs').readFileSync(require.resolve('../src/app'), 'utf8')

    expect(appSource).toContain("this.app.use('/api', standardGeminiRoutes)")
  })
})
