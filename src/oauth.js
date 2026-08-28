// claude.ai 远程连接器要求的 OAuth 2.0 最小实现。
//
// 令牌用 HMAC 自签，不落库：进程重启后已授权的连接器不用重新授权。
// 授权页用一个口令（AUTH_PASSWORD）把门，防止别人拿到你的地址就能连。
//
// 「最小」不等于「可以省掉绑定」：授权码必须绑死申请它的那个客户端和
// 那个回调地址，否则任何人都能构造一个把码送去自己服务器的授权链接，
// 而受害者看到的是你自己的域名和你自己的口令框。
import crypto from 'node:crypto'

// 同样要 trim：面板上多粘一个空格就会改变下面的密钥，
// 导致所有已签发的令牌静默失效，而客户端只会报「令牌过期」。
const PASSWORD = (process.env.AUTH_PASSWORD || '').trim()
const SECRET = crypto
  .createHash('sha256')
  .update(PASSWORD || 'insecure-default')
  .digest()

// 一年期令牌意味着一年内没有任何办法把它收回来。改成 30 天，
// 到期客户端会自己走一遍授权流程，用户只是再输一次口令。
// 需要立刻吊销全部令牌时：改掉 AUTH_PASSWORD——SECRET 是从口令派生的，
// 口令一变，所有已签发的令牌当场失效。启动日志里的口令指纹就是给这件事用的。
const TOKEN_TTL_S = 30 * 24 * 3600
// 扫码登录只需要几分钟，管理会话没有理由活得比这更久。
const ADMIN_TTL_S = 30 * 60

// 授权码活不过几分钟，放内存就够
const codes = new Map()
// 动态注册过的客户端：client_id -> { redirect_uris: Set }
// 不落盘。进程重启后客户端会重新注册一次，这是 MCP 客户端的常规行为。
const clients = new Map()

// 口令的短指纹。不泄露口令本身，但口令一变它就变——
// 令牌突然全失效时，对比这个值就能确认是不是口令被改了。
export const passwordFingerprint = PASSWORD
  ? crypto.createHash('sha256').update(PASSWORD).digest('hex').slice(0, 8)
  : null

export const hasPassword = Boolean(PASSWORD)

function b64u(buf) {
  return Buffer.from(buf).toString('base64url')
}

function sign(payload) {
  const body = b64u(JSON.stringify(payload))
  const mac = b64u(crypto.createHmac('sha256', SECRET).update(body).digest())
  return `${body}.${mac}`
}

// 只验签名和有效期，不认领用途。用途由调用方检查 purpose 字段——
// 管理会话的 cookie 和连接器的 access token 都是这里签出来的，
// 但它们绝不能互相顶用。
function openSigned(token) {
  if (!token || !token.includes('.')) return null
  const [body, mac] = token.split('.')
  const expect = b64u(crypto.createHmac('sha256', SECRET).update(body).digest())
  // 定长比较，避免时序泄漏
  if (mac.length !== expect.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url'))
    return payload.exp > Date.now() / 1000 ? payload : null
  } catch {
    return null
  }
}

export function verifyToken(token) {
  const payload = openSigned(token)
  return Boolean(payload && payload.purpose === 'access')
}

export function verifyAdmin(token) {
  const payload = openSigned(token)
  return Boolean(payload && payload.purpose === 'admin')
}

export function signAdmin() {
  return sign({ purpose: 'admin', exp: Math.floor(Date.now() / 1000) + ADMIN_TTL_S })
}

export const ADMIN_COOKIE = 'tx_admin'

export function readCookie(req, name) {
  const raw = req.headers?.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim())
    }
  }
  return null
}

