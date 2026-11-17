// Keep schema creation atomic, including when a module is used inside another
// transaction. Autocommitting each CREATE TABLE adds a durable disk flush per
// table on a fresh install, blocking the server's event loop before readiness.
export function applySchema(db, sql) {
  db.exec('savepoint agentglim_schema');
  try {
    db.exec(sql);
    db.exec('release agentglim_schema');
  } catch (error) {
    db.exec('rollback to agentglim_schema; release agentglim_schema');
    throw error;
  }
}
