/* 知命 · 每日运势推送后端（Web Push）
 * 部署到 Railway / Render / 任意 Node 托管，拿到 HTTPS 地址后填到前端 PUSH_API_BASE 即可。
 */
const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const VAPID_PUBLIC = 'BNsz-7dIIL_T3UKUDcl9m61dC6jZF2L9ZtbyXW4FzpHjC9nJbvUyOMYZdaR3dvsDYwNAoSX5MFvhsvOm-_ZXAdk';
const VAPID_PRIVATE = 'tXHrB8CxvYHh6iU7meuebdQnjTxA3t__Ve8pheFBqH8';
const CONTACT = 'mailto:qt@example.com';
const SUB_FILE = path.join(__dirname, 'subscribers.json');
const PUSH_URL = 'https://zhiming.qtapi.space/';
const PUSH_HOUR = 8;   // 北京时间每天几点推送（24 小时制）

/* 五行映射（与前端 app.js 保持一致） */
const GAN_WX = { 甲:'木',乙:'木',丙:'火',丁:'火',戊:'土',己:'土',庚:'金',辛:'金',壬:'水',癸:'水' };
const WX_SHENG = { 木:'火',火:'土',土:'金',金:'水',水:'木' };  // 木生火...
const WX_KE = { 木:'土',土:'水',水:'火',火:'金',金:'木' };     // 木克土...

webpush.setVapidDetails(CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);

const app = express();
app.use(express.json());

function loadSubs(){
  try{ const a = JSON.parse(fs.readFileSync(SUB_FILE, 'utf8')); return Array.isArray(a) ? a : []; }
  catch(e){ return []; }
}
function saveSubs(subs){
  try{ fs.writeFileSync(SUB_FILE, JSON.stringify(subs, null, 2)); }catch(e){}
}

app.post('/subscribe', function(req, res){
  const sub = req.body && req.body.subscription;
  if(!sub || !sub.endpoint){ return res.json({ ok:false, err:'invalid subscription' }); }
  const profile = (req.body && req.body.profile) || null;
  const rec = { endpoint: sub.endpoint, keys: sub.keys, profile: profile };
  let subs = loadSubs();
  const idx = subs.findIndex(function(s){ return s.endpoint === sub.endpoint; });
  if(idx >= 0) subs[idx] = rec; else subs.push(rec);
  saveSubs(subs);
  res.json({ ok:true, count: subs.length });
});

app.post('/unsubscribe', function(req, res){
  const ep = req.body && req.body.endpoint;
  let subs = loadSubs();
  subs = subs.filter(function(s){ return s.endpoint !== ep; });
  saveSubs(subs);
  res.json({ ok:true });
});

app.get('/', function(req, res){ res.send('知命推送服务运行中，订阅数：' + loadSubs().length); });

/* 手动触发推送（供外部 cron 定时调用，解决 Render 免费层 idle 后 setInterval 不跑的问题） */
app.get('/push', function(req, res){
  pushNow();
  res.json({ ok:true, count: loadSubs().length });
});

/* 今日天干+五行 + 流月天干+五行（后端用 lunar 库算，避免硬编码） */
function todayGanWx(){
  try{
    const lunar = require('./lunar.min.js');
    const Lunar = lunar.Lunar || lunar;
    const l = Lunar.fromDate(new Date());
    const ec = l.getEightChar();
    const gz = ec.getDay(), mgz = ec.getMonth();
    return { gan: gz[0], wx: GAN_WX[gz[0]] || '', monthGan: mgz[0], monthWx: GAN_WX[mgz[0]] || '' };
  }catch(e){ return { gan:'', wx:'', monthGan:'', monthWx:'' }; }
}

/* 按用户命理标签（日主/喜用/忌神）生成个性化推送正文（今日 + 流月二维联动） */
function pushBody(profile, t){
  if(!profile || !profile.xi || !profile.dayGan){
    return { title:'知命 · 今日运势', body:'打开看看今天的黄历、每日一签，和你的日主运势 →' };
  }
  const gan = t.gan, twx = t.wx, xi = profile.xi, ji = profile.ji;
  const title = '知命 · ' + (gan ? ('今日【'+gan+'】日') : '今日') + '运势';
  let body;
  if(twx && twx === xi)      body = '今日【'+gan+'】属【'+twx+'】，正合你的喜用神，气场旺你——宜推进大事、主动出击';
  else if(twx && twx === ji) body = '今日【'+gan+'】属【'+twx+'】，恰为你的忌神，气场偏弱——宜稳守蓄力';
  else if(twx && WX_SHENG[twx] === xi) body = '今日【'+gan+'】属【'+twx+'】，生助你的喜用神——可顺势而为';
  else if(twx && WX_SHENG[xi] === twx) body = '今日【'+gan+'】属【'+twx+'】，泄你的喜用神之气——宜养精蓄锐';
  else body = '今日【'+gan+'】日，与你命局不冲不助——安稳度日即可';
  /* 流月补充（本月大方向，一个月换一次） */
  if(t.monthGan && t.monthWx){
    const mwx = t.monthWx;
    let mTip;
    if(mwx === xi) mTip = '本月【'+t.monthGan+'】月正旺你，宜乘势';
    else if(mwx === ji) mTip = '本月【'+t.monthGan+'】月偏弱，宜守不宜攻';
    else if(WX_SHENG[mwx] === xi) mTip = '本月【'+t.monthGan+'】月生助你，宜布局';
    else mTip = '本月【'+t.monthGan+'】月平稳，稳扎稳打';
    body += '；'+mTip+' →';
  } else {
    body += ' →';
  }
  return { title: title, body: body };
}

function pushNow(){
  const subs = loadSubs();
  if(!subs.length) return console.log('无订阅，跳过');
  const t = todayGanWx();
  let dropped = 0;
  Promise.all(subs.map(function(sub){
    const msg = pushBody(sub.profile, t);
    const payload = JSON.stringify({ title: msg.title, body: msg.body, url: PUSH_URL });
    const cleanSub = { endpoint: sub.endpoint, keys: sub.keys };
    return webpush.sendNotification(cleanSub, payload).catch(function(err){
      if(err.statusCode === 404 || err.statusCode === 410){ dropped++; return sub.endpoint; }
      return null;
    });
  })).then(function(results){
    const dead = results.filter(Boolean);
    if(dead.length){
      const cur = loadSubs();
      saveSubs(cur.filter(function(s){ return dead.indexOf(s.endpoint) < 0; }));
      console.log('清理失效订阅：', dead.length);
    }
    console.log('推送完成，当前订阅：', loadSubs().length);
  });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, function(){ console.log('知命推送服务启动，端口 ' + PORT + '，每天 ' + PUSH_HOUR + ':00（北京）推送'); schedule(); });
