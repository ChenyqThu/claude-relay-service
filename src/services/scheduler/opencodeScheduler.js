const opencodeAccountService = require('../account/opencodeAccountService')
const accountGroupService = require('../accountGroupService')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const { isTruthy, isAccountHealthy, sortAccountsByPriority } = require('../../utils/commonHelper')

class OpencodeScheduler {
  constructor() {
    this.STICKY_PREFIX = 'opencode'
  }

  _isAccountSchedulable(account) {
    return isTruthy(account?.schedulable ?? true)
  }

  _composeStickySessionKey(sessionHash, apiKeyId) {
    if (!sessionHash) {
      return null
    }
    const apiKeyPart = apiKeyId || 'default'
    return `${this.STICKY_PREFIX}:${apiKeyPart}:${sessionHash}`
  }

  // 🔍 模型是否被账户的映射表支持
  _supportsModel(account, requestedModel) {
    if (!requestedModel) {
      return true
    }
    return opencodeAccountService.isModelSupported(account.supportedModels, requestedModel)
  }

  async _loadGroupAccounts(groupId) {
    const memberIds = await accountGroupService.getGroupMembers(groupId)
    if (!memberIds || memberIds.length === 0) {
      return []
    }

    const accounts = await Promise.all(
      memberIds.map(async (memberId) => {
        try {
          return await opencodeAccountService.getAccount(memberId)
        } catch (error) {
          logger.warn(`⚠️ 获取 Opencode 分组成员账号失败: ${memberId}`, error)
          return null
        }
      })
    )

    const result = []
    for (const account of accounts) {
      if (!account || !isAccountHealthy(account) || !this._isAccountSchedulable(account)) {
        continue
      }
      const isTempUnavailable = await upstreamErrorHelper.isTempUnavailable(account.id, 'opencode')
      if (isTempUnavailable) {
        logger.debug(
          `⏭️ Skipping Opencode group member ${account.name || account.id} - temporarily unavailable`
        )
        continue
      }
      result.push(account)
    }
    return result
  }

  async _ensureLastUsedUpdated(accountId) {
    try {
      await opencodeAccountService.touchLastUsedAt(accountId)
    } catch (error) {
      logger.warn(`⚠️ 更新 Opencode 账号最后使用时间失败: ${accountId}`, error)
    }
  }

  async _cleanupStickyMapping(stickyKey) {
    if (!stickyKey) {
      return
    }
    try {
      await redis.deleteSessionAccountMapping(stickyKey)
    } catch (error) {
      logger.warn(`⚠️ 清理 Opencode 粘性会话映射失败: ${stickyKey}`, error)
    }
  }

  async selectAccount(apiKeyData, sessionHash, requestedModel = null) {
    const stickyKey = this._composeStickySessionKey(sessionHash, apiKeyData?.id)

    let candidates = []
    let isDedicatedBinding = false

    if (apiKeyData?.opencodeAccountId) {
      const binding = apiKeyData.opencodeAccountId
      if (binding.startsWith('group:')) {
        const groupId = binding.substring('group:'.length)
        logger.info(
          `🧩 API Key ${apiKeyData.name || apiKeyData.id} 绑定 Opencode 分组 ${groupId}，按分组调度`
        )
        candidates = await this._loadGroupAccounts(groupId)
      } else {
        const account = await opencodeAccountService.getAccount(binding)
        if (account) {
          const isTempUnavailable = await upstreamErrorHelper.isTempUnavailable(
            account.id,
            'opencode'
          )
          if (isTempUnavailable) {
            logger.warn(
              `⏱️ Bound Opencode account ${account.name || account.id} temporarily unavailable, falling back to pool`
            )
          } else {
            candidates = [account]
            isDedicatedBinding = true
          }
        }
      }
    }

    if (!candidates || candidates.length === 0) {
      candidates = await opencodeAccountService.getSchedulableAccounts()
    }

    const syncFiltered = candidates.filter(
      (account) =>
        account &&
        isAccountHealthy(account) &&
        this._isAccountSchedulable(account) &&
        this._supportsModel(account, requestedModel)
    )

    const filteredResults = await Promise.all(
      syncFiltered.map(async (account) => {
        const isTempUnavailable = await upstreamErrorHelper.isTempUnavailable(
          account.id,
          'opencode'
        )
        if (isTempUnavailable) {
          logger.debug(
            `⏭️ Skipping Opencode account ${account.name || account.id} - temporarily unavailable`
          )
          return null
        }
        if (await opencodeAccountService.isAccountRateLimited(account.id)) {
          logger.debug(`⏭️ Skipping Opencode account ${account.name || account.id} - rate limited`)
          return null
        }
        return account
      })
    )
    const filtered = filteredResults.filter(Boolean)

    if (filtered.length === 0) {
      throw new Error(
        `No available Opencode accounts${requestedModel ? ` for model ${requestedModel}` : ''}${
          apiKeyData?.opencodeAccountId ? ' (respecting binding)' : ''
        }`
      )
    }

    if (stickyKey && !isDedicatedBinding) {
      const mappedAccountId = await redis.getSessionAccountMapping(stickyKey)
      if (mappedAccountId) {
        const mappedAccount = filtered.find((account) => account.id === mappedAccountId)
        if (mappedAccount) {
          await redis.extendSessionAccountMappingTTL(stickyKey)
          logger.info(
            `🧩 命中 Opencode 粘性会话: ${sessionHash} -> ${mappedAccount.name || mappedAccount.id}`
          )
          await this._ensureLastUsedUpdated(mappedAccount.id)
          return mappedAccount
        }

        await this._cleanupStickyMapping(stickyKey)
      }
    }

    const sorted = sortAccountsByPriority(filtered)
    const selected = sorted[0]

    if (!selected) {
      throw new Error('No schedulable Opencode account available after sorting')
    }

    if (stickyKey && !isDedicatedBinding) {
      await redis.setSessionAccountMapping(stickyKey, selected.id)
    }

    await this._ensureLastUsedUpdated(selected.id)

    logger.info(
      `🧩 选择 Opencode 账号 ${selected.name || selected.id}（priority: ${selected.priority || 50}）`
    )

    return selected
  }
}

module.exports = new OpencodeScheduler()
