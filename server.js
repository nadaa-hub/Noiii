'use strict';
/*
  Elevio: the page + /api/ai proxy to an AI provider (single file, 3 files total in the project).
  No dependencies. Needs Node 18 or newer.
  The API key stays here on the server and never reaches the browser.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');

/* ---------- .env loader (no packages needed) ---------- */
function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv(path.join(__dirname, '.env'));

/* ---------- AI providers ---------- */
async function* sse(body) {
  const dec = new TextDecoder();
  let buf = '';
  const sep = /\r?\n\r?\n/;
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let m;
    while ((m = sep.exec(buf))) {
      const block = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const lines = block.split(/\r?\n/);
      const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      const ev = (lines.find((l) => l.startsWith('event:')) || '').slice(6).trim();
      if (data) yield { event: ev, data };
    }
  }
};

const providers = {};
providers.gemini = {};
(function (exports) {

const key = () => process.env.GEMINI_API_KEY;
const mainModel = () => process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const quickModel = () => process.env.GEMINI_MODEL_QUICK || 'gemini-3.5-flash-lite';
const fallbackModel = () => process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite';

exports.check = () => (key() ? null : 'GEMINI_API_KEY غير موجود. أضفه في ملف .env أو في إعدادات الاستضافة.');

function err(code, status, message) { return Object.assign(new Error(message), { code, status }); }

function merge(turns) {
  const out = [];
  for (const t of turns) {
    const role = t.role === 'assistant' ? 'model' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push({ text: '\n\n' + t.content });
    else out.push({ role, parts: [{ text: t.content }] });
  }
  return out;
}

function call(model, body, signal) {
  return fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key() },
    body: JSON.stringify(body),
    signal,
  });
}

async function failure(resp) {
  let text = '';
  try { text = await resp.text(); } catch (e) {}
  console.error('[gemini]', resp.status, text.slice(0, 400));
  if (resp.status === 429) return err('rate_limited', 429, 'provider rate limit');
  if (resp.status === 400 && !/api key/i.test(text)) return err('invalid_request', 400, 'provider rejected the request');
  return err('upstream_error', 502, 'provider error ' + resp.status);
}

exports.stream = async function* ({ turns, images, json, tier, signal }) {
  const contents = merge(turns);
  const last = contents[contents.length - 1];
  for (const im of images) last.parts.unshift({ inlineData: { mimeType: im.mime, data: im.data } });
  const body = { contents, generationConfig: { temperature: 0.6, maxOutputTokens: 8192 } };
  if (json) body.generationConfig.responseMimeType = 'application/json';

  const model = tier === 'quick' ? quickModel() : mainModel();
  let resp = await call(model, body, signal);
  if ((resp.status === 404 || resp.status === 403) && fallbackModel() !== model) {
    try { await resp.body.cancel(); } catch (e) {}
    resp = await call(fallbackModel(), body, signal);
  }
  if (!resp.ok) throw await failure(resp);

  let truncated = false, emitted = false;
  for await (const ev of sse(resp.body)) {
    let j;
    try { j = JSON.parse(ev.data); } catch (e) { continue; }
    if (j.promptFeedback && j.promptFeedback.blockReason) throw err('refused', 422, 'blocked');
    const c = j.candidates && j.candidates[0];
    if (!c) continue;
    const parts = (c.content && c.content.parts) || [];
    for (const p of parts) {
      if (p.text && !p.thought) { emitted = true; yield p.text; }
    }
    if (c.finishReason === 'MAX_TOKENS') truncated = true;
    if (!emitted && ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION'].includes(c.finishReason)) throw err('refused', 422, 'blocked');
  }
  return { truncated };
};
})(providers.gemini);

providers.claude = {};
(function (exports) {

const key = () => process.env.ANTHROPIC_API_KEY;
const mainModel = () => process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const quickModel = () => process.env.CLAUDE_MODEL_QUICK || 'claude-haiku-5-5';

exports.check = () => (key() ? null : 'ANTHROPIC_API_KEY غير موجود. أضفه في ملف .env أو في إعدادات الاستضافة.');

function err(code, status, message) { return Object.assign(new Error(message), { code, status }); }

function merge(turns) {
  const out = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content.push({ type: 'text', text: '\n\n' + t.content });
    else out.push({ role: t.role, content: [{ type: 'text', text: t.content }] });
  }
  return out;
}

exports.stream = async function* ({ turns, images, json, tier, signal }) {
  const messages = merge(turns);
  const last = messages[messages.length - 1];
  for (const im of images) last.content.unshift({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } });
  const body = {
    model: tier === 'quick' ? quickModel() : mainModel(),
    max_tokens: 8000,
    stream: true,
    messages,
  };
  if (json) body.system = 'Reply with one valid JSON value only. No markdown fences and no text before or after it.';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key(), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    let text = '';
    try { text = await resp.text(); } catch (e) {}
    console.error('[claude]', resp.status, text.slice(0, 400));
    if (resp.status === 429) throw err('rate_limited', 429, 'provider rate limit');
    if (resp.status === 400) throw err('invalid_request', 400, 'provider rejected the request');
    throw err('upstream_error', 502, 'provider error ' + resp.status);
  }

  let truncated = false;
  for await (const ev of sse(resp.body)) {
    let j;
    try { j = JSON.parse(ev.data); } catch (e) { continue; }
    if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta' && j.delta.text) yield j.delta.text;
    else if (j.type === 'message_delta' && j.delta) {
      if (j.delta.stop_reason === 'max_tokens') truncated = true;
      if (j.delta.stop_reason === 'refusal') throw err('refused', 422, 'refused');
    } else if (j.type === 'error') throw err('upstream_error', 502, 'provider stream error');
  }
  return { truncated };
};
})(providers.claude);

