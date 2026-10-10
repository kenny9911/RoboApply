// server/src/features/copilot/tools/registry.ts — the Assistant's tool registry (ARCH §5.2; WP-50).
//
// Each tool is a zod schema exported to JSON Schema with `z.toJSONSchema`.
// `runToolCall` is the only way a tool runs: it parses the model's arguments,
// refuses job ids no tool returned (or that are not the job in context), runs
// the tool, and never lets one tool call another. Errors become data the
// model reads (`{ error }`), never an exception out of the turn.

import crypto from 'node:crypto';
import { z } from 'zod';
import type { LlmToolCall, LlmToolDefinition } from '../../../platform/llm/index.js';
import { logger } from '../../../services/LoggerService.js';
import type { CopilotTool, ToolContext, ToolOutput } from '../types.js';
import { addExternalJob, draftOutreach, findConnections, interviewPrep, tailorResume, writeCoverLetter } from './actions.js';
import { getCurrentFilters, proposeFilterChange, setSort } from './filters.js';
import { addedJobs, analyzeFit, companyInsights, competitiveness, getJob, publicSearchJobs, salaryContext, searchJobs, topFitJobs } from './jobs.js';
import { isNotFound, isNotImplemented } from './util.js';
import { applicationSummary, campusDeadlines, explainFeature, getProfileGaps, remember, resumeIssues, rewriteResumeSection } from './you.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTool = CopilotTool<any>;

export const SEEKER_TOOLS: readonly AnyTool[] = [
  searchJobs,
  topFitJobs,
  addedJobs,
  getCurrentFilters,
  proposeFilterChange,
  setSort,
  getJob,
  analyzeFit,
  companyInsights,
  findConnections,
  draftOutreach,
  tailorResume,
  writeCoverLetter,
  interviewPrep,
  salaryContext,
  applicationSummary,
  addExternalJob,
  remember,
  getProfileGaps,
  resumeIssues,
  rewriteResumeSection,
  campusDeadlines,
  competitiveness,
  explainFeature,
];

/** Visitor turns: page-scoped public tools only (search_jobs public, salary_context, explain_feature). */
export const PUBLIC_TOOLS: readonly AnyTool[] = [publicSearchJobs, salaryContext, explainFeature];

/** Tools available for this turn (flags, market, mode). */
export async function availableTools(scope: 'seeker' | 'public', ctx: ToolContext): Promise<AnyTool[]> {
  const list = scope === 'public' ? PUBLIC_TOOLS : SEEKER_TOOLS;
  const out: AnyTool[] = [];
  for (const t of list) {
    try {
      if (!t.available || (await t.available(ctx))) out.push(t);
    } catch (err) {
      logger.warn('COPILOT', 'tool availability check failed; tool hidden', { tool: t.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = raw;
  return rest;
}

export function toLlmTools(tools: readonly AnyTool[]): LlmToolDefinition[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: jsonSchemaOf(t.schema) }));
}

/** Tool results are truncated to about 2,000 tokens each (ARCH §5.6). */
export const TOOL_RESULT_MAX_CHARS = 8000;

/** Wrap data for the model; `</data>` inside the data cannot close the wrapper. */
export function wrapData(source: string, content: string): string {
  const safe = content.replace(/<\/?\s*data\b/gi, (m) => m.replace('<', '&lt;'));
  return `<data source="${source.replace(/[^A-Za-z0-9_:.-]/g, '_')}">\n${safe}\n</data>`;
}

export function serializeResult(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = '{"error":"unserializable_result"}';
  }
  if (text.length > TOOL_RESULT_MAX_CHARS) text = `${text.slice(0, TOOL_RESULT_MAX_CHARS)}…[truncated]`;
  return text;
}

export interface ToolRunRecord {
  id: string;
  name: string;
  args: unknown;
  resultDigest: string;
  ms: number;
  ok: boolean;
}

export interface ToolRunResult {
  output: ToolOutput;
  /** Serialized `output.data` (what the model gets, before wrapping). */
  content: string;
  record: ToolRunRecord;
}

/** Find job ids in parsed tool arguments (`jobId`). */
function argJobIds(args: unknown): string[] {
  if (!args || typeof args !== 'object') return [];
  const id = (args as { jobId?: unknown }).jobId;
  return typeof id === 'string' && id ? [id] : [];
}

export async function runToolCall(
  call: LlmToolCall,
  tools: readonly AnyTool[],
  ctx: ToolContext,
  allowedJobIds: ReadonlySet<string>,
  now: () => number = Date.now,
): Promise<ToolRunResult> {
  const started = now();
  const finish = (output: ToolOutput, ok: boolean, args: unknown): ToolRunResult => {
    const content = serializeResult(output.data);
    return {
      output,
      content,
      record: { id: call.id, name: call.name, args, resultDigest: crypto.createHash('sha256').update(content).digest('hex').slice(0, 16), ms: Math.max(0, now() - started), ok },
    };
  };
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) return finish({ data: { error: 'unknown_tool', tool: call.name } }, false, null);
  if (call.argumentsError || call.parsedArguments === undefined) return finish({ data: { error: 'invalid_arguments', detail: call.argumentsError ?? 'not JSON' } }, false, call.arguments);
  const parsed = tool.schema.safeParse(call.parsedArguments ?? {});
  if (!parsed.success) {
    return finish({ data: { error: 'invalid_arguments', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } }, false, call.parsedArguments);
  }
  for (const id of argJobIds(parsed.data)) {
    if (!allowedJobIds.has(id)) {
      return finish({ data: { error: 'unknown_job_id', jobId: id, note: 'Use a job id from a tool result (search_jobs, top_fit_jobs) or the job in context.' } }, false, parsed.data);
    }
  }
  try {
    const output = await tool.run(parsed.data, ctx);
    return finish(output, !(output.data && typeof output.data === 'object' && 'error' in (output.data as object)), parsed.data);
  } catch (err) {
    if (isNotImplemented(err)) return finish({ data: { available: false, reason: 'not_available_yet' } }, false, parsed.data);
    if (isNotFound(err)) return finish({ data: { error: 'not_found' } }, false, parsed.data);
    const code = (err as { code?: unknown } | null)?.code;
    logger.warn('COPILOT', 'tool failed', { tool: call.name, code: typeof code === 'string' ? code : undefined, error: err instanceof Error ? err.message : String(err) });
    return finish({ data: { error: typeof code === 'string' ? code : 'tool_failed' } }, false, parsed.data);
  }
}
