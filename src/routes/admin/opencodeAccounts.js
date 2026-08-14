const express = require('express')
const axios = require('axios')
const opencodeAccountService = require('../../services/account/opencodeAccountService')
const accountGroupService = require('../../services/accountGroupService')
const apiKeyService = require('../../services/apiKeyService')
const redis = require('../../models/redis')
const { authenticateAdmin } = require('../../middleware/auth')
const logger = require('../../utils/logger')
const webhookNotifier = require('../../utils/webhookNotifier')
const ProxyHelper = require('../../utils/proxyHelper')
const { formatAccountExpiry, mapExpiryField } = require('./utils')
const { extractErrorMessage } = require('../../utils/testPayloadHelper')

const router = express.Router()

// 🔧 Opencode 账户管理

// 获取所有 Opencode 账户
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const { platform, groupId } = req.query
    let accounts = await opencodeAccountService.getAllAccounts()

    if (platform && platform !== 'all' && platform !== 'opencode') {
      accounts = []
    }

    if (groupId && groupId !== 'all') {
      if (groupId === 'ungrouped') {
        const filteredAccounts = []
        for (const account of accounts) {
          const groups = await accountGroupService.getAccountGroups(account.id)
          if (!groups || groups.length === 0) {
            filteredAccounts.push(account)
          }
        }
        accounts = filteredAccounts
      } else {
        const groupMembers = await accountGroupService.getGroupMembers(groupId)
        accounts = accounts.filter((account) => groupMembers.includes(account.id))
      }
    }

    const accountsWithStats = await Promise.all(
      accounts.map(async (account) => {
        try {
          const usageStats = await redis.getAccountUsageStats(account.id)
          const groupInfos = await accountGroupService.getAccountGroups(account.id)

          const formattedAccount = formatAccountExpiry(account)
          return {
            ...formattedAccount,
            schedulable: account.schedulable === 'true' || account.schedulable === true,
            groupInfos,
            usage: {
              daily: usageStats.daily,
              total: usageStats.total,
              averages: usageStats.averages
            }
          }
        } catch (statsError) {
          logger.warn(
            `⚠️ Failed to get usage stats for Opencode account ${account.id}:`,
            statsError.message
          )
          return {
            ...account,
            groupInfos: [],
            usage: {
              daily: { tokens: 0, requests: 0, allTokens: 0 },
              total: { tokens: 0, requests: 0, allTokens: 0 },
              averages: { rpm: 0, tpm: 0 }
            }
          }
        }
      })
    )

    return res.json({ success: true, data: accountsWithStats })
  } catch (error) {
    logger.error('❌ Failed to get Opencode accounts:', error)
    return res
      .status(500)
      .json({ error: 'Failed to get Opencode accounts', message: error.message })
  }
})

// 创建新的 Opencode 账户
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      baseUrl,
      apiKey,
      priority,
      supportedModels,
      userAgent,
      rateLimitDuration,
      proxy,
      accountType,
      groupId,
      dailyQuota,
      quotaResetTime
    } = req.body

    if (!name || !apiKey) {
      return res.status(400).json({ error: 'Name and API Key are required' })
    }

    if (priority !== undefined && (priority < 1 || priority > 100)) {
      return res.status(400).json({ error: 'Priority must be between 1 and 100' })
    }

    if (accountType && !['shared', 'dedicated', 'group'].includes(accountType)) {
      return res
        .status(400)
        .json({ error: 'Invalid account type. Must be "shared", "dedicated" or "group"' })
    }

    if (accountType === 'group' && !groupId) {
      return res.status(400).json({ error: 'Group ID is required for group type accounts' })
    }

    const newAccount = await opencodeAccountService.createAccount({
      name,
      description,
      baseUrl: baseUrl || opencodeAccountService.DEFAULT_BASE_URL,
      apiKey,
      priority: priority || 50,
      supportedModels: supportedModels || [],
      userAgent,
      rateLimitDuration:
        rateLimitDuration !== undefined && rateLimitDuration !== null ? rateLimitDuration : 60,
      proxy,
      accountType: accountType || 'shared',
      dailyQuota: dailyQuota || 0,
      quotaResetTime: quotaResetTime || '00:00'
    })

    if (accountType === 'group' && groupId) {
      await accountGroupService.addAccountToGroup(newAccount.id, groupId, 'opencode')
    }

    logger.success(`🔧 Admin created Opencode account: ${name}`)
    return res.json({ success: true, data: formatAccountExpiry(newAccount) })
  } catch (error) {
    logger.error('❌ Failed to create Opencode account:', error)
    return res
      .status(500)
      .json({ error: 'Failed to create Opencode account', message: error.message })
  }
})

