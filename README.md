# netease-mcp

网易云音乐 MCP 服务。部署一次，扫码一次，之后作为 **claude.ai 远程连接器**直接挂载。

## 它能做什么

| 工具 | 说明 |
|---|---|
| `search_song` | 搜歌，返回歌曲 id / 名称 / 歌手 / 专辑 / 时长 |
| `get_lyric` | 看歌词，有翻译、罗马音一并返回 |
| `like_song` | 收藏、取消收藏 |
| `my_playlists` | 列出自己的歌单（拿 pid） |
| `create_playlist` | 新建歌单 |
| `add_to_playlist` | 歌曲加入 / 移出歌单 |
| `write_comment` | 给歌曲或歌单发评论 |
| `send_message` | 给某人发文字私信 |
| `send_song_to` | 把一首歌连同一句话私信给某人 |
| `listen_together_status` | 查看「一起听」房间状态 |
| `login_status` | 查当前登录的账号 |

### 两个已知够不到的地方

**一起听房间内的聊天发不了。** 房间聊天走网易云信 IM 长连接
（`roomRTCType: "yunxin"`，房间返回里有 `chatRoomId` 和
`agoraChannelId`），需要独立 SDK 和 token。上游 377 个接口里没有
任何一个能往房间里发消息。`send_message` 是私信，不是房间发言。

**遥控切歌做不到（已实测证伪，工具已移除）。** 曾经有一个实验性的
`listen_together_play`，调上游的 `listentogether_play_command`。实测结果：

```
上游返回 { code: 200, data: { result: true } }   // 报告成功
对方客户端                                        // 纹丝不动
```

原因在 endpoint 名字里——`/api/listen/together/play/command/report`，
结尾那个 **report** 是「上报」不是「下发」。真正推给对方设备的那一步走云信 IM 长连接，
纯 HTTP 调用不是房间里的活跃客户端，推送不会发出。参数名传得完全正确
（`commandType` / `targetSongId` / `clientSeq` 都对得上上游源码），
所以这不是调用姿势问题，是能力边界。

**一个报成功但什么都没做的工具，比没有这个工具更糟**——它会让调用方
基于假成功继续往下走。所以它被删掉了，而不是留着加个警告。

## 部署（Zeabur）

1. 新建服务，指向本仓库。仓库带 `Dockerfile` 和 `zbpack.json`，会自动按 Dockerfile 构建。
2. **挂一个持久卷到 `/app/data`** —— 登录态存在这里，不挂的话每次重启都要重新扫码。
3. 配置环境变量：

   | 变量 | 必填 | 说明 |
   |---|---|---|
   | `AUTH_PASSWORD` | ✅ | 连接器授权口令，自己设一个长的。不设则 `/mcp` 不鉴权 |
   | `PUBLIC_URL` | ✅ | 部署后的公开地址，如 `https://xxx.zeabur.app`。OAuth 回调要用 |
   | `REAL_IP` | 建议 | 国内 IP。网易云按 IP 限区，境外服务器不带会静默失败 |

4. 部署完成后访问 `https://你的域名/login`，用网易云 App 扫码。扫一次即可，服务每 12 小时自动续期。

## 挂到 claude.ai

设置 → 连接器 → 添加自定义连接器，地址填：

```
https://你的域名/mcp
```

会跳到授权页，输入 `AUTH_PASSWORD` 即可。令牌有效期一年，服务重启不失效。

## 本地跑

```bash
cp .env.example .env   # 改里面的口令
npm install
npm start              # 默认 http://localhost:8080
npm test               # 纯函数单元测试，不碰网络
```

## 已知限制

- **网易云没有官方开放 API。** 本项目依赖社区维护的
  [`NeteaseCloudMusicApi`](https://www.npmjs.com/package/NeteaseCloudMusicApi)，
  上游接口随时可能变。
- 评论、收藏等写操作**落在你本人账号名下**，是公开可见的。
- 服务器需要能访问 `music.163.com`。

## 结构

```
src/
  server.js    HTTP 服务：MCP 端点、扫码页、健康检查
  oauth.js     claude.ai 连接器要求的 OAuth 2.0（含 PKCE）
  tools.js     MCP 工具定义
  netease.js   上游 API 封装：注入 cookie / realIP，校验错误码，翻译错误
  session.js   登录态持久化与自动续期
test/
  unit.test.js 纯函数用例（错误翻译、字段裁剪、时长计算）
```

## 一条设计原则

上游有一批接口**会把失败吞成 HTTP 200**，真正的错误码藏在 `body.code` 里
（最典型的是 `playlist_tracks`，源码里 `catch` 之后原样
`return { status: 200, body: error.body }`）。所以 `netease.js` 的 `call()`
统一校验 `body.code`，非 200 一律抛出人话错误。

对应到工具设计上：**宁可少一个工具，不要多一个会撒谎的工具。**
