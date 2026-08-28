// NeteaseCloudMusicApi 的薄封装：自动注入 cookie 和 realIP。
import NCM from 'NeteaseCloudMusicApi'
import * as session from './session.js'

// 网易云按 IP 限区。服务器在境外时不带 realIP 会静默返回空结果 /
// -460「网络太拥挤」，而不是明确报错——这是最容易查半天的坑。
const REAL_IP = process.env.REAL_IP || '116.25.146.177'

// NeteaseCloudMusicApi 失败时 reject 的是普通对象 {status, body}，不是 Error。
// 直接往上抛的话，错误信息会变成 "[object Object]"，等于没有信息。
// 这里翻译成人能读的话，并把几个最常见的坑单独点名。
function explain(err) {
  const status = err?.status
  const code = err?.body?.code
  const msg = err?.body?.msg || err?.body?.message || err?.message

  if (code === 301 || status === 301) {
    return '需要登录（或登录已失效）。请打开服务的 /login 页面重新扫码。'
  }
  if (code === -460) {
    return '网易云返回「网络太拥挤」(-460)。这几乎总是 IP 限区：确认 REAL_IP 环境变量设了一个国内 IP。'
  }
  // NCM 会把上游 403 包成 502，所以要连消息文本一起看
  if (status === 403 || code === 403 || /\b403\b/.test(String(msg))) {
    return '请求被网易云或中间网络拒绝 (403)。检查两处：部署环境能否访问 music.163.com；REAL_IP 是否为有效的国内 IP。'
  }
  return `网易云接口失败（status=${status ?? '?'} code=${code ?? '?'}）：${msg || '无详细信息'}`
}

async function call(name, params = {}) {
  const fn = NCM[name]
  if (typeof fn !== 'function') {
    throw new Error(`未知接口：${name}`)
  }
  try {
    const res = await fn({
      ...params,
      cookie: params.cookie ?? session.getCookie(),
      realIP: REAL_IP,
    })
    return res.body
  } catch (err) {
    const e = new Error(explain(err))
    e.cause = err
    throw e
  }
}

export const api = {
  // --- 登录 ---
  qrKey: () => call('login_qr_key'),
  qrCreate: (key) => call('login_qr_create', { key, qrimg: true }),
  qrCheck: (key) => call('login_qr_check', { key }),
  loginStatus: () => call('login_status'),
  loginRefresh: () => call('login_refresh'),
  userAccount: () => call('user_account'),

  // --- 搜索 ---
  search: (keywords, limit = 15, type = 1) =>
    call('search', { keywords, limit, type }),

  // --- 收藏 / 歌单 ---
  like: (id, like = true) => call('like', { id, like }),
  playlistCreate: (name, privacy) =>
    call('playlist_create', { name, ...(privacy ? { privacy: 10 } : {}) }),
  playlistTracks: (op, pid, tracks) =>
    call('playlist_tracks', { op, pid, tracks }),
  userPlaylist: (uid, limit = 50) => call('user_playlist', { uid, limit }),

  // --- 评论 ---
  // t: 1=发送 0=删除 2=回复；type: 0=歌曲 2=歌单 ...
  comment: (params) => call('comment', params),

  // --- 一起听 ---
  listenTogetherStatus: () => call('listentogether_status'),
  listenTogetherPlayCommand: (params) =>
    call('listentogether_play_command', params),
}

export { call }
