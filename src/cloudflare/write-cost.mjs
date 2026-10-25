const measuredRows = value => Number.isSafeInteger(value) && value >= 0;

/** Keep the existing atomic batch and its statement order. Group ranges only
 * attribute D1's returned measurements; they never issue additional queries. */
export function createWriteBatch() {
  const commands = [];
  const groups = [];
  function append(name, statements) {
    groups.push({ name, from: commands.length, to: commands.length + statements.length });
    commands.push(...statements);
  }
  function measure(results) {
    const rowsWrittenByGroup = Object.fromEntries(groups.map(({ name }) => [name, 0]));
    if (!Array.isArray(results) || results.length !== commands.length) {
      for (const name of Object.keys(rowsWrittenByGroup)) rowsWrittenByGroup[name] = null;
      return { totalRowsWritten: null, rowsWrittenByGroup };
    }
    for (const { name, from, to } of groups) {
      for (let index = from; index < to; index++) {
        const rows = results[index]?.meta?.rows_written;
        const sum = rowsWrittenByGroup[name] + rows;
        if (rowsWrittenByGroup[name] === null || !measuredRows(rows) || !measuredRows(sum)) {
          rowsWrittenByGroup[name] = null;
          break;
        }
        rowsWrittenByGroup[name] = sum;
      }
    }
    const values = Object.values(rowsWrittenByGroup);
    const total = values.reduce((sum, value) => sum + value, 0);
    return { totalRowsWritten: values.every(measuredRows) && measuredRows(total) ? total : null, rowsWrittenByGroup };
  }
  return { commands, append, measure };
}
