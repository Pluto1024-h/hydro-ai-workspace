/**
 * Standard problem package: the shape produced by `add_problem_draft` and
 * consumed when an admin confirms the proposal.
 *
 * Design rule: AI may WRITE (statement, reference program, test inputs and
 * generators) but must never INVENT answer outputs. Outputs are computed by
 * actually running the reference program in a restricted subprocess (see
 * solution_runner.ts), and the program must first reproduce every statement
 * sample. If it cannot, we only keep the statement's own samples and warn.
 *
 * Test data quality: every spec carries a category (boundary / extreme /
 * tricky / normal / special) plus a concrete purpose, so coverage can be
 * checked mechanically instead of trusting the model's word. Large "extreme"
 * inputs are produced by an AI-written generator script because a 10^5-element
 * input cannot be emitted through a tool call.
 */
export interface SampleCase {
  input: string;
  output: string;
}

export type TestCategory = 'boundary' | 'extreme' | 'tricky' | 'normal' | 'special';
export const CATEGORY_LABELS: Record<TestCategory, string> = {
  boundary: '边界', extreme: '极限', tricky: '易错', normal: '普通', special: '特殊',
};
const REQUIRED_CATEGORIES: TestCategory[] = ['boundary', 'extreme', 'tricky', 'normal', 'special'];

export interface TestDataSpec {
  category: TestCategory;
  purpose: string;
  input?: string;       // small hand-written input
  generator?: string;   // Python3 program that prints the input to stdout
}

/** Where the confirmed package should land. */
export interface DraftTarget {
  mode: 'new' | 'existing';
  pid: string;                  // pid or numeric docId when mode === 'existing'
}

export interface ProblemPackage {
  title: string;
  content: string;              // markdown statement
  constraints: string;          // data range stated in the problem
  tags: string[];
  timeLimit: string;            // e.g. '1s', '1000ms'
  memoryLimit: string;          // e.g. '256m'
  score: number;                // full score, split across cases
  judgeType: string;            // 'default' (standard IO) only, for now
  referenceLang: string;        // 'python' (only supported runner for now)
  referenceCode: string;        // reference solution, NOT executed by the AI
  samples: SampleCase[];        // from the statement; used as ground truth
  testData: TestDataSpec[];     // categorised inputs; outputs computed by runner
  source: string;
  notes: string;
  target?: DraftTarget;         // default: create a new problem
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  pkg: ProblemPackage;
}

const TIME_RE = /^\d{1,6}(\.\d{1,3})?(ms|s)$/;
const MEM_RE = /^\d{1,6}(k|m|g|kb|mb|gb)$/i;
const JUDGE_TYPES = ['default'];
const MAX_SAMPLES = 10;
const MAX_SPECS = 30;
const MIN_SPECS = 6;

function clean(s: any): string {
  return String(s ?? '').replace(/\r\n/g, '\n').trim();
}

function normalizeCaseList(raw: any): SampleCase[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_SAMPLES).map((c: any) => ({
    input: clean(c?.input).slice(0, 4000),
    output: clean(c?.output).slice(0, 4000),
  })).filter((c: SampleCase) => c.input || c.output);
}

function normalizeSpecs(raw: any, warnings: string[]): TestDataSpec[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: TestDataSpec[] = [];
  for (const item of list.slice(0, MAX_SPECS)) {
    const rawCat = clean(item?.category).toLowerCase();
    const category = (REQUIRED_CATEGORIES.includes(rawCat as TestCategory) ? rawCat : 'normal') as TestCategory;
    const input = String(item?.input ?? '').replace(/\r\n/g, '\n').slice(0, 4000);
    const generator = String(item?.generator ?? '').replace(/\r\n/g, '\n').slice(0, 4000);
    const purpose = clean(item?.purpose).slice(0, 200);
    if (!input.trim() && !generator.trim()) continue;
    if (generator && input.trim()) warnings.push('同一测试项同时给了 input 和 generator，将以 generator 为准');
    out.push({ category, purpose, input: input || undefined, generator: generator || undefined });
  }
  return out;
}

