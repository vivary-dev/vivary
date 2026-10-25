/**
 * Runs Vivary's Linux CI jobs from .github/workflows/ci.yml inside Dagger.
 *
 * The workflow stays the only owner of each check. This module reads a job's
 * steps and runs them in order, so a step added to ci.yml runs here unchanged.
 * Runtimes come from the same pinned bootstrap scripts the GitHub jobs run.
 * The Windows jobs stay on GitHub Actions.
 */
import { argument, check, Container, dag, Directory, func, object } from "@dagger.io/dagger"
import { parse } from "yaml"

const WORKFLOW = ".github/workflows/ci.yml"
// The setup-python stand-in: CPython 3.12.15 with curl, git and xz, which the
// bootstrap scripts call. The job's own provisioning step then installs and
// admits the qualified runtime, exactly as on GitHub.
const SEED_IMAGE =
  "python:3.12.15-bookworm@sha256:14a4933e6cef421424f7a66d89a3f4eafcbd0d90e0a822251f298e05132dc735"
const SEED_PYTHON = "3.12.15"
// Mirror the GitHub runner layout and its non-root user, so tests that depend
// on file permissions behave as they do there.
const USER = "runner"
const HOME = "/home/runner"
const WORKSPACE = `${HOME}/work/vivary`
const RUNNER_TEMP = `${HOME}/work/_temp`
const TOOL_ROOT = `${RUNNER_TEMP}/vivary-build-tools`
// Only download and compiler caches persist between runs. Every archive and Go
// module is rehashed against its pin on reuse, and the tool trees built from
// them are rebuilt in a fresh layer each run.
const CACHES: [string, string][] = [
  [`${TOOL_ROOT}/archives`, "vivary-build-tool-archives"],
  [`${TOOL_ROOT}/go-cache`, "vivary-go-build"],
  [`${TOOL_ROOT}/go-path`, "vivary-go-modules"],
  [`${TOOL_ROOT}/npm-cache`, "vivary-npm"],
  [`${HOME}/.local/share/pnpm/store`, "vivary-pnpm-store"],
  [`${HOME}/.cache/pip`, "vivary-pip"],
  [`${HOME}/.cache/uv`, "vivary-uv"],
]
// `changes` detects site paths and validates GitHub dispatches with the GitHub
// API. Here every job runs, so it has nothing to decide.
const GITHUB_ONLY_JOBS = new Set(["changes"])
const STEP_KEYS = new Set(["name", "id", "if", "run", "shell", "env", "working-directory", "uses", "with", "timeout-minutes"])

type Value = string | boolean
type Step = Record<string, unknown>
type Job = { "runs-on"?: string; steps?: Step[]; env?: Record<string, string>; strategy?: { matrix?: Record<string, unknown> } }
type Workflow = { env?: Record<string, string>; jobs: Record<string, Job> }
// One entry of the plan runner.py executes.
type PlanStep = { label: string; script: string; run: string; argv: string[]; env: Record<string, string>; cwd: string }

@object()
export class VivaryCi {
  source: Directory
  base: string
  head: string

  constructor(
    /** Repository checkout with its .git directory, so the design and diff checks can read history. */
    @argument({ defaultPath: "/", ignore: ["**/node_modules", ".dagger/sdk", "site/dist", "**/__pycache__"] })
    source: Directory,
    /** Commit the change is compared against. Defaults to the merge base with origin/dev. */
    base = "",
    /** Commit under test. Defaults to HEAD. */
    head = "",
  ) {
    this.source = source
    this.base = base
    this.head = head
  }

  /** The `tests + checks` job. */
  @func()
  @check()
  async test(): Promise<string> {
    return this.job("test")
  }

  /** The `workbench tests` job. */
  @func()
  @check()
  async workbench(): Promise<string> {
    return this.job("workbench")
  }

  /** The `maintained workbench checks` job. */
  @func()
  @check()
  async workbenchMaintained(): Promise<string> {
    return this.job("workbench-maintained")
  }

  /** The `graph review gate` job. */
  @func()
  @check()
  async review(): Promise<string> {
    return this.job("review")
  }

  /** The `site build` job. */
  @func()
  @check()
  async site(): Promise<string> {
    return this.job("site")
  }

