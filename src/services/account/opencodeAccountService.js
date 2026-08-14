const { v4: uuidv4 } = require('uuid')
const ProxyHelper = require('../../utils/proxyHelper')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const { createEncryptor } = require('../../utils/commonHelper')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const { stripLongContextSuffix } = require('../../utils/modelHelper')

// opencode zen 默认 base URL（Go 套餐）
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'

// 上游支持的三种协议格式
const FORMATS = ['responses', 'messages', 'chat']

// 「模型不支持某协议格式」的负缓存有效期（秒），到期后重新探测，模型能力变化可自愈
const FORMAT_CACHE_TTL = 7 * 24 * 60 * 60

class OpencodeAccountService {
  constructor() {
    // Redis键前缀
    this.ACCOUNT_KEY_PREFIX = 'opencode_account:'
    this.SHARED_ACCOUNTS_KEY = 'shared_opencode_accounts'
    this.FORMAT_CACHE_PREFIX = 'opencode_fmt_unsupported:'

    // 使用 commonHelper 的加密器
    this._encryptor = createEncryptor('opencode-account-salt')

    // 🧹 定期清理缓存（每10分钟）
    setInterval(
      () => {
        this._encryptor.clearCache()
        logger.info(
          '🧹 Opencode account decrypt cache cleanup completed',
          this._encryptor.getStats()
        )
      },
      10 * 60 * 1000
    )
  }

  // 🏢 创建 opencode 账户
  async createAccount(options = {}) {
    const {
      name = 'Opencode Account',
      description = '',
      baseUrl = DEFAULT_BASE_URL,
      apiKey = '',
      priority = 50, // 默认优先级50（1-100）
      supportedModels = [], // 支持的模型列表或映射表，空数组/对象表示支持所有
      userAgent = '',
      rateLimitDuration = 60, // 限流时间（分钟）
      proxy = null,
      isActive = true,
      accountType = 'shared', // 'dedicated' or 'shared'
      schedulable = true, // 是否可被调度
      dailyQuota = 0, // 每日额度限制（美元），0表示不限制
      quotaResetTime = '00:00', // 额度重置时间（HH:mm格式）
      disableAutoProtection = false // 是否关闭自动防护（429/401/400/529 不自动禁用）
    } = options

    // 验证必填字段
    if (!apiKey) {
      throw new Error('API Key is required for Opencode account')
    }

    const accountId = uuidv4()

    // 处理 supportedModels，确保向后兼容
    const processedModels = this._processModelMapping(supportedModels)

    const accountData = {
      id: accountId,
      platform: 'opencode',
      name,
      description,
      baseUrl: this._normalizeBaseUrl(baseUrl),
      apiKey: this._encryptSensitiveData(apiKey),
      priority: priority.toString(),
      supportedModels: JSON.stringify(processedModels),
      userAgent,
      rateLimitDuration: rateLimitDuration.toString(),
      proxy: proxy ? JSON.stringify(proxy) : '',
      isActive: isActive.toString(),
      accountType,

      // 账户订阅到期时间（业务字段，手动管理）
      // 注意：opencode 使用 API Key 认证，没有 OAuth token，因此没有 expiresAt
      subscriptionExpiresAt: options.subscriptionExpiresAt || null,

      createdAt: new Date().toISOString(),
      lastUsedAt: '',
      status: 'active',
      errorMessage: '',
      // 限流相关
      rateLimitedAt: '',
      rateLimitStatus: '',
      // 调度控制
      schedulable: schedulable.toString(),
      // 额度管理相关
      dailyQuota: dailyQuota.toString(),
      dailyUsage: '0',
      lastResetDate: redis.getDateStringInTimezone(),
      quotaResetTime,
      quotaStoppedAt: '',
      disableAutoProtection: disableAutoProtection.toString()
    }

    const client = redis.getClientSafe()
    await client.hset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, accountData)
    await redis.addToIndex('opencode_account:index', accountId)

    // 如果是共享账户，添加到共享账户集合
    if (accountType === 'shared') {
      await client.sadd(this.SHARED_ACCOUNTS_KEY, accountId)
    }

