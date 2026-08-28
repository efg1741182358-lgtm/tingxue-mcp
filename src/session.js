// 登录态：一次扫码，之后自动续期，重启不丢。
import fs from 'node:fs/promises'
import path from 'node:path'

const DATA_DIR = process.env.DATA_DIR || './data'
const FILE = path.join(DATA_DIR, 'session.json')

// 网易云续期：cookie 有效期很长，但长期不动会失效。
// 每 12 小时打一次 login_refresh 保活。
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000

let cookie = ''

export function getCookie() {
  return cookie
}

export function isLoggedIn() {
  return Boolean(cookie)
}

export async function load() {
  try {
    const raw = await fs.readFile(FILE, 'utf8')
    cookie = JSON.parse(raw).cookie || ''
    if (cookie) console.log('[session] 已从磁盘恢复登录态')
  } catch {
    // 首次启动没有文件，属正常
    cookie = ''
  }
  return cookie
}

export async function save(newCookie) {
  cookie = newCookie || ''
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(
    FILE,
    JSON.stringify({ cookie, savedAt: new Date().toISOString() }, null, 2),
  )
  console.log('[session] 登录态已落盘')
}

export async function clear() {
  cookie = ''
  await fs.rm(FILE, { force: true })
}

// 后台保活。刷新失败不清空 cookie —— 网络抖动不该让人重扫码，
// 真失效了 login_status 会报，前端页面再提示重扫。
export function startRefreshLoop(refreshFn) {
  const tick = async () => {
    if (!cookie) return
    try {
      const fresh = await refreshFn()
      if (fresh) await save(fresh)
      console.log('[session] 续期成功')
    } catch (err) {
      console.warn('[session] 续期失败（保留现有登录态）：', err.message)
    }
  }
  setInterval(tick, REFRESH_INTERVAL_MS).unref?.()
  setTimeout(tick, 30_000).unref?.() // 启动 30 秒后先刷一次
}
