/** 系统音频采集：loopback-capture（N-API 预编译），只支持 Windows。 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface CaptureLike {
  start(onPcm: (pcm: Int16Array) => void): void;
  stop(): void;
}

export interface LoopbackAddon {
  LoopbackCapture: new () => {
    startSystemAudio: (callback: (chunk: Buffer) => void) => void;
    stop: () => void;
  };
}

export function loadLoopback(): LoopbackAddon {
  if (process.platform !== 'win32') throw new Error('音乐 World 目前只支持 Windows（WASAPI 系统环回）。');
  try {
    return require('loopback-capture') as LoopbackAddon;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`载入 loopback-capture 失败：${detail}。请在扩展目录安装依赖后重启应用。`);
  }
}

/** 采集默认系统输出；回调和 listen 一样是 48k 立体声 16-bit PCM。 */
export class SystemAudioCapture implements CaptureLike {
  private impl: InstanceType<LoopbackAddon['LoopbackCapture']> | null = null;

  start(onPcm: (pcm: Int16Array) => void): void {
    if (this.impl) throw new Error('已经在采集了：先 stop。');
    const mod = loadLoopback();
    const impl = new mod.LoopbackCapture();
    impl.startSystemAudio((chunk: Buffer) => {
      const pcm = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2));
      if (pcm.length) onPcm(pcm);
    });
    this.impl = impl;
  }

  stop(): void {
    const impl = this.impl;
    this.impl = null;
    if (!impl) return;
    try { impl.stop(); } catch {}
  }
}
