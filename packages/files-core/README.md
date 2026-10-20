# @gugu-acp/files-core(代码里引用为 `@gugu/files-core`)

「打开的文件」和存储无关的那一半。**远端的文件服务**(`services/files`,Postgres)和**桌面的本地服务**(任务工作副本,磁盘为真源)共用这一份,各自只管「从哪加载、存到哪、谁能打开」。设计见 gugu-base `notes/2026-09-29-app-platform/workspace-app/L2-task-files-local-service.md` §9(统筹 09-30 选 (甲):核心放在 gugu-supabase,发布后 gugu 按版本引用)。

| 入口 | 内容 |
|---|---|
| `./content` | 可读内容 ↔ Yjs:`buildDoc`、`readText`、`applyEdit`(agent 的 `edit(旧, 新)`)、`applyJson`(map 按键、数组按位置、协同文本按字符并入)、`rebuildDoc`(冷压缩按当前结构重建);协同文本的正文标记 `{"$text": "..."}`(`isTextMark`,投影 `withoutMarks`)。**页面运行时也从这里引用** |
| `./concurrent` | F43:同时建同一条嵌套路径两边都留下(`mergeConcurrentCreations`);`keepReplacedMaps`(被别的值顶掉的 map 不做 GC,直接删掉的照常回收,F61)。**页面运行时也从这里引用** |
| `./open-files` | `createOpenFiles`:每个打开的文件的簿记、限速与单文件上限、presence 盖章、`{"t":"self"}`,以 Hocuspocus 钩子的形式交给调用方 |
| `./presence` | `colorFor`、`stampOf`:章只有服务端这一份(F9) |
| `./limits` | 每连接的令牌桶 |

yjs 是 peer dependency(精确版本 13.6.33):同一个进程里只能有一份 Yjs,各处的 `instanceof Y.Map` 才对得上。

`./content`、`./concurrent`、`./presence` 不用任何 Node API,浏览器里能跑;`./open-files`、`./limits` 只给 Node(服务端与桌面主进程)。

## 协同文本的正文标记

正文里写 `{"$text": "..."}`(恰好只有这一个键、值是字符串;多一个键就是普通对象)就是一段协同文本(Y.Text)。App 的 `gugu.text(s)` 序列化出来是它,agent 在 `data` / `workspace_create_document` 里直接写它。

- 建文件(`buildDoc`)、agent 编辑里新写的值、数组里的新元素:都经 `toY`,标记 ⇒ Y.Text。
- 已有的 Y.Text 遇到 `{"$text": s}` 或普通字符串:按字符并入,类型不变。普通字符串或 map 遇到标记:换成 Y.Text。Y.Text 遇到对象、数字:替换。
- 建好以后标记不再出现:投影(`readText`、存盘写的 inline_text)里是普通字符串。文件服务在第一次按正文建状态时,用同一条 UPDATE 把正文换成投影;还没被打开过的文件,读的时候也经 `withoutMarks` 投影。

## 发布与引用

- 发到 npmjs,公开包 `@gugu-acp/files-core`(主人 10-01)。改了这个包就升 `package.json` 的版本;合进 dev 时 `.github/workflows/publish-files-core.yml` 用本仓的 secret `NPM_TOKEN` 发(`--access public`),同一个版本号内容不一样会红。装它不要令牌。
- 引用名照旧是 `@gugu/files-core/...`:本仓 `services/files` 用 pnpm 的 workspace 别名 `"@gugu/files-core": "workspace:@gugu-acp/files-core@*"`,gugu 用 `"@gugu/files-core": "npm:@gugu-acp/files-core@<版本>"`。
- GitHub Packages 上的 `@nmhjklnm/files-core@0.1.0`(私有,10-01 早些时候发的)已弃用:没人再引用它,也不再往那里发。
- `./content` 的 `spliceText`:整段协同文本改成新值,只换不同的那一段。服务端合并 JSON 与页面运行时写协同文本共用。