// 更新 Opencode 账户
router.put('/:accountId', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const mappedUpdates = mapExpiryField(req.body, 'Opencode', accountId)

    if (
      mappedUpdates.priority !== undefined &&
      (mappedUpdates.priority < 1 || mappedUpdates.priority > 100)
    ) {
      return res.status(400).json({ error: 'Priority must be between 1 and 100' })
    }

    if (
      mappedUpdates.accountType &&
      !['shared', 'dedicated', 'group'].includes(mappedUpdates.accountType)
    ) {
      return res
        .status(400)
        .json({ error: 'Invalid account type. Must be "shared", "dedicated" or "group"' })
    }

    if (mappedUpdates.accountType === 'group' && !mappedUpdates.groupId) {
      return res.status(400).json({ error: 'Group ID is required for group type accounts' })
    }

    const currentAccount = await opencodeAccountService.getAccount(accountId)
    if (!currentAccount) {
      return res.status(404).json({ error: 'Account not found' })
    }

    if (mappedUpdates.accountType !== undefined) {
      if (currentAccount.accountType === 'group') {
        const oldGroups = await accountGroupService.getAccountGroups(accountId)
        for (const oldGroup of oldGroups) {
          await accountGroupService.removeAccountFromGroup(accountId, oldGroup.id)
        }
      }
      if (mappedUpdates.accountType === 'group') {
        if (Object.prototype.hasOwnProperty.call(mappedUpdates, 'groupIds')) {
          if (mappedUpdates.groupIds && mappedUpdates.groupIds.length > 0) {
            await accountGroupService.setAccountGroups(
              accountId,
              mappedUpdates.groupIds,
              'opencode'
            )
          } else {
            await accountGroupService.removeAccountFromAllGroups(accountId)
          }
        } else if (mappedUpdates.groupId) {
          await accountGroupService.addAccountToGroup(accountId, mappedUpdates.groupId, 'opencode')
        }
      }
    }

    await opencodeAccountService.updateAccount(accountId, mappedUpdates)

    // base URL / 模型映射变化后，之前记录的协议格式负缓存可能失效
    if (mappedUpdates.baseUrl !== undefined || mappedUpdates.supportedModels !== undefined) {
      await opencodeAccountService.clearFormatCache(accountId)
    }

    logger.success(`📝 Admin updated Opencode account: ${accountId}`)
    return res.json({ success: true, message: 'Opencode account updated successfully' })
  } catch (error) {
    logger.error('❌ Failed to update Opencode account:', error)
    return res
      .status(500)
      .json({ error: 'Failed to update Opencode account', message: error.message })
  }
})

// 删除 Opencode 账户
router.delete('/:accountId', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params

    const unboundCount = await apiKeyService.unbindAccountFromAllKeys(accountId, 'opencode')

    const account = await opencodeAccountService.getAccount(accountId)
    if (account && account.accountType === 'group') {
      const groups = await accountGroupService.getAccountGroups(accountId)
      for (const group of groups) {
        await accountGroupService.removeAccountFromGroup(accountId, group.id)
      }
    }

    await opencodeAccountService.clearFormatCache(accountId)
    await opencodeAccountService.deleteAccount(accountId)

    let message = 'Opencode 账号已成功删除'
    if (unboundCount > 0) {
      message += `，${unboundCount} 个 API Key 已切换为共享池模式`
    }

    logger.success(`🗑️ Admin deleted Opencode account: ${accountId}`)
    return res.json({ success: true, message, unboundKeys: unboundCount })
  } catch (error) {
    logger.error('❌ Failed to delete Opencode account:', error)
    return res
      .status(500)
      .json({ error: 'Failed to delete Opencode account', message: error.message })
  }
})

// 切换账户启用状态
router.put('/:accountId/toggle', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params

    const account = await opencodeAccountService.getAccount(accountId)
    if (!account) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const newStatus = !account.isActive
    await opencodeAccountService.updateAccount(accountId, { isActive: newStatus })

    logger.success(
      `🔄 Admin toggled Opencode account status: ${accountId} -> ${newStatus ? 'active' : 'inactive'}`
    )
    return res.json({ success: true, isActive: newStatus })
  } catch (error) {
    logger.error('❌ Failed to toggle Opencode account status:', error)
    return res
      .status(500)
      .json({ error: 'Failed to toggle account status', message: error.message })
  }
})

