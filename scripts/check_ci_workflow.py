from pathlib import Path


WORKFLOW = Path(".github/workflows/ci.yml")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"{WORKFLOW}: {message}")


def main() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")
    test_job_start = text.index("\n  test:\n")
    next_job_start = text.index("\n  governed-platform-proof:\n", test_job_start)
    test_job = text[test_job_start:next_job_start]

    runner_install = "python -m pip install pytest packaging"
    first_pytest = "python -m pytest"

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

    print(f"{WORKFLOW}: CI workflow contract passed")


if __name__ == "__main__":
    main()
