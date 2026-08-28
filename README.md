# netease-mcp

网易云音乐 MCP 服务。部署一次，扫码一次，之后作为 **claude.ai 远程连接器**直接挂载。

## 它能做什么

| 工具 | 说明 |
|---|---|
| `search_song` | 搜歌，返回歌曲 id / 名称 / 歌手 / 专辑 / 时长 |
| `get_lyric` | 看歌词，有翻译一并返回（已去时间轴） |
| `like_song` | 收藏、取消收藏 |
| `my_playlists` | 列出自己的歌单（拿 pid） |
| `create_playlist` | 新建歌单 |
| `add_to_playlist` | 歌曲加入 / 移出歌单 |
| `write_comment` | 给歌曲或歌单发评论 |
| `send_message` | 给某人发私信，可附一首歌 |
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
   | `TOOLS` | 可选 | 只启用需要的工具组，省 token。不设=全开。见下 |

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

## 省 token

工具定义（`tools/list` 的内容）会被塞进模型**每一轮**的上下文——不管这轮
聊不聊音乐，只要连接器挂着就得付。全开是约 **1300 token 的固定开销**，
对免费额度来说不是小数目。

用 `TOOLS` 只启用需要的组，没启用的工具连定义都不会出现：

| `TOOLS` | 工具数 | 每轮固定开销 |
|---|---:|---:|
| 不设置（全开） | 10 | ~1318 |
| `search,lyric,together` | 3 | ~356 |
| `search,lyric` | 2 | ~264 |

可用组：`search` / `lyric` / `library`（收藏歌单） / `social`（评论私信） /
`together`（一起听） / `status`（登录状态）。也可以直接写单个工具名，
逗号分隔。启动日志会打印实际启用了哪些。

只想听歌查词的话，`TOOLS=search,lyric` 能把固定开销砍掉 **80%**。

### 几条已经做进代码里的

- **歌词默认不返回时间轴。** `[00:11.37]` 这种前缀在对话里没用，
  一首四十行的歌光时间轴就是一两百 token。
- **搜歌默认只回 5 条**（上限 20）。
- **歌单只列本账号创建的**——收藏来的别人的歌单本来也改不了。
- **一起听状态丢掉头像挂件**：原始返回里两个人各带四个挂件 URL，一千多 token。

### 一条反直觉的经验

**加一个参数去省返回值，通常是亏的。** 参数写在 schema 里，每轮都付；
返回值只在真正调用时付。所以这里没有 `withTimestamp` 这样的开关——
默认不需要的东西直接砍掉，而不是给个选项让人自己关。

## 一条设计原则

上游有一批接口**会把失败吞成 HTTP 200**，真正的错误码藏在 `body.code` 里
（最典型的是 `playlist_tracks`，源码里 `catch` 之后原样
`return { status: 200, body: error.body }`）。所以 `netease.js` 的 `call()`
统一校验 `body.code`，非 200 一律抛出人话错误。

对应到工具设计上：**宁可少一个工具，不要多一个会撒谎的工具。**
