# netease-mcp

网易云音乐 MCP 服务。部署一次，扫码一次，之后作为 **claude.ai 远程连接器**直接挂载。

## 它能做什么

| 工具 | 说明 |
|---|---|
| `search_song` | 搜歌，返回歌曲 id / 名称 / 歌手 / 专辑 |
| `like_song` | 收藏、取消收藏 |
| `my_playlists` | 列出自己的歌单（拿 pid） |
| `create_playlist` | 新建歌单 |
| `add_to_playlist` | 歌曲加入 / 移出歌单 |
| `write_comment` | 给歌曲或歌单发评论 |
| `listen_together_status` | 查看「一起听」房间状态 |
| `login_status` | 查当前登录的账号 |

> **换歌（一起听遥控）暂未实现。** 上游接口 `listentogether_play_command` 存在，
> 但它的语义是「本客户端上报播放状态」，能否真正让对方客户端跳歌需要实机验证。
> 没验证的功能不写进来。

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
  netease.js   上游 API 封装：注入 cookie / realIP，翻译错误
  session.js   登录态持久化与自动续期
```
