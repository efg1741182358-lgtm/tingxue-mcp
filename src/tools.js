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
function slimSongs(result) {
  const songs = result?.result?.songs || []
  return songs.map((s) => ({
    id: s.id,
    名称: s.name,
    歌手: (s.artists || s.ar || []).map((a) => a.name).join('/'),
    专辑: s.album?.name || s.al?.name,
  }))
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
      description: '按关键词搜索歌曲，返回歌曲 id、名称、歌手、专辑。拿到 id 才能收藏、加歌单、评论。',
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
      description: '把一首或多首歌加进指定歌单，也可以从歌单移除。',
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
    'listen_together_play',
    {
      title: '一起听发送播放指令（实验性）',
      description:
        '向当前「一起听」房间上报一条播放指令，尝试让房间切到指定歌曲。' +
        '⚠ 实验性：上游接口的语义是「本客户端上报自己的播放状态」，' +
        '能否真正遥控对方客户端未经证实，commandType 的合法取值上游也没有文档。' +
        '不填 roomId 时自动从当前房间状态取。',
      inputSchema: {
        targetSongId: z.number().int().describe('要切到的歌曲 id，用 search_song 拿'),
        commandType: z
          .string()
          .default('PLAY')
          .describe('指令类型。取值未知，需实验：PLAY / PAUSE / RESUME / SEEK / SWITCH 等'),
        playStatus: z.string().default('PLAY').describe('播放状态，通常 PLAY 或 PAUSE'),
        progress: z.number().int().default(0).describe('播放进度（毫秒）'),
        formerSongId: z
          .number()
          .int()
          .optional()
          .describe('切换前那首歌的 id，可不填'),
        roomId: z.string().optional().describe('房间 id，不填则自动取当前房间'),
      },
    },
    async ({ targetSongId, commandType, playStatus, progress, formerSongId, roomId }) => {
      requireLogin()

      // 省掉调用方先查一次房间的麻烦
      if (!roomId) {
        const st = await api.listenTogetherStatus()
        roomId = st?.data?.roomInfo?.roomId
        if (!roomId) throw new Error('当前不在任何一起听房间里，无法发送播放指令。')
      }

      const params = {
        roomId,
        commandType,
        playStatus,
        progress,
        targetSongId,
        formerSongId: formerSongId ?? 0,
        // 客户端序列号：同一房间内递增即可，用时间戳最省事
        clientSeq: Date.now(),
      }
      const res = await api.listenTogetherPlayCommand(params)
      return text({ 发送的参数: params, 上游返回: res })
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
