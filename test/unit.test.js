// 纯函数单元测试：不碰网络，跑 `npm test` 即可。
// 这些用例全部来自实测踩到的坑，不是为了凑覆盖率。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { explain, boolFlag, unwrap, stripCookie } from '../src/netease.js'
import {
  slimSongs, mmss, slimRoom, stripTimestamps, enabledTools, slimComment, slimMessage, ack, slimHistory, beijing, slimTracks, slimRecord, roomIdOf, GROUPS,
} from '../src/tools.js'

test('explain：上游把失败吞成 200 时，仍按 body.code 说人话', () => {
  // playlist_tracks 往别人的歌单里加歌，就是这个形状
  assert.match(explain({ status: 200, body: { code: 401 } }), /不是本账号创建/)
  assert.match(explain({ status: 200, body: { code: 250 } }), /限流/)
  assert.match(explain({ status: 200, body: { code: -2 } }), /内容被拒绝/)
})

test('explain：登录失效和 IP 限区各自指向对应的修法', () => {
  assert.match(explain({ body: { code: 301 } }), /扫码/)
  assert.match(explain({ body: { code: -460 } }), /REAL_IP/)
  assert.match(explain({ status: 403 }), /music\.163\.com/)
})

test('explain：认不出的错误也要带上原始 code 和 msg，不能吃掉线索', () => {
  const msg = explain({ status: 502, body: { code: 8888, msg: '未知情况' } })
  assert.match(msg, /8888/)
  assert.match(msg, /未知情况/)
})

test('mmss：毫秒转时长，秒数补零', () => {
  assert.equal(mmss(227000), '3:47')
  assert.equal(mmss(130000), '2:10')
  assert.equal(mmss(605000), '10:05')
  assert.equal(mmss(0), null)
  assert.equal(mmss(undefined), null)
})

test('slimSongs：只留有用字段，并带上区分翻唱版本的时长', () => {
  const out = slimSongs({
    result: {
      songs: [
        {
          id: 1,
          name: '同淋雪',
          artists: [{ name: '余翊' }],
          album: { name: '同淋雪' },
          duration: 227000,
          // 下面这些是原始返回里的噪音，不该出现在结果里
          copyrightId: 123,
          mvid: 0,
          alias: [],
        },
      ],
    },
  })
  assert.deepEqual(out, [
    { id: 1, 名称: '同淋雪', 歌手: '余翊', 专辑: '同淋雪', 时长: '3:47' },
  ])
})

test('slimSongs：多歌手用 / 连接；搜索为空不报错', () => {
  const out = slimSongs({
    result: { songs: [{ id: 2, name: 'x', ar: [{ name: 'A' }, { name: 'B' }], al: { name: 'Z' }, dt: 60000 }] },
  })
  assert.equal(out[0].歌手, 'A/B')
  assert.equal(out[0].专辑, 'Z')
  assert.deepEqual(slimSongs({}), [])
})

test('slimRoom：不在房间时明说，不返回半个空壳', () => {
  assert.deepEqual(slimRoom({ data: { inRoom: false } }), {
    在一起听: false,
    说明: '当前没有进行中的一起听房间',
  })
})

test('slimRoom：在房间时算出持续时长，并丢掉头像挂件那堆噪音', () => {
  const 三十小时前 = Date.now() - 30 * 3600 * 1000
  const out = slimRoom({
    data: {
      inRoom: true,
      status: 'CONNECTED',
      anotherDeviceInfo: { osType: 'android', appVersion: '9.5.70' },
      roomInfo: {
        roomId: 'r1',
        roomType: 'FRIEND',
        roomCreateTime: 三十小时前,
        roomUsers: [
          { userId: 1, nickname: '甲', avatarDetail: { url: 'x' } },
          { userId: 2, nickname: '乙', avatarDetail: { url: 'y' } },
        ],
      },
    },
  })
  assert.equal(out.已持续, '1 天 6 小时')
  assert.equal(out.对方设备, 'android 9.5.70')
  assert.deepEqual(out.成员, [{ uid: 1, 昵称: '甲' }, { uid: 2, 昵称: '乙' }])
})

