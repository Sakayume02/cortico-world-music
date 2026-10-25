/** 主屏截图：只在换歌且没有媒体信息时用，给 bot 看播放器界面。 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ScreenShot {
  bytes: Uint8Array;
  mime: string;
  name: string;
}

export async function capturePrimaryScreen(dataDir: string): Promise<ScreenShot | null> {
  if (process.platform !== 'win32') return null;
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, `screen-${Date.now()}.png`);
  const quoted = file.replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.X,$b.Y,0,0,$b.Size)',
    `$bmp.Save('${quoted}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose(); $bmp.Dispose()',
  ].join('; ');
  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      timeout: 10000,
      windowsHide: true,
    });
    const bytes = await readFile(file);
    return { bytes: new Uint8Array(bytes), mime: 'image/png', name: 'screen.png' };
  } catch {
    return null;
  } finally {
    void unlink(file).catch(() => {});
  }
}
