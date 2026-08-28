# 知命 · 每日运势推送后端

一个极简 Web Push 服务，配合前端 `zhiming.qtapi.space` 的「开启每日推送」按钮使用。

## 工作原理

1. 前端用户点「开启每日推送」→ 浏览器生成 Push 订阅 → `POST /subscribe` 存到本服务
2. 本服务每天北京时间 `08:00` 给所有订阅推送一条「知命 · 今日运势」通知
3. 失效订阅（用户卸载/换设备）自动清理

## 部署到 Railway（推荐，你已有 Railway 经验）

1. 把这个 `push-server/` 目录 push 到一个 GitHub 仓库
2. Railway → New Project → Deploy from GitHub repo → 选这个目录（或整个仓库，设置 root directory 为 `push-server`）
3. 无需任何环境变量（VAPID 密钥已内置，`PORT` 自动）
4. 部署完成后拿到 `https://xxx.up.railway.app` 地址

## 打通前端

拿到后端地址后，把 `zhiming_app/js/app.js` 里的：

```js
var PUSH_API_BASE = '';
```

改成：

```js
var PUSH_API_BASE = 'https://xxx.up.railway.app';
```

然后重新部署前端（`wrangler pages deploy`），即可开启推送。

## 本地测试

```bash
npm install
npm start
# 默认 http://localhost:3000
```

## 自定义

- 推送时间：改 `server.js` 里的 `PUSH_HOUR`（默认 8 = 早上 8 点）
- 推送文案：改 `pushNow()` 里的 `payload`
- 推送落地页：改 `PUSH_URL`

## 注意

- 订阅存储在 `subscribers.json`（Railway 免费版重启会重置磁盘，订阅会丢失；如需长期稳定请挂 Volume 或用数据库）
- 必须 HTTPS 才能用 Web Push（Railway 默认提供 HTTPS）
