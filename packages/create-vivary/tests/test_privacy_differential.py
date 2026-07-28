"""Differential tests: doctor's privacy verdict against real `git check-ignore`.

Doctor's central promise is that it never reports a workspace clean while Git would
still let you commit a private file. Every other privacy test in this repo asserts
against a *hand-reasoned* expectation, which is exactly how the original matcher bugs
survived: the tests encoded the same misunderstanding as the code. These tests ask Git
instead.

Written during the #218(3) adversarial pass, which found two false greens this way —
an escaped trailing space (`USER.md\\ `) and a case-folded bracket expression
(`[U]SER.md`). Both are now fixed and appear below as regression variants.

The asymmetry is deliberate and load-bearing:

  * a FALSE GREEN (doctor ok, Git would commit the file) is always a failure;
  * a false red (doctor complains, Git actually ignores it) is acceptable — several
    rules fail closed on purpose so the predicate can stay pure and usable from
    `adopt` on a directory that is not a repository yet.
"""

import os
import shutil
import subprocess
import sys
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PKG = ROOT / "packages" / "create-vivary"
TROPO = ROOT / "packages" / "tropo"

sys.path.insert(0, str(PKG))
sys.path.insert(0, str(TROPO))

import create_vivary  # noqa: E402

PROBES = create_vivary.PRIVACY_IGNORE_PROBES

COVERING_BLOCK = (
    "USER.md\nMEMORY.md\nmemory/*\n!memory/.gitkeep\n"
    "heartbeat-reports/*\n!heartbeat-reports/.gitkeep\n"
    ".strato/private/\n*.vivary-tmp\n"
)


def _swap_first_line(replacement: str) -> str:
    return COVERING_BLOCK.replace("USER.md\n", replacement, 1)


# (name, root .gitignore text, {nested path: text})
VARIANTS: list[tuple[str, str, dict[str, str]]] = [
    ("plain", COVERING_BLOCK, {}),
    ("crlf_line_endings", COVERING_BLOCK.replace("\n", "\r\n"), {}),
    ("utf8_bom", "\ufeff" + COVERING_BLOCK, {}),
    ("trailing_spaces", _swap_first_line("USER.md   \n"), {}),
    ("escaped_trailing_space", _swap_first_line("USER.md\\ \n"), {}),
    ("character_class", _swap_first_line("[U]SER.md\n"), {}),
    ("bracket_range", _swap_first_line("[A-Z]SER.md\n"), {}),
    ("case_variant", _swap_first_line("user.md\n"), {}),
    ("leading_slash", _swap_first_line("/USER.md\n"), {}),
    ("globstar_prefix", _swap_first_line("**/USER.md\n"), {}),
    ("question_mark", _swap_first_line("USER?md\n"), {}),
    ("escaped_hash", _swap_first_line("\\#USER.md\nUSER.md\n"), {}),
    ("negation_last", COVERING_BLOCK + "!USER.md\n", {}),
    ("dir_rule_memory", COVERING_BLOCK.replace("memory/*\n", "memory/\n", 1), {}),
    ("nested_negation_memory", COVERING_BLOCK, {"memory/.gitignore": "!private.md\n"}),
    ("nested_negation_strato", COVERING_BLOCK, {".strato/.gitignore": "!private/secret.md\n"}),
    ("deep_nested_negation", COVERING_BLOCK, {"memory/.gitignore": "!*.md\n"}),
]


def _git_available() -> bool:
    try:
        return subprocess.run(
            ["git", "--version"], capture_output=True, timeout=15
        ).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


@unittest.skipUnless(_git_available(), "git unavailable")
class PrivacyDifferentialTests(unittest.TestCase):
    """Doctor's verdict must never be more optimistic than Git's."""

    @classmethod
    def setUpClass(cls):
        cls.sandbox = ROOT / "sandboxes" / f"test-privacy-diff-{uuid.uuid4().hex}"
        cls.template = cls.sandbox / "template"
        cls.sandbox.mkdir(parents=True)
        create_vivary.scaffold_workspace(
            cls.template, preset="coding", force=False, storage="file", repo_root=ROOT
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.sandbox, ignore_errors=True)

    def _git_env(self) -> dict[str, str]:
        env = dict(os.environ)
        env.update(
            {
                "GIT_CONFIG_GLOBAL": str(self.sandbox / "no-such-gitconfig"),
                "GIT_CONFIG_NOSYSTEM": "1",
                "HOME": str(self.sandbox),
                "USERPROFILE": str(self.sandbox),
                "GIT_OPTIONAL_LOCKS": "0",
            }
        )
        return env


    def _git(self, target: Path, *args: str) -> subprocess.CompletedProcess:
        config = [
            "-c",
            "core.excludesFile=",
            "-c",
            "core.fsmonitor=false",
        ]
        if args and args[0] == "init":
            config.extend(["-c", "init.templateDir="])
        return subprocess.run(
            ["git", *config, *args],
            cwd=str(target),
            env=self._git_env(),
            capture_output=True,
            text=True,
            timeout=30,
        )

    def _git_ignores(self, target: Path, rel: str) -> bool:
        result = self._git(target, "check-ignore", "--no-index", "-q", "--", rel)
        if result.returncode not in (0, 1):
            self.skipTest(f"git check-ignore unusable: {result.stderr.strip()}")
        return result.returncode == 0

    def _build(self, name: str, root_text: str, nested: dict[str, str]) -> Path:
        target = self.sandbox / name
        shutil.copytree(self.template, target)
        (target / ".gitignore").write_text(root_text, encoding="utf-8", newline="")
        for rel, text in nested.items():
            path = target / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        init = self._git(target, "init", "-q")
        if init.returncode != 0:
            self.skipTest(f"git init failed: {init.stderr.strip()}")
        return target

    def _patterns_git_leaves_exposed(self, target: Path) -> set[str]:
        return {
            pattern
            for pattern, probes in PROBES.items()
            if not all(self._git_ignores(target, probe) for probe in probes)
        }

    def test_doctor_is_never_more_optimistic_than_git(self):
        for name, root_text, nested in VARIANTS:
            with self.subTest(variant=name):
                target = self._build(f"verdict-{name}", root_text, nested)

                doctor_missing = set(create_vivary._missing_privacy_ignores(target))
                exposed = self._patterns_git_leaves_exposed(target)

                self.assertEqual(
                    exposed - doctor_missing,
                    set(),
                    f"[{name}] FALSE GREEN — doctor reports these covered but "
                    f"git check-ignore says the probe files are committable",
                )

    def test_repair_converges_and_never_reports_ok_while_leaking(self):
        """`--repair --yes` must terminate, and its final verdict must be honest."""
        for name, root_text, nested in VARIANTS:
            with self.subTest(variant=name):
                target = self._build(f"repair-{name}", root_text, nested)

                first = create_vivary.doctor_repair_workspace(
                    target, yes=True, repo_root=ROOT
                )
                after_first = (target / ".gitignore").read_bytes()
                second = create_vivary.doctor_repair_workspace(
                    target, yes=True, repo_root=ROOT
                )
                after_second = (target / ".gitignore").read_bytes()

                self.assertEqual(
                    after_first,
                    after_second,
                    f"[{name}] repair must converge; the second run rewrote .gitignore",
                )
                self.assertIsNotNone(first)

                if second["ok"]:
                    self.assertEqual(
                        self._patterns_git_leaves_exposed(target),
                        set(),
                        f"[{name}] repair reported ok on a workspace git would "
                        f"still let you commit private files from",
                    )


if __name__ == "__main__":
    unittest.main()
