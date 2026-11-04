// テスト・動作確認用の D1 互換シム（node:sqlite）。Worker が使う範囲（prepare/bind/first/all/run/batch）だけを実装
import { DatabaseSync } from 'node:sqlite';

export function createD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    first: async (col) => {
      const row = db.prepare(sql).get(...params);
      if (!row) return null;
      return col ? row[col] : { ...row };
    },
    all: async () => ({ results: db.prepare(sql).all(...params).map((r) => ({ ...r })), success: true }),
    run: async () => runSync(sql, params),
    _runSync: () => runSync(sql, params),
  });
  const runSync = (sql, params) => {
    const r = db.prepare(sql).run(...params);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  return {
    prepare: (sql) => stmt(sql),
    // D1 の batch は、途中で他の処理が割り込まない1つのトランザクション。同期で実行して、同じ性質にする
    // （await をはさむと、同時に送った2つの batch が割り込み合い、BEGIN が入れ子になる）
    batch: async (list) => {
      const out = [];
      db.exec('BEGIN');
      try {
        for (const s of list) out.push(s._runSync());
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return out;
    },
    _raw: db,
  };
}
