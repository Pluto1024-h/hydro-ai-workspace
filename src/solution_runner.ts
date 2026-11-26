/**
 * Restricted reference-program runner.
 *
 * IMPORTANT: this is the only place where AI-written code is executed. It runs
 * ONLY after an admin confirms the proposal (never while the AI drafts it),
 * serially, with hard CPU/memory/output/time limits and a scrubbed environment.
 * It computes test outputs instead of letting the model invent them.
 *
 * Large inputs (e.g. n = 10^5) cannot be sent through a tool call, so a spec
 * may carry a `generator` program; we run it to produce the real input, then
 * run the reference solution on that input to obtain the true output.
 *
 * Set HYDRO_AI_DISABLE_SOLUTION_RUN=1 to turn this off; the importer then falls
 * back to statement samples only.
 */
import { execFile, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ProblemPackage, SampleCase, ConcreteCase, TestCategory } from './problem_package';
import { CATEGORY_LABELS, normalizeOutput } from './problem_package';

export interface RunResult {
  available: boolean;       // python3 usable and execution enabled
  passedSamples: boolean;   // reference reproduced every statement sample
  cases: ConcreteCase[];    // final testdata (samples + generated)
  generated: number;        // how many specs produced a case
  warnings: string[];
  logs: string[];
  timedOut: boolean;        // hit the total budget before covering everything
}

const PER_CASE_TIMEOUT_MS = 4000;
const GENERATOR_TIMEOUT_MS = 8000;
const MAX_STDOUT_BYTES = 1024 * 1024;   // 1 MB for program output
const MAX_INPUT_BYTES = 1024 * 1024;    // 1 MB for generated input
const MAX_CASES = 30;
const TOTAL_BUDGET_MS = 45000;

function disabled(): boolean {
  return String(process.env.HYDRO_AI_DISABLE_SOLUTION_RUN || '') === '1';
}

let pythonChecked = false;
let pythonBin: string | null = null;
function findPython(): string | null {
  if (pythonChecked) return pythonBin;
  pythonChecked = true;
  for (const bin of ['python3', 'python']) {
    const r = spawnSync(bin, ['--version'], { timeout: 3000, encoding: 'utf8' });
    if (!r.error && r.status === 0) { pythonBin = bin; return bin; }
  }
  pythonBin = null;
  return null;
}

const WRAPPER = `
import sys, os
try:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (3, 4))
    resource.setrlimit(resource.RLIMIT_AS, (384*1024*1024, 384*1024*1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (4*1024*1024, 4*1024*1024))
    resource.setrlimit(resource.RLIMIT_NPROC, (32, 32))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
except Exception:
    pass
sys.setrecursionlimit(2000)
src = open(sys.argv[1], 'r', encoding='utf-8', errors='replace').read()
g = {'__name__': '__main__', '__builtins__': __builtins__}
exec(compile(src, 'solution.py', 'exec'), g)
`;

interface RunOpts { timeoutMs?: number; maxBuffer?: number; }

/** Run one program (solution or generator) with a given stdin, return stdout. */
function runOnce(
  python: string, dir: string, codeFile: string, wrapperFile: string,
  input: string, opts: RunOpts = {},
): Promise<{ out?: string; error?: string; timeout?: boolean }> {
  const timeoutMs = opts.timeoutMs || PER_CASE_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer || MAX_STDOUT_BYTES;
  return new Promise((resolve) => {
    const child = execFile(python, ['-I', '-S', wrapperFile, codeFile], {
      cwd: dir,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' },
    }, (error: any, stdout: string, stderr: string) => {
      if (error) {
        const killed = error.killed || error.code === 'SIGKILL';
        const tooBig = String(error.message).includes('maxBuffer');
        resolve({
          error: tooBig ? '输出超过大小上限' : killed ? '超时' : String(stderr || error.message).slice(0, 200),
          timeout: killed,
        });
        return;
      }
      // Normalise CRLF so generated .in files are identical on Windows/Linux.
      resolve({ out: String(stdout).replace(/\r\n/g, '\n').slice(0, maxBuffer) });
    });
    try { child.stdin?.end(input ?? ''); } catch { /* ignore */ }
  });
}

/**
 * Validate the reference program against statement samples, then produce one
 * case per categorised spec. If validation fails we keep ONLY the statement's
 * own samples and warn.
 */
