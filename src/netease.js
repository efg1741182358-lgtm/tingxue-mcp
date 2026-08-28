// NeteaseCloudMusicApi 的薄封装：自动注入 cookie 和 realIP。
import NCM from 'NeteaseCloudMusicApi'
import * as session from './session.js'

// 网易云按 IP 限区。服务器在境外时不带 realIP 会静默返回空结果 /
// -460「网络太拥挤」，而不是明确报错——这是最容易查半天的坑。
const REAL_IP = process.env.REAL_IP || '116.25.146.177'

// NeteaseCloudMusicApi 失败时 reject 的是普通对象 {status, body}，不是 Error。
// 直接往上抛的话，错误信息会变成 "[object Object]"，等于没有信息。
// 这里翻译成人能读的话，并把几个最常见的坑单独点名。
export function explain(err) {
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
  if (code === 401) {
    return '没有操作权限 (401)。最常见的原因：这个歌单不是本账号创建的，只能读不能改。'
  }
  if (code === 250) {
    return '被网易云限流或判定为异常操作 (250)。等一会儿再试，别连着刷。'
  }
  if (code === -2) {
    return '内容被拒绝 (-2)。评论重复、含敏感词或发得太频繁时会这样。'
  }
  return `网易云接口失败（status=${status ?? '?'} code=${code ?? '?'}）：${msg || '无详细信息'}`
}

// 少数接口（playlist_tracks 是典型）在自己的 catch 里又往外包了一层：
//   { status: 200, body: { 真正的结果 }, cookie: [...] }
// 两个后果，都很隐蔽：
//   1. 真正的 code 藏在 body.body.code，顶层根本没有 code，下面那道
//      错误码校验会整个跳过——恰恰漏掉最需要它的那个接口；
//   2. cookie 会跟着返回值一路进模型上下文（NMTID 有效期十年）。
export function unwrap(body) {
  if (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    'body' in body &&
    ('status' in body || 'cookie' in body)
  ) {
    return body.body
  }
  return body
}

// 返回值里的 cookie 对调用方毫无用处，却是实打实的凭证。
// 只有登录/续期那两处需要它，走 opts 显式保留。
export function stripCookie(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  if (!('cookie' in body)) return body
  const { cookie, ...rest } = body
  return rest
}

// 上游有一批接口会把失败吞成 HTTP 200，真正的错误码藏在 body.code 里。
// 最典型的是 playlist_tracks：源码里 catch 之后原样 `return { status: 200, body: error.body }`。
// 只看 res.body 而不看 code，等于把失败当成功往上报——工具一旦会撒谎，
// 模型就会基于假成功继续往下做。所以这里统一把 code 当成结果的一部分校验。
//
// opts.raw：留给那些「非 200 是正常业务语义」的接口，目前只有扫码轮询
// （800 过期 / 801 等待 / 802 已扫 / 803 成功，全都不是错误）。原样返回。
// opts.keepCookie：仍然校验错误码，但保留返回里的 cookie（登录续期要用）。
async function call(name, params = {}, opts = {}) {
  const fn = NCM[name]
  if (typeof fn !== 'function') {
    throw new Error(`未知接口：${name}`)
  }
  let body
  try {
    const res = await fn({
      ...params,
      cookie: params.cookie ?? session.getCookie(),
      realIP: REAL_IP,
    })
    body = res.body
  } catch (err) {
    const e = new Error(explain(err))
    e.cause = err
    throw e
  }

  if (opts.raw) return body

  body = unwrap(body)

  const code = body?.code
  if (code != null && code !== 200) {
    const e = new Error(explain({ status: 200, body }))
    e.cause = body
    throw e
  }
  return opts.keepCookie ? body : stripCookie(body)
}

// 上游有接口用字符串比较布尔值，统一转成 'true' / 'false' 再传。
export const boolFlag = (v) => (v ? 'true' : 'false')

export const api = {
  // --- 登录 ---
  qrKey: () => call('login_qr_key'),
  qrCreate: (key) => call('login_qr_create', { key, qrimg: true }),
  // 扫码轮询的 800/801/802/803 都是正常状态，不能当错误抛
  qrCheck: (key) => call('login_qr_check', { key }, { raw: true }),
  loginStatus: () => call('login_status'),
  // 续期要拿返回里的新 cookie，这一处显式保留
  loginRefresh: () => call('login_refresh', {}, { keepCookie: true }),
  userAccount: () => call('user_account'),

  // --- 搜索 ---
  search: (keywords, limit = 15, type = 1) =>
    call('search', { keywords, limit, type }),

  // --- 收藏 / 歌单 ---
  // ⚠ 上游 like.js 是 `query.like == 'false' ? false : true`——拿参数跟
  // **字符串** 'false' 比。传真布尔 false 时 `false == 'false'` 会走
  // 0 == NaN 得出 false，于是三元取 true：取消收藏被静悄悄翻译成收藏，
  // 而且照样回 code 200。必须传字符串。
  like: (id, like = true) => call('like', { id, like: boolFlag(like) }),
  playlistCreate: (name, privacy) =>
    call('playlist_create', { name, ...(privacy ? { privacy: 10 } : {}) }),
  playlistTracks: (op, pid, tracks) =>
    call('playlist_tracks', { op, pid, tracks }),
  userPlaylist: (uid, limit = 50) => call('user_playlist', { uid, limit }),
  playlistDelete: (id) => call('playlist_delete', { id }),

  // --- 评论 ---
  // t: 1=发送 0=删除 2=回复；type: 0=歌曲 2=歌单 ...
  // 删除要额外给 commentId——所以发评论时必须把 id 交出来，
  // 否则「发得出撤不回」。
  comment: (params) => call('comment', params),
  // 我发过的评论。time 是游标（上一页最后一条的 time），0 = 从最新开始。
  userCommentHistory: (uid, limit = 10, time = 0) =>
    call('user_comment_history', { uid, limit, time }),

  // --- 歌词 ---
  lyric: (id) => call('lyric_new', { id }),

  // --- 私信 ---
  sendText: (userIds, msg) => call('send_text', { user_ids: userIds, msg }),
  sendSong: (userIds, id, msg) => call('send_song', { user_ids: userIds, id, msg }),

  // --- 一起听 ---
  // 只有查状态。遥控切歌（listentogether_play_command）已实测无效，见 README。
  listenTogetherStatus: () => call('listentogether_status'),
}

export { call }
