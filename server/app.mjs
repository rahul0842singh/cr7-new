import { createServer } from 'node:http';
import { openReportStore, reportFilter } from './mongo-store.mjs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { isIP } from 'node:net';

export const PAYMENT_ADDRESS = 'GT4Yb6bbst19uYo2Kzc42Uun7Hj1Xj94umbMtzioeVkx';
const clean = (value, limit = 200) => String(value ?? '').slice(0, limit);
const normalizeIP = ip => (ip || '').replace(/^::ffff:/, '');
export function clientIP(req, trusted = []) {
  const peer = normalizeIP(req.socket.remoteAddress);
  if (trusted.includes(peer)) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
    if (isIP(forwarded)) return normalizeIP(forwarded);
  }
  return peer;
}
export function isPublicIP(ip) {
  if (isIP(ip) === 4) {
    const [a,b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18,19].includes(b)));
  }
  return isIP(ip) === 6 && /^[23]/.test(ip) && !ip.startsWith('2001:db8:');
}
export async function lookupLocation(ip) {
  if (!isPublicIP(ip)) return { status: 'local', city: '', region: '', country: '' };
  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,region,country`, { signal: AbortSignal.timeout(3500) });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error('Unavailable');
    return { status: 'located', city: clean(data.city,100), region: clean(data.region,100), country: clean(data.country,100) };
  } catch { return { status: 'unavailable', city: '', region: '', country: '' }; }
}
export async function createApplication({ mongoUri = process.env.MONGODB_URI, databaseName = process.env.MONGODB_DB, password = process.env.ADMIN_PASSWORD, secure = process.env.NODE_ENV === 'production', trustedProxies = (process.env.TRUSTED_PROXY_IPS || '').split(',').filter(Boolean), geo = lookupLocation } = {}) {
  if (!password || password.length < 16) throw new Error('Set ADMIN_PASSWORD (at least 16 characters). Run npm run setup:admin.');
  const store = await openReportStore({mongoUri,databaseName});
  const sessions = new Map(), limits = new Map(), cache = new Map(), pending = new Set();
  const digest = v => createHash('sha256').update(v).digest();
  const passwordHash = digest(password);
  const rateLimit = (key, max) => {
    const now = Date.now();
    if (limits.size > 10000) for (const [k,v] of limits) if (v.until < now) limits.delete(k);
    const record = limits.get(key) || { count: 0, until: now + 60000 };
    if (record.until < now) { record.count = 0; record.until = now + 60000; }
    record.count++; limits.set(key,record); return record.count > max;
  };
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type':'application/json', 'Cache-Control':'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = async req => {
    if (!String(req.headers['content-type']).startsWith('application/json')) throw Object.assign(new Error('JSON required'),{status:415});
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 8192) throw Object.assign(new Error('Request too large'),{status:413}); }
    try { return JSON.parse(body); } catch { throw Object.assign(new Error('Invalid JSON'),{status:400}); }
  };
  const cookie = req => /(?:^|;\s*)cr7_admin=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const authorized = req => { const token = cookie(req); const expiry = sessions.get(token); if (expiry && expiry > Date.now()) return true; sessions.delete(token); return false; };
  const setCookie = (res, token, age) => res.setHeader('Set-Cookie', `cr7_admin=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${age}${secure ? '; Secure' : ''}`);
  const server = createServer(async (req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','same-origin');
    try {
      const url = new URL(req.url,'http://localhost');
      const ip = clientIP(req,trustedProxies);
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return json(res,403,{error:'Origin not allowed'});
        if (req.headers['sec-fetch-site'] === 'cross-site') return json(res,403,{error:'Origin not allowed'});
      }
      if (url.pathname === '/api/health') { await store.ping(); return json(res,200,{ok:true,database:'mongodb'}); }
      if (url.pathname === '/api/payment-reports' && req.method === 'POST') {
        if (rateLimit(`reports:${ip}`,60)) return json(res,429,{error:'Too many reports. Please retry in a minute.'});
        const data = await readBody(req);
        if (!/^[a-f0-9-]{36}$/i.test(data.eventId || '') || typeof data.orderId !== 'string' || !/^#?[a-zA-Z0-9_-]{1,80}$/.test(data.orderId) || typeof data.amount !== 'number' || !Number.isFinite(data.amount) || data.amount < 0.2 || data.amount > 1e9 || data.currency !== 'SOL') return json(res,400,{error:'Invalid order details. Please return to checkout.'});
        const base = Math.floor(data.amount * 7000), bonus = data.amount >= 5 ? .35 : data.amount >= 1 ? .1 : 0;
        const inserted = await store.insert({id:data.eventId,createdAt:new Date().toISOString(),orderId:data.orderId,amount:data.amount,currency:'SOL',tokenAmount:base+Math.floor(base*bonus),recipientAddress:PAYMENT_ADDRESS,ip,city:'',region:'',country:'',locationStatus:'pending',userAgent:clean(req.headers['user-agent'],500),language:clean(req.headers['accept-language'],100),timezone:clean(data.timezone,100)});
        if (inserted) {
          const job = (async () => {
            let location;
            try {
              const cached = cache.get(ip);
              location = cached && cached.expires > Date.now() ? cached.value : await geo(ip);
              if (cache.size > 2000) cache.clear();
              cache.set(ip,{value:location,expires:Date.now()+3600000});
            } catch { location = {status:'unavailable',city:'',region:'',country:''}; }
            await store.updateLocation(data.eventId,location);
          })();
          pending.add(job); job.catch(() => console.error("Location update could not be saved; report remains recorded.")).finally(() => pending.delete(job));
        }
        return json(res, inserted ? 201 : 200, { recorded:true, duplicate:!inserted });
      }
      if (url.pathname === '/api/admin/login' && req.method === 'POST') {
        if (rateLimit(`login:${ip}`,5)) return json(res,429,{error:'Too many attempts. Try again in a minute.'});
        const body = await readBody(req);
        if (!timingSafeEqual(digest(clean(body.password,1024)),passwordHash)) return json(res,401,{error:'Incorrect password'});
        for (const [key,expiry] of sessions) if (expiry < Date.now()) sessions.delete(key);
        const token = randomBytes(32).toString('hex'); sessions.set(token,Date.now()+8*3600000); setCookie(res,token,28800); return json(res,200,{ok:true});
      }
      if (url.pathname.startsWith('/api/admin/')) {
        if (!authorized(req)) return json(res,401,{error:'Admin login required'});
        if (url.pathname === '/api/admin/session') return json(res,200,{ok:true});
        if (url.pathname === '/api/admin/logout' && req.method === 'POST') { sessions.delete(cookie(req)); setCookie(res,'',0); return json(res,200,{ok:true}); }
        if (['/api/admin/reports','/api/admin/export'].includes(url.pathname) && req.method === 'GET') {
          const filter = reportFilter(url);
          if (url.pathname.endsWith('/export')) {
            const rows = await store.exportRows(filter);
            if (rows.length > 10000) return json(res,400,{error:'Narrow the date range to export at most 10,000 records.'});
            const columns = ['id','createdAt','orderId','amount','currency','tokenAmount','recipientAddress','ip','city','region','country','locationStatus','userAgent','language','timezone'];
            const escape = value => '"'+String(value ?? '').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
            res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="payment-clicks.csv"','Cache-Control':'no-store'});
            return res.end('\uFEFF'+[columns.join(','),...rows.map(row => columns.map(c=>escape(row[c])).join(','))].join('\r\n'));
          }
          const page = Math.max(1,Math.min(100000,parseInt(url.searchParams.get('page') || '1') || 1));
          return json(res,200,await store.dashboard(filter,page));
        }
      }
      if (url.pathname.startsWith('/api/')) return json(res,404,{error:'Not found'});
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res,405,{error:'Method not allowed'});
      const root = resolve('dist'); let file = resolve(root,'.'+decodeURIComponent(url.pathname));
      if (!file.startsWith(root+sep)) file = resolve(root,'index.html');
      if (!existsSync(file) || !statSync(file).isFile()) file = resolve(root,'index.html');
      if (!existsSync(file)) return json(res,404,{error:'Build the website first: npm run build'});
      const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'};
      res.writeHead(200,{'Content-Type':types[extname(file)] || 'application/octet-stream','Cache-Control':extname(file)==='.html'?'no-cache':'public, max-age=3600'});
      if (req.method==='HEAD') return res.end(); createReadStream(file).pipe(res);
    } catch(error) { if (!res.headersSent) json(res,error.status || 500,{error:error.status ? error.message : 'Unable to save or load data. Please retry.'}); else res.end(); }
  });
  return {server,async close(){ if(server.listening) await new Promise(resolve=>server.close(resolve)); await Promise.allSettled([...pending]); await store.close(); }};
}