  /** The Ubuntu leg of the `orientation proof` matrix. */
  @func()
  @check()
  async orientationProof(): Promise<string> {
    return this.job("orientation-proof")
  }

  /** Fails when ci.yml gains a Linux job that has no check above. */
  @func()
  @check()
  async coverage(): Promise<string> {
    const covered = ["test", "workbench", "workbench-maintained", "review", "site", "orientation-proof"]
    const linux = Object.entries((await this.workflow()).jobs)
      .filter(([id, job]) => !GITHUB_ONLY_JOBS.has(id) && linuxRunner(job))
      .map(([id]) => id)
    const missing = linux.filter((id) => !covered.includes(id))
    const stale = covered.filter((id) => !linux.includes(id))
    if (missing.length || stale.length) {
      throw new Error(`Linux jobs without a Dagger check: [${missing}]. Checks without a Linux job: [${stale}].`)
    }
    return `All ${linux.length} Linux jobs in ${WORKFLOW} have a Dagger check.`
  }

  /** Run any Linux job from ci.yml by its job id, such as `workbench`. */
  @func()
  async job(name: string): Promise<string> {
    const workflow = await this.workflow()
    const job = workflow.jobs[name]
    if (!job || GITHUB_ONLY_JOBS.has(name) || !linuxRunner(job)) {
      throw new Error(`${name} is not a Linux job this module runs`)
    }
    const { base, head } = await this.revisions()
    const context: Record<string, Value> = {
      "runner.os": "Linux",
      "runner.temp": RUNNER_TEMP,
      "matrix.os": "ubuntu-latest",
      "github.event_name": "workflow_dispatch",
      "inputs.base_sha": base,
      "inputs.head_sha": head,
      "github.event.pull_request.base.sha": "",
      "github.event.pull_request.head.sha": "",
      "github.event.before": "",
      "github.sha": head,
      "needs.changes.result": "success",
      "needs.changes.outputs.site": "true",
      // The admission step guards the Node that runs GitHub's JavaScript
      // actions. Dagger runs none, so the steps gated on it run here.
      "steps.runner_action_node.outcome": "success",
    }
    const env = Object.fromEntries(Object.entries({ ...workflow.env, ...job.env }).map(([k, v]) => [k, interpolate(String(v), context)]))
    const steps: PlanStep[] = []
    const log: string[] = []
    let ctr = await this.runner()

    for (const [index, step] of (job.steps ?? []).entries()) {
      const label = String(step.name ?? step.uses ?? step.run ?? `step ${index}`).split("\n")[0]
      for (const key of Object.keys(step)) {
        if (!STEP_KEYS.has(key)) throw new Error(`${name}: step "${label}" uses unsupported key ${key}`)
      }
      if (step.id === "runner_action_node") {
        log.push(`skip  ${label} (GitHub runner admission, no JavaScript action runs here)`)
        continue
      }
      if (step.if !== undefined && !truthy(evaluate(unwrap(String(step.if)), context))) {
        log.push(`skip  ${label} (if: ${step.if})`)
        continue
      }
      if (typeof step.uses === "string") {
        const action = step.uses.split("@")[0]
        const inputs = (step.with ?? {}) as Record<string, string>
        if (action === "actions/checkout") {
          log.push(`done  ${label} (source mounted at ${WORKSPACE})`)
        } else if (action === "actions/setup-python") {
          if (inputs["python-version"] !== SEED_PYTHON) throw new Error(`${name}: seed image has Python ${SEED_PYTHON}, step wants ${inputs["python-version"]}`)
          log.push(`done  ${label} (seed image CPython ${SEED_PYTHON})`)
        } else if (action === "actions/setup-node") {
          const node = await this.nodePin()
          if (inputs["node-version"] !== node.version) throw new Error(`${name}: bootstrap pins Node ${node.version}, step wants ${inputs["node-version"]}`)
          const directory = `${HOME}/work/_tool/node/${node.version}/x64`
          const archive = `${RUNNER_TEMP}/node-v${node.version}-linux-x64.tar.xz`
          ctr = ctr.withFile(archive, dag.http(`https://nodejs.org/dist/v${node.version}/node-v${node.version}-linux-x64.tar.xz`), { owner: USER })
          steps.push(planStep(index, label, undefined,
            `echo "${node.sha256}  ${archive}" | sha256sum -c -\nmkdir -p ${directory}\ntar -xJf ${archive} -C ${directory} --strip-components=1\nrm ${archive}\necho ${directory}/bin >> "$GITHUB_PATH"\n`,
            {}, WORKSPACE))
          log.push(`ran   ${label} (Node ${node.version}, SHA256 from scripts/bootstrap_build_tools.py)`)
        } else if (action === "actions/upload-artifact") {
          log.push(`skip  ${label} (artifact upload is GitHub-only)`)
        } else {
          throw new Error(`${name}: step "${label}" uses unsupported action ${step.uses}`)
        }
        continue
      }
      if (typeof step.run !== "string") throw new Error(`${name}: step "${label}" has neither run nor uses`)

      const stepEnv = Object.fromEntries(Object.entries((step.env ?? {}) as Record<string, string>).map(([k, v]) => [k, interpolate(String(v), context)]))
      const cwd = step["working-directory"] ? `${WORKSPACE}/${step["working-directory"]}` : WORKSPACE
      steps.push(planStep(index, label, step.shell as string | undefined, interpolate(step.run, context), stepEnv, cwd))
      log.push(`ran   ${label}`)
    }
    // One process runs every step, so the engine commits the filesystem once
    // per job instead of once per step. runner.py applies GITHUB_PATH and
    // GITHUB_ENV between steps and prints a ::step line for each.
    const plan = `${RUNNER_TEMP}/plan.json`
    await ctr
      .withFile(`${RUNNER_TEMP}/runner.py`, this.source.file(".dagger/runner.py"), { owner: USER })
      .withNewFile(plan, JSON.stringify({ env, path: [], temp: RUNNER_TEMP, steps }), { owner: USER })
      .withExec(["/usr/local/bin/python3", "-I", "-B", `${RUNNER_TEMP}/runner.py`, plan])
      .sync()
    return [`${name}: passed at ${head}`, ...log].join("\n")
  }

