// 纯函数单元测试：不碰网络，跑 `npm test` 即可。
// 这些用例全部来自实测踩到的坑，不是为了凑覆盖率。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { explain, boolFlag } from '../src/netease.js'
import { slimSongs, mmss, slimRoom, stripTimestamps, enabledTools } from '../src/tools.js'

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
  assert.deepEqual([...on].sort(), ['listen_together_status', 'search_song'])
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