providers.mock = {};
(function (exports) {
const QUIZ = JSON.stringify([
  { type: 'mcq', q: 'أين يحدث التمثيل الضوئي في الخلية النباتية؟', options: ['الميتوكوندريا', 'البلاستيدات الخضراء', 'النواة', 'جدار الخلية'], answer: 1, explain: 'تحتوي البلاستيدات الخضراء على الكلوروفيل الذي يمتص الضوء.' },
  { type: 'tf', q: 'ينتج التمثيل الضوئي غاز الأكسجين.', answer: 0, explain: 'يتحلل الماء في التفاعلات الضوئية فيتحرر الأكسجين.' },
  { type: 'mcq', q: 'أي غاز تأخذه النبتة من الهواء؟', options: ['الأكسجين', 'النيتروجين', 'ثاني أكسيد الكربون', 'الهيدروجين'], answer: 2, explain: 'يدخل عبر الثغور ويُحوَّل إلى سكر.' },
  { type: 'short', q: 'اذكر مرحلتي التمثيل الضوئي.', answer: 'التفاعلات الضوئية ودورة كالفن.', explain: 'الأولى في الثايلاكويد والثانية في الستروما.' },
]);
const PLAN = JSON.stringify({
  summary: 'خطة تجريبية من وضع mock. اربط مزوّدًا حقيقيًا لتحصل على خطة فعلية.',
  days: [{ date: '', focus: 'مراجعة تجريبية', tasks: [{ subject: 'مادة', what: 'مراجعة الدرس الأول وحل أسئلة', min: 45, kind: 'learn' }, { subject: 'مادة', what: 'حل تمارين الفصل', min: 40, kind: 'practice' }] }],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.check = () => null;

exports.stream = async function* ({ turns, json, signal }) {
  const all = turns.map((t) => t.content).join('\n');
  let text;
  if (json) text = all.includes('"type":"mcq"') ? QUIZ : all.includes('"summary"') ? PLAN : '[]';
  else text = '## رد تجريبي\n\nهذا رد من **وضع mock** ليتأكد أن الموقع يعمل بدون مفتاح. اضبط `PROVIDER` في ملف `.env` على `gemini` أو `claude` لتحصل على ردود حقيقية.\n\n- الفكرة الأولى\n- الفكرة الثانية\n\nهل فهمت الفكرة؟ اشرح لي بكلماتك.';
  for (let i = 0; i < text.length; i += 18) {
    if (signal && signal.aborted) return { truncated: false };
    yield text.slice(i, i + 18);
    await sleep(15);
  }
  return { truncated: false };
};
})(providers.mock);

const PORT = Number(process.env.PORT) || 3000;
const PROVIDER = (process.env.PROVIDER || 'gemini').toLowerCase();
if (!['gemini', 'claude', 'mock'].includes(PROVIDER)) {
  console.error('PROVIDER must be gemini, claude or mock (got "' + PROVIDER + '")');
  process.exit(1);
}
const LIMIT_IP = Number(process.env.DAILY_LIMIT_PER_IP) || 40;
const LIMIT_ALL = Number(process.env.DAILY_LIMIT_GLOBAL) || 600;
const BURST_PER_MIN = 10;
const MAX_BODY = 12 * 1024 * 1024;
const MAX_CHARS = 200000;

const provider = providers[PROVIDER];
const problem = provider.check && provider.check();
if (problem) console.warn('[تنبيه] ' + problem);

/* ---------- usage limits (in memory, reset daily) ---------- */
let day = '', perIp = new Map(), total = 0;
const recent = new Map();
function today() { return new Date().toISOString().slice(0, 10); }
function allow(ip) {
  const d = today();
  if (d !== day) { day = d; perIp = new Map(); total = 0; }
  const now = Date.now();
  const hits = (recent.get(ip) || []).filter((t) => now - t < 60000);
  if (hits.length >= BURST_PER_MIN) return 'burst';
  if (total >= LIMIT_ALL) return 'global';
  if ((perIp.get(ip) || 0) >= LIMIT_IP) return 'ip';
  hits.push(now); recent.set(ip, hits);
  perIp.set(ip, (perIp.get(ip) || 0) + 1); total++;
  if (recent.size > 5000) for (const [k, v] of recent) if (!v.some((t) => now - t < 60000)) recent.delete(k);
  return null;
}
function refund(ip) {
  if (perIp.get(ip) > 0) perIp.set(ip, perIp.get(ip) - 1);
  if (total > 0) total--;
}
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || 'unknown';
}

/* ---------- helpers ---------- */
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
function sendJson(res, status, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store', ...SEC });
  res.end(b);
}
function bad(code, message, status) {
  return Object.assign(new Error(message), { code, status: status || 400 });
}
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false;
    const chunks = [];
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > max) { over = true; chunks.length = 0; reject(bad('prompt_too_large', 'body too large', 413)); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}
const MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
function parse(raw) {
  let b;
  try { b = JSON.parse(raw); } catch (e) { throw bad('invalid_request', 'invalid json'); }
  if (!b || typeof b !== 'object') throw bad('invalid_request', 'invalid body');
  let turns;
  if (typeof b.input === 'string') turns = [{ role: 'user', content: b.input }];
  else if (Array.isArray(b.input)) turns = b.input.map((t) => ({ role: t && t.role, content: t && t.content }));
  else throw bad('invalid_request', 'input must be a string or a list of turns');
  if (!turns.length || turns.some((t) => (t.role !== 'user' && t.role !== 'assistant') || typeof t.content !== 'string' || !t.content.trim())) {
    throw bad('invalid_request', 'invalid turns');
  }
  if (turns[0].role !== 'user' || turns[turns.length - 1].role !== 'user') throw bad('invalid_request', 'turns must start and end with user');
  if (turns.reduce((n, t) => n + t.content.length, 0) > MAX_CHARS) throw bad('prompt_too_large', 'prompt too large', 413);
  const images = (Array.isArray(b.images) ? b.images : []).slice(0, 4).map((im) => {
    if (!im || !MIMES.includes(im.mime) || typeof im.data !== 'string' || im.data.length > 3500000 || /[^A-Za-z0-9+/=]/.test(im.data)) {
      throw bad('image_rejected', 'invalid image');
    }
    return { mime: im.mime, data: im.data };
  });
  const tier = ['quick', 'default', 'complex'].includes(b.tier) ? b.tier : 'default';
  return { turns, images, json: !!b.json, tier };
}

