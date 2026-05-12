const logger = require('../utils/logger')
const modelsConfig = require('../../config/models')
const modelPricing = require('../../data/model_pricing.json')
const { stripLongContextSuffix } = require('../utils/modelHelper')

/**
 * 模型服务
 * 管理系统支持的 AI 模型列表
 * 与 pricingService 独立，专注于"支持哪些模型"而不是"如何计费"
 */
class ModelService {
  constructor() {
    this.supportedModels = this.getDefaultModels()
  }

  /**
   * 初始化模型服务
   */
  async initialize() {
    const totalModels = Object.values(this.supportedModels).reduce(
      (sum, config) => sum + config.models.length,
      0
    )
    logger.success(`Model service initialized with ${totalModels} models`)
  }

  /**
   * 获取支持的模型配置
   */
  getDefaultModels() {
    return {
      claude: {
        provider: 'anthropic',
        description: 'Claude models from Anthropic',
        models: modelsConfig.CLAUDE_MODELS.map((model) => model.value)
      },
      openai: {
        provider: 'openai',
        description: 'OpenAI GPT models',
        models: modelsConfig.OPENAI_MODELS.map((model) => model.value)
      },
      gemini: {
        provider: 'google',
        description: 'Google Gemini models',
        models: modelsConfig.GEMINI_MODELS.map((model) => model.value)
      }
    }
  }

  /**
   * 获取所有支持的模型（OpenAI API 格式）
   */
  getAllModels() {
    const models = []
    const now = Math.floor(Date.now() / 1000)

    for (const [_service, config] of Object.entries(this.supportedModels)) {
      for (const modelId of config.models) {
        const pricing = modelPricing[stripLongContextSuffix(modelId)]
        const model = {
          id: modelId,
          object: 'model',
          created: now,
          owned_by: config.provider
        }

        if (pricing?.max_input_tokens) {
          model.max_input_tokens = pricing.max_input_tokens
        }
        if (pricing?.max_tokens) {
          model.max_tokens = pricing.max_tokens
        }

        models.push(model)
      }
    }

    return models.sort((a, b) => {
      // 先按 provider 排序，再按 model id 排序
      if (a.owned_by !== b.owned_by) {
        return a.owned_by.localeCompare(b.owned_by)
      }
      return a.id.localeCompare(b.id)
    })
  }

  /**
   * 按 provider 获取模型
   * @param {string} provider - 'anthropic', 'openai', 'google' 等
   */
  getModelsByProvider(provider) {
    return this.getAllModels().filter((m) => m.owned_by === provider)
  }

  /**
   * 检查模型是否被支持
   * @param {string} modelId - 模型 ID
   */
  isModelSupported(modelId) {
    if (!modelId) {
      return false
    }
    return this.getAllModels().some((m) => m.id === modelId)
  }

  /**
   * 获取模型的 provider
   * @param {string} modelId - 模型 ID
   */
  getModelProvider(modelId) {
    const model = this.getAllModels().find((m) => m.id === modelId)
    return model ? model.owned_by : null
  }

  /**
   * 获取服务状态
   */
  getStatus() {
    const totalModels = Object.values(this.supportedModels).reduce(
      (sum, config) => sum + config.models.length,
      0
    )

    return {
      initialized: true,
      totalModels,
      providers: Object.keys(this.supportedModels)
    }
  }

  /**
   * 清理资源（保留接口兼容性）
   */
  cleanup() {
    logger.debug('📋 Model service cleanup (no-op)')
  }
}

module.exports = new ModelService()