// PKCE 只接受 S256。允许 plain 等于允许「挑战即验证码」，
// 授权码一旦在传输中被看到，PKCE 就没有任何保护作用了。
function pkceOk(verifier, challenge) {
  if (!challenge || !verifier) return false
  const expect = b64u(crypto.createHash('sha256').update(verifier).digest())
  if (expect.length !== challenge.length) return false
  return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(challenge))
}

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export const formPage = ({ action, title, hint, params = {}, error }) => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
 body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#eee;
      display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
 form{background:#1c1c1c;padding:32px;border-radius:14px;width:min(360px,88vw)}
 h1{font-size:17px;margin:0 0 6px} p{color:#999;font-size:13px;margin:0 0 20px}
 input{width:100%;box-sizing:border-box;padding:11px;border-radius:8px;
       border:1px solid #333;background:#111;color:#eee;font-size:15px}
 button{width:100%;margin-top:14px;padding:11px;border:0;border-radius:8px;
        background:#c96442;color:#fff;font-size:15px;cursor:pointer}
 .err{color:#e5736a;font-size:13px;margin-top:10px}
</style>
<form method="post" action="${esc(action)}">
  <h1>听雪</h1>
  <p>${esc(hint)}</p>
  ${Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('')}
  <input type="password" name="password" placeholder="访问口令" autofocus>
  <button type="submit">确认</button>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
</form>`

// 口令比较也走定长，避免逐字符早退泄漏长度/前缀。
export function passwordOk(input) {
  if (!PASSWORD) return false
  const a = Buffer.from(String(input ?? ''))
  const b = Buffer.from(PASSWORD)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function mountOAuth(app, baseUrl) {
  // --- 发现文档 ---
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({ resource: baseUrl, authorization_servers: [baseUrl] })
  })
  // 有些客户端会带上资源路径去问，一并答上
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
    res.json({ resource: baseUrl, authorization_servers: [baseUrl] })
  })

  app.get(
    ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'],
    (_req, res) => {
      res.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        registration_endpoint: `${baseUrl}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        // 只宣告 S256。宣告 plain 等于告诉客户端「可以不保护」。
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
    },
  )

  // --- 动态客户端注册（RFC 7591）---
  // 会真的把注册信息记下来：授权阶段要拿它来核验 redirect_uri。
  app.post('/oauth/register', (req, res) => {
    const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : []
    const valid = uris.filter((u) => {
      try {
        const parsed = new URL(u)
        return parsed.protocol === 'https:' || parsed.hostname === 'localhost' ||
          parsed.hostname === '127.0.0.1' || !parsed.protocol.startsWith('http')
      } catch {
        return false
      }
    })
    if (!valid.length) {
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: '至少要登记一个 https 或本地回环的 redirect_uri',
      })
    }
    const clientId = `c_${crypto.randomBytes(12).toString('hex')}`
    clients.set(clientId, { redirectUris: new Set(valid), at: Date.now() })
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: valid,
      token_endpoint_auth_method: 'none',
    })
  })

  // 授权请求的公共校验：client_id 必须注册过，redirect_uri 必须逐字匹配。
  // 不匹配时**绝不重定向**——往一个没登记过的地址跳，本身就是漏洞。
  function checkAuthzParams(q) {
    const clientId = q.client_id
    const redirectUri = q.redirect_uri
    if (!clientId) return { error: '缺少 client_id' }
    if (!redirectUri) return { error: '缺少 redirect_uri' }
    const client = clients.get(clientId)
    if (!client) return { error: '未知的 client_id，请先注册（服务重启后需重新授权）' }
    if (!client.redirectUris.has(redirectUri)) return { error: 'redirect_uri 与注册时登记的不一致' }
    if (!q.code_challenge) return { error: '缺少 code_challenge（本服务强制 PKCE）' }
    if (q.code_challenge_method !== 'S256') return { error: 'code_challenge_method 必须是 S256' }
    return { clientId, redirectUri }
  }

  const authzFields = (q) => ({
    client_id: q.client_id,
    redirect_uri: q.redirect_uri,
    state: q.state,
    code_challenge: q.code_challenge,
    code_challenge_method: q.code_challenge_method,
  })

  // --- 授权页 ---
  app.get('/oauth/authorize', (req, res) => {
    if (!PASSWORD) return res.status(500).send('服务端未设置 AUTH_PASSWORD')
    const checked = checkAuthzParams(req.query)
    if (checked.error) return res.status(400).send(esc(checked.error))
    res.type('html').send(
      formPage({
        action: `${baseUrl}/oauth/authorize`,
        title: '授权连接',
        hint: '输入访问口令，允许这个客户端连接。',
        params: authzFields(req.query),
      }),
    )
  })

  app.post('/oauth/authorize', (req, res) => {
    if (!PASSWORD) return res.status(500).send('服务端未设置 AUTH_PASSWORD')
    const checked = checkAuthzParams(req.body || {})
    if (checked.error) return res.status(400).send(esc(checked.error))
    if (!passwordOk(req.body.password)) {
      return res.type('html').send(
        formPage({
          action: `${baseUrl}/oauth/authorize`,
          title: '授权连接',
          hint: '输入访问口令，允许这个客户端连接。',
          params: authzFields(req.body),
          error: '口令不对',
        }),
      )
    }
    const code = crypto.randomBytes(24).toString('hex')
    codes.set(code, {
      clientId: checked.clientId,
      redirectUri: checked.redirectUri,
      challenge: req.body.code_challenge,
      exp: Date.now() + 5 * 60_000,
    })
    const url = new URL(checked.redirectUri)
    url.searchParams.set('code', code)
    if (req.body.state) url.searchParams.set('state', req.body.state)
    res.redirect(url.toString())
  })

  // --- 换令牌 ---
  app.post('/oauth/token', (req, res) => {
    const { code, code_verifier, client_id, redirect_uri } = req.body || {}
    const entry = codes.get(code)
    codes.delete(code)
    const bad = (desc) => res.status(400).json({ error: 'invalid_grant', error_description: desc })
    if (!entry || entry.exp < Date.now()) return bad('授权码无效或已过期')
    // 换码时再核一次：码只能由申请它的那个客户端、用同一个回调地址来换。
    if (entry.clientId !== client_id) return bad('client_id 与授权码不匹配')
    if (entry.redirectUri !== redirect_uri) return bad('redirect_uri 与授权码不匹配')
    if (!pkceOk(code_verifier, entry.challenge)) return bad('PKCE 校验失败')
    res.json({
      access_token: sign({
        purpose: 'access',
        iss: baseUrl,
        aud: baseUrl,
        cid: entry.clientId,
        exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S,
      }),
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_S,
    })
  })

  // 过期的授权码不会自己消失，定期清一遍，免得内存慢慢涨。
  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [k, v] of codes) if (v.exp < now) codes.delete(k)
  }, 60_000)
  sweeper.unref?.()
}

// /mcp 的守门：没令牌就 401，并按规范指路给发现文档
export function requireAuth(baseUrl) {
  return (req, res, next) => {
    if (!PASSWORD) return next() // 没设口令就不鉴权（仅建议本地用）
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (verifyToken(token)) return next()
    res
      .status(401)
      .set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
      )
      .json({ error: 'unauthorized' })
  }
}
