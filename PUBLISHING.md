# 发布指南（给从没用过 npm / GitHub 的人）

这个包已经是独立 git 仓库：`E:\Cortina\state\packages\cortico-world-music`。
按下面的顺序做，每步都有"成功的样子"。

> 发布和 push 由你本人执行；我不会替你 push / publish。

## 0. 发布前自检

```powershell
cd E:\Cortina\state\packages\cortico-world-music
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build:webui
```

在 Cortico 检出目录再做扩展检查：

```powershell
cd E:\Cortina\state\cortico
corepack pnpm describe:extension E:\Cortina\state\packages\cortico-world-music
corepack pnpm check:extension E:\Cortina\state\packages\cortico-world-music
```

成功：`Extension check passed.`，最后一段会打印发布前清单和官方索引的申请格式。

## 1. npm 账号

1. 打开 https://www.npmjs.com/signup 注册（用户名、邮箱、密码）。
2. 邮箱验证。
3. 本机登录：

```powershell
npm login
npm whoami
```

`npm whoami` 打印你的用户名就是成功。
如果开了两步验证，`npm publish` 会要求一次性验证码。

### 网页一直提示“机器人” / 注册不了

网页注册走的是 Cloudflare 的机器人验证，VPN 的数据中心 IP 很容易被判定成机器人；关掉 VPN 又可能一直转圈。可以绕过网页，用 npm CLI 的旧式注册接口直接建账号：

```powershell
npm adduser --auth-type=legacy
```

它会依次问 Username、Password、Email（Email 会公开显示，用你常用的邮箱），不需要浏览器验证码。创建后：

```powershell
npm whoami
```

成功会打印用户名。
然后去邮箱点 npm 的验证链接（没验证的账号不能发布），再回来发布。

如果 `legacy` 也报错（有些网络会拦这个接口）：

1. 关 VPN，用手机热点试一次；或者换一个住宅 IP 的节点（不要用常见机房 VPN）。
2. 浏览器用无痕窗口、关掉广告拦截/脚本拦截、换 Chrome/Edge 再试注册。
3. 还是不行，用 **GitHub Codespaces**（你有 GitHub，免费额度够）：
   - 先把最新提交 push 到 GitHub；
   - 打开仓库 → **Code** → **Codespaces** → **Create codespace on main**；
   - 在 Codespaces 终端里跑：

```bash
npm adduser --auth-type=legacy
npm whoami
```

   - 邮箱验证后，直接在 Codespaces 里发布（`dist` 已经提交，跳过本机脚本）：

```bash
cd /workspaces/cortico-world-music
npm publish --access public --ignore-scripts
```

   - `--ignore-scripts` 会跳过 `prepublishOnly`/`prepare`，但 `dist/webui.js` 已经在仓库里，发布内容不受影响；本机前面已经跑过 typecheck/test。
   - 发布成功后再在本地 `npm login --auth-type=legacy`，以后更新版本就可以从 Windows 发布。

检查名字（当前 `cortico-world-music` 在 npm 上还没人用）：

```powershell
npm view cortico-world-music version
```

成功（名字可用）：`E404` 之类"Not found"。
如果以后被别人占用，见第 6 节"改名"。

## 2. 先填 GitHub 信息（可选，但推荐）

先在 GitHub 建一个空仓库：https://github.com/new
- 名字：`cortico-world-music`
- Public
- 不要勾选 "Add a README"（本地已有）

然后把本地仓库接上并第一次 push：

```powershell
cd E:\Cortina\state\packages\cortico-world-music
git remote add origin https://github.com/<你的GitHub用户名>/cortico-world-music.git
git branch -M main
git push -u origin main
```

成功：GitHub 页面能看到 `src/`、`dist/`、`README.md`、`PROJECT.md`、`describe.json`。

建议在 `package.json` 补上（把尖括号换成你的信息）：

```json
"author": "<你的名字或昵称>",
"homepage": "https://github.com/<你的GitHub用户名>/cortico-world-music#readme",
"repository": { "type": "git", "url": "git+https://github.com/<你的GitHub用户名>/cortico-world-music.git" },
"bugs": { "url": "https://github.com/<你的GitHub用户名>/cortico-world-music/issues" }
```

改完提交：

```powershell
git add package.json
git commit -m "docs: add repository metadata"
git push
```

## 3. npm 发布

先看会发布哪些文件（不会真的发布）：

