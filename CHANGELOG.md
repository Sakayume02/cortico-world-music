# Changelog

## 0.2.0

- **明确指令才开始**：World 默认待命、不采集；只有用户明确说「一起听音乐」后，bot 调 `music_watch start` 才开始；停止时先总结当前一段。
- **沉浸式感受**：分析新增 `listenerSummary`（像人正听着）、`feeling`（情绪质地）、`imagery`（画面）、`body`（身体反应）、`arc`（走向）；事件正文先感受，技术参数放在末尾「内部参考」，明确要求 bot 不要照念。
- **完整歌词**：桌面播放器通过 Windows 媒体会话（GSMTC）读歌名/歌手，再用 LRCLIB 查完整歌词；浏览器/未知来源按音频听写，听不清就保守。
- **截图兜底**：只在来源未知且开启时截屏，给 bot 看播放器界面；播放器已给曲目时不截。
- **稳定性**：修复原生采集静音不回调导致「暂停不结束」的问题，加 500ms 墙钟看门狗，暂停 2.5 秒收段。
- 新增 `readPlayerMeta` / `lookupLyrics` 配置；显示名改为「一起感受音乐」。

## 0.1.0

- 第一个版本：Windows 系统环回采集、静音/换歌分段、DashScope Qwen-Omni 音频理解、`music.started/scene/ended/state` 事件、`music_watch/music_now/music_mode` 工具。
- 默认 `end` 模式（一段结束/暂停时总结）；可选 `live` / `both`。
- `isMusic` 门控：直播说话、播客、有声书会被丢弃，确认是音乐才发 `music.started`。
- 乐器受控词表覆盖西方、国风与日风常见乐器；情绪按三层框架给倾向与置信度，不做「调 = 情绪」的硬映射。