/* ---------- /api/ai ---------- */
async function handleAI(req, res) {
  const ip = clientIp(req);
  if (problem) return sendJson(res, 503, { error: { code: 'upstream_error', message: 'server is not configured: missing API key' } });
  const gate = allow(ip);
  if (gate) {
    return sendJson(res, 429, { error: { code: 'rate_limited', message: gate, scope: gate } });
  }
  const ctl = new AbortController();
  res.on('close', () => ctl.abort());
  let started = false;
  try {
    const raw = await readBody(req, MAX_BODY);
    const r = parse(raw);
    const it = provider.stream({ ...r, signal: ctl.signal })[Symbol.asyncIterator]();
    let step = await it.next();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      ...SEC,
    });
    started = true;
    while (!step.done) {
      res.write('data: ' + JSON.stringify({ t: step.value }) + '\n\n');
      step = await it.next();
    }
    res.write('data: ' + JSON.stringify({ done: true, truncated: !!(step.value && step.value.truncated) }) + '\n\n');
    res.end();
  } catch (e) {
    if (ctl.signal.aborted) { if (started) res.end(); return; }
    const code = typeof e.code === 'string' ? e.code : 'upstream_error';
    if (code === 'upstream_error') console.error('[ai]', e && e.message);
    if (!started) {
      refund(ip);
      return sendJson(res, e.status || 502, { error: { code, message: String(e.message || '').slice(0, 200) } });
    }
    res.write('data: ' + JSON.stringify({ error: code }) + '\n\n');
    res.end();
  }
}

/* ---------- the page ---------- */
const PAGE = path.join(__dirname, 'index.html');
function servePage(pathname, req, res) {
  if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (pathname !== '/' && pathname !== '/index.html') return sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } });
  fs.readFile(PAGE, (err, buf) => {
    if (err) return sendJson(res, 500, { error: { code: 'upstream_error', message: 'index.html is missing next to server.js' } });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-cache', ...SEC });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/ai') return await handleAI(req, res);
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, provider: PROVIDER });
    if (req.method === 'GET' || req.method === 'HEAD') return servePage(url.pathname, req, res);
    sendJson(res, 405, { error: { code: 'invalid_request', message: 'method not allowed' } });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: { code: 'upstream_error', message: 'server error' } });
    else res.end();
  }
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(PORT, () => {
  console.log('Elevio يعمل على http://localhost:' + PORT + '  (المزوّد: ' + PROVIDER + ')');
});
