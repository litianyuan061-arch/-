# 德州扑克 · 好友房

多人在线德州扑克。创建房间后把邀请链接发给朋友，大家用手机或电脑的浏览器打开就能一起玩，不用下载安装。

## 功能

- **房间与邀请**：创建房间会生成 5 位房间号，点「邀请好友」可以用系统分享或复制链接，朋友打开链接即可入座（每桌 2~9 人）
- **完整规则**：盲注、庄家轮转、单挑（两人）规则、最小加注、不完整全下不重开加注、主池/边池、平分底池、退还没人跟的下注
- **实时同步**：基于 WebSocket，每个人只收到自己的底牌，别人的牌只有摊牌时才会发给你
- **断线重连**：刷新页面或网络断开后自动回到原座位
- **行动计时**：每人 1 分钟，超时自动过牌/弃牌（掉线的玩家 5 秒），不会卡住整桌
- **机器人**：房主点空位即可添加 🤖 机器人（会根据胜率和底池赔率决策，偶尔诈唬），人不够也能开局
- **语音聊天**：同桌玩家点「🎤」即可语音，显示谁在说话、支持静音；弱网自动重连，开启了 Opus 丢包纠错
- **变声器**：御姐音、可爱甜美音、男性气泡音、磁性嗓音、正太音，可先戴耳机试听
- **亮牌**：一手结束后可以把自己的底牌秀给大家看
- **其他**：牌型实时提示、规则说明、输光后可补码、文字聊天和牌局记录、适配手机竖屏

## 一键部署到公网（推荐）

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/litianyuan061-arch/-)

1. 点上面的按钮，用 GitHub 账号登录 Render（免费）
2. 确认页面直接点 **Deploy Blueprint**（免费套餐不需要绑卡）
3. 等几分钟构建完成，Render 会给你一个 `https://texas-holdem-xxxx.onrender.com` 这样的网址
4. 打开网址 → 创建房间 → 点「邀请好友」把链接发出去

免费套餐 15 分钟没人访问会休眠，之后第一次打开要等 30~60 秒启动，属于正常现象。

## 本地运行

需要 Node.js 18 或更高版本。

```bash
npm install
npm start
# 打开 http://localhost:3000
```

同一个 Wi-Fi 下的朋友可以用 `http://你电脑的局域网IP:3000` 加入。

要让不在身边的朋友也能玩，需要把服务部署到公网，例如 Render、Railway、Fly.io，或者自己的云服务器。启动命令都是 `npm start`，端口读取 `PORT` 环境变量。

## 语音中转服务器（强烈建议配置）

语音默认是玩家之间直连。手机 4G/5G、公司/学校网络经常无法直连，会提示「语音连不上」。
配置一个 TURN 中转服务器就能解决，推荐 Cloudflare（每月 1000GB 免费，足够朋友间使用）：

1. 注册并登录 [Cloudflare](https://dash.cloudflare.com/)
2. 左侧菜单找到 **Realtime**（实时通信）→ **TURN Server**，点 **Create** 创建一个 TURN Key
3. 创建后会显示 **Turn Token ID** 和 **API Token**（API Token 只显示一次，先复制保存好）
4. 打开 Render 后台 → 你的服务 → **Environment** → 添加两个变量后保存（会自动重新部署）：
   - `CLOUDFLARE_TURN_KEY_ID` = Turn Token ID
   - `CLOUDFLARE_TURN_API_TOKEN` = API Token
5. 部署完成后打开 `https://你的网址/api/ice-servers`，看到 `"relay":true` 就说明配置成功

也可以用 Metered（`METERED_DOMAIN`、`METERED_API_KEY`）或自建 coturn（`TURN_URLS`、`TURN_USERNAME`、`TURN_CREDENTIAL`）。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `TURN_SECONDS` | `60` | 每次行动的时限（秒） |
| `NEXT_HAND_SECONDS` | `6` | 一手结束后，隔多少秒自动开始下一手 |
| `CLOUDFLARE_TURN_KEY_ID` / `CLOUDFLARE_TURN_API_TOKEN` | 无 | Cloudflare 语音中转（见上文） |
| `METERED_DOMAIN` / `METERED_API_KEY` | 无 | Metered 语音中转 |
| `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` | 无 | 自建 TURN 服务器 |

## 测试

```bash
npm test
```

测试覆盖牌型比较、盲注和行动顺序、加注规则、边池、平分底池、中途离桌，还有一个随机对局测试，用来确认筹码总数始终不变。

## 目录结构

```
server/
  cards.js    牌堆、洗牌、牌型评估
  table.js    牌桌规则引擎（纯逻辑，不涉及网络）
  bot.js      机器人 AI（蒙特卡洛估算胜率）
  ice.js      语音 STUN/TURN 配置
  index.js    Express + Socket.IO 服务器：房间、计时器、状态推送
public/
  index.html  大厅和牌桌页面
  style.css
  client.js   前端逻辑（含语音、变声）
  pitch-worklet.js  实时变调处理器
test/         单元测试
```

## 说明

- 房间保存在服务器内存里，服务器重启后房间会清空；一个房间没人超过 10 分钟会自动删除
- 语音聊天需要通过 https 访问（部署到 Render 后自带）。微信内置浏览器的语音效果较差，建议用 Safari / Chrome 打开
- 这是朋友间娱乐用的，筹码是虚拟的，不涉及真实金钱
