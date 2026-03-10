const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SCOPES = 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.compose';
const PORT = process.env.PORT || 3847;

// In-memory token store (will be sent back to main server via webhook)
const WEBHOOK_URL = process.env.WEBHOOK_URL; // URL to send tokens back to main server

function getRedirectUri(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3847';
  const proto = req.headers['x-forwarded-proto'] || (req.headers.host?.includes('localhost') ? 'http' : 'https');
  return `${proto}://${host}/oauth/callback`;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // Health check
  if (parsed.pathname === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }

  // Step 1: Start OAuth - /connect?user=+33XXXXXXXXX
  if (parsed.pathname === '/connect') {
    const user = parsed.query.user || 'unknown';
    const redirectUri = getRedirectUri(req);
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&access_type=offline` +
      `&prompt=consent` +
      `&state=${encodeURIComponent(user)}`;
    
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // Step 2: OAuth callback
  if (parsed.pathname === '/oauth/callback') {
    const code = parsed.query.code;
    const user = parsed.query.state || 'unknown';
    
    if (!code) {
      res.writeHead(400);
      res.end('Erreur: pas de code');
      return;
    }

    const redirectUri = getRedirectUri(req);
    const postData = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }).toString();

    const tokenReq = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (tokenRes) => {
      let body = '';
      tokenRes.on('data', d => body += d);
      tokenRes.on('end', () => {
        try {
          const tokens = JSON.parse(body);
          
          if (tokens.error) {
            console.error('Token error:', tokens);
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<h1>Erreur</h1><p>${tokens.error_description || tokens.error}</p>`);
            return;
          }

          // Send tokens to main server via webhook
          if (WEBHOOK_URL) {
            const webhookData = JSON.stringify({ user, tokens });
            const webhookUrl = new URL(WEBHOOK_URL);
            const httpModule = webhookUrl.protocol === 'https:' ? https : http;
            const webhookReq = httpModule.request({
              hostname: webhookUrl.hostname,
              port: webhookUrl.port || (webhookUrl.protocol === 'https:' ? 443 : 80),
              path: webhookUrl.pathname,
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(webhookData)
              },
              timeout: 10000
            }, (whRes) => {
              let b = '';
              whRes.on('data', d => b += d);
              whRes.on('end', () => console.log(`Webhook response: ${whRes.statusCode} ${b}`));
            });
            webhookReq.on('error', e => console.error('Webhook error:', e.message));
            webhookReq.write(webhookData);
            webhookReq.end();
          }

          // Also save locally
          const userDir = path.join(__dirname, 'tokens', user.replace(/[^a-zA-Z0-9+]/g, '_'));
          fs.mkdirSync(userDir, { recursive: true });
          fs.writeFileSync(path.join(userDir, 'google-tokens.json'), JSON.stringify(tokens, null, 2));
          
          console.log(`✅ Tokens saved for ${user}`);
          
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
            <body style="font-family: sans-serif; text-align: center; padding: 60px 20px; background: #FBF7F2;">
              <div style="font-size: 64px; margin-bottom: 20px;">🧠</div>
              <h1 style="color: #1B1F3B;">C'est connecté !</h1>
              <p style="color: #4A4D68; font-size: 18px;">
                Cervobis a maintenant accès à ton agenda et tes mails.<br><br>
                👉 <b>Retourne sur WhatsApp et envoie "c'est bon"</b> pour que je regarde ta semaine !
              </p>
              <p style="margin-top: 40px; color: #7C7F99;">Tu peux fermer cette page.</p>
            </body>
            </html>
          `);
        } catch(e) {
          console.error('Token parse error:', e, body);
          res.writeHead(500);
          res.end('Erreur lors de la connexion');
        }
      });
    });
    
    tokenReq.on('error', (e) => {
      console.error('Token request error:', e);
      res.writeHead(500);
      res.end('Erreur serveur');
    });
    
    tokenReq.write(postData);
    tokenReq.end();
    return;
  }

  // Check if user has connected - /tokens?user=+33XXXXXXXXX
  if (parsed.pathname === '/tokens') {
    const user = parsed.query.user || '';
    const userDir = path.join(__dirname, 'tokens', user.replace(/[^a-zA-Z0-9+]/g, '_'));
    const tokenFile = path.join(userDir, 'google-tokens.json');
    
    if (fs.existsSync(tokenFile)) {
      const tokens = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connected: true, tokens }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connected: false }));
    }
    return;
  }

  // Default
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`
    <!DOCTYPE html>
    <html>
    <body style="font-family: sans-serif; text-align: center; padding: 60px; background: #FBF7F2;">
      <div style="font-size: 64px;">🧠</div>
      <h1>Cervobis</h1>
      <p>Serveur d'authentification</p>
    </body>
    </html>
  `);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🧠 Cervobis OAuth server running on port ${PORT}`);
});
