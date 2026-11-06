// Mocked PostgreSQL transport. Only the synthetic statements in this test run.
export const databaseUrl = 'postgres://invalid.example/inspection';
export const events = [];
export const row = { id: 'own', body: 'own seeded row', owner_email: 'owner@example.test' };

export default function postgres(url) {
  if (url !== databaseUrl) throw new Error('The PostgreSQL fixture refuses other databases');
  function connection(transaction) {
    const record = (kind, detail = {}) => events.push({ kind, transaction, ...detail });
    async function sql(parts) {
      const text = parts.join('?');
      if (!text.includes('information_schema.columns')) throw new Error('Unexpected tagged fixture query');
      record('discover');
      return Object.keys(row).map(column_name => ({ table_name: 'inspection_notes', column_name }));
    }
    sql.unsafe = async (text, args = []) => {
      const compact = text.trim().replace(/\s+/g, ' ').replace(/;$/, '');
      if (compact.toUpperCase() === 'SET LOCAL STANDARD_CONFORMING_STRINGS = ON') {
        record('literal-policy');
        return [];
      }
      if (compact.startsWith('CREATE OR REPLACE TEMPORARY VIEW')) {
        if (!text.includes(row.owner_email)) throw new Error('Fixture view lacks caller ownership');
        record('scope-setup');
        return [];
      }
      if (compact.startsWith('DROP VIEW IF EXISTS')) { record('scope-teardown'); return []; }
      if (compact === 'SELECT id, body FROM inspection_notes') {
        record('user-select');
        return [{ id: row.id, body: row.body }];
      }
      if (compact === 'SELECT "body" AS __val FROM "inspection_notes" WHERE id = \'own\'') {
        record('patch-select');
        return [{ __val: row.body }];
      }
      if ((compact === 'UPDATE inspection_notes SET body = $1 WHERE id = $2' && args[1] === row.id) ||
          compact === 'UPDATE "inspection_notes" SET "body" = $1 WHERE id = \'own\'') {
        row.body = args[0];
        record('user-update');
        return Object.assign([], { count: 1 });
      }
      throw new Error(`Unexpected fixture SQL: ${compact}`);
    };
    sql.begin = async callback => {
      if (transaction) throw new Error('Unexpected nested fixture transaction');
      record('begin');
      const result = await callback(connection(true));
      record('commit');
      return result;
    };
    sql.end = async () => record('close');
    return sql;
  }
  return connection(false);
}
