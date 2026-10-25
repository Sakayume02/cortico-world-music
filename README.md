# 一起感受音乐（Together with Music）

> 不是音乐分析器，是一个会和你一起沉浸、走神、兴奋、安静下来的听歌搭子。

这是一个 Coopanion / Cortico 的 World 扩展。**只有你明确说想一起听音乐，它才开始听**；然后它会像真正爱音乐的人一样，跟着音乐感受氛围、画面和情绪，而不是冷冰冰地报 BPM、调式和乐器置信度。

- 听见电脑上任何应用的声音：播放器、浏览器、Ego 都行。
- 换歌/暂停/结束会知道；默认在一段结束或暂停时，把整段的感受说给你听。
- 桌面播放器能给出曲目信息时，会去查**完整可信的歌词**；浏览器就按音频自己听，听不清就保守。
- 国风/日风的小众乐器不会被默认成钢琴；不确定时它会说“像/可能是”。
- 全程一个 World，不需要听觉、语音转文本、网易云等别的插件配合。

> Windows 10/11；需要 Coopanion 和 DashScope（阿里云百炼）API Key。

## 它听起来是什么样

这些是**语气示例**，不是固定台词：

- **兴奋的歌**：“这个鼓一进来我就想跟着点头——副歌一开，整个人被推着往前跑。”
- **安静的歌**：“钢琴一层层落下来，我没说话；像傍晚的空房间，光慢慢暗下去。”
- **悲伤的歌**：“这句‘别不说话我的亲爱’出来的时候，我有点不敢接下一句。”
- **国风的歌**：“开头像古筝，但那个尾音又有点像 koto；我不太敢认，先听着。”
- **纯音乐**：“没有词，但弦乐一直往上走，我胸口跟着提起来。”

它不会说：“本段 BPM 72，A 小调，钢琴置信度 0.95。”——这些只放在事件末尾的「内部参考」里，给它自己理解用。

## 快速开始

1. 在 Coopanion 的「扩展」页用「从本机目录安装」选这个包，或命令行：
   ```bash
   cd <Coopanion>/data/extensions
   corepack pnpm add <这个包目录>
   ```
2. **重启 Coopanion**，在「World 总览」启用「一起感受音乐」。
3. 在部署的 `.env` 里配置 DashScope Key（变量名默认 `AUDIO_API_KEY`）：
   ```
   AUDIO_API_KEY=sk-...
   ```
4. 对桌宠说：**“一起听音乐”** / “听首歌” / “我们一起听”。它才会调用 `music_watch start` 开始听。
5. 想停就说：**“停 / 不听了”**。它会先总结当前这一段，再停。

> 默认待命，不会因为环境里有声音就自己开始；这是有意的。

## 工作原理（简版）

```
你明确说「一起听音乐」
  → bot 调 music_watch start
  → World 开始 WASAPI 系统环回（之前完全不采集）
  → 分段：静音 2.5s 收段 / 连续音乐最长 5 分钟
  → 第一个窗口先判断「是不是音乐」；直播说话/播客整段丢弃
  → 播放器：读 Windows 媒体会话的曲目/歌手 → 查 LRCLIB 完整歌词
     浏览器/未知来源：不查歌词，按音频听写，保守处理
  → 每 30s 一段音频 → Qwen-Omni：感受/情绪/画面/身体/走向 + 技术参考
  → 事件：music.started → music.scene（live）→ music.ended
  → bot 以「爱音乐的人」的语气回应；参数只放在内部参考，不照念
```

## 需要什么、和谁配合

| 类别 | 东西 | 作用 |
|---|---|---|
| 必需 | **Coopanion**（Cortico Core） | 运行 World、把事件交给 bot、WebUI 配置 |
| 必需 | **Windows 10/11** | WASAPI 系统环回（`loopback-capture`，随包安装） |
| 必需 | **DashScope API Key** | Qwen-Omni 音频理解（按音频时长计费，30 秒约 210 音频 token） |
| 必需 | 网络 | 调用 DashScope；播放器歌词时调用 LRCLIB |
| 可选 | **桌面播放器**（网易云 / QQ 音乐 / Spotify / Media Player 等） | 通过 Windows 媒体会话给出准确曲目/歌手，查完整歌词 |
| 可选 | **LRCLIB**（免费，无 Key） | 有曲目信息时提供完整歌词；服务不可用就退回听写 |
| 可选 | 支持图片的模型 | 浏览器/未知来源时，屏幕截图兜底识别播放器 |
| 不需要 | 听觉 / 语音转文本 / 网易云等别的 World | 本 World 自己采集、自己分析，一个包全包 |
| 不需要 | Python / GPU / 麦克风 | 纯 Node + 云端 |