  private async workflow(): Promise<Workflow> {
    return parse(await this.source.file(WORKFLOW).contents()) as Workflow
  }

  /** Read the Node pin from the bootstrap script, so setup-node and the build tools share one source. */
  private async nodePin(): Promise<{ version: string; sha256: string }> {
    const text = await this.source.file("scripts/bootstrap_build_tools.py").contents()
    const version = text.match(/^NODE = "(\d+\.\d+\.\d+)"$/m)?.[1]
    const sha256 = text.match(/^NODE_SHA = "([0-9a-f]{64})"$/m)?.[1]
    if (!version || !sha256) throw new Error("scripts/bootstrap_build_tools.py has no NODE and NODE_SHA pins")
    return { version, sha256 }
  }

  /** The runner user and its directories, with the checkout and caches mounted. */
  private async runner(): Promise<Container> {
    let ctr = dag
      .container()
      .from(SEED_IMAGE)
      .withExec(["sh", "-c", `useradd --create-home --uid 1001 ${USER} && mkdir -p ${HOME}/work ${RUNNER_TEMP} ${TOOL_ROOT} ${HOME}/.local/share/pnpm ${HOME}/.cache && chown -R ${USER}:${USER} ${HOME}`])
      .withUser(USER)
      .withEnvVariable("HOME", HOME)
      .withEnvVariable("CI", "true")
      .withEnvVariable("RUNNER_OS", "Linux")
      .withEnvVariable("RUNNER_ARCH", "X64")
      .withEnvVariable("RUNNER_TEMP", RUNNER_TEMP)
      .withEnvVariable("GITHUB_WORKSPACE", WORKSPACE)
    for (const [mount, volume] of CACHES) {
      ctr = ctr.withMountedCache(mount, dag.cacheVolume(volume), { owner: USER })
    }
    return ctr.withDirectory(WORKSPACE, this.source, { owner: USER }).withWorkdir(WORKSPACE)
  }

