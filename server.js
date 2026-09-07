/* 知命 · 每日晨报推送后端（Web Push）
 * 部署到 Railway / Render / 任意 Node 托管，拿到 HTTPS 地址后填到前端 PUSH_API_BASE 即可。
 * 2026-09-06（P0#3）：正文从「五行一句话」升级为「晨间迷你早报」：
 *   干支日+黄历宜 → 五行视角句（5 档正向措辞）→ 微光金句（22 句按日期种子轮换，同日全站同句）。
 *   无命理档案的用户同样收到完整晨报（今日氛围通适句），末尾轻引导建档（不硬广）。
 * 2026-09-06（持久化）：订阅/反馈存 Cloudflare Workers KV（跨重启稳定），本地文件作镜像/降级。
 *   解决 Render 免费层重启清空 subscribers.json 导致订阅归零的硬伤。CF_TOKEN 走环境变量。
 * 2026-09-07（v113cy 晨报章名化）：标题与首页「今日一页」同构——守灯晨报 · 第N日 · 节气章名。
 *   天地节律(节气+候) 命名今天，个人节律(firstDay=客户端 fz_first_day) 编号第N日，跨端同一故事页码。
 *   firstDay 缺失时只出章名不出页码；订阅/重订时取更早日期（最早陪伴日）。
 */
const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const VAPID_PUBLIC = 'BNsz-7dIIL_T3UKUDcl9m61dC6jZF2L9ZtbyXW4FzpHjC9nJbvUyOMYZdaR3dvsDYwNAoSX5MFvhsvOm-_ZXAdk';
const VAPID_PRIVATE = 'tXHrB8CxvYHh6iU7meuebdQnjTxA3t__Ve8pheFBqH8';
const CONTACT = 'mailto:qt@example.com';
const SUB_FILE = path.join(__dirname, 'subscribers.json');
const FB_FILE = path.join(__dirname, 'feedback.json');
const FB_TOKEN = process.env.FB_TOKEN || 'zhiming-fb-admin-2026';   // 反馈查询 token（生产请改 env）
const PUSH_URL = 'https://zhiming.qtapi.space/';
const PUSH_HOUR = 8;   // 北京时间每天几点推送（24 小时制）

/* ===== 持久化层：Cloudflare Workers KV（主存储）+ 本地文件（镜像/降级） =====
 * Render free 重启清空本地磁盘 → 订阅/反馈存 KV 跨重启稳定。
 * CF_TOKEN 走环境变量（不进代码/日志/git）；KV_ACCOUNT / KV_NS 非敏感可内置。
 * KV 未配置或网络失败时自动降级本地文件（开发/单测照常）。 */
const KV_ACCOUNT = 'acbe9ea49235a87c4c6b014a747cb3df';
const KV_NS = process.env.CF_NS || 'ab707355826449be84175b640916ff34';   // zhiming-push namespace
function kvBase(key){
  return 'https://api.cloudflare.com/client/v4/accounts/' + KV_ACCOUNT
    + '/storage/kv/namespaces/' + KV_NS + '/values/' + key;
}
function kvFetch(url, opts){
  const tk = process.env.CF_TOKEN;
  if(!tk || !KV_NS || KV_NS.length < 10) return Promise.resolve(null);
  const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const tm = ctl ? setTimeout(function(){ ctl.abort(); }, 6000) : null;
  const o = Object.assign({}, opts || {});
  o.headers = Object.assign({ Authorization: 'Bearer ' + tk }, o.headers || {});
  if(ctl) o.signal = ctl.signal;
  return fetch(url, o).then(function(r){ if(tm) clearTimeout(tm); return r; })
    .catch(function(){ if(tm) clearTimeout(tm); return null; });
}
async function kvGet(key){
  try{
    const r = await kvFetch(kvBase(key), { method: 'GET' });
    if(r && r.status === 200) return await r.text();
  }catch(e){}
  return null;
}
async function kvPut(key, val){
  try{
    const r = await kvFetch(kvBase(key), { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: val });
    return !!(r && (r.status === 200 || r.status === 204));
  }catch(e){ return false; }
}
function fileArray(f, def){
  try{ const a = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(a) ? a : def; }catch(e){ return def; }
}
function fileWrite(f, v){ try{ fs.writeFileSync(f, v); }catch(e){} }

