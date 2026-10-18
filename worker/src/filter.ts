/**
 * The filter of the scheduled translation: a CEL expression (https://github.com/google/cel-spec) over one pull request,
 * evaluated with `@marcbachmann/cel-js`. CEL has no side effects, loops or I/O. The expression is compiled and type
 * checked once, when a run reads its configuration; one that does not parse, does not type check or is not a `bool`
 * stops the run before anything is searched. An evaluation that fails or answers anything but `true` translates nothing.
 *
 * The filter only narrows: it runs after the author check and PRIV-1 (`scheduled.ts`), never instead of them.
 */
import { Environment } from "@marcbachmann/cel-js";

export type FilterInput = {
  readonly repo: {
    readonly owner: string;
    readonly name: string;
    readonly full_name: string;
    readonly private: boolean;
  };
  readonly pr: {
    readonly number: number;
    readonly title: string;
    readonly draft: boolean;
    /** Label names. */
    readonly labels: readonly string[];
    /** The base branch. */
    readonly base: string;
    /** Milliseconds since the Unix epoch. */
    readonly updated_at: number;
  };
};

/** `true` when the pull request may be translated. */
export type Filter = (input: FilterInput) => FilterResult;
export type FilterResult =
  | { readonly ok: true; readonly pass: boolean }
  | { readonly ok: false; readonly code: "evaluation-failed" };

export type CompileResult =
  | { readonly ok: true; readonly filter: Filter }
  | { readonly ok: false; readonly code: "invalid-filter" };

/**
 * Bounds on the expression's size, checked when it is parsed. They do not bound the CPU an evaluation takes: `matches()`
 * runs a JavaScript regular expression. The filter is the owner's own setting, so no evaluation budget is set.
 */
const LIMITS = { maxAstNodes: 500, maxDepth: 32, maxListElements: 100, maxMapEntries: 100, maxCallArguments: 8 };

function environment(): Environment {
  return new Environment({ limits: LIMITS })
    .registerVariable({
      name: "repo",
      schema: { owner: "string", name: "string", full_name: "string", private: "bool" },
    })
    .registerVariable({
      name: "pr",
      schema: {
        number: "int",
        title: "string",
        draft: "bool",
        labels: "list<string>",
        base: "string",
        // A `timestamp` value at run time. Declared `dyn` because cel-js 8.0.0 cannot declare a `timestamp` field in a
        // schema (registering it throws); comparisons with `timestamp(...)` still dispatch on the value.
        updated_at: "dyn",
      },
    });
}

/** Compiles `expression`; an empty or blank one passes every pull request. */
export function compileFilter(expression: string): CompileResult {
  if (expression.trim() === "") return { ok: true, filter: () => ({ ok: true, pass: true }) };
  const env = environment();
  let program: ReturnType<Environment["parse"]>;
  try {
    program = env.parse(expression);
  } catch {
    return { ok: false, code: "invalid-filter" };
  }
  const checked = program.check();
  if (!checked.valid || checked.type !== "bool") return { ok: false, code: "invalid-filter" };
  return {
    ok: true,
    filter: ({ repo, pr }) => {
      try {
        const result: unknown = program({
          repo: { ...repo },
          pr: { ...pr, number: BigInt(pr.number), labels: [...pr.labels], updated_at: new Date(pr.updated_at) },
        });
        return { ok: true, pass: result === true };
      } catch {
        return { ok: false, code: "evaluation-failed" };
      }
    },
  };
}