    logger.success(`🏢 Created Opencode account: ${name} (${accountId})`)

    return {
      id: accountId,
      name,
      description,
      baseUrl: accountData.baseUrl,
      priority,
      supportedModels: processedModels,
      userAgent,
      rateLimitDuration,
      isActive,
      proxy,
      accountType,
      status: 'active',
      createdAt: accountData.createdAt,
      dailyQuota,
      dailyUsage: 0,
      lastResetDate: accountData.lastResetDate,
      quotaResetTime,
      quotaStoppedAt: null
    }
  }

  // 📋 获取所有 opencode 账户
  async getAllAccounts() {
    try {
      const accountIds = await redis.getAllIdsByIndex(
        'opencode_account:index',
        `${this.ACCOUNT_KEY_PREFIX}*`,
        /^opencode_account:(.+)$/
      )
      const keys = accountIds.map((id) => `${this.ACCOUNT_KEY_PREFIX}${id}`)
      const accounts = []
      const dataList = await redis.batchHgetallChunked(keys)

      for (let i = 0; i < keys.length; i++) {
        const accountData = dataList[i]
        if (accountData && Object.keys(accountData).length > 0) {
          const rateLimitInfo = this._getRateLimitInfo(accountData)

          accounts.push({
            id: accountData.id,
            platform: accountData.platform,
            name: accountData.name,
            description: accountData.description,
            baseUrl: accountData.baseUrl || DEFAULT_BASE_URL,
            priority: parseInt(accountData.priority) || 50,
            supportedModels: JSON.parse(accountData.supportedModels || '[]'),
            userAgent: accountData.userAgent,
            rateLimitDuration: Number.isNaN(parseInt(accountData.rateLimitDuration))
              ? 60
              : parseInt(accountData.rateLimitDuration),
            isActive: accountData.isActive === 'true',
            proxy: accountData.proxy ? JSON.parse(accountData.proxy) : null,
            accountType: accountData.accountType || 'shared',
            createdAt: accountData.createdAt,
            lastUsedAt: accountData.lastUsedAt,
            status: accountData.status || 'active',
            errorMessage: accountData.errorMessage,
            rateLimitInfo,
            schedulable: accountData.schedulable !== 'false',

            // 前端显示订阅过期时间（业务字段）
            expiresAt: accountData.subscriptionExpiresAt || null,

            // 额度管理相关
            dailyQuota: parseFloat(accountData.dailyQuota || '0'),
            dailyUsage: parseFloat(accountData.dailyUsage || '0'),
            lastResetDate: accountData.lastResetDate || '',
            quotaResetTime: accountData.quotaResetTime || '00:00',
            quotaStoppedAt: accountData.quotaStoppedAt || null,
            disableAutoProtection: accountData.disableAutoProtection === 'true'
          })
        }
      }

      return accounts
    } catch (error) {
      logger.error('❌ Failed to get Opencode accounts:', error)
      throw error
    }
  }

  // 🔍 获取单个账户（内部使用，包含敏感信息）
  async getAccount(accountId) {
    const client = redis.getClientSafe()
    const accountData = await client.hgetall(`${this.ACCOUNT_KEY_PREFIX}${accountId}`)

    if (!accountData || Object.keys(accountData).length === 0) {
      return null
    }

    accountData.apiKey = this._decryptSensitiveData(accountData.apiKey)
    accountData.baseUrl = accountData.baseUrl || DEFAULT_BASE_URL
    accountData.supportedModels = JSON.parse(accountData.supportedModels || '[]')
    accountData.priority = parseInt(accountData.priority) || 50
    {
      const _parsedDuration = parseInt(accountData.rateLimitDuration)
      accountData.rateLimitDuration = Number.isNaN(_parsedDuration) ? 60 : _parsedDuration
    }
    accountData.isActive = accountData.isActive === 'true'
    accountData.schedulable = accountData.schedulable !== 'false'
    accountData.disableAutoProtection = accountData.disableAutoProtection === 'true'

    if (accountData.proxy) {
      accountData.proxy = JSON.parse(accountData.proxy)
    }

    return accountData
  }

  // 📝 更新账户
  async updateAccount(accountId, updates) {
    try {
      const existingAccount = await this.getAccount(accountId)
      if (!existingAccount) {
        throw new Error('Opencode Account not found')
      }

      const client = redis.getClientSafe()
      const updatedData = {}

      if (updates.name !== undefined) {
        updatedData.name = updates.name
      }
      if (updates.description !== undefined) {
        updatedData.description = updates.description
      }
      if (updates.baseUrl !== undefined) {
        updatedData.baseUrl = this._normalizeBaseUrl(updates.baseUrl)
      }
      if (updates.apiKey !== undefined) {
        updatedData.apiKey = this._encryptSensitiveData(updates.apiKey)
      }
      if (updates.priority !== undefined) {
        updatedData.priority = updates.priority.toString()
      }
      if (updates.supportedModels !== undefined) {
        const processedModels = this._processModelMapping(updates.supportedModels)
        updatedData.supportedModels = JSON.stringify(processedModels)
      }
      if (updates.userAgent !== undefined) {
        updatedData.userAgent = updates.userAgent
      }
      if (updates.rateLimitDuration !== undefined) {
        updatedData.rateLimitDuration = updates.rateLimitDuration.toString()
      }
      if (updates.proxy !== undefined) {
        updatedData.proxy = updates.proxy ? JSON.stringify(updates.proxy) : ''
      }
      if (updates.isActive !== undefined) {
        updatedData.isActive = updates.isActive.toString()
      }
      if (updates.schedulable !== undefined) {
        updatedData.schedulable = updates.schedulable.toString()
      }
      if (updates.dailyQuota !== undefined) {
        updatedData.dailyQuota = updates.dailyQuota.toString()
      }
      if (updates.quotaResetTime !== undefined) {
        updatedData.quotaResetTime = updates.quotaResetTime
      }
      if (updates.subscriptionExpiresAt !== undefined) {
        updatedData.subscriptionExpiresAt = updates.subscriptionExpiresAt
      }
      if (updates.disableAutoProtection !== undefined) {
        updatedData.disableAutoProtection = updates.disableAutoProtection.toString()
      }

      // accountType / groupId 不落在这些字段里，只改它们时 updatedData 会是空对象，
      // 直接 hset 会报 "wrong number of arguments"
      if (updates.accountType !== undefined) {
        updatedData.accountType = updates.accountType
      }

      if (Object.keys(updatedData).length > 0) {
        await client.hset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, updatedData)
      }

      // 处理共享账户集合变更
      if (updates.accountType !== undefined) {
        if (updates.accountType === 'shared') {
          await client.sadd(this.SHARED_ACCOUNTS_KEY, accountId)
        } else {
          await client.srem(this.SHARED_ACCOUNTS_KEY, accountId)
        }
      }

      logger.success(`📝 Updated Opencode account: ${accountId}`)
      return await this.getAccount(accountId)
    } catch (error) {
      logger.error(`❌ Failed to update Opencode account ${accountId}:`, error)
      throw error
    }
  }

  // 🗑️ 删除账户
  async deleteAccount(accountId) {
    try {
      const client = redis.getClientSafe()

      await client.srem(this.SHARED_ACCOUNTS_KEY, accountId)
      await redis.removeFromIndex('opencode_account:index', accountId)

      const result = await client.del(`${this.ACCOUNT_KEY_PREFIX}${accountId}`)

      if (result === 0) {
        throw new Error('Opencode Account not found or already deleted')
      }

      logger.success(`🗑️ Deleted Opencode account: ${accountId}`)
      return { success: true }
    } catch (error) {
      logger.error(`❌ Failed to delete Opencode account ${accountId}:`, error)
      throw error
    }
  }

  // 🧭 记录「某模型不支持某协议格式」，后续该模型直接走回落
  async markFormatUnsupported(accountId, model, format) {
    if (!accountId || !model || !FORMATS.includes(format)) {
      return
    }

    try {
      const client = redis.getClientSafe()
      const key = `${this.FORMAT_CACHE_PREFIX}${accountId}:${format}:${model}`
      await client.set(key, '1', 'EX', FORMAT_CACHE_TTL)
      logger.info(`🧭 Opencode model ${model} marked as unsupported for format ${format}`)
    } catch (error) {
      logger.warn(`⚠️ Failed to cache format support for ${model}/${format}:`, error.message)
    }
  }

  // 🔍 查询「某模型是否已知不支持某协议格式」
  async isFormatUnsupported(accountId, model, format) {
    if (!accountId || !model || !FORMATS.includes(format)) {
      return false
    }

    try {
      const client = redis.getClientSafe()
      const key = `${this.FORMAT_CACHE_PREFIX}${accountId}:${format}:${model}`
      return (await client.exists(key)) === 1
    } catch (error) {
      logger.warn(`⚠️ Failed to read format support for ${model}/${format}:`, error.message)
      return false
    }
  }

  // 🧹 清空某账户的协议格式负缓存
  async clearFormatCache(accountId) {
    try {
      const client = redis.getClientSafe()
      const keys = await client.keys(`${this.FORMAT_CACHE_PREFIX}${accountId}:*`)
      if (keys.length > 0) {
        await client.del(...keys)
      }
      return { success: true, cleared: keys.length }
    } catch (error) {
      logger.error(`❌ Failed to clear format cache for Opencode account ${accountId}:`, error)
      return { success: false, cleared: 0 }
    }
  }

  // 🚫 标记账户为限流状态
  async markAccountRateLimited(accountId) {
    try {
      const client = redis.getClientSafe()
      const account = await this.getAccount(accountId)
      if (!account) {
        throw new Error('Opencode Account not found')
      }

      if (account.disableAutoProtection === true || account.disableAutoProtection === 'true') {
        logger.info(
          `🛡️ Account ${accountId} has auto-protection disabled, skipping markAccountRateLimited`
        )
        upstreamErrorHelper
          .recordErrorHistory(accountId, 'opencode', 429, 'rate_limit')
          .catch(() => {})
        return { success: true, skipped: true }
      }

      if (account.rateLimitDuration === 0) {
        logger.info(
          `ℹ️ Opencode account ${account.name} (${accountId}) has rate limiting disabled, skipping rate limit`
        )
        return { success: true, skipped: true }
      }

      const now = new Date().toISOString()
      await client.hmset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, {
        status: 'rate_limited',
        rateLimitedAt: now,
        rateLimitStatus: 'active',
        errorMessage: 'Rate limited by upstream service'
      })

      logger.warn(`⏱️ Marked Opencode account as rate limited: ${account.name} (${accountId})`)
      return { success: true, rateLimitedAt: now }
    } catch (error) {
      logger.error(`❌ Failed to mark Opencode account as rate limited: ${accountId}`, error)
      throw error
    }
  }

  // ✅ 移除账户限流状态
  async removeAccountRateLimit(accountId) {
    try {
      const client = redis.getClientSafe()
      const accountKey = `${this.ACCOUNT_KEY_PREFIX}${accountId}`

      const [, quotaStoppedAt] = await client.hmget(accountKey, 'status', 'quotaStoppedAt')

      await client.hdel(accountKey, 'rateLimitedAt', 'rateLimitStatus')

      let newStatus = 'active'
      let errorMessage = ''

      if (quotaStoppedAt) {
        newStatus = 'quota_exceeded'
        errorMessage = 'Account stopped due to quota exceeded'
        logger.info(
          `ℹ️ Opencode account ${accountId} rate limit removed but remains stopped due to quota exceeded`
        )
      } else {
        logger.success(`Removed rate limit for Opencode account: ${accountId}`)
      }

      await client.hmset(accountKey, {
        status: newStatus,
        errorMessage
      })

      return { success: true, newStatus }
    } catch (error) {
      logger.error(`❌ Failed to remove rate limit for Opencode account: ${accountId}`, error)
      throw error
    }
  }

  // 🔍 检查账户是否被限流
  async isAccountRateLimited(accountId) {
    try {
      const client = redis.getClientSafe()
      const accountKey = `${this.ACCOUNT_KEY_PREFIX}${accountId}`
      const [rateLimitedAt, rateLimitDuration] = await client.hmget(
        accountKey,
        'rateLimitedAt',
        'rateLimitDuration'
      )

      if (rateLimitedAt) {
        const limitTime = new Date(rateLimitedAt)
        const duration = parseInt(rateLimitDuration) || 60
        const now = new Date()
        const expireTime = new Date(limitTime.getTime() + duration * 60 * 1000)

        if (now < expireTime) {
          return true
        } else {
          await this.removeAccountRateLimit(accountId)
          return false
        }
      }
      return false
    } catch (error) {
      logger.error(`❌ Failed to check rate limit status for Opencode account: ${accountId}`, error)
      return false
    }
  }

  // 🚫 标记账户为未授权状态
  async markAccountUnauthorized(accountId) {
    try {
      const client = redis.getClientSafe()
      const account = await this.getAccount(accountId)
      if (!account) {
        throw new Error('Opencode Account not found')
      }

      if (account.disableAutoProtection === true || account.disableAutoProtection === 'true') {
        logger.info(
          `🛡️ Account ${accountId} has auto-protection disabled, skipping markAccountUnauthorized`
        )
        upstreamErrorHelper
          .recordErrorHistory(accountId, 'opencode', 401, 'auth_error')
          .catch(() => {})
        return { success: true, skipped: true }
      }

      await client.hmset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, {
        status: 'unauthorized',
        errorMessage: 'API key invalid or unauthorized'
      })

      logger.warn(`🚫 Marked Opencode account as unauthorized: ${account.name} (${accountId})`)
      return { success: true }
    } catch (error) {
      logger.error(`❌ Failed to mark Opencode account as unauthorized: ${accountId}`, error)
      throw error
    }
  }

  // 🔄 处理模型映射
  _processModelMapping(supportedModels) {
    if (!supportedModels || (Array.isArray(supportedModels) && supportedModels.length === 0)) {
      return {}
    }

    if (typeof supportedModels === 'object' && !Array.isArray(supportedModels)) {
      return supportedModels
    }

    if (Array.isArray(supportedModels)) {
      const mapping = {}
      supportedModels.forEach((model) => {
        if (model && typeof model === 'string') {
          mapping[model] = model
        }
      })
      return mapping
    }

    return {}
  }

  // 🔍 检查模型是否被支持
  isModelSupported(modelMapping, requestedModel) {
    const normalizedRequestedModel = stripLongContextSuffix(requestedModel)

    if (!modelMapping || Object.keys(modelMapping).length === 0) {
      return true
    }
    if (!normalizedRequestedModel || typeof normalizedRequestedModel !== 'string') {
      return false
    }

    if (
      Object.prototype.hasOwnProperty.call(modelMapping, requestedModel) ||
      Object.prototype.hasOwnProperty.call(modelMapping, normalizedRequestedModel)
    ) {
      return true
    }

    const requestedModelLower = normalizedRequestedModel.toLowerCase()
    for (const key of Object.keys(modelMapping)) {
      if (key.toLowerCase() === requestedModelLower) {
        return true
      }
    }

    return false
  }

  // 🔄 获取映射后的模型名称
  getMappedModel(modelMapping, requestedModel) {
    const normalizedRequestedModel = stripLongContextSuffix(requestedModel)

    if (!modelMapping || Object.keys(modelMapping).length === 0) {
      return normalizedRequestedModel
    }
    if (!normalizedRequestedModel || typeof normalizedRequestedModel !== 'string') {
      return requestedModel
    }

    if (modelMapping[requestedModel]) {
      return modelMapping[requestedModel]
    }
    if (modelMapping[normalizedRequestedModel]) {
      return modelMapping[normalizedRequestedModel]
    }

    const requestedModelLower = normalizedRequestedModel.toLowerCase()
    for (const [key, value] of Object.entries(modelMapping)) {
      if (key.toLowerCase() === requestedModelLower) {
        return value
      }
    }

    return normalizedRequestedModel
  }

  // 🔗 规范化 base URL（去掉末尾斜杠）
  _normalizeBaseUrl(baseUrl) {
    const trimmed = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
    return trimmed || DEFAULT_BASE_URL
  }

  // 🔐 加密敏感数据
  _encryptSensitiveData(data) {
    return this._encryptor.encrypt(data)
  }

  // 🔓 解密敏感数据
  _decryptSensitiveData(encryptedData) {
    return this._encryptor.decrypt(encryptedData)
  }

  // 🔍 获取限流状态信息
  _getRateLimitInfo(accountData) {
    const { rateLimitedAt } = accountData
    const rateLimitDuration = parseInt(accountData.rateLimitDuration) || 60

    if (rateLimitedAt) {
      const limitTime = new Date(rateLimitedAt)
      const now = new Date()
      const expireTime = new Date(limitTime.getTime() + rateLimitDuration * 60 * 1000)
      const remainingMs = expireTime.getTime() - now.getTime()

      return {
        isRateLimited: remainingMs > 0,
        rateLimitedAt,
        rateLimitExpireAt: expireTime.toISOString(),
        remainingTimeMs: Math.max(0, remainingMs),
        remainingTimeMinutes: Math.max(0, Math.ceil(remainingMs / (60 * 1000)))
      }
    }

    return {
      isRateLimited: false,
      rateLimitedAt: null,
      rateLimitExpireAt: null,
      remainingTimeMs: 0,
      remainingTimeMinutes: 0
    }
  }

  // 🔧 创建代理客户端
  _createProxyAgent(proxy) {
    return ProxyHelper.createProxyAgent(proxy)
  }

  // 🔄 重置每日使用量
  async resetDailyUsage(accountId) {
    try {
      const client = redis.getClientSafe()
      await client.hmset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, {
        dailyUsage: '0',
        lastResetDate: redis.getDateStringInTimezone(),
        quotaStoppedAt: ''
      })
      return { success: true }
    } catch (error) {
      logger.error(`❌ Failed to reset daily usage for Opencode account: ${accountId}`, error)
      throw error
    }
  }

  // 🚫 检查账户是否超额
  async isAccountQuotaExceeded(accountId) {
    try {
      const account = await this.getAccount(accountId)
      if (!account) {
        return false
      }

      const dailyQuota = parseFloat(account.dailyQuota || '0')
      if (dailyQuota <= 0) {
        return false
      }

      const usageStats = await this.getAccountUsageStats(accountId)
      if (!usageStats) {
        return false
      }

      const dailyUsage = usageStats.dailyUsage || 0
      const isExceeded = dailyUsage >= dailyQuota

      if (isExceeded && !account.quotaStoppedAt) {
        const client = redis.getClientSafe()
        await client.hmset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, {
          status: 'quota_exceeded',
          errorMessage: `Daily quota exceeded: $${dailyUsage.toFixed(2)} / $${dailyQuota.toFixed(2)}`,
          quotaStoppedAt: new Date().toISOString()
        })
        logger.warn(`💰 Opencode account ${account.name} (${accountId}) quota exceeded`)
      }

      return isExceeded
    } catch (error) {
      logger.error(`❌ Failed to check quota for Opencode account ${accountId}:`, error)
      return false
    }
  }

  // 🔄 重置所有 opencode 账户的每日使用量
  async resetAllDailyUsage() {
    try {
      const accounts = await this.getAllAccounts()
      const today = redis.getDateStringInTimezone()
      let resetCount = 0

      for (const account of accounts) {
        if (account.lastResetDate !== today) {
          await this.resetDailyUsage(account.id)
          resetCount += 1
        }
      }

      logger.success(`Reset daily usage for ${resetCount} Opencode accounts`)
      return { success: true, resetCount }
    } catch (error) {
      logger.error('❌ Failed to reset all Opencode daily usage:', error)
      throw error
    }
  }

  // 📊 获取账户使用统计（含每日费用）
  async getAccountUsageStats(accountId) {
    try {
      const usageStats = await redis.getAccountUsageStats(accountId)

      const accountData = await this.getAccount(accountId)
      if (!accountData) {
        return null
      }

      const dailyQuota = parseFloat(accountData.dailyQuota || '0')
      const currentDailyCost = usageStats?.daily?.cost || 0

      return {
        dailyQuota,
        dailyUsage: currentDailyCost,
        remainingQuota: dailyQuota > 0 ? Math.max(0, dailyQuota - currentDailyCost) : null,
        usagePercentage: dailyQuota > 0 ? (currentDailyCost / dailyQuota) * 100 : 0,
        lastResetDate: accountData.lastResetDate,
        quotaResetTime: accountData.quotaResetTime,
        quotaStoppedAt: accountData.quotaStoppedAt,
        isQuotaExceeded: dailyQuota > 0 && currentDailyCost >= dailyQuota,
        fullUsageStats: usageStats
      }
    } catch (error) {
      logger.error('❌ Failed to get Opencode account usage stats:', error)
      return null
    }
  }

  // 🔄 重置账户所有异常状态
  async resetAccountStatus(accountId) {
    try {
      const accountData = await this.getAccount(accountId)
      if (!accountData) {
        throw new Error('Account not found')
      }

      const client = redis.getClientSafe()
      const accountKey = `${this.ACCOUNT_KEY_PREFIX}${accountId}`

      const updates = {
        status: 'active',
        errorMessage: '',
        schedulable: 'true',
        isActive: 'true'
      }

      const fieldsToDelete = [
        'rateLimitedAt',
        'rateLimitStatus',
        'unauthorizedAt',
        'unauthorizedCount',
        'overloadedAt',
        'overloadStatus',
        'blockedAt',
        'quotaStoppedAt'
      ]

      await client.hset(accountKey, updates)
      await client.hdel(accountKey, ...fieldsToDelete)

      logger.success(`Reset all error status for Opencode account ${accountId}`)

      await upstreamErrorHelper.clearTempUnavailable(accountId, 'opencode').catch(() => {})

      try {
        const webhookNotifier = require('../../utils/webhookNotifier')
        await webhookNotifier.sendAccountAnomalyNotification({
          accountId,
          accountName: accountData.name || accountId,
          platform: 'opencode',
          status: 'recovered',
          errorCode: 'STATUS_RESET',
          reason: 'Account status manually reset',
          timestamp: new Date().toISOString()
        })
      } catch (webhookError) {
        logger.warn('Failed to send webhook notification for Opencode status reset:', webhookError)
      }

      return { success: true, accountId }
    } catch (error) {
      logger.error(`❌ Failed to reset Opencode account status: ${accountId}`, error)
      throw error
    }
  }

  // 📋 获取所有可调度账户（供调度器使用，含解密后的 apiKey）
  async getSchedulableAccounts() {
    const accounts = await this.getAllAccounts()
    const schedulable = []

    for (const account of accounts) {
      if (!account.isActive || !account.schedulable) {
        continue
      }
      if ((account.status || 'active').toLowerCase() !== 'active') {
        continue
      }
      if (this.isSubscriptionExpired({ subscriptionExpiresAt: account.expiresAt })) {
        logger.debug(
          `⏰ Skipping expired Opencode account: ${account.name}, expired at ${account.expiresAt}`
        )
        continue
      }

      const full = await this.getAccount(account.id)
      if (full) {
        schedulable.push(full)
      }
    }

    return schedulable
  }

  // 🕐 更新最后使用时间
  async touchLastUsedAt(accountId) {
    try {
      const client = redis.getClientSafe()
      const accountKey = `${this.ACCOUNT_KEY_PREFIX}${accountId}`
      if (!(await client.exists(accountKey))) {
        return
      }
      await client.hset(accountKey, 'lastUsedAt', new Date().toISOString())
    } catch (error) {
      logger.warn(
        `⚠️ Failed to update last used time for Opencode account ${accountId}:`,
        error.message
      )
    }
  }

  /**
   * ⏰ 检查账户订阅是否过期
   * @param {Object} account - 账户对象
   * @returns {boolean} - true: 已过期, false: 未过期
   */
  isSubscriptionExpired(account) {
    if (!account.subscriptionExpiresAt) {
      return false
    }
    const expiryDate = new Date(account.subscriptionExpiresAt)
    return expiryDate <= new Date()
  }
}

module.exports = new OpencodeAccountService()
module.exports.DEFAULT_BASE_URL = DEFAULT_BASE_URL
module.exports.FORMATS = FORMATS