## 歌词策略

- **桌面播放器**：从 Windows 媒体会话（GSMTC）读歌名、歌手；有准确信息时去 [LRCLIB](https://lrclib.net) 查完整歌词。查到了就是「完整可信」，bot 可以引用短句；查不到就退回听写。
- **浏览器 / 来源未知**：不读媒体会话，按音频听写；只听清多少写多少，听不清就空着。bot 会被要求保守，不编歌词。
- **纯音乐**：不假装有人声。
- 截图兜底（默认关闭）：没有曲目信息、且你开启时，截一张主屏给 bot 看播放器界面；浏览器裸播放页可能没有标题，识别不出就只说听感。

## 配置（WebUI「一起感受音乐」页）

| 键 | 默认 | 说明 |
|---|---|---|
| `worlds.music.backend` | `dashscope` | 云端分析；`off` 只采集不分析 |
| `worlds.music.baseUrl` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容地址 |
| `worlds.music.model` | `qwen3.8-omni-flash` | 支持音频输入、只输出文本的模型 |
| `worlds.music.apiKeySecret` | `AUDIO_API_KEY` | 部署 .env 里的变量名 |
| `worlds.music.mode` | `end` | `end` / `live` / `both` |
| `worlds.music.windowSec` | `30` | 分析窗口秒数（15–60） |
| `worlds.music.maxCallsPerMinute` | `4` | 限流 |
| `worlds.music.screenFallback` | `false` | 无曲目信息时截屏给 bot 看 |
| `worlds.music.readPlayerMeta` | `true` | 读桌面播放器的媒体会话 |
| `worlds.music.lookupLyrics` | `true` | 有曲目信息时查 LRCLIB |
| `worlds.music.instrumentHints` | 空 | 额外乐器提示 |
| `worlds.music.debug` | `false` | 调试日志 |

## 模式

- **end**（默认）：一段结束/暂停时，把整段的感受、画面、歌词交给 bot，让它说一段完整的。
- **live**：每 30 秒左右给一段短评；适合边听边聊。
- **both**：两者都要。

## 隐私与费用

- 只有你明确说“一起听”之后才开始采集；说停就停。
- 上传 DashScope 的是 **16kHz 单声道 WAV 片段**（约 30 秒），不是整首、不是原始 48k。
- 播放器曲目信息只用于查歌词；LRCLIB 只收到歌名/歌手，不收到音频。
- 截图兜底默认关闭；开启后会截主屏，可能包含屏幕上的其他内容。
- 费用按 DashScope 音频 token 计；World 自身不额外上报模型费用。可用 `backend=off` 只采集不分析。

## 已知限制

- **歌名识别**：桌面播放器走媒体会话比较准；浏览器主要靠听，不保证能报出歌名。
- **歌词**：LRCLIB 中文覆盖不保证；服务 503 时退回听写；听写可能错，bot 会保守。
- **乐器**：云端模型对国风/日风小众乐器仍可能混淆；提示词要求不确定就说“像/可能”，不硬认。
- **桌宠自己的 TTS** 会被系统环回录进去；听音乐时建议关掉朗读，或让 bot 忽略自己的声音。
- 纯打击乐、太吵、太短的片段置信度会低；默认 `end` 模式要等静音 2.5 秒才收段。
- 连续 DJ/串烧没有静音时不会自动切歌。

## 开发

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
```

在 Cortico 检出根目录：

```bash
corepack pnpm describe:extension <包目录>
corepack pnpm check:extension <包目录>
```

## 市场标签

`voice`、`requires-key`、`sensitive-data`、`experimental`。

## 许可

MIT。见 [LICENSE](LICENSE)。
