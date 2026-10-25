# Changelog

## 0.1.0

- 第一个版本：Windows 系统环回采集、静音/换歌分段、DashScope Qwen-Omni 音频理解、`music.started/scene/ended/state` 事件、`music_watch/music_now/music_mode` 工具。
- 先用第一个窗口判断 `isMusic`：直播说话、播客、有声书会被丢弃，确认是音乐才发 `music.started`。
- 默认 `end` 模式（一段结束/暂停时总结）；可选 `live` / `both`。
- 可选主屏截图兜底，用来识别播放器/歌名。
- 乐器受控词表覆盖西方、国风与日风常见乐器；情绪按三层框架给倾向与置信度，不做“调=情绪”的硬映射。
