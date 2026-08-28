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
  let subs = loadSubs();
  if(!subs.some(function(s){ return s.endpoint === sub.endpoint; })) subs.push(sub);
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

function pushNow(){
  const subs = loadSubs();
  if(!subs.length) return console.log('无订阅，跳过');
  const payload = JSON.stringify({
    title: '知命 · 今日运势',
    body: '打开看看今天的黄历、每日一签，和你的日主运势 →',
    url: PUSH_URL
  });
  let dropped = 0;
  Promise.all(subs.map(function(sub){
    return webpush.sendNotification(sub, payload).catch(function(err){
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