  private async revisions(): Promise<{ base: string; head: string }> {
    // A linked worktree's .git is a file naming a directory on the host, which
    // the container cannot see.
    if ((await this.source.entries()).includes(".git") && !(await this.source.directory(".git").entries().catch(() => null))) {
      throw new Error("the source's .git is a file, as in a git worktree. Run from a plain clone, or pass --source=<clone>")
    }
    // On dev itself the merge base is HEAD, so compare with the first parent,
    // the commit a push of one merge moves dev from.
    const git = (await this.runner()).withExec([
      "sh", "-c",
      'head=$(git rev-parse HEAD); echo "$head"; dev=$(git rev-parse --verify --quiet refs/remotes/origin/dev || git rev-parse --verify --quiet dev) || exit 0; ' +
        'base=$(git merge-base "$head" "$dev") || exit 0; if [ "$base" = "$head" ]; then git rev-parse --verify --quiet "$head^1" || true; else echo "$base"; fi',
    ])
    const [head, mergeBase] = (await git.stdout()).trim().split("\n")
    const base = this.base || mergeBase
    if (!base) throw new Error("no origin/dev or dev ref to compare with, so pass --base <commit>")
    return { base, head: this.head || head }
  }
}

function linuxRunner(job: Job): boolean {
  const runsOn = job["runs-on"]
  if (runsOn === "ubuntu-latest") return true
  const os = job.strategy?.matrix?.os
  return runsOn === "${{ matrix.os }}" && Array.isArray(os) && os.includes("ubuntu-latest")
}

/** GitHub's Linux shells: bash -e by default, the stricter bash for `shell: bash`. */
function shell(name: string | undefined, script: string): string[] {
  if (name === undefined) return ["bash", "-e", script]
  if (name === "bash") return ["bash", "--noprofile", "--norc", "-eo", "pipefail", script]
  if (name === "python -I -B {0}") return ["python", "-I", "-B", script]
  throw new Error(`unsupported shell: ${name}`)
}

function planStep(index: number, label: string, shellName: string | undefined, run: string, env: Record<string, string>, cwd: string): PlanStep {
  const script = `${RUNNER_TEMP}/steps/${index}.${shellName === "python -I -B {0}" ? "py" : "sh"}`
  return { label, script, run, argv: shell(shellName, script), env, cwd }
}

function unwrap(expression: string): string {
  const match = expression.trim().match(/^\$\{\{([\s\S]*)\}\}$/)
  return match ? match[1] : expression
}

function interpolate(text: string, context: Record<string, Value>): string {
  return text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) => {
    const value = evaluate(expression, context)
    return value === false ? "false" : value === true ? "true" : value
  })
}

function truthy(value: Value): boolean {
  return value !== false && value !== ""
}

/**
 * The expression subset ci.yml uses: context paths, single-quoted strings,
 * always() and cancelled(), !, ==, !=, && and ||. Anything else fails loudly,
 * so a new construct in ci.yml cannot run here with a guessed meaning.
 */
function evaluate(expression: string, context: Record<string, Value>): Value {
  const tokens = expression.match(/\|\||&&|==|!=|!|\(|\)|'(?:[^']|'')*'|[A-Za-z_][\w.-]*(?:\(\))?|\S/g) ?? []
  let position = 0
  const peek = () => tokens[position]
  const take = (expected?: string) => {
    const token = tokens[position++]
    if (expected !== undefined && token !== expected) throw new Error(`expected ${expected} in ${expression}`)
    return token
  }
  const primary = (): Value => {
    const token = take()
    if (token === "(") {
      const value = or()
      take(")")
      return value
    }
    if (token?.startsWith("'")) return token.slice(1, -1).replace(/''/g, "'")
    if (token === "always()") return true
    if (token === "cancelled()") return false
    if (token !== undefined && token in context) return context[token]
    throw new Error(`unsupported expression term ${token} in ${expression}`)
  }
  const comparison = (): Value => {
    const left = primary()
    const operator = peek()
    if (operator !== "==" && operator !== "!=") return left
    take()
    // GitHub compares strings case-insensitively.
    const equal = String(left).toLowerCase() === String(primary()).toLowerCase()
    return operator === "==" ? equal : !equal
  }
  const not = (): Value => {
    if (peek() !== "!") return comparison()
    take()
    return !truthy(not())
  }
  const and = (): Value => {
    let value = not()
    while (peek() === "&&") {
      take()
      const right = not()
      value = truthy(value) ? right : value
    }
    return value
  }
  const or = (): Value => {
    let value = and()
    while (peek() === "||") {
      take()
      const right = and()
      value = truthy(value) ? value : right
    }
    return value
  }
  const value = or()
  if (position !== tokens.length) throw new Error(`unparsed tokens in ${expression}`)
  return value
}
