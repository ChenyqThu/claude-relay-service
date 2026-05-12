jest.mock('../config/config', () => ({
  requestTimeout: 1000
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  recordUsage: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  updateCodexUsageSnapshot: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  markAccountRateLimited: jest.fn(),
  markAccountUnauthorized: jest.fn()
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn(() => null),
  extractOpenAICacheReadTokens: jest.fn(() => 0)
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  sanitizeErrorForClient: jest.fn((payload) => payload),
  markTempUnavailable: jest.fn()
}))

const openaiImageRelayService = require('../src/services/relay/openaiImageRelayService')

describe('openaiImageRelayService helpers', () => {
  test('builds Codex Responses payload for image generations', () => {
    const payload = openaiImageRelayService.buildImagesResponsesRequest({
      prompt: 'draw a launch screen',
      action: 'generate',
      source: {
        model: 'gpt-image-2',
        size: '3840x2160',
        quality: 'high',
        output_format: 'webp',
        output_compression: 80,
        partial_images: 2
      }
    })

    expect(payload.model).toBe(openaiImageRelayService.DEFAULT_IMAGES_MAIN_MODEL)
    expect(payload.stream).toBe(true)
    expect(payload.store).toBe(false)
    expect(payload.tool_choice).toEqual({ type: 'image_generation' })
    expect(payload.input[0].content).toEqual([
      {
        type: 'input_text',
        text: 'draw a launch screen'
      }
    ])
    expect(payload.tools).toEqual([
      {
        type: 'image_generation',
        action: 'generate',
        model: 'gpt-image-2',
        size: '3840x2160',
        quality: 'high',
        output_format: 'webp',
        output_compression: 80,
        partial_images: 2
      }
    ])
  })

  test('builds Codex Responses payload for image edits with image and mask inputs', () => {
    const payload = openaiImageRelayService.buildImagesResponsesRequest({
      prompt: 'make it cinematic',
      images: ['data:image/png;base64,aW1n'],
      action: 'edit',
      source: {
        input_fidelity: 'high',
        background: 'transparent'
      },
      maskImageURL: 'data:image/png;base64,bWFzaw=='
    })

    expect(payload.input[0].content).toEqual([
      {
        type: 'input_text',
        text: 'make it cinematic'
      },
      {
        type: 'input_image',
        image_url: 'data:image/png;base64,aW1n'
      }
    ])
    expect(payload.tools[0]).toMatchObject({
      type: 'image_generation',
      action: 'edit',
      model: 'gpt-image-2',
      input_fidelity: 'high',
      background: 'transparent',
      input_image_mask: {
        image_url: 'data:image/png;base64,bWFzaw=='
      }
    })
  })

  test('extracts completed Codex image output and builds Image API response', () => {
    const completed = {
      type: 'response.completed',
      response: {
        created_at: 1770000000,
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
          {
            type: 'image_generation_call',
            result: 'aW1hZ2U=',
            output_format: 'png',
            revised_prompt: 'A sharper prompt',
            size: '3840x2160',
            quality: 'high'
          }
        ],
        tool_usage: {
          image_gen: {
            input_tokens: 12,
            output_tokens: 34,
            total_tokens: 46
          }
        }
      }
    }

    const extracted = openaiImageRelayService.extractImageResultsFromCompleted(completed)
    const response = openaiImageRelayService.buildImagesAPIResponse({
      ...extracted,
      responseFormat: 'b64_json'
    })

    expect(response).toEqual({
      created: 1770000000,
      data: [
        {
          b64_json: 'aW1hZ2U=',
          revised_prompt: 'A sharper prompt'
        }
      ],
      output_format: 'png',
      quality: 'high',
      size: '3840x2160',
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        total_tokens: 46
      }
    })
  })

  test('patches completed events from response.output_item.done image calls', () => {
    const completed = {
      type: 'response.completed',
      response: {
        created_at: 1770000000,
        output: [],
        tool_usage: {
          image_gen: {
            input_tokens: 1,
            output_tokens: 2,
            total_tokens: 3
          }
        }
      }
    }
    const outputItem = openaiImageRelayService.extractImageOutputItemDone({
      type: 'response.output_item.done',
      item: {
        id: 'ig_1',
        type: 'image_generation_call',
        result: 'aW1hZ2U=',
        output_format: 'png'
      }
    })

    const patched = openaiImageRelayService.completedWithFallbackOutputItems(completed, [
      outputItem
    ])
    const extracted = openaiImageRelayService.extractImageResultsFromCompleted(patched)

    expect(extracted.results).toEqual([
      expect.objectContaining({
        result: 'aW1hZ2U=',
        outputFormat: 'png'
      })
    ])
    expect(extracted.usage).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3
    })
  })

  test('builds Codex image headers that match the Codex TUI route', () => {
    const headers = openaiImageRelayService._buildCodexHeaders(
      {
        headers: {
          version: '1',
          originator: 'custom-originator'
        }
      },
      {
        accessToken: 'access-token',
        accountId: 'account-1',
        account: {
          accountId: 'chatgpt-account-id'
        }
      },
      true
    )

    expect(headers.authorization).toBe('Bearer access-token')
    expect(headers['chatgpt-account-id']).toBe('chatgpt-account-id')
    expect(headers['user-agent']).toBe(openaiImageRelayService.CODEX_IMAGE_USER_AGENT)
    expect(headers.originator).toBe('custom-originator')
    expect(headers.connection).toBe('Keep-Alive')
    expect(headers.session_id).toEqual(expect.any(String))
    expect(headers['x-client-request-id']).toEqual(expect.any(String))
  })
})
