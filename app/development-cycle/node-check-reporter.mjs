// Loaded by the host Node runner, outside the test subprocesses. Test output is data,
// never a verdict. Only runner-owned assertion events can establish meaningful red.
import {inspect} from 'node:util';
const detail = value => inspect(value,{depth:2,maxArrayLength:10,maxStringLength:1000}).slice(0,2000);
export default async function* report(source) {
  let assertions = 0, infrastructure = 0, failures = 0, summary = null;
  const cases = [], files = [];
  for await (const { type, data } of source) {
    // Real test subprocess events carry entryFile. Synthetic file wrappers do not.
    // Suites are containers; skip/todo completions do not prove a required body ran.
    if (['test:pass', 'test:fail'].includes(type) && data.entryFile && data.details?.type === 'test') {
      const error=data.details?.error, cause=error?.cause || error;
      cases.push({ ...(type === 'test:fail' ? {failure:{message:String(cause?.message || error?.message || 'test failed').slice(0,4000),actual:detail(cause?.actual),expected:detail(cause?.expected),operator:String(cause?.operator || '')}} : {}), file: data.file, name: data.name, line: data.line, column: data.column,
        status: data.skip ? 'skip' : data.todo ? 'todo' : type === 'test:pass' ? 'pass' : 'fail' });
    }
    if (type === 'test:fail') {
      failures++;
      const error = data.details?.error;
      if (error?.failureType === 'testCodeFailure' && error.cause?.code === 'ERR_ASSERTION' && error.cause?.name === 'AssertionError' && error.exitCode === undefined && !data.todo && !data.skip) assertions++;
      else if (error?.failureType !== 'subtestsFailed') infrastructure++;
    }
    // Keep output in the bounded execFile capture, but never parse it as runner events.
    if (type === 'test:stdout' || type === 'test:stderr') yield JSON.stringify({ type: 'output', stream: type, message: data.message }) + '\n';
    if (type === 'test:summary' && data.file) files.push({ file: data.file, success: data.success });
    if (type === 'test:summary' && !data.file) summary = { success: data.success, counts: data.counts };
  }
  yield JSON.stringify({ type: 'result', schemaVersion: 2, assertions, infrastructure, failures, cases, files, summary }) + '\n';
}
