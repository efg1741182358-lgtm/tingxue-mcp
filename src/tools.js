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
  social: ['write_comment', 'delete_comment', 'send_message'],
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

// 评论发出后原样返回一大坨（含发布者头像、等级、会员信息……）。
// 只留下真正有用的那一个：commentId。没有它就删不掉自己刚发的评论。
export function slimComment(res) {
  const c = res?.comment
  if (!c?.commentId) return { 结果: '已提交，但上游没有返回评论 id（就删不掉了）', 原始: res }
  return { 评论id: c.commentId, 内容: c.content }
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
      return text(await api.like(id, like))
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
      return text(await api.playlistCreate(name, isPrivate))
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
      return text(await api.playlistTracks(op, pid, trackIds.join(',')))
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
      return text(await api.playlistDelete(pid))
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
      return text(
        await api.comment({ t: 0, type: type === 'song' ? 0 : 2, id, commentId }),
      )
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