test('stripTimestamps：剥掉时间轴，保留歌词本身', () => {
  const lrc = ['[00:11.37]长街又飞雪恍若别离夜', '[00:17.16]故地仍未变只是人已缺', '', '[00:22.86]回忆是深渊'].join('\n')
  assert.equal(stripTimestamps(lrc), '长街又飞雪恍若别离夜\n故地仍未变只是人已缺\n回忆是深渊')
})

test('stripTimestamps：一行多个时间戳（同词复用）也要剥干净', () => {
  assert.equal(stripTimestamps('[00:10.00][01:20.00]副歌'), '副歌')
})

test('stripTimestamps：没有时间轴的纯文本原样返回', () => {
  assert.equal(stripTimestamps('作词 : 某人\n作曲 : 某人'), '作词 : 某人\n作曲 : 某人')
})

test('enabledTools：不设置就是全开', () => {
  assert.equal(enabledTools(undefined), null)
  assert.equal(enabledTools('   '), null)
})

test('enabledTools：按组启用，没启用的工具连定义都不该出现', () => {
  const on = enabledTools('search,lyric')
  assert.deepEqual([...on].sort(), ['get_lyric', 'search_song'])
  assert.ok(!on.has('write_comment'))
})

test('enabledTools：也接受单个工具名，认不出的忽略掉但不炸', () => {
  const on = enabledTools('search_song, 不存在的东西 ,together')
  assert.deepEqual([...on].sort(), [...GROUPS.together, 'search_song'].sort())
  assert.ok(on.has('search_song'))
  assert.ok(!on.has('不存在的东西'))
})

test('boolFlag：布尔转字符串', () => {
  assert.equal(boolFlag(true), 'true')
  assert.equal(boolFlag(false), 'false')
})

test('boolFlag：回归——上游 like.js 拿字符串比布尔，传真 false 会被判成 true', () => {
  // 上游原样逻辑：query.like = query.like == 'false' ? false : true
  const upstream = (v) => (v == 'false' ? false : true)

  // 直接传布尔的下场：取消收藏变成收藏，而且照样回 200
  assert.equal(upstream(false), true, '这就是当初的 bug')

  // 过一遍 boolFlag 之后才是对的
  assert.equal(upstream(boolFlag(false)), false)
  assert.equal(upstream(boolFlag(true)), true)
})

test('unwrap：playlist_tracks 多包的那层要剥掉，露出真正的 code', () => {
  // 实测拿到的原样形状
  const raw = {
    status: 200,
    body: { trackIds: '[3317989656]', code: 200, count: 2, cloudCount: 0 },
    cookie: ['NMTID=xxx; Max-Age=315360000; Path=/;'],
  }
  assert.deepEqual(unwrap(raw), { trackIds: '[3317989656]', code: 200, count: 2, cloudCount: 0 })
})

test('unwrap：剥完之后失败才看得见——这是当初漏掉的那一格', () => {
  const 失败 = { status: 200, body: { code: 401, msg: '无权限' } }
  assert.equal(unwrap(失败).code, 401)
})

test('unwrap：普通返回原样放行，不要误伤', () => {
  assert.deepEqual(unwrap({ code: 200, playlist: [] }), { code: 200, playlist: [] })
  // 有 body 字段但不是那层包装（没有 status / cookie），不动
  assert.deepEqual(unwrap({ code: 200, body: '正文' }), { code: 200, body: '正文' })
  assert.equal(unwrap(null), null)
  assert.deepEqual(unwrap([1, 2]), [1, 2])
})

test('stripCookie：凭证不进模型上下文', () => {
  assert.deepEqual(stripCookie({ code: 200, cookie: ['NMTID=xxx'] }), { code: 200 })
  assert.deepEqual(stripCookie({ code: 200 }), { code: 200 })
  assert.equal(stripCookie(null), null)
})