/* 五行映射（与前端 app.js 保持一致） */
const GAN_WX = { 甲:'木',乙:'木',丙:'火',丁:'火',戊:'土',己:'土',庚:'金',辛:'金',壬:'水',癸:'水' };
const WX_SHENG = { 木:'火',火:'土',土:'金',金:'水',水:'木' };  // 木生火...
const WX_KE = { 木:'土',土:'水',水:'火',火:'金',金:'木' };     // 木克土...

webpush.setVapidDetails(CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);

const app = express();
app.use(express.json({limit:'32kb'}));
/* ===== CORS：浏览器跨域 POST 必走 OPTIONS 预检，没这头会被浏览器直接拒绝（curl 不受影响） ===== */
const CORS_ALLOW = ['https://zhiming.qtapi.space', 'https://zhiming-1oy.pages.dev', 'http://localhost'];  // 已知合法 Origin 白名单
app.use(function corsMw(req, res, next){
  const o = req.headers.origin || '';
  if(CORS_ALLOW.indexOf(o) >= 0){
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if(req.method === 'OPTIONS'){ return res.sendStatus(204); }  // 预检直接 204
  next();
});

/* ===== 安全防护：内存限流（IP 维度）+ Origin 校验 ===== */
const rateMap = {};   // { ip: { count, reset } }
function getClientIp(req){
  try{
    var xf = req.headers['x-forwarded-for'];
    if(xf) return String(xf).split(',')[0].trim();
  }catch(e){}
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function rateLimit(limit, windowMs){
  return function(req, res, next){
    var ip = getClientIp(req);
    var now = Date.now();
    var rec = rateMap[ip];
    if(rec && now < rec.reset){
      rec.count++;
      if(rec.count > limit){
        return res.status(429).json({ ok:false, err:'请求过于频繁，请稍后再试' });
      }
    } else {
      rateMap[ip] = { count:1, reset: now + windowMs };
    }
    next();
  };
}
/* 定期清理限流记录，防内存膨胀（Render 免费层重启会清空，此清理是兜底） */
setInterval(function(){
  var now = Date.now();
  for(var k in rateMap){ if(rateMap[k].reset < now) delete rateMap[k]; }
}, 10 * 60 * 1000);
/* Origin 校验：只允许本站前端调用（浏览器跨域本就会拦，此校验防非浏览器直接 POST） */
function checkOrigin(req, res, next){
  var origin = req.headers.origin;
  if(origin && origin !== 'https://zhiming.qtapi.space' && origin !== 'https://zhiming-1oy.pages.dev'){
    return res.status(403).json({ ok:false, err:'forbidden origin' });
  }
  next();
}
app.use(checkOrigin);

async function loadSubs(){
  try{
    const kv = await kvGet('subs');
    if(kv !== null){
      const a = JSON.parse(kv);
      if(Array.isArray(a)){ fileWrite(SUB_FILE, JSON.stringify(a, null, 2)); return a; }
    }
  }catch(e){}
  return fileArray(SUB_FILE, []);
}
async function saveSubs(subs){
  const j = JSON.stringify(subs);
  fileWrite(SUB_FILE, j);
  try{ await kvPut('subs', j); }catch(e){}
}

app.post('/subscribe', rateLimit(10, 60*1000), async function(req, res){
  try{
    const body = req.body || {};
    const sub = body.subscription;
    if(!sub || !sub.endpoint){ return res.json({ ok:false, err:'invalid subscription' }); }
    const profile = body.profile || null;
    const fdIn = normDay(body.firstDay);
    const subs = await loadSubs();
    const idx = subs.findIndex(function(s){ return s.endpoint === sub.endpoint; });
    const rec = { endpoint: sub.endpoint, keys: sub.keys, profile: profile, firstDay: fdIn };
    if(idx >= 0){
      /* 重订：firstDay 取更早（第N日从最早陪伴日算起），档案/订阅信息用最新 */
      rec.firstDay = earlierDay(subs[idx].firstDay, fdIn);
      subs[idx] = rec;
    } else {
      subs.push(rec);
    }
    await saveSubs(subs);
    res.json({ ok:true, count: subs.length });
  }catch(e){ res.status(500).json({ ok:false, err:'server error' }); }
});

app.post('/unsubscribe', async function(req, res){
  try{
    const ep = req.body && req.body.endpoint;
    let subs = await loadSubs();
    subs = subs.filter(function(s){ return s.endpoint !== ep; });
    await saveSubs(subs);
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false, err:'server error' }); }
});

