# 音乐（Music）— cortico-world-music

让 Coopanion 的 bot **听见并感受**电脑上正在播放的音乐。

- **任意应用**：系统环回采集，播放器、浏览器、Ego 里的声音都能听到，不需要逐个适配。
- **换歌/结束会知道**：静音 ≥ 2.5 秒算一段结束；再响起来算新的一段。
- **按《如何听懂音乐》的框架感受**：先感官（音色/力度/音区），再表现（情绪质地），最后纯音乐（节奏/旋律/调式/形式）。
- **默认结束时总结**，也可以切成实时短评（live）或两者都要（both）。
- **歌词**：云端模型会转写它确实听清的片段；听不清就留空，不编。
- **歌名**：拿不到媒体信息时，可以截一张主屏给 bot 看播放器界面（默认关闭，见配置）。
- **一个 World**：采集、分析、事件、工具都在这里，不依赖听觉或语音转文本插件。

> 目前只支持 **Windows**（WASAPI 系统环回），且需要 **DashScope（阿里云百炼）API Key**。

## 依赖

- Coopanion（Cortico 扩展 API v6）。
- Windows 10/11，Node 22+（Coopanion 自带）。
- DashScope API Key：用于 Qwen-Omni 的音频理解，按音频时长计费（很便宜，30 秒约 210 个音频 token）。

## 安装

1. 在 Coopanion 设置 → 扩展 →「从本机目录安装」，选这个包目录；或命令行：
   ```bash
   cd <Coopanion>/data/extensions
   corepack pnpm add <这个包目录>
   ```
2. **重启 Coopanion**（扩展是 ESM，进程内不会重新加载）。
3. 在 **World 总览**启用「音乐」。
4. 配置 Key：在部署的 `.env` 里加一行（变量名与配置里的「密钥变量名」一致）：
   ```
   AUDIO_API_KEY=sk-...
   ```
   Coopanion 里通常是 `data/home/<bot>/.env`。密钥不写进包、不写进 config.json。
5. 打开 World 后它会自动开始听；默认 `end` 模式，一段结束/暂停时把汇总交给 bot。

## 配置（WebUI「音乐」页）

| 键 | 默认 | 说明 |
|---|---|---|
| `worlds.music.backend` | `dashscope` | 云端分析；`off` 只采集不分析 |
| `worlds.music.baseUrl` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容地址；不同业务空间可能不同 |
| `worlds.music.model` | `qwen3.8-omni-flash` | 支持音频输入、只输出文本的模型；不可用时试 `qwen3-omni-flash` / `qwen-omni-turbo` |
| `worlds.music.apiKeySecret` | `AUDIO_API_KEY` | 环境变量名 |
| `worlds.music.mode` | `end` | `end` / `live` / `both` |
| `worlds.music.windowSec` | `30` | 分析窗口秒数（15–60） |
| `worlds.music.maxCallsPerMinute` | `4` | 限流，超过的窗口跳过 |
| `worlds.music.screenFallback` | `false` | 换歌且没有媒体信息时截图给 bot 看 |
| `worlds.music.instrumentHints` | 空 | 额外乐器提示，拼进分析提示词 |
| `worlds.music.debug` | `false` | 运行日志里记录窗口/请求/解析 |

## 事件与工具

事件：`music.started`（开始/换歌，可带截图）、`music.scene`（实时窗口）、`music.ended`（整段汇总）、`music.state`（采集状态）。

工具：
- `music_watch`：`start` / `stop`（停止并总结当前一段）/ `status`；可带 `mode`。
- `music_now`：状态 + 最近一次分析。
- `music_mode`：切 `end` / `live` / `both`。

## 隐私与费用

- 启用后 World 会**持续录制系统输出**（包括所有应用的声音）；只在检测到有声音时分析。
- 上传到 DashScope 的是 **16kHz 单声道 WAV 片段**（约 30 秒）；不上传整首，不上传原始 48k。
- `screenFallback` 开启时会截**主屏**（可能包含屏幕上的其他内容）；默认关闭。
- 费用按 DashScope 音频 token 计；可在控制台「用量与成本」看到调用次数，本 World 自身不额外上报模型费用。
- 不想上传时把 `backend` 设为 `off`（只采集、不分析）。

## 已知限制

- 不能可靠识别「这是哪首歌」——没有媒体会话/指纹识别；只有截图给 bot 看这一条兜底。
- 系统环回会录到桌宠自己的 TTS；听音乐时建议关掉朗读，或让 bot 忽略自己的声音。
- 纯打击乐/太吵/太短的片段，分析置信度会低；提示词要求它标注不确定。
- 乐器识别依赖云端模型；国风/日风小众乐器可能混淆，提示词要求「不确定就说像/可能」。
- 默认 `end` 模式的总结要等静音 2.5 秒；连续 DJ/串烧不会切段。

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

## 许可

MIT。见 [LICENSE](LICENSE)。
