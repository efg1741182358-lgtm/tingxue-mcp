import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { registerTools, GROUPS } from './tools.js'
import { mountOAuth, requireAuth, passwordFingerprint } from './oauth.js'
import { api } from './netease.js'
import * as session from './session.js'

const PORT = Number(process.env.PORT || 8080)
// 环境变量在各家面板上粘贴时很容易带上首尾空白，而带空格的 issuer
// 会让 OAuth 客户端拿到畸形 URL、且报错完全不指向真正的原因。这里统一清掉。
const BASE_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`)
  .trim()
  .replace(/\/+$/, '')

// 构建标记：优先用部署平台注入的 commit，没有就退回 package.json 的版本号。
// 各家面板注入的变量名不一样，都试一遍，别为了一个字符串把服务搞挂。
const BUILD =
  process.env.BUILD_ID ||
  process.env.ZEABUR_GIT_COMMIT_SHA ||
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.SOURCE_COMMIT ||
  process.env.GIT_COMMIT ||
  '0.1.0（未注入 commit）'

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))

mountOAuth(app, BASE_URL)

// --- MCP 端点（无状态：每个请求一个 server 实例，横向扩容也不会串）---
// 这一版到底部署上去没有——今天为这个问题栽过一次：代码推在另一条分支上，
// 面板上怎么点「重新部署」都拉不到，而现象跟「客户端缓存了旧工具表」一模一样。
// 分不出来是因为服务端从不自报家门。所以把「我现在有哪些工具」摆到首页上，
// 用手机浏览器打开就能对答案，不用先开一个新会话去试。
const 启动于 = new Date().toISOString()
let 工具清单 = []

app.post('/mcp', requireAuth(BASE_URL), async (req, res) => {
  const server = new McpServer({ name: 'netease-mcp', version: '0.1.0' })
  工具清单 = registerTools(server)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    transport.close()
    server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
})

// 无状态模式下 GET/DELETE 用不上，按规范回 405
app.all('/mcp', (_req, res) =>
  res.status(405).json({ error: 'method_not_allowed' }),
)

// --- 扫码登录页 ---
app.get('/login', (_req, res) => {
  res.type('html').send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>扫码登录网易云</title>
<style>
 body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#eee;
      display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
 .card{background:#1c1c1c;padding:28px;border-radius:14px;text-align:center;width:min(320px,88vw)}
 h1{font-size:17px;margin:0 0 4px} p{color:#999;font-size:13px;margin:0 0 18px}
 img{width:220px;height:220px;background:#fff;border-radius:8px}
 #msg{margin-top:16px;font-size:14px;min-height:20px}
 .ok{color:#7bc47f}.err{color:#e5736a}
</style>
<div class="card">
  <h1>扫码登录网易云</h1>
  <p>用网易云音乐 App 扫一次，之后长期有效</p>
  <img id="qr" alt="二维码加载中">
  <div id="msg">正在生成二维码…</div>
</div>
<script>
let key
async function boot(){
  const r = await (await fetch('/login/qr')).json()
  key = r.key; document.getElementById('qr').src = r.img
  document.getElementById('msg').textContent = '等待扫码…'
  poll()
}
async function poll(){
  const r = await (await fetch('/login/check?key='+key)).json()
  const m = document.getElementById('msg')
  if(r.code===803){ m.className='ok'; m.textContent='登录成功，可以关掉这个页面了'; return }
  if(r.code===802){ m.textContent='已扫码，请在手机上确认' }
  if(r.code===800){ m.className='err'; m.textContent='二维码过期，正在重新生成…'; return boot() }
  setTimeout(poll, 2000)
}
boot()
</script>`)
})

app.get('/login/qr', async (_req, res) => {
  try {
    const { data } = await api.qrKey()
    const created = await api.qrCreate(data.unikey)
    res.json({ key: data.unikey, img: created.data.qrimg })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/login/check', async (req, res) => {
  try {
    const r = await api.qrCheck(req.query.key)
    if (r.code === 803 && r.cookie) await session.save(r.cookie)
    res.json({ code: r.code, message: r.message })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- 健康检查 / 首页 ---
app.get('/', (_req, res) => {
  res.type('html').send(
    `<meta charset="utf-8"><body style="font-family:system-ui;background:#111;color:#eee;padding:40px">
     <h2>netease-mcp</h2>
     <p>登录状态：<b>${session.isLoggedIn() ? '已登录' : '未登录'}</b></p>
     <p><a href="/login" style="color:#c96442">去扫码登录</a></p>
     <p style="color:#666;font-size:13px">MCP 端点：<code>${BASE_URL}/mcp</code></p>
     <hr style="border:none;border-top:1px solid #333;margin:24px 0">
     <p style="color:#888;font-size:13px">版本 <code>${BUILD}</code> ・ 启动于 ${启动于}</p>
     <p style="color:#888;font-size:13px">本次注册了 <b>${工具清单.length}</b> 个工具：</p>
     <p style="color:#666;font-size:12px;line-height:1.9">${
       工具清单.length
         ? 工具清单.map((n) => `<code>${n}</code>`).join(' ')
         : '（还没有请求打到 /mcp，工具清单在第一次请求后才有）'
     }</p>
     <p style="color:#555;font-size:12px">看不到刚加的工具？先看这里有没有：<b>这里有 = 服务端是新的</b>，
     那就是客户端缓存了旧工具表，换个新会话即可；<b>这里也没有 = 部署没生效</b>，去看拉的是哪条分支。</p>
     </body>`,
  )
})

app.get('/healthz', (_req, res) =>
  res.json({
    ok: true,
    loggedIn: session.isLoggedIn(),
    版本: BUILD,
    启动于,
    工具数: 工具清单.length,
    工具: 工具清单,
  }),
)

// --- 启动 ---
await session.load()
session.startRefreshLoop(async () => {
  const r = await api.loginRefresh()
  return r?.cookie || null
})

app.listen(PORT, () => {
  console.log(`netease-mcp 已启动：${BASE_URL}`)
  console.log(`  MCP  ${BASE_URL}/mcp`)
  console.log(`  登录 ${BASE_URL}/login`)
  if (!process.env.AUTH_PASSWORD) {
    console.warn('  ⚠ 未设置 AUTH_PASSWORD，/mcp 不鉴权，请勿公网暴露')
  }
  if (!process.env.PUBLIC_URL) {
    console.warn('  ⚠ 未设置 PUBLIC_URL，OAuth 会指向 localhost，claude.ai 挂不上')
  } else if (process.env.PUBLIC_URL !== process.env.PUBLIC_URL.trim()) {
    console.warn('  ⚠ PUBLIC_URL 首尾有空白，已自动清除；建议在面板上一并改掉')
  }
  console.log(`  数据目录 ${process.env.DATA_DIR || './data'}（未挂持久卷则重启后需重新扫码）`)
  // 工具定义会进模型每一轮的上下文，是笔固定开销。把启用了几个打出来，
  // 免得部署者不知道自己在为用不上的工具付钱。
  const probe = []
  registerTools({ registerTool: (n) => probe.push(n) })
  console.log(
    `  已启用 ${probe.length} 个工具${
      process.env.TOOLS ? `（TOOLS=${process.env.TOOLS}）` : '（全开，可用 TOOLS 精简）'
    }：${probe.join(' ')}`,
  )
  if (!process.env.TOOLS) {
    console.log(`  可用工具组：${Object.keys(GROUPS).join(' / ')}`)
  }
  if (passwordFingerprint) {
    console.log(`  口令指纹 ${passwordFingerprint}（这个值一变，已签发的令牌全部失效）`)
  }
})