app.get('/', async function(req, res){
  const n = (await loadSubs()).length;
  res.send('知命推送服务运行中，订阅数：' + n);
});

/* 手动触发推送（供外部 cron 定时调用，解决 Render 免费层 idle 后 setInterval 不跑的问题） */
app.get('/push', rateLimit(30, 60*1000), async function(req, res){
  try{
    await pushNow();
    res.json({ ok:true, count: (await loadSubs()).length });
  }catch(e){ res.status(500).json({ ok:false, err:'push error' }); }
});

/* 章名候位用（与首页今日一页一致）：交节当天=初候，之后每 5 天一候 */
const HOU_CN = ['', '初候', '二候', '三候'];

/* 今日历象：日干+五行、日柱干支全串、流月干+五行、农历月日、黄历宜 + 节气章名(ch)/候位(hou)（后端用 lunar 库算） */
/* 章名算法移植自前端 app.js _tpChapter（v113cu）：交节日当天 getJieQi 非空 → 该节气·初候；
   否则取上一节气，距其交节日天数 diff → 候 = min(3, floor(diff/5)+1)；兜底农历月名。 */
function chapterOfD(l, now){
  try{
    let ch = '', hou = 0;
    try{
      const jqT = (typeof l.getJieQi === 'function') ? (l.getJieQi() || '') : '';
      if(jqT){ ch = jqT; hou = 1; }
      else{
        const pj = l.getPrevJieQi();
        ch = pj.getName() || '';
        const s = pj.getSolar();
        const jd = new Date(s.getYear(), s.getMonth() - 1, s.getDay()).getTime();
        let diff = Math.floor((now.getTime() - jd) / 86400000);
        if(diff < 0) diff = 0;
        hou = Math.min(3, Math.floor(diff / 5) + 1);
      }
    }catch(e){ ch = ''; hou = 0; }
    if(!ch){
      try{ ch = (l.getMonthInChinese ? l.getMonthInChinese() : '') + '月'; hou = 0; }catch(e){}
    }
    return { ch: ch, hou: hou };
  }catch(e){ return { ch:'', hou:0 }; }
}
function todayGanWx(d){
  try{
    const lunar = require('./lunar.min.js');
    const Lunar = lunar.Lunar || lunar;
    const now = d || new Date();
    const l = Lunar.fromDate(now);
    const ec = l.getEightChar();
    const gz = ec.getDay(), mgz = ec.getMonth();
    let lunarTxt = '';
    try{
      const lm = l.getMonthInChinese ? l.getMonthInChinese() : '';
      const ld = l.getDayInChinese ? l.getDayInChinese() : '';
      const leap = (l.getYear && typeof l.getYearInGanZhiByLiChun === 'undefined' && l.isLeapMonth && l.isLeapMonth()) ? '闰' : '';
      lunarTxt = leap + lm + '月' + ld;
    }catch(e2){}
    let yi = [];
    try{ yi = (l.getDayYi ? l.getDayYi() : []).slice(0, 3); }catch(e3){}
    const jc = chapterOfD(l, now);
    return {
      gan: gz[0], wx: GAN_WX[gz[0]] || '', dayGZ: gz,
      monthGan: mgz[0], monthWx: GAN_WX[mgz[0]] || '', monthGZ: mgz,
      lunarTxt: lunarTxt, yi: yi,
      ch: jc.ch, hou: jc.hou
    };
  }catch(e){ return { gan:'', wx:'', dayGZ:'', monthGan:'', monthWx:'', monthGZ:'', lunarTxt:'', yi:[], ch:'', hou:0 }; }
}