// 切换账户调度状态
router.put('/:accountId/toggle-schedulable', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params

    const account = await opencodeAccountService.getAccount(accountId)
    if (!account) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const newSchedulable = !account.schedulable
    await opencodeAccountService.updateAccount(accountId, { schedulable: newSchedulable })

    if (!newSchedulable) {
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId: account.id,
        accountName: account.name || 'Opencode Account',
        platform: 'opencode',
        status: 'disabled',
        errorCode: 'OPENCODE_MANUALLY_DISABLED',
        reason: '账号已被管理员手动禁用调度',
        timestamp: new Date().toISOString()
      })
    }

    logger.success(
      `🔄 Admin toggled Opencode account schedulable status: ${accountId} -> ${
        newSchedulable ? 'schedulable' : 'not schedulable'
      }`
    )
    return res.json({ success: true, schedulable: newSchedulable })
  } catch (error) {
    logger.error('❌ Failed to toggle Opencode account schedulable status:', error)
    return res
      .status(500)
      .json({ error: 'Failed to toggle schedulable status', message: error.message })
  }
})

// 获取账户使用统计
router.get('/:accountId/usage', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const usageStats = await opencodeAccountService.getAccountUsageStats(accountId)

    if (!usageStats) {
      return res.status(404).json({ error: 'Account not found' })
    }

    return res.json(usageStats)
  } catch (error) {
    logger.error('❌ Failed to get Opencode account usage stats:', error)
    return res.status(500).json({ error: 'Failed to get usage stats', message: error.message })
  }
})

// 手动重置每日使用量
router.post('/:accountId/reset-usage', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    await opencodeAccountService.resetDailyUsage(accountId)

    logger.success(`Admin manually reset daily usage for Opencode account: ${accountId}`)
    return res.json({ success: true, message: 'Daily usage reset successfully' })
  } catch (error) {
    logger.error('❌ Failed to reset Opencode account daily usage:', error)
    return res.status(500).json({ error: 'Failed to reset daily usage', message: error.message })
  }
})

// 重置账户异常状态
router.post('/:accountId/reset-status', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const result = await opencodeAccountService.resetAccountStatus(accountId)
    logger.success(`Admin reset status for Opencode account: ${accountId}`)
    return res.json({ success: true, data: result })
  } catch (error) {
    logger.error('❌ Failed to reset Opencode account status:', error)
    return res.status(500).json({ error: 'Failed to reset status', message: error.message })
  }
})

// 清空协议格式负缓存（重新探测各模型对 responses/messages 的支持情况）
router.post('/:accountId/clear-format-cache', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const result = await opencodeAccountService.clearFormatCache(accountId)
    logger.success(`Admin cleared format cache for Opencode account: ${accountId}`)
    return res.json({ success: true, data: result })
  } catch (error) {
    logger.error('❌ Failed to clear Opencode format cache:', error)
    return res.status(500).json({ error: 'Failed to clear format cache', message: error.message })
  }
})

// 拉取上游模型列表
router.get('/:accountId/models', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const account = await opencodeAccountService.getAccount(accountId)
    if (!account) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const opencodeRelayService = require('../../services/relay/opencodeRelayService')
    const result = await opencodeRelayService.fetchModels(account)

    return res.status(result.statusCode).json(result.data)
  } catch (error) {
    logger.error('❌ Failed to fetch Opencode models:', error)
    return res.status(500).json({ error: 'Failed to fetch models', message: error.message })
  }
})

// 测试账户连通性（走 chat/completions，模型覆盖最广）
router.post('/:accountId/test', authenticateAdmin, async (req, res) => {
  const { accountId } = req.params
  const { model = 'kimi-k3' } = req.body
  const startTime = Date.now()

  try {
    const account = await opencodeAccountService.getAccount(accountId)
    if (!account) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const requestConfig = {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${account.apiKey}`,
        'User-Agent': account.userAgent || 'claude-relay-service/1.0.0'
      },
      timeout: 30000
    }

    const agent = ProxyHelper.createProxyAgent(account.proxy)
    if (agent) {
      requestConfig.httpsAgent = agent
      requestConfig.httpAgent = agent
      requestConfig.proxy = false
    }

    const response = await axios.post(
      `${account.baseUrl}/chat/completions`,
      {
        model,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say "Hello" in one word.' }]
      },
      requestConfig
    )
    const latency = Date.now() - startTime

    const responseText = response.data?.choices?.[0]?.message?.content || ''

    logger.success(
      `✅ Opencode account test passed: ${account.name} (${accountId}), latency: ${latency}ms`
    )

    return res.json({
      success: true,
      data: {
        accountId,
        accountName: account.name,
        model,
        latency,
        responseText: responseText.substring(0, 200)
      }
    })
  } catch (error) {
    const latency = Date.now() - startTime
    logger.error(`❌ Opencode account test failed: ${accountId}`, error.message)

    return res.status(500).json({
      success: false,
      error: 'Test failed',
      message: extractErrorMessage(error.response?.data, error.message),
      latency
    })
  }
})

module.exports = router
