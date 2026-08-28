// MCP 工具定义。参数校验用 zod。
//
// 这个文件里最贵的东西不是代码，是字数。tools/list 的内容会被塞进模型
// 每一轮的上下文——不管这轮聊不聊音乐，只要连接器挂着就得付。所以：
//   · 描述写到刚好够用就停，不写场景故事；
//   · 能不加的参数就不加（参数每轮都付，返回值只在真调用时付，
//     用「加个开关让用户自己关」去省返回值是亏的）；
//   · 返回值里默认不需要的字段直接砍掉，不留开关。
import { z } from 'zod'
import { api } from './netease.js'
import * as session from './session.js'

// 按需启用工具组。免费额度有限的用户可以只开自己要的，
// 没启用的工具连定义都不会出现在 tools/list 里，一分钱不花。
//   TOOLS=search,lyric   只开搜歌和歌词
//   不设置               全开（默认）
export const GROUPS = {
  search: ['search_song'],
  lyric: ['get_lyric'],
  library: ['like_song', 'my_playlists', 'create_playlist', 'add_to_playlist', 'delete_playlist'],
  social: ['write_comment', 'my_comments', 'delete_comment', 'send_message'],
  together: ['listen_together_status'],
  status: ['login_status'],
}

export function enabledTools(spec) {
  const raw = (spec ?? '').trim()
  if (!raw) return null // null = 全开
  const names = new Set()
  const unknown = []
  for (const item of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (GROUPS[item]) GROUPS[item].forEach((n) => names.add(n))
    else if (Object.values(GROUPS).flat().includes(item)) names.add(item)
    else unknown.push(item)
  }
  if (unknown.length) {
    console.warn(
      `  ⚠ TOOLS 里有认不出的名字：${unknown.join(', ')}` +
        `（可用组：${Object.keys(GROUPS).join(' / ')}）`,
    )
  }
  return names
}

// 只在启动时解析一次：/mcp 是无状态的，每个请求都会重新注册工具，
// 放在函数默认参数里会导致告警按请求数刷屏。
const DEFAULT_ONLY = enabledTools(process.env.TOOLS)

// 统一收口：没登录就明说，不要让模型对着一个空结果瞎猜。
function requireLogin() {
  if (!session.isLoggedIn()) {
    throw new Error('尚未登录。请先打开服务的 /login 页面扫码。')
  }
}

function text(value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return { content: [{ type: 'text', text: body }] }
}

