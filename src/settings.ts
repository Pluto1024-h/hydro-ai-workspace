import { coll, state } from './state';
import type { AiSettings } from './types';

export const DEFAULT_SETTINGS: AiSettings = {
  enabled: false,
  apiBase: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  validationAlias: 'deepseek_pro',
  validationTarget: 'deepseek-flash',
  searchProvider: 'bocha',
  searchApiBase: 'https://api.bochaai.com',
  timeoutMs: 60000,
  maxRetries: 2,
  maxContextMessages: 8,
  // Tool calls that build a whole problem package emit a large JSON payload;
  // 2048 truncates it and drops fields such as `title`.
  maxTokens: 8192,
};

const KEY_ENV = 'HYDRO_AI_DEEPSEEK_KEY';

export async function loadSettings(): Promise<AiSettings> {
  try {
    const doc = await coll('aiws_settings').findOne({ _id: 'global' });
    if (!doc) return { ...DEFAULT_SETTINGS };
    const result: any = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (doc[key] !== undefined && doc[key] !== null) result[key] = doc[key];
    }
    result._id = 'global';
    return result as AiSettings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<AiSettings>): Promise<AiSettings> {
  const allowed: (keyof AiSettings)[] = [
    'enabled', 'apiBase', 'model',     'validationAlias', 'validationTarget',
    'searchProvider', 'searchApiBase',
    'timeoutMs', 'maxRetries', 'maxContextMessages', 'maxTokens',
  ];
  const clean: any = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) clean[key] = patch[key];
  }
  clean.updatedAt = new Date();
  await coll('aiws_settings').updateOne({ _id: 'global' }, { $set: clean }, { upsert: true });
  return loadSettings();
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

export async function getApiKey(): Promise<string> {
  if (process.env[KEY_ENV]) return process.env[KEY_ENV] as string;

  const setting = state.ctx?.setting;
  if (setting && typeof setting.get === 'function') {
    try {
      const value = setting.get('aiws.apiKey');
      if (typeof value === 'string' && value.trim()) return value.trim();
    } catch {
      // Not registered in this Hydro version; fall through.
    }
  }

  try {
    const doc = await coll('aiws_settings').findOne({ _id: 'global' });
    if (typeof doc?.apiKey === 'string' && doc.apiKey.trim()) return doc.apiKey.trim();
  } catch {
    // Ignore and report as unset.
  }
  return '';
}

export async function setApiKey(key: string): Promise<void> {
  const value = String(key || '').trim();
  if (!value) return;

  const setting = state.ctx?.setting;
  if (setting && typeof setting.setConfig === 'function') {
    try {
      await setting.setConfig('aiws.apiKey', value);
    } catch {
      // Fall back to the private collection.
    }
  }

  await coll('aiws_settings').updateOne(
    { _id: 'global' },
    { $set: { apiKey: value, updatedAt: new Date() } },
    { upsert: true },
  );
}

export async function getPublicSettings(): Promise<any> {
  const settings = await loadSettings();
  const key = await getApiKey();
  // IMPORTANT: never expose a template variable named `model`.
  // Hydro's layout templates rely on the global `model` object
  // (e.g. model.system.get(...)); a string named `model` shadows it
  // and breaks rendering with "Unable to call model[\"system\"][\"get\"]".
  const { model: chatModel, ...rest } = settings as any;
  return {
    ...rest,
    chatModel,
    apiKeySet: !!key,
    apiKeyMasked: key ? maskKey(key) : '',
    apiKeyFromEnv: !!process.env[KEY_ENV],
  };
}

/** Resolve the internal "deepseek_pro" alias to a real model id. */
export function resolveValidationModel(settings: AiSettings): string {
  const target = String(settings.validationTarget || '').trim();
  return target || settings.model || 'deepseek-flash';
}
