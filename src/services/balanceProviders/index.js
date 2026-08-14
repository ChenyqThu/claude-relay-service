const ClaudeBalanceProvider = require('./claudeBalanceProvider')
const ClaudeConsoleBalanceProvider = require('./claudeConsoleBalanceProvider')
const OpenAIResponsesBalanceProvider = require('./openaiResponsesBalanceProvider')
const GenericBalanceProvider = require('./genericBalanceProvider')
const GeminiBalanceProvider = require('./geminiBalanceProvider')

function registerAllProviders(balanceService) {
  // Claude
  balanceService.registerProvider('claude', new ClaudeBalanceProvider())
  balanceService.registerProvider('claude-console', new ClaudeConsoleBalanceProvider())

  // OpenAI / Codex
  balanceService.registerProvider('openai-responses', new OpenAIResponsesBalanceProvider())
  balanceService.registerProvider('openai', new GenericBalanceProvider('openai'))
  balanceService.registerProvider('azure_openai', new GenericBalanceProvider('azure_openai'))

  // 其他平台（降级）
  balanceService.registerProvider('gemini', new GeminiBalanceProvider())
  balanceService.registerProvider('gemini-api', new GenericBalanceProvider('gemini-api'))
  balanceService.registerProvider('bedrock', new GenericBalanceProvider('bedrock'))
  balanceService.registerProvider('droid', new GenericBalanceProvider('droid'))
  balanceService.registerProvider('ccr', new GenericBalanceProvider('ccr'))
  // opencode 是包月套餐，上游没有余额接口，走本地统计降级
  balanceService.registerProvider('opencode', new GenericBalanceProvider('opencode'))
}

module.exports = { registerAllProviders }