// 毫秒 → m:ss
export function mmss(ms) {
  if (!ms || ms < 0) return null
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// 搜索结果原样返回太吵（每首歌几十个字段），只留有用的。
// 时长要留：热门歌被翻唱十几遍，只看歌名歌手挑不出是哪一版。
export function slimSongs(result) {
  const songs = result?.result?.songs || []
  return songs.map((s) => ({
    id: s.id,
    名称: s.name,
    歌手: (s.artists || s.ar || []).map((a) => a.name).join('/'),
    专辑: s.album?.name || s.al?.name,
    时长: mmss(s.duration ?? s.dt),
  }))
}

// 歌词的时间轴（[00:11.37]）在对话里没有任何用处，但每行要占十来个字符。
// 一首四十行的歌，光时间轴就是一两百 token 的纯噪音。默认剥掉，不给开关。
export function stripTimestamps(lrc) {
  return lrc
    .split('\n')
    .map((line) => line.replace(/^(\[[\d:.]+\])+/, '').trim())
    .filter(Boolean)
    .join('\n')
}

// 写操作（收藏、建歌单、加歌、删歌单、删评论）成功时只需要回答一件事：成了。
// 失败根本走不到这里——call() 已经在 code != 200 时抛掉了，所以连 code 都不用回。
// 而上游附赠的东西一律不值钱：create_playlist 回四十多个字段五百多 token
// （背景图 URL、commentThreadId、anonimous、coverImgId_str……），真正有用的
// 只有 id 和 name；add_to_playlist 回一份 trackIds 参数回声，外加只在歌单
// 从空变非空那一次才出现的封面 URL；delete_playlist 回三个恒为 null 的 msg。
// 统一收成一行确认，需要留的字段显式写进 详情。
export function ack(动作, 详情) {
  const out = { 已完成: 动作 }
  for (const [k, v] of Object.entries(详情 || {})) {
    if (v != null) out[k] = v
  }
  return out
}

// 评论发出后原样返回一大坨（含发布者头像、等级、会员信息……）。
// 只留下真正有用的那一个：commentId。没有它就删不掉自己刚发的评论。
export function slimComment(res) {
  const c = res?.comment
  if (!c?.commentId) return { 结果: '已提交，但上游没有返回评论 id（就删不掉了）', 原始: res }
  return { 评论id: c.commentId, 内容: c.content }
}

// 网易云回的是毫秒时间戳，而服务器可能跑在任何时区。直接 toISOString 会
// 得到 UTC——北京时间早上八点前的事会被显示成前一天，看的人得自己换算。
// 这里显式加 8 小时，字段名也写明是北京时间。
export function beijing(ms) {
  if (!ms) return null
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

// 「我发过的评论」。这个接口没能在开发机上跑通（出网白名单不含 music.163.com），
// 响应结构是照 weapi 的惯例推的。所以认不出结构时必须明说并把字段名报上来——
// 绝不能返回一个空数组假装「你没发过评论」。工具宁可说「我不知道」，也不能
// 说一句听起来像答案的假话：调用方分不出「查到了，是空的」和「我没看懂」。
// ⚠ 默认只回 5 条，前提是上游按时间倒序（time=0 游标从最新开始）。
// 这个前提没验过。万一它是正序，5 条就全是最老的评论，刚发的那条根本
// 看不见——真环境第一次调用就能看出来，看错了把 default 调大不算修，
// 得改排序。
export function slimHistory(res) {
  const data = res?.data ?? res
  const list = [data?.comments, data?.commentHistoryList, data?.list, data?.records].find(
    Array.isArray,
  )
  if (!list) {
    return {
      结果: '没认出这个接口的返回结构，不敢瞎猜',
      顶层字段: Object.keys(res || {}),
      data字段:
        data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : null,
      下一步: '把上面两行字段名交给开发者，一次往返就能改对',
    }
  }
  return list.map((item) => {
    const c = item?.comment ?? item
    const r = item?.resource ?? item?.resourceInfo ?? c?.resource ?? {}
    return {
      // commentId 必须留：没有它就删不掉，这个工具也就闭不上环。
      评论id: c?.commentId ?? item?.commentId ?? null,
      正文: c?.content ?? item?.content ?? null,
      // 跨歌曲的列表，不标明是哪一首就认不出哪条是哪条。
      作品: r?.name ?? r?.title ?? r?.songName ?? null,
      发布时间: beijing(c?.time ?? item?.time),
    }
  })
}

// 私信发出后，上游为了说一句「成功」回了两份完整用户资料——头像、背景图、
// 生日、地区、会员等级……实测约 900 token，真正有用的就下面三个字段。
export function slimMessage(res) {
  const m = (res?.newMsgs || [])[0]
  return {
    已发送: true,
    消息id: res?.id ?? m?.id ?? null,
    收件人: m?.toUser?.nickname ?? null,
  }
}

// 一起听的原始返回里，两个人各带一整套头像挂件（安卓/iOS/PC/循环共四个 URL），
// 加起来一千多 token，而真正有用的就下面这几行。
export function slimRoom(res) {
  const d = res?.data
  if (!d?.inRoom) return { 在一起听: false, 说明: '当前没有进行中的一起听房间' }

  const info = d.roomInfo || {}
  const started = info.roomCreateTime ? new Date(info.roomCreateTime) : null
  let 已持续
  if (started) {
    const ms = Date.now() - started.getTime()
    const h = Math.floor(ms / 3.6e6)
    已持续 = `${Math.floor(h / 24)} 天 ${h % 24} 小时`
  }

  return {
    在一起听: true,
    状态: d.status,
    房间id: info.roomId,
    房间类型: info.roomType,
    成员: (info.roomUsers || []).map((u) => ({ uid: u.userId, 昵称: u.nickname })),
    开始时间: started ? started.toISOString() : null,
    已持续,
    对方设备: d.anotherDeviceInfo
      ? `${d.anotherDeviceInfo.osType} ${d.anotherDeviceInfo.appVersion}`
      : null,
  }
}

export function registerTools(server, only = DEFAULT_ONLY) {
  const registered = []
  const add = (name, spec, handler) => {
    if (only && !only.has(name)) return
    server.registerTool(name, spec, handler)
    registered.push(name)
  }

  add(
    'search_song',
    {
      title: '搜歌',
      description: '搜歌，返回 id/歌名/歌手/专辑/时长。翻唱同名多，用时长区分。',
      inputSchema: {
        keywords: z.string().describe('歌名或歌手'),
        limit: z.coerce.number().int().min(1).max(20).default(5).describe('返回条数'),
      },
    },
    async ({ keywords, limit }) => text(slimSongs(await api.search(keywords, limit))),
  )

  add(
    'get_lyric',
    {
      title: '看歌词',
      description: '取歌词，有翻译一并返回。已去掉时间轴。',
      inputSchema: { id: z.coerce.number().int().describe('歌曲 id') },
    },
    async ({ id }) => {
      const res = await api.lyric(id)
      const 原文 = res?.lrc?.lyric?.trim()
      if (!原文) return text('这首歌没有歌词（纯音乐，或网易云没收录）。')
      const out = { 歌词: stripTimestamps(原文) }
      const 译 = res?.tlyric?.lyric?.trim()
      if (译) out.翻译 = stripTimestamps(译)
      return text(out)
    },
  )

  add(
    'like_song',
    {
      title: '收藏歌曲',
      description: '把歌加入或移出「我喜欢的音乐」。',
      inputSchema: {
        id: z.coerce.number().int().describe('歌曲 id'),
        like: z.boolean().default(true).describe('false=取消收藏'),
      },
    },
    async ({ id, like }) => {
      requireLogin()
      await api.like(id, like)
      return text(ack(like ? '加入「我喜欢的音乐」' : '移出「我喜欢的音乐」'))
    },
  )

  add(
    'my_playlists',
    {
      title: '我的歌单',
      description: '列出本账号创建的歌单，拿 pid。',
      inputSchema: {},
    },
    async () => {
      requireLogin()
      const me = await api.userAccount()
      const uid = me?.account?.id
      const res = await api.userPlaylist(uid)
      // 收藏来的别人的歌单反正也改不了（401），列出来只是白占字数
      const list = (res?.playlist || [])
        .filter((p) => p.userId === uid)
        .map((p) => ({ pid: p.id, 名称: p.name, 歌曲数: p.trackCount }))
      return text(list)
    },
  )

  add(
    'create_playlist',
    {
      title: '创建歌单',
      description: '新建歌单，返回 pid。',
      inputSchema: {
        name: z.string().describe('歌单名'),
        private: z.boolean().default(false).describe('true=隐私歌单'),
      },
    },
    async ({ name, private: isPrivate }) => {
      requireLogin()
      const res = await api.playlistCreate(name, isPrivate)
      // pid 必须留：建完拿不到 id，这个歌单就再也加不了歌了。
      return text(ack('创建歌单', { pid: res?.id ?? res?.playlist?.id, 名称: res?.playlist?.name ?? name }))
    },
  )

  add(
    'add_to_playlist',
    {
      title: '歌曲加入歌单',
      description: '把歌加进或移出歌单。只能改本账号创建的歌单。',
      inputSchema: {
        pid: z.coerce.number().int().describe('歌单 id'),
        trackIds: z.array(z.coerce.number().int()).min(1).describe('歌曲 id 列表'),
        op: z.enum(['add', 'del']).default('add').describe('del=移除'),
      },
    },
    async ({ pid, trackIds, op }) => {
      requireLogin()
      const res = await api.playlistTracks(op, pid, trackIds.join(','))
      // count 是操作后歌单里的总曲目数，不是这次加了几首——实测加两次是 1、2，
      // 移除一次回到 1。留着它，调用方不用再多查一次 my_playlists 才敢信。
      return text(ack(op === 'add' ? '加入歌单' : '移出歌单', { 歌单现有: res?.count }))
    },
  )

  add(
    'delete_playlist',
    {
      title: '删除歌单',
      description: '删掉自己的歌单。删了拿不回来。',
      inputSchema: { pid: z.coerce.number().int().describe('歌单 id') },
    },
    async ({ pid }) => {
      requireLogin()
      await api.playlistDelete(pid)
      return text(ack('删除歌单'))
    },
  )

  add(
    'write_comment',
    {
      title: '写评论',
      description: '给歌曲或歌单发评论。公开可见，落本人账号名下。',
      inputSchema: {
        id: z.coerce.number().int().describe('歌曲或歌单 id'),
        content: z.string().max(140).describe('评论正文'),
        type: z.enum(['song', 'playlist']).default('song'),
      },
    },
    async ({ id, content, type }) => {
      requireLogin()
      return text(
        slimComment(
          await api.comment({ t: 1, type: type === 'song' ? 0 : 2, id, content }),
        ),
      )
    },
  )

  add(
    'my_comments',
    {
      title: '我的评论',
      description: '列出本账号发过的评论，含 commentId（删评论要用）。',
      inputSchema: {
        limit: z.coerce.number().int().min(1).max(50).default(5).describe('返回条数'),
      },
    },
    async ({ limit }) => {
      requireLogin()
      const me = await api.userAccount()
      return text(slimHistory(await api.userCommentHistory(me?.account?.id, limit)))
    },
  )

  add(
    'delete_comment',
    {
      title: '删除评论',
      description: '删掉自己发过的一条评论。commentId 由 write_comment 返回。',
      inputSchema: {
        id: z.coerce.number().int().describe('被评论的歌曲或歌单 id'),
        commentId: z.coerce.number().int().describe('评论 id'),
        type: z.enum(['song', 'playlist']).default('song'),
      },
    },
    async ({ id, commentId, type }) => {
      requireLogin()
      await api.comment({ t: 0, type: type === 'song' ? 0 : 2, id, commentId })
      return text(ack('删除评论'))
    },
  )

  add(
    'send_message',
    {
      title: '发私信',
      description:
        '给某人发私信，可附一首歌。注意这是私信，不是「一起听」房间内发言（房间聊天走 IM 长连接，本 API 够不到）。',
      inputSchema: {
        userId: z.coerce.number().int().describe('收信人 uid'),
        message: z.string().max(500).default('').describe('正文'),
        songId: z.coerce.number().int().optional().describe('附带的歌曲 id'),
      },
    },
    async ({ userId, message, songId }) => {
      requireLogin()
      if (songId) return text(slimMessage(await api.sendSong(String(userId), songId, message)))
      if (!message) throw new Error('message 和 songId 至少要给一个。')
      return text(slimMessage(await api.sendText(String(userId), message)))
    },
  )

  add(
    'listen_together_status',
    {
      title: '查看一起听',
      description: '查「一起听」房间：有没有在听、房里有谁、持续多久。',
      inputSchema: {},
    },
    async () => {
      requireLogin()
      return text(slimRoom(await api.listenTogetherStatus()))
    },
  )

  add(
    'login_status',
    {
      title: '登录状态',
      description: '查当前登录的账号。掉线要去 /login 重新扫码。',
      inputSchema: {},
    },
    async () => {
      if (!session.isLoggedIn()) return text('未登录。请打开服务的 /login 页面扫码。')
      const me = await api.userAccount()
      return text({
        已登录: true,
        昵称: me?.profile?.nickname,
        uid: me?.account?.id,
        会员: me?.account?.vipType ? `VIP ${me.account.vipType}` : '无',
      })
    },
  )

  return registered
}