/** Strict, defensive validation. Never trust model-generated JSON. */
export function validatePackage(raw: any): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const title = clean(raw?.title).slice(0, 120);
  const content = clean(raw?.content).slice(0, 20000);
  const constraints = clean(raw?.constraints).slice(0, 1000);
  const tags = Array.from(new Set(
    (Array.isArray(raw?.tags) ? raw.tags : [])
      .map((t: any) => clean(t).slice(0, 40))
      .filter(Boolean),
  )).slice(0, 12) as string[];
  const timeLimit = clean(raw?.timeLimit) || '1s';
  const memoryLimit = clean(raw?.memoryLimit) || '256m';
  const score = Number(raw?.score) || 100;
  const judgeType = clean(raw?.judgeType) || 'default';
  const referenceLang = clean(raw?.referenceLang).toLowerCase() || 'python';
  const referenceCode = String(raw?.referenceCode ?? '').replace(/\r\n/g, '\n').slice(0, 8000);
  const samples = normalizeCaseList(raw?.samples);
  // Backward compatibility: older drafts used a flat testInputs array.
  let specsRaw = raw?.testData;
  if (!Array.isArray(specsRaw) && Array.isArray(raw?.testInputs)) {
    specsRaw = raw.testInputs.map((input: any) => ({ category: 'normal', purpose: 'AI 提供的测试输入', input }));
  }
  const testData = normalizeSpecs(specsRaw, warnings);
  const source = clean(raw?.source).slice(0, 500);
  const notes = clean(raw?.notes).slice(0, 500);
  // Preserve the target through re-validation (executor validates again).
  const rawTarget = raw?.target;
  const target: DraftTarget | undefined = rawTarget && typeof rawTarget === 'object'
    ? {
      mode: rawTarget.mode === 'existing' ? 'existing' : 'new',
      pid: String(rawTarget.pid ?? '').trim().slice(0, 60),
    }
    : undefined;

  if (!title) errors.push('题目标题不能为空');
  if (content.length < 20) errors.push('题面内容过短（至少 20 字），拒绝入库以免产生空题');
  if (!TIME_RE.test(timeLimit)) errors.push(`时限格式不合法：${timeLimit}（应为 1s / 1000ms）`);
  if (!MEM_RE.test(memoryLimit)) errors.push(`内存格式不合法：${memoryLimit}（应为 256m / 512m）`);
  if (!Number.isInteger(score) || score < 1 || score > 1000) errors.push('满分必须是 1–1000 的整数');
  if (!JUDGE_TYPES.includes(judgeType)) errors.push(`暂不支持测评方式 ${judgeType}，当前仅支持 default（标准 IO）`);
  if (referenceLang !== 'python') warnings.push(`参考程序语言 ${referenceLang} 暂不支持本地执行，将仅保留题面样例`);
  if (!referenceCode.trim()) warnings.push('未提供参考程序：将只入库题面样例，无法生成额外测试点');

  // Category coverage is enforced: the whole point is systematic edge coverage.
  const counts: Record<string, number> = {};
  for (const spec of testData) counts[spec.category] = (counts[spec.category] || 0) + 1;
  const missing = REQUIRED_CATEGORIES.filter((c) => !counts[c]);
  if (missing.length) {
    errors.push(`测试数据缺少类别：${missing.map((c) => `${CATEGORY_LABELS[c]}(${c})`).join('、')}。`
      + `请用 testData 为每类至少提供 1 个，category 可选 ${REQUIRED_CATEGORIES.join('/')}`);
  }
  if (testData.length < MIN_SPECS) {
    errors.push(`测试数据只有 ${testData.length} 个，至少需要 ${MIN_SPECS} 个，且要覆盖普通与特殊情况`);
  }
  if (!constraints) warnings.push('未填写 constraints（题面数据范围），无法据此核对数据是否越界，建议补上');
  if (samples.length) {
    const over = samples.filter((s) => !s.input.trim() && !s.output.trim());
    if (over.length) errors.push('存在空的样例，请检查');
  } else {
    warnings.push('未提供题面样例，无法校验参考程序正确性');
  }

  const pkg: ProblemPackage = {
    title, content, constraints, tags, timeLimit, memoryLimit, score, judgeType,
    referenceLang, referenceCode, samples, testData, source, notes, target,
  };
  if (!tags.length) warnings.push('未提供标签');
  return { ok: errors.length === 0, errors, warnings, pkg };
}

/** Compare program stdout to expected output, ignoring trailing whitespace. */
export function normalizeOutput(s: string): string {
  return String(s ?? '').replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
}

export interface TestdataFile {
  name: string;
  content: string;
}

export interface ConcreteCase {
  input: string;
  output: string;
  category: TestCategory | 'sample';
  categoryLabel: string;
  purpose: string;
}

/**
 * Build the complete testdata file set.
 * `cases` are already-resolved inputs with computed outputs.
 */
export function buildTestdataFiles(pkg: ProblemPackage, cases: ConcreteCase[]): TestdataFile[] {
  const files: TestdataFile[] = [];
  cases.forEach((c, i) => {
    files.push({ name: `${i + 1}.in`, content: c.input.replace(/\n?$/, '\n') });
    files.push({ name: `${i + 1}.out`, content: normalizeOutput(c.output) + '\n' });
  });
  files.push({ name: 'config.yaml', content: buildConfigYaml(pkg, cases.length) });
  return files;
}

/** Standard Hydro config.yaml for standard-IO problems. */
export function buildConfigYaml(pkg: ProblemPackage, caseCount: number): string {
  const lines = [
    'type: default',
    `time: ${pkg.timeLimit}`,
    `memory: ${pkg.memoryLimit}`,
  ];
  if (caseCount > 0) {
    lines.push('cases:');
    const base = Math.floor(pkg.score / caseCount);
    const rest = pkg.score - base * caseCount;
    for (let i = 1; i <= caseCount; i++) {
      const s = base + (i === caseCount ? rest : 0);
      lines.push(`  - input: ${i}.in`);
      lines.push(`    output: ${i}.out`);
      lines.push(`    score: ${s}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Coverage summary, e.g. 边界2/极限2/易错3/普通2/特殊2. */
export function coverageText(specs: TestDataSpec[]): string {
  const counts: Record<string, number> = {};
  for (const s of specs) counts[s.category] = (counts[s.category] || 0) + 1;
  return REQUIRED_CATEGORIES
    .filter((c) => counts[c])
    .map((c) => `${CATEGORY_LABELS[c]}${counts[c]}`)
    .join(' / ') || '无';
}

/** Short human-readable summary for the proposal list/detail page. */
export function packageBrief(pkg: ProblemPackage): string {
  return `${pkg.title}｜${pkg.tags.join('、') || '无标签'}｜${pkg.timeLimit}/${pkg.memoryLimit}`
    + `｜满分${pkg.score}｜样例${pkg.samples.length}组｜测试数据${pkg.testData.length}个（${coverageText(pkg.testData)}）`;
}
