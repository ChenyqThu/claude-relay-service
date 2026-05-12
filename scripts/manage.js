#!/usr/bin/env node

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const process = require('process')

const PM2_APP_NAME = 'claude-relay'
const APP_FILE = path.join(__dirname, '..', 'src', 'app.js')
const LOG_FILE = path.join(__dirname, '..', 'logs', 'pm2.log')

class ServiceManager {
  constructor() {
    this.ensureLogDir()
  }

  ensureLogDir() {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
  }

  runPm2(args, options = {}) {
    const result = spawnSync('pm2', args, {
      stdio: options.capture ? 'pipe' : 'inherit',
      encoding: 'utf8'
    })

    if (result.error) {
      console.error('❌ PM2 不可用，请先安装 PM2: npm install -g pm2')
      console.error(result.error.message)
      process.exit(1)
    }

    if (result.status !== 0 && !options.allowFailure) {
      process.exit(result.status || 1)
    }

    return result
  }

  hasPm2Process() {
    const result = this.runPm2(['describe', PM2_APP_NAME], {
      capture: true,
      allowFailure: true
    })
    return result.status === 0
  }

  savePm2ProcessList() {
    this.runPm2(['save'], { allowFailure: true })
  }

  start() {
    if (this.hasPm2Process()) {
      console.log(`ℹ️  PM2 进程 ${PM2_APP_NAME} 已存在，执行 restart 以加载最新代码`)
      return this.restart()
    }

    console.log(`🚀 使用 PM2 启动 ${PM2_APP_NAME}...`)
    this.runPm2(['start', APP_FILE, '--name', PM2_APP_NAME, '--log', LOG_FILE, '--update-env'])
    this.savePm2ProcessList()
    return true
  }

  stop() {
    if (!this.hasPm2Process()) {
      console.log(`⚠️  PM2 进程 ${PM2_APP_NAME} 不存在`)
      return false
    }

    this.runPm2(['stop', PM2_APP_NAME])
    this.savePm2ProcessList()
    return true
  }

  restart() {
    if (!this.hasPm2Process()) {
      console.log(`ℹ️  PM2 进程 ${PM2_APP_NAME} 不存在，改为启动服务`)
      return this.start()
    }

    this.runPm2(['restart', PM2_APP_NAME, '--update-env'])
    this.savePm2ProcessList()
    return true
  }

  status() {
    if (!this.hasPm2Process()) {
      console.log(`❌ PM2 进程 ${PM2_APP_NAME} 不存在`)
      return false
    }

    this.runPm2(['describe', PM2_APP_NAME])
    return true
  }

  logs(lines = 50, follow = false) {
    const args = ['logs', PM2_APP_NAME, '--lines', String(lines)]
    if (!follow) {
      args.push('--nostream')
    }
    this.runPm2(args)
  }

  help() {
    console.log(`
🔧 Claude Relay Service PM2 进程管理器

本地服务由 PM2 管理，进程名固定为 ${PM2_APP_NAME}。
不要使用 PID 文件或直接后台 node 进程管理本服务。

命令:
  start                  使用 PM2 启动；如果已存在则重启
  stop                   pm2 stop ${PM2_APP_NAME}
  restart                pm2 restart ${PM2_APP_NAME} --update-env
  status                 pm2 describe ${PM2_APP_NAME}
  logs [lines]           查看 PM2 日志，默认最近 50 行
  logs [lines] --follow  跟随 PM2 日志
  help                   显示帮助

推荐:
  npm run service:restart
  npm run service:status
  curl http://127.0.0.1:8765/health

直接 PM2:
  pm2 restart ${PM2_APP_NAME} --update-env
  pm2 describe ${PM2_APP_NAME}
  pm2 logs ${PM2_APP_NAME} --lines 100 --nostream
`)
  }
}

function main() {
  const manager = new ServiceManager()
  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case 'start':
    case 's':
      manager.start()
      break
    case 'stop':
    case 'halt':
      manager.stop()
      break
    case 'restart':
    case 'r':
      manager.restart()
      break
    case 'status':
    case 'st':
      manager.status()
      break
    case 'logs':
    case 'log':
    case 'l': {
      const lines = Number.parseInt(args[1], 10) || 50
      manager.logs(lines, args.includes('--follow') || args.includes('-f'))
      break
    }
    case 'help':
    case '--help':
    case '-h':
    case 'h':
    case undefined:
      manager.help()
      break
    default:
      console.log('❌ 未知命令:', command)
      manager.help()
      process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = ServiceManager