test('slimComment：只留 commentId 和正文，不要发布者那一大坨资料', () => {
  const out = slimComment({
    code: 200,
    comment: {
      commentId: 12345678,
      content: '测试',
      user: { nickname: '某人', avatarUrl: 'http://…', vipRights: {}, expertTags: null },
      time: 1787893661884,
      likedCount: 0,
    },
  })
  assert.deepEqual(out, { 评论id: 12345678, 内容: '测试' })
})

test('slimComment：拿不到 commentId 要明说「删不掉了」，不能假装成功', () => {
  const out = slimComment({ code: 200 })
  assert.match(out.结果, /删不掉/)
})

test('删除类工具跟对应的创建工具在同一组，不会出现开了创建没开删除', () => {
  assert.ok(GROUPS.library.includes('create_playlist'))
  assert.ok(GROUPS.library.includes('delete_playlist'))
  assert.ok(GROUPS.social.includes('write_comment'))
  assert.ok(GROUPS.social.includes('delete_comment'))
  const on = enabledTools('library')
  assert.ok(on.has('delete_playlist'))
})

test('slimMessage：一句「发送成功」不该带两份用户资料', () => {
  const 上游 = {
    code: 200,
    id: 352421123097,
    newMsgs: [{
      id: 352421123097,
      msg: '{"msg":"测试"}',
      fromUser: { nickname: '甲', avatarUrl: 'http://…', backgroundUrl: 'http://…', birthday: -2209017600000 },
      toUser: { nickname: '乙', avatarUrl: 'http://…', backgroundUrl: 'http://…', vipType: 11 },
    }],
  }
  assert.deepEqual(slimMessage(上游), { 已发送: true, 消息id: 352421123097, 收件人: '乙' })
})

test('slimMessage：上游少字段也不炸', () => {
  assert.deepEqual(slimMessage({}), { 已发送: true, 消息id: null, 收件人: null })
})

test('ack：写操作只回一句确认，不回 code——失败根本走不到这里', () => {
  assert.deepEqual(ack('删除歌单'), { 已完成: '删除歌单' })
})

test('ack：显式留下的字段要保住，pid 丢了歌单就再也加不了歌', () => {
  assert.deepEqual(ack('创建歌单', { pid: 18327059436, 名称: '测试_删我' }), {
    已完成: '创建歌单',
    pid: 18327059436,
    名称: '测试_删我',
  })
})

test('ack：详情里的 null / undefined 不占字数', () => {
  assert.deepEqual(ack('加入歌单', { 歌单现有: undefined, 备注: null, 歌曲数: 0 }), {
    已完成: '加入歌单',
    歌曲数: 0,
  })
})

test('beijing：毫秒时间戳按北京时间显示，不能甩个 UTC 让人自己换算', () => {
  // 2026-08-28T23:30:00+08:00 == 1787931000000
  assert.equal(beijing(1787931000000), '2026-08-28 23:30')
  assert.equal(beijing(0), null)
  assert.equal(beijing(undefined), null)
})

test('slimHistory：认不出返回结构时要明说，不能返回空数组假装「没有评论」', () => {
  const out = slimHistory({ code: 200, 某个没见过的字段: {} })
  assert.ok(!Array.isArray(out), '不能伪装成一个正常的空列表')
  assert.match(out.结果, /没认出/)
  assert.deepEqual(out.顶层字段, ['code', '某个没见过的字段'])
})

test('slimHistory：真的一条评论都没有时，返回的是空数组而不是报错', () => {
  assert.deepEqual(slimHistory({ code: 200, data: { comments: [] } }), [])
})

test('slimHistory：留下 commentId，否则查得到也删不掉', () => {
  const out = slimHistory({
    data: {
      comments: [
        {
          comment: { commentId: 9624313173, content: '他朝若是同淋雪', time: 1787931000000 },
          resource: { name: '同淋雪' },
        },
      ],
    },
  })
  assert.deepEqual(out, [
    { 评论id: 9624313173, 正文: '他朝若是同淋雪', 作品: '同淋雪', 发布时间: '2026-08-28 23:30' },
  ])
})

