/**
 * Small shared holder for the plugin Context.
 * Avoids circular imports between index.ts, handlers and tools.
 */
export const state: { ctx: any; db: any } = { ctx: null, db: null };

export function setCtx(ctx: any) {
  state.ctx = ctx;
  state.db = ctx?.db || null;
}

export function coll(name: string) {
  if (!state.db?.collection) throw new Error('数据库尚未就绪，请确认插件已由 Hydro 正常加载。');
  return state.db.collection(name);
}

export function getModel(name: string): any {
  return (globalThis as any).Hydro?.model?.[name];
}