export async function buildCases(pkg: ProblemPackage): Promise<RunResult> {
  const warnings: string[] = [];
  const logs: string[] = [];
  const startedAt = Date.now();

  const sampleCases: SampleCase[] = pkg.samples
    .filter((s) => s.input.trim() || s.output.trim())
    .slice(0, 10);
  const sampleConcrete: ConcreteCase[] = sampleCases.map((s) => ({
    input: s.input, output: s.output,
    category: 'sample' as const, categoryLabel: '样例', purpose: '题面样例（校验基准）',
  }));

  const fallback = (reason: string): RunResult => ({
    available: false, passedSamples: false,
    cases: sampleConcrete, generated: 0,
    warnings: [reason, ...sampleCases.length ? [] : ['题面没有任何样例，入库后题目没有测试点']],
    logs, timedOut: false,
  });

  if (disabled()) return fallback('参考程序执行已被环境变量 HYDRO_AI_DISABLE_SOLUTION_RUN 禁用，仅保留题面样例');
  if (pkg.referenceLang !== 'python') return fallback('参考程序非 Python，暂不执行，仅保留题面样例');
  if (!pkg.referenceCode.trim()) return fallback('未提供参考程序，仅保留题面样例');
  if (!sampleCases.length) return fallback('没有题面样例可用于校验参考程序，拒绝生成自动测试点，仅保留题面样例');

  const python = findPython();
  if (!python) return fallback('服务器未找到 python3，仅保留题面样例');

  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'aiws-sol-'));
    const codeFile = join(dir, 'solution.py');
    const wrapperFile = join(dir, '_runner.py');
    writeFileSync(codeFile, pkg.referenceCode, 'utf8');
    writeFileSync(wrapperFile, WRAPPER, 'utf8');

    // Step 1: self-check against statement samples (ground truth).
    for (let i = 0; i < sampleCases.length; i++) {
      const s = sampleCases[i];
      const r = await runOnce(python, dir, codeFile, wrapperFile, s.input);
      if (r.error) {
        logs.push(`样例${i + 1}运行失败：${r.error}`);
        return {
          ...fallback(`参考程序在第 ${i + 1} 个样例上运行失败（${r.error}），已拒绝生成自动测试点`),
          available: true, logs,
        };
      }
      const ok = normalizeOutput(r.out || '') === normalizeOutput(s.output);
      logs.push(`样例${i + 1}：${ok ? '通过' : '输出与题面样例不一致'}`);
      if (!ok) {
        return {
          available: true, passedSamples: false, cases: sampleConcrete, generated: 0, logs, timedOut: false,
          warnings: [`参考程序输出与题面样例第 ${i + 1} 组不一致，说明 AI 题解可能有误，已拒绝生成自动测试点，仅保留题面样例。请人工核对后再补数据。`],
        };
      }
    }

    // Step 2: materialise one case per spec (generator for large inputs).
    const cases: ConcreteCase[] = [...sampleConcrete];
    let generated = 0;
    let timedOut = false;
    const budgetLeft = () => TOTAL_BUDGET_MS - (Date.now() - startedAt);

    for (let i = 0; i < pkg.testData.length; i++) {
      const spec = pkg.testData[i];
      const label = `${CATEGORY_LABELS[spec.category]}#${i + 1}`;
      if (cases.length >= MAX_CASES) { warnings.push(`已达到 ${MAX_CASES} 个测试点上限，其余测试数据未生成`); break; }
      if (budgetLeft() < PER_CASE_TIMEOUT_MS) { timedOut = true; warnings.push('生成测试数据超过总时间预算，剩余部分未生成'); break; }

      let input = String(spec.input ?? '');
      if (spec.generator && spec.generator.trim()) {
        const genFile = join(dir, `gen_${i}.py`);
        writeFileSync(genFile, spec.generator, 'utf8');
        const g = await runOnce(python, dir, genFile, wrapperFile, '', {
          timeoutMs: GENERATOR_TIMEOUT_MS, maxBuffer: MAX_INPUT_BYTES,
        });
        if (g.error) {
          warnings.push(`${label} 生成器运行失败（${g.error}），已跳过`);
          logs.push(`生成器 ${label} 失败：${g.error}`);
          continue;
        }
        input = String(g.out || '');
      }
      if (!input.trim()) { warnings.push(`${label} 输入为空，已跳过`); continue; }
      if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
        warnings.push(`${label} 输入超过 1MB，已跳过（可减小数据规模）`);
        continue;
      }

      const r = await runOnce(python, dir, codeFile, wrapperFile, input);
      if (r.error) {
        warnings.push(`${label} 参考程序运行失败（${r.error}），该数据未写入——题解可能未覆盖此情况`);
        logs.push(`${label} 失败：${r.error}`);
        continue;
      }
      cases.push({
        input, output: normalizeOutput(r.out || ''),
        category: spec.category as TestCategory,
        categoryLabel: CATEGORY_LABELS[spec.category],
        purpose: spec.purpose || '未说明用途',
      });
      generated++;
    }

    if (!generated) warnings.push('所有测试数据均未成功生成，仅保留题面样例');
    if (cases.length < 8) warnings.push(`最终只有 ${cases.length} 个测试点，建议再补充边界/极限/易错数据`);
    return {
      available: true, passedSamples: true, cases, generated, warnings, logs, timedOut,
    };
  } catch (e: any) {
    return { ...fallback(`执行环境异常：${String(e?.message || e).slice(0, 200)}`), available: true };
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}
