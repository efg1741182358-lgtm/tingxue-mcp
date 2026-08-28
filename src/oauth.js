// claude.ai 远程连接器要求的 OAuth 2.0 最小实现。
//
// 令牌用 HMAC 自签，不落库：进程重启后已授权的连接器不用重新授权。
// 授权页用一个口令（AUTH_PASSWORD）把门，防止别人拿到你的地址就能连。
import crypto from 'node:crypto'

// 同样要 trim：面板上多粘一个空格就会改变下面的密钥，
// 导致所有已签发的令牌静默失效，而客户端只会报「令牌过期」。
const PASSWORD = (process.env.AUTH_PASSWORD || '').trim()
const SECRET = crypto
  .createHash('sha256')
  .update(PASSWORD || 'insecure-default')
  .digest()

const TOKEN_TTL_S = 365 * 24 * 3600 // 一年，省得反复授权

// 授权码活不过几秒，放内存就够
const codes = new Map()

// 口令的短指纹。不泄露口令本身，但口令一变它就变——
// 令牌突然全失效时，对比这个值就能确认是不是口令被改了。
export const passwordFingerprint = PASSWORD
  ? crypto.createHash('sha256').update(PASSWORD).digest('hex').slice(0, 8)
  : null

function b64u(buf) {
  return Buffer.from(buf).toString('base64url')
}

function sign(payload) {
  const body = b64u(JSON.stringify(payload))
  const mac = b64u(crypto.createHmac('sha256', SECRET).update(body).digest())
  return `${body}.${mac}`
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return false
  const [body, mac] = token.split('.')
  const expect = b64u(crypto.createHmac('sha256', SECRET).update(body).digest())
  // 定长比较，避免时序泄漏
  if (mac.length !== expect.length) return false
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return false
  try {
    return JSON.parse(Buffer.from(body, 'base64url')).exp > Date.now() / 1000
  } catch {
    return false
  }
}

function pkceOk(verifier, challenge, method) {
  if (!challenge) return true // 没用 PKCE 就不校验
  if (method === 'S256') {
    return b64u(crypto.createHash('sha256').update(verifier || '').digest()) === challenge
  }
  return verifier === challenge
}

const page = (base, params, error) => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权连接</title>
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
<form method="post" action="${base}/oauth/authorize">
  <h1>网易云 MCP</h1>
  <p>输入访问口令，允许这个客户端连接。</p>
  ${Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v ?? '').replace(/"/g, '&quot;')}">`)
    .join('')}
  <input type="password" name="password" placeholder="访问口令" autofocus>
  <button type="submit">允许连接</button>
  ${error ? `<div class="err">${error}</div>` : ''}
</form>`

export function mountOAuth(app, baseUrl) {
  // --- 发现文档 ---
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: baseUrl,
      authorization_servers: [baseUrl],
    })
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
        code_challenge_methods_supported: ['S256', 'plain'],
        token_endpoint_auth_methods_supported: ['none'],
      })
    },
  )

  // --- 动态客户端注册（RFC 7591）---
  // 不做真正的客户端管理：谁来都发一个 id，真正的门是授权页的口令。
  app.post('/oauth/register', (req, res) => {
    res.status(201).json({
      client_id: `c_${crypto.randomBytes(12).toString('hex')}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: req.body?.redirect_uris || [],
      token_endpoint_auth_method: 'none',
    })
  })

  // --- 授权页 ---
  app.get('/oauth/authorize', (req, res) => {
    const { redirect_uri, state, code_challenge, code_challenge_method } = req.query
    if (!redirect_uri) return res.status(400).send('缺少 redirect_uri')
    res.type('html').send(
      page(baseUrl, { redirect_uri, state, code_challenge, code_challenge_method }),
    )
  })

  app.post('/oauth/authorize', (req, res) => {
    const { password, redirect_uri, state, code_challenge, code_challenge_method } = req.body
    if (!PASSWORD) return res.status(500).send('服务端未设置 AUTH_PASSWORD')
    if (password !== PASSWORD) {
      return res
        .type('html')
        .send(page(baseUrl, { redirect_uri, state, code_challenge, code_challenge_method }, '口令不对'))
    }
    const code = crypto.randomBytes(24).toString('hex')
    codes.set(code, {
      challenge: code_challenge,
      method: code_challenge_method,
      exp: Date.now() + 5 * 60_000,
    })
    const url = new URL(redirect_uri)
    url.searchParams.set('code', code)
    if (state) url.searchParams.set('state', state)
    res.redirect(url.toString())
  })

  // --- 换令牌 ---
  app.post('/oauth/token', (req, res) => {
    const { code, code_verifier } = req.body || {}
    const entry = codes.get(code)
    codes.delete(code)
    if (!entry || entry.exp < Date.now()) {
      return res.status(400).json({ error: 'invalid_grant' })
    }
    if (!pkceOk(code_verifier, entry.challenge, entry.method)) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE 校验失败' })
    }
    res.json({
      access_token: sign({ exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S }),
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_S,
    })
  })
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
