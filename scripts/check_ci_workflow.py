import re
from pathlib import Path


WORKFLOW = Path(".github/workflows/ci.yml")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"{WORKFLOW}: {message}")


def job_block(text: str, name: str) -> str:
    """Return one top-level job without accepting commands from later jobs."""
    jobs_marker = "\njobs:\n"
    require(jobs_marker in text, "workflow must declare jobs")
    jobs = text[text.index(jobs_marker) + len(jobs_marker) :]
    headers = list(re.finditer(r"(?m)^  ([A-Za-z0-9_-]+):\s*$", jobs))
    matches = [index for index, match in enumerate(headers) if match.group(1) == name]
    require(len(matches) == 1, f"workflow must declare exactly one {name} job")

    index = matches[0]
    start = headers[index].start()
    end = headers[index + 1].start() if index + 1 < len(headers) else len(jobs)
    return jobs[start:end]


def main() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")
    test_job = job_block(text, "test")
    site_job = job_block(text, "site")

    runner_install = "python -m pip install pytest packaging"
    first_pytest = "python -m pytest"
    contract_tests = "python scripts/tests/test_ci_workflow.py"
    site_install = "        run: npm ci\n        working-directory: site"
    site_audit = (
        "        run: npm audit --audit-level=high\n"
        "        working-directory: site"
    )

    require(runner_install in test_job, "tests job must install pytest and packaging")
    require(first_pytest in test_job, "tests job must run a pytest suite")
    require(
        test_job.index(runner_install) < test_job.index(first_pytest),
        "shared test runner install must precede the first pytest suite",
    )
    require(
        test_job.count(runner_install) == 1,
        "tests job must install the shared test runner exactly once",
    )
    require(
        "python scripts/check_ci_workflow.py" in test_job,
        "tests job must run the CI workflow contract guard",
    )
    require(
        contract_tests in test_job,
        f"tests job must run {contract_tests}",
    )
    require(
        test_job.count(contract_tests) == 1,
        "tests job must run the CI workflow contract regression suite exactly once",
    )
    require(
        site_install in site_job,
        "site job must run npm ci with working-directory: site",
    )
    require(
        site_job.count(site_install) == 1,
        "site job must run npm ci in site exactly once",
    )
    require(
        site_audit in site_job,
        "site job must run npm audit --audit-level=high with working-directory: site",
    )
    require(
        site_job.count(site_audit) == 1,
        "site job must run the blocking high-severity audit exactly once",
    )
    require(
        site_job.index(site_install) < site_job.index(site_audit),
        "site dependency audit must follow the locked npm install",
    )

    print(f"{WORKFLOW}: CI workflow contract passed")


if __name__ == "__main__":
    main()
