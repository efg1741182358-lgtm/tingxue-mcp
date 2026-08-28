// MCP 工具定义。参数校验用 zod。
import { z } from 'zod'
import { api } from './netease.js'
import * as session from './session.js'

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

// 搜索结果原样返回太吵（每首歌几十个字段），只留有用的。
export function slimSongs(result) {
  const songs = result?.result?.songs || []
  return songs.map((s) => ({
    id: s.id,
    名称: s.name,
    歌手: (s.artists || s.ar || []).map((a) => a.name).join('/'),
    专辑: s.album?.name || s.al?.name,
    // 热门歌被翻唱十几遍是常态，只看歌名歌手挑不出是哪一版；
    // 时长是最省字节的区分方式（原曲 3:47 和纯人声 2:10 一眼分得开）。
    时长: mmss(s.duration ?? s.dt),
  }))
}

// 毫秒 → m:ss
export function mmss(ms) {
  if (!ms || ms < 0) return null
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
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

export function registerTools(server) {
  server.registerTool(
    'search_song',
    {
      title: '搜歌',
      description:
        '按关键词搜索歌曲，返回歌曲 id、名称、歌手、专辑、时长。' +
        '同名翻唱很多，用时长和专辑区分是哪一版。拿到 id 才能收藏、加歌单、评论。',
      inputSchema: {
        keywords: z.string().describe('搜索词，可以是歌名、歌手名或两者'),
        limit: z.number().int().min(1).max(50).default(15).describe('返回条数'),
      },
    },
    async ({ keywords, limit }) => text(slimSongs(await api.search(keywords, limit))),
  )

  server.registerTool(
    'like_song',
    {
      title: '收藏歌曲',
      description: '把一首歌加入/移出「我喜欢的音乐」。需要歌曲 id，先用 search_song 拿。',
      inputSchema: {
        id: z.number().int().describe('歌曲 id'),
        like: z.boolean().default(true).describe('true=收藏，false=取消收藏'),
      },
    },
    async ({ id, like }) => {
      requireLogin()
      return text(await api.like(id, like))
    },
  )

  server.registerTool(
    'my_playlists',
    {
      title: '我的歌单',
      description: '列出当前账号的歌单，拿 pid 用于 add_to_playlist。',
      inputSchema: {},
    },
    async () => {
      requireLogin()
      const me = await api.userAccount()
      const uid = me?.account?.id
      const res = await api.userPlaylist(uid)
      const list = (res?.playlist || []).map((p) => ({
        pid: p.id,
        名称: p.name,
        歌曲数: p.trackCount,
        是我创建的: p.userId === uid,
      }))
      return text(list)
    },
  )

  server.registerTool(
    'create_playlist',
    {
      title: '创建歌单',
      description: '新建一个歌单，返回它的 pid。',
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

  server.registerTool(
    'add_to_playlist',
    {
      title: '歌曲加入歌单',
      description:
        '把一首或多首歌加进指定歌单，也可以从歌单移除。' +
        '只能操作本账号创建的歌单——收藏来的别人的歌单改不了（会报 401）。',
      inputSchema: {
        pid: z.number().int().describe('歌单 id，用 my_playlists 拿'),
        trackIds: z.array(z.number().int()).min(1).describe('歌曲 id 列表'),
        op: z.enum(['add', 'del']).default('add').describe('add=加入，del=移除'),
      },
    },
    async ({ pid, trackIds, op }) => {
      requireLogin()
      return text(await api.playlistTracks(op, pid, trackIds.join(',')))
    },
  )

  server.registerTool(
    'write_comment',
    {
      title: '写评论',
      description: '给歌曲或歌单发一条评论。发出去是公开可见的，落到本人账号名下。',
      inputSchema: {
        id: z.number().int().describe('资源 id：歌曲 id 或歌单 id'),
        content: z.string().max(140).describe('评论正文'),
        type: z.enum(['song', 'playlist']).default('song').describe('评论对象类型'),
      },
    },
    async ({ id, content, type }) => {
      requireLogin()
      return text(
        await api.comment({ t: 1, type: type === 'song' ? 0 : 2, id, content }),
      )
    },
  )

  server.registerTool(
    'listen_together_status',
    {
      title: '查看一起听',
      description: '查询当前「一起听」房间状态：有没有在听、房间 id、房里都有谁、已经持续多久。',
      inputSchema: {},
    },
    async () => {
      requireLogin()
      return text(slimRoom(await api.listenTogetherStatus()))
    },
  )

  server.registerTool(
    'get_lyric',
    {
      title: '看歌词',
      description: '取一首歌的歌词。有翻译的话一并返回。需要歌曲 id，用 search_song 拿。',
      inputSchema: {
        id: z.number().int().describe('歌曲 id'),
        withTranslation: z.boolean().default(true).describe('是否一并返回中文翻译'),
      },
    },
    async ({ id, withTranslation }) => {
      const res = await api.lyric(id)
      const 原文 = res?.lrc?.lyric?.trim()
      if (!原文) return text('这首歌没有歌词（纯音乐，或网易云没收录）。')
      const out = { 歌词: 原文 }
      const 译 = res?.tlyric?.lyric?.trim()
      if (withTranslation && 译) out.翻译 = 译
      // 日韩歌接口本来就带罗马音，之前白白丢掉了
      const 罗马音 = res?.romalrc?.lyric?.trim()
      if (罗马音) out.罗马音 = 罗马音
      return text(out)
    },
  )

  server.registerTool(
    'send_message',
    {
      title: '发私信',
      description:
        '给网易云用户发一条文字私信。⚠ 一起听房间内的聊天走的是 IM 长连接，' +
        '本 API 够不到；这是私信，会出现在对方的私信列表里。以本账号名义发出。',
      inputSchema: {
        userId: z.number().int().describe('收信人的 uid'),
        message: z.string().max(500).describe('私信正文'),
      },
    },
    async ({ userId, message }) => {
      requireLogin()
      return text(await api.sendText(String(userId), message))
    },
  )

  server.registerTool(
    'send_song_to',
    {
      title: '把一首歌私信给某人',
      description:
        '把一首歌连同一句话发给对方，对方在私信里能直接点开听。' +
        '比单纯发歌名好用。以本账号名义发出。',
      inputSchema: {
        userId: z.number().int().describe('收信人的 uid'),
        songId: z.number().int().describe('歌曲 id，用 search_song 拿'),
        message: z.string().max(500).default('').describe('附带的一句话，可留空'),
      },
    },
    async ({ userId, songId, message }) => {
      requireLogin()
      return text(await api.sendSong(String(userId), songId, message))
    },
  )

  server.registerTool(
    'login_status',
    {
      title: '登录状态',
      description: '查当前服务有没有登录、登录的是哪个账号。掉线了要去 /login 重新扫码。',
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
}