/* ===== 晨报「微光一句」话术池（情绪陪伴层：不预测、不恐吓，只给温柔提醒；同日全站同句） ===== */
const QUOTES = [
  '慢慢来，比较快。',
  '今天不必完美，开始就很好。',
  '你走的每一步，都算数。',
  '先照顾好自己，再照顾好世界。',
  '有些答案，走着走着就清楚了。',
  '允许自己慢一点，天不会塌。',
  '把今天过好，明天自有答案。',
  '少想一点万一，多做一点现在。',
  '你比自己以为的更扛得住。',
  '温柔待人，也温柔待己。',
  '今天做的小事，是明天的底气。',
  '别怕选错，试过才知道答案。',
  '休息不是偷懒，是在给自己充电。',
  '向外看是方向，向内看是力量。',
  '稳稳地走，比快快地跑更长久。',
  '心里有光，走到哪里都不暗。',
  '今天种下的耐心，明天会发芽。',
  '不必追赶所有人，走自己的时区。',
  '深呼吸，你已经做得很好了。',
  '把期待放低一点，惊喜反而更多。',
  '日子是过出来的，不是想出来的。',
  '把今天过踏实，就是给明天最好的礼物。'
];
/* 日期串 → 稳定整数种子（同日全员同句，次日自然轮换） */
function seedOf(dateStr){
  let h = 0;
  const s = String(dateStr || '');
  for(let i = 0; i < s.length; i++){ h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return h;
}
/* 无命理档案时的「今日氛围」通适句（按日干五行，只给行为灵感不给断言） */
const DAY_MOOD = {
  '木': '今天的气在生长，适合学点新的、开个头。',
  '火': '今天的气在发光，适合表达与分享，把想法讲出来。',
  '土': '今天的气在沉淀，适合整理与规划，把事做扎实。',
  '金': '今天的气在收束，适合做决断、清清单、了结旧事。',
  '水': '今天的气在流动，适合沟通走动、连接新的人。'
};
/* 五行视角句：5 档全正向收尾，忌神场景只给策略不给恐吓 */
function wxLine(twx, xi, ji){
  if(twx === xi) return '今日【' + twx + '】气与你同频，适合把惦记已久的事往前推一步。';
  if(ji && twx === ji) return '今日【' + twx + '】气与你的步调相左——不急，拆小步走稳就是赢。';
  if(WX_SHENG[twx] === xi) return '今日【' + twx + '】气生助你的节奏，适合把想法落成具体行动。';
  if(WX_SHENG[xi] === twx) return '今日【' + twx + '】气会带走一些能量——要紧事先做，给自己留点白。';
  return '今日【' + twx + '】气与你相安，按自己的节奏过，就很好。';
}
/* 流月一句（月度背景，一个月换一次，正向收尾） */
function monthLine(mwx, xi, ji){
  if(mwx === xi) return '本月【' + mwx + '】气旺你，大方向可以更笃定。';
  if(ji && mwx === ji) return '本月【' + mwx + '】气与你不合拍，稳字当头，不必硬冲。';
  if(WX_SHENG[mwx] === xi) return '本月【' + mwx + '】气生助你，适合播种与布局。';
  return '本月【' + mwx + '】气平稳，按部就班即可。';
}
/* ===== 日期工具：firstDay 规范化 / 取更早 / 第N日 ===== */
function normDay(v){
  const s = String(v || '').trim();
  return (/^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : '';
}
function earlierDay(a, b){
  a = normDay(a); b = normDay(b);
  if(!a) return b;
  if(!b) return a;
  return (a <= b) ? a : b;
}
/* 第 N 日：距 firstDay 天数 +1（与首页「今日一页」同口径），无效返回 0（不显示页码） */
function dayNOf(firstDay, dateStr){
  try{
    const f = normDay(firstDay), t = normDay(dateStr);
    if(!f || !t) return 0;
    const fd = new Date(f.replace(/-/g, '/'));
    const td = new Date(t.replace(/-/g, '/'));
    if(isNaN(fd.getTime()) || isNaN(td.getTime())) return 0;
    const d = Math.floor((td.getTime() - fd.getTime()) / 86400000) + 1;
    return (d >= 1) ? d : 0;
  }catch(e){ return 0; }
}
/* 章名串：白露·初候 / 白露 / 兜底 M月D日 */
function chTxt(t){
  if(!t) return '';
  if(t.ch) return t.ch + (t.hou ? '·' + HOU_CN[t.hou] : '');
  const s = t.dateStr;
  if(s && s.length >= 10){
    const mm = parseInt(s.slice(5, 7), 10), dd = parseInt(s.slice(8, 10), 10);
    return mm + '月' + dd + '日';
  }
  return '';
}
/* 标题：与首页「今日一页」同构 —— 守灯晨报 · 第N日 · 白露·初候（天地节律+个人节律页码） */
function titleOf(t, meta){
  meta = meta || {};
  const parts = ['守灯晨报'];
  if(meta.dayN >= 1) parts.push('第' + meta.dayN + '日');
  const ct = chTxt(t);
  if(ct) parts.push(ct);
  return parts.join(' · ');
}

/* 晨报正文：三段式。profile=null 也出完整晨报（通适句 + 轻引导建档）。
   meta = { firstDay }：决定标题「第N日」页码（无 firstDay 只出章名，不出页码）。 */
function pushBody(profile, t, meta){
  meta = meta || {};
  t = t || {};
  const hasPro = !!(profile && profile.dayGan);
  const xi = profile && profile.xi, ji = profile && profile.ji;
  const headParts = [];
  if(t.ch) headParts.push(t.ch + (t.hou ? '·' + HOU_CN[t.hou] : ''));
  if(t.lunarTxt) headParts.push(t.lunarTxt);
  if(t.dayGZ) headParts.push(t.dayGZ + '日');
  if(t.yi && t.yi.length) headParts.push('宜 ' + t.yi.join(' '));
  const head = headParts.join(' · ');
  const mid = (hasPro && t.wx) ? wxLine(t.wx, xi, ji) : (t.wx ? (DAY_MOOD[t.wx] || '') : '');
  const month = (hasPro && t.monthWx) ? monthLine(t.monthWx, xi, ji) : '';
  const quote = '✨ ' + QUOTES[seedOf(t.dateStr) % QUOTES.length];
  const lines = [head, mid, month, quote].filter(function(x){ return !!x; });
  if(!hasPro) lines.push('想让晨报更懂你？点开建个命理档案，多一层专属视角 →');
  const body = lines.join('\n');
  const dayN = dayNOf(meta.firstDay, t.dateStr);
  return { title: titleOf(t, { dayN: dayN }), body: body };
}

async function pushNow(){
  const subs = await loadSubs();
  if(!subs.length){ console.log('无订阅，跳过'); return; }
  const cn = beijingNow();
  const t = todayGanWx(cn);
  t.dateStr = fmtDate(cn);
  let dropped = 0;
  const results = await Promise.all(subs.map(function(sub){
    const msg = pushBody(sub.profile, t, { firstDay: sub.firstDay });
    const payload = JSON.stringify({ title: msg.title, body: msg.body, url: PUSH_URL });
    const cleanSub = { endpoint: sub.endpoint, keys: sub.keys };
    return webpush.sendNotification(cleanSub, payload).catch(function(err){
      if(err.statusCode === 404 || err.statusCode === 410){ dropped++; return sub.endpoint; }
      return null;
    });
  }));
  const dead = results.filter(Boolean);
  if(dead.length){
    const cur = await loadSubs();
    await saveSubs(cur.filter(function(s){ return dead.indexOf(s.endpoint) < 0; }));
    console.log('清理失效订阅：', dead.length);
  }
  console.log('推送完成，当前订阅：', (await loadSubs()).length);
}

/* 定时：每分钟检查一次是否到 PUSH_HOUR 点整（北京时间） */
function beijingNow(){
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
}
function schedule(){
  let lastDate = '';
  setInterval(function(){
    const cn = beijingNow();
    const key = cn.getFullYear()+'-'+cn.getMonth()+'-'+cn.getDate();
    if(cn.getHours() === PUSH_HOUR && key !== lastDate){
      lastDate = key;
      pushNow();
    }
  }, 60 * 1000);
}

/* ===== 反馈系统：用户提交问题/Bug/建议，开发者查询 ===== */
async function loadFb(){
  try{
    const kv = await kvGet('fb');
    if(kv !== null){
      const a = JSON.parse(kv);
      if(Array.isArray(a)){ fileWrite(FB_FILE, JSON.stringify(a, null, 2)); return a; }
    }
  }catch(e){}
  return fileArray(FB_FILE, []);
}
async function saveFb(arr){
  const j = JSON.stringify(arr);
  fileWrite(FB_FILE, j);
  try{ await kvPut('fb', j); }catch(e){}
}

app.post('/feedback', rateLimit(5, 60*1000), async function(req, res){
  try{
    const body = req.body || {};
    const type = String(body.type || 'feedback').slice(0, 20);
    const content = String(body.content || '').trim();
    if(content.length < 2){ return res.json({ ok:false, err:'反馈内容太短（≥2 字）' }); }
    if(content.length > 2000){ return res.json({ ok:false, err:'反馈内容过长（≤2000 字）' }); }
    const contact = String(body.contact || '').slice(0, 200);
    const rec = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      type: type,
      content: content,
      contact: contact,
      page: String(body.page || '').slice(0, 200),
      ua: String(body.ua || '').slice(0, 180),
      ts: new Date().toISOString()
    };
    const fb = await loadFb();
    fb.push(rec);
    await saveFb(fb);
    console.log('收到反馈：', type, '|', content.slice(0, 40), '...');
    res.json({ ok:true, id: rec.id, count: fb.length });
  }catch(e){ res.status(500).json({ ok:false, err:'server error' }); }
});

app.get('/feedback/list', rateLimit(30, 60*1000), async function(req, res){
  try{
    if(String(req.query.token||'') !== FB_TOKEN){ return res.json({ ok:false, err:'invalid token' }); }
    const list = await loadFb();
    /* 默认按时间倒序，可选 ?type=bug 过滤 */
    const type = req.query.type;
    let out = list.slice().reverse();
    if(type) out = out.filter(function(x){ return x.type === type; });
    res.json({ ok:true, total: list.length, shown: out.length, list: out });
  }catch(e){ res.status(500).json({ ok:false, err:'server error' }); }
});

function fmtDate(d){
  const p = function(n){ return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* 条件启动：被 require（本地单测）时不起服务不设定时器 */
if (require.main === module){
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, function(){ console.log('知命推送服务启动，端口 ' + PORT + '，每天 ' + PUSH_HOUR + ':00（北京）推送；反馈 token 默认 = '+FB_TOKEN); schedule(); });
}
module.exports = { app: app, pushBody: pushBody, todayGanWx: todayGanWx, pushNow: pushNow,
  QUOTES: QUOTES, seedOf: seedOf, fmtDate: fmtDate, beijingNow: beijingNow,
  loadSubs: loadSubs, saveSubs: saveSubs, loadFb: loadFb, saveFb: saveFb,
  kvGet: kvGet, kvPut: kvPut, KV_ACCOUNT: KV_ACCOUNT, KV_NS: KV_NS,
  normDay: normDay, earlierDay: earlierDay, dayNOf: dayNOf, titleOf: titleOf, chTxt: chTxt, HOU_CN: HOU_CN };
