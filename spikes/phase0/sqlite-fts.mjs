// S1 probe: node:sqlite FTS5 + diacritic folding. Always prints exactly one JSON line.
let warning = null;
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning') warning = w.message;
});

const result = {
  node: process.versions.node,
  sqlite: null,
  fts5: false,
  accentFolding: false,
  warning: null,
};
let error = null;

try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    result.sqlite = db.prepare('select sqlite_version() as v').get().v;
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(title, body, tokenize="unicode61 remove_diacritics 2")`);
    result.fts5 = true;
    db.prepare('INSERT INTO t(title, body) VALUES (?, ?)').run(
      'Decisión de autenticación',
      'Usamos sesiones con migración en caché',
    );
    const count = db.prepare('SELECT count(*) AS c FROM t WHERE t MATCH ?');
    result.accentFolding = ['decision', 'autenticacion', 'migracion', 'Decisión', 'cache'].every(
      (q) => count.get(q).c === 1,
    );
  } finally {
    db.close();
  }
} catch (e) {
  error = `${e?.code ?? e?.name ?? 'Error'}: ${e?.message ?? e}`;
}

// Let the 'warning' event (emitted on nextTick) fire before reporting.
await new Promise((r) => setImmediate(r));
result.warning = warning;
if (error) result.error = error;
console.log(JSON.stringify(result));
process.exit(result.fts5 && result.accentFolding ? 0 : 1);