```powershell
npm pack --dry-run
```

确认里面有：`src/`、`dist/webui.js`、`README.md`、`PROJECT.md`、`CHANGELOG.md`、`describe.json`、`LICENSE`。

发布：

```powershell
npm publish --access public
```

成功：终端出现 `+ cortico-world-music@0.2.0`，并能在
https://www.npmjs.com/package/cortico-world-music 打开。

如果报 `prepublishOnly` 失败：先在本机跑第 0 节，修好再发。
如果报 403 / 名字被占用：见第 6 节。

## 4. 在 Coopanion 里装一次 npm 版

1. 打开 Coopanion →「扩展」→ 搜索/手动输入 `cortico-world-music`。
2. 安装，重启 Coopanion。
3. 打开 World 页「一起感受音乐」→「接口与密钥」，确认面板正常；密钥填好后保存。
4. 对桌宠说「一起听音乐」，放一首歌，确认能报歌名、能总结、能换歌。

> 如果你本机还留着"从本机目录安装"的 link 版，先在扩展页卸掉/停用它，再装 npm 版，避免两份同名。

## 5. 上架 Coo 扩展市场 / 官方索引

Coo 的扩展市场列的是 **npm 上带 `cortico-world` 关键字的包**；你的 `package.json` 已经有：

```json
"keywords": ["cortico-world", "cortico", "coopanion", ...]
```

所以 npm 发布成功后，市场搜索就能看到。要补标签/认证/展示，去官方索引仓：

- 仓库：https://github.com/Pal-AI-Lab/cortico-extensions
- 提一个 issue（标题格式 `[tags] cortico-world-music`），正文按 `check:extension` 最后打印的格式填：

```
package: cortico-world-music
add: voice, requires-key, sensitive-data, experimental
reason: 一句话说明
evidence: https://www.npmjs.com/package/cortico-world-music
         https://github.com/<你的GitHub用户名>/cortico-world-music
```

- `sensitive-data` 是警告标签（读系统声音/屏幕，发给模型端点）；`requires-key`、`voice`、`experimental` 是普通/提示标签。
- 官方蓝标（coopanion / pal-ai-world / corti）只有维护者能加，作者不能自己声明。
- 认证、替换包、标签申诉也在这个仓提 issue；格式同上。

## 6. 常见问题

### 名字被占用

把 `package.json` 的 `"name"` 改成带 scope 的名字，例如：

```json
"name": "@<你的npm用户名>/cortico-world-music"
```

同步改 README/PROJECT 里的包名，然后：

```powershell
npm publish --access public
```

### `npm publish` 报 403 / 需要 2FA

- 确认 `npm whoami` 是你的用户名；
- 开了 2FA 就按提示输入验证码；
- 确认 `"publishConfig": { "access": "public" }` 还在。

### `dist/webui.js` 没进包

`files` 里要有 `"dist"`；先跑 `corepack pnpm build:webui`，再 `npm pack --dry-run` 检查。

### 扩展页搜不到

- npm 上 `keywords` 必须有 `cortico-world`；
- 发布后等几分钟；
- 市场搜索用 `keywords:cortico-world`，如果 registry 不支持，会退回关键字文本搜索；
- 扩展页可以手动输入包名安装。

### 更新版本

```powershell
# 改 package.json 的 version，例如 0.2.1
# 在 CHANGELOG.md 加 ## 0.2.1
corepack pnpm typecheck
corepack pnpm test
npm publish --access public
git add -A
git commit -m "release: 0.2.1"
git tag v0.2.1
git push
git push --tags
```

## 7. 不要提交的东西

- 部署的 `.env`（API Key）不要进 git；
- 用户数据、截图、日志不要进包；
- 包里的 `files` 只列 `src`、`dist`、文档、`describe.json`、`LICENSE`。

## 8. 发布前最后一眼

- [ ] `typecheck` / `test` / `check:extension` 全过
- [ ] `dist/webui.js` 是最新构建
- [ ] `package.json` 版本与 `CHANGELOG.md` 的 `## <版本>` 一致
- [ ] `npm pack --dry-run` 没有多余文件
- [ ] 本机从 npm 安装并跑过一次
- [ ] 标签 issue 已发（可选但推荐）
- [ ] GitHub 仓库、npm 包、README 里的链接都对

当前包名可用性检查：`cortico-world-music` 在 npm 上未找到（可注册）。