test('slimHistory：评论字段不套 comment 层时也认得（上游两种写法都见过）', () => {
  const out = slimHistory({
    data: { comments: [{ commentId: 1, content: 'x', time: 1787931000000, resourceInfo: { title: 'y' } }] },
  })
  assert.equal(out[0].评论id, 1)
  assert.equal(out[0].作品, 'y')
})

test('my_comments 跟写/删评论在同一组，不会出现发得出、查不着', () => {
  assert.ok(GROUPS.social.includes('my_comments'))
  assert.ok(GROUPS.social.includes('write_comment'))
  assert.ok(GROUPS.social.includes('delete_comment'))
})

test('slimTracks：截断时必须说出来，不能让人以为歌单就这么点歌', () => {
  const songs = Array.from({ length: 20 }, (_, i) => ({
    id: i, name: 's' + i, ar: [{ name: 'a' }], al: { name: 'b' }, dt: 60000,
  }))
  const out = slimTracks({ songs }, 20, 0)
  assert.equal(out.歌曲.length, 20)
  assert.match(out.说明, /后面还有/)
  assert.match(out.说明, /offset 设成 20/)
})

test('slimTracks：没截断就不要多说一句废话', () => {
  const songs = [{ id: 1, name: 's', ar: [{ name: 'a' }], al: { name: 'b' }, dt: 175000 }]
  const out = slimTracks({ songs }, 20, 0)
  assert.deepEqual(out, { 歌曲: [{ id: 1, 名称: 's', 歌手: 'a', 专辑: 'b', 时长: '2:55' }] })
  assert.equal(out.说明, undefined)
})

test('slimTracks：翻页时说明里的区间要跟着 offset 走', () => {
  const songs = Array.from({ length: 5 }, (_, i) => ({ id: i, name: 's', ar: [], al: {}, dt: 0 }))
  assert.match(slimTracks({ songs }, 5, 20).说明, /第 21~25 首/)
})

test('slimTracks：认不出结构时明说，不返回空歌单', () => {
  const out = slimTracks({ code: 200 }, 20, 0)
  assert.ok(!Array.isArray(out.歌曲))
  assert.match(out.结果, /没认出/)
})

test('slimRecord：空列表分不出「不公开」还是「真没有」，就不能替它选一个说', () => {
  const out = slimRecord({ weekData: [] }, true)
  assert.ok(!Array.isArray(out))
  assert.match(out.结果, /不公开/)
  assert.match(out.结果, /分不出来/)
})

test('slimRecord：周榜和总榜读的是不同字段，别拿错', () => {
  const res = {
    weekData: [{ playCount: 7, song: { name: '周', ar: [{ name: 'x' }] } }],
    allData: [{ playCount: 99, song: { name: '总', ar: [{ name: 'y' }] } }],
  }
  assert.equal(slimRecord(res, true)[0].名称, '周')
  assert.equal(slimRecord(res, false)[0].名称, '总')
  assert.equal(slimRecord(res, false)[0].播放次数, 99)
})

test('slimRecord：认不出结构时明说，不伪装成「没听过歌」', () => {
  assert.match(slimRecord({ code: 200 }, true).结果, /没认出/)
})

test('playlist_songs 跟建歌单/加歌在同一组——造得出就得看得见', () => {
  assert.ok(GROUPS.library.includes('playlist_songs'))
  assert.ok(GROUPS.library.includes('create_playlist'))
  assert.ok(GROUPS.record.includes('listening_record'))
})

test('roomIdOf：房间号在哪一层都认，认不出就是 null 不是瞎编', () => {
  assert.equal(roomIdOf({ data: { roomInfo: { roomId: 'a_1' } } }), 'a_1')
  assert.equal(roomIdOf({ data: { roomId: 'b_2' } }), 'b_2')
  assert.equal(roomIdOf({ roomId: 'c_3' }), 'c_3')
  assert.equal(roomIdOf({ code: 200 }), null)
  assert.equal(roomIdOf(null), null)
})

test('一起听：查/建/结束跟状态在同一组——建得出就得关得掉', () => {
  for (const t of ['listen_together_status', 'listen_together_create',
                   'listen_together_check', 'listen_together_end']) {
    assert.ok(GROUPS.together.includes(t), t)
  }
})
