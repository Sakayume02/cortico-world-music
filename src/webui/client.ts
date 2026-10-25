/** 「一起感受音乐」的 WebUI 面板：选择后端/模型、填接口地址和 API Key。 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

interface SettingsState {
  backend: string;
  baseUrl: string;
  model: string;
  afterSong: string;
  hasKey: boolean;
  keyName: string;
  models: string[];
}

const DASH_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const CUSTOM = '__custom__';

const settingsPanel: WebUiPanel = {
  async mount(ctx: WebUiPanelContext): Promise<void> {
    const { ui } = ctx;
    const sheet = ui.sheet({
      title: '接口与密钥',
      desc: '选分析后端和模型，填接口地址与自己的 API Key。密钥只写入部署 .env，不会回显。',
    });
    ctx.root.appendChild(sheet.el);

    const status = ui.rowbar();
    const backend = ui.select({
      options: [
        { value: 'dashscope', label: 'DashScope / Qwen-Omni（推荐）' },
        { value: 'openai-compatible', label: 'OpenAI 兼容接口（自定义）' },
        { value: 'off', label: '关闭分析（只采集）' },
      ],
    });
    const baseUrl = ui.input({ placeholder: 'https://…/compatible-mode/v1' });
    const modelPick = ui.select({
      options: [
        { value: 'qwen3.8-omni-flash', label: 'qwen3.8-omni-flash' },
        { value: 'qwen3-omni-flash', label: 'qwen3-omni-flash' },
        { value: 'qwen-omni-turbo', label: 'qwen-omni-turbo' },
        { value: CUSTOM, label: '自定义模型名…' },
      ],
    });
    const model = ui.input({ placeholder: 'qwen3.8-omni-flash 或你的模型名' });
    const afterSong = ui.select({
      options: [
        { value: 'continue', label: '继续听下一首' },
        { value: 'stop', label: '听完这首就停（总结后自动停）' },
      ],
    });
    const key = ui.input({ type: 'password', placeholder: 'sk-…（只写不读）' });
    const msg = ui.msgline();
    const actions = ui.actions();
    const save = ui.button('保存设置', { variant: 'primary' });
    const saveKey = ui.button('保存密钥');
    const reset = ui.button('恢复 DashScope 默认');
    const keyName = ui.pill('密钥变量：—');
    actions.append(save, saveKey, reset);

    sheet.body.append(
      ui.field('分析后端', backend),
      ui.field('接口地址', baseUrl),
      ui.field('常用模型', modelPick),
      ui.field('模型名（可手填）', model),
      ui.field('听完一首后', afterSong),
      ui.field('API Key', key),
      actions,
      msg,
    );
    status.append(keyName);
    sheet.body.prepend(status);

    const say = (text: string, bad = false): void => {
      msg.textContent = text;
      msg.classList.toggle('bad', bad);
    };

    const show = (s: SettingsState): void => {
      backend.value = s.backend;
      baseUrl.value = s.baseUrl;
      model.value = s.model;
      modelPick.value = s.models.includes(s.model) ? s.model : CUSTOM;
      afterSong.value = s.afterSong;
      key.value = '';
      key.placeholder = s.hasKey ? `已配置（留空不修改，变量：${s.keyName}）` : 'sk-…（只写不读）';
      keyName.textContent = `密钥变量：${s.keyName} · ${s.hasKey ? '已配置' : '未配置'}`;
      keyName.className = s.hasKey ? 'pill on' : 'pill off';
    };

    const refresh = async (): Promise<void> => {
      try {
        show(await ctx.invoke<SettingsState>('state'));
      } catch (e) {
        say('读取失败：' + (e instanceof Error ? e.message : String(e)), true);
      }
    };

    backend.addEventListener('change', () => {
      if (backend.value === 'dashscope') {
        baseUrl.value = DASH_BASE;
        if (!model.value.trim()) model.value = 'qwen3.8-omni-flash';
        modelPick.value = model.value;
      }
    });
    modelPick.addEventListener('change', () => {
      if (modelPick.value !== CUSTOM) model.value = modelPick.value;
    });

    save.addEventListener('click', () => {
      void (async () => {
        try {
          const s = await ctx.invoke<SettingsState>('save', [{
            backend: backend.value,
            baseUrl: baseUrl.value,
            model: model.value,
            afterSong: afterSong.value,
          }]);
          show(s);
          say('已保存。');
        } catch (e) {
          say('保存失败：' + (e instanceof Error ? e.message : String(e)), true);
        }
      })();
    });

    saveKey.addEventListener('click', () => {
      void (async () => {
        try {
          const s = await ctx.invoke<SettingsState>('save-key', [{ key: key.value }]);
          show(s);
          say('密钥已写入部署 .env。');
        } catch (e) {
          say('密钥保存失败：' + (e instanceof Error ? e.message : String(e)), true);
        }
      })();
    });

    reset.addEventListener('click', () => {
      void (async () => {
        try {
          const s = await ctx.invoke<SettingsState>('reset');
          show(s);
          say('已恢复 DashScope 默认地址和模型。');
        } catch (e) {
          say('恢复失败：' + (e instanceof Error ? e.message : String(e)), true);
        }
      })();
    });

    await refresh();
  },
};

export default { panels: { settings: settingsPanel } } satisfies WebUiClientBundle;
