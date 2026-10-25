"""The desktop release guard passes the real workflow and fails each broken rule."""

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import check_desktop_release_workflow as guard  # noqa: E402


class DesktopReleaseWorkflowGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = (ROOT / guard.WORKFLOW).read_text(encoding="utf-8")
        self.target = (ROOT / guard.WINDOWS_TARGET).read_text(encoding="utf-8")
        self.ci = (ROOT / guard.CI_WORKFLOW).read_text(encoding="utf-8")

    def check(self, text=None, target=None, ci=None) -> list[str]:
        return guard.check(self.text if text is None else text, self.target if target is None else target,
                           self.ci if ci is None else ci)

    def broken(self, old: str, new: str) -> list[str]:
        self.assertIn(old, self.text)
        return self.check(self.text.replace(old, new, 1))

    def test_real_workflow_passes(self) -> None:
        self.assertEqual(self.check(), [])

    def test_node_must_match_the_bundled_windows_node_everywhere(self) -> None:
        self.assertNotEqual(self.broken('node-version: "24.22.1"', 'node-version: "24.21.0"'), [])
        moved = self.target.replace('nodeVersion: "v24.22.1"', 'nodeVersion: "v24.23.0"', 1)
        self.assertNotEqual(moved, self.target)
        self.assertNotEqual(self.check(target=moved), [])
        ci = self.ci.replace('node-version: "24.22.1"', 'node-version: "24.21.0"', 1)
        self.assertNotEqual(ci, self.ci)
        self.assertNotEqual(self.check(ci=ci), [])
        with mock.patch.object(guard.build_tools, "NODE", "24.21.0"):
            self.assertNotEqual(self.check(), [])

    def test_each_broken_rule_fails(self) -> None:
        tools = guard.ci.WORKBENCH_TOOLS_STEP
        cases = {
            "mutable action ref": ("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/checkout@v7.0.1"),
            "npm publish setup-node pin": ("actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
                                           "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"),
            "unproved download action": ("actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
                                         "actions/download-artifact@0000000000000000000000000000000000000000"),
            "draft job without admission": ("      - *runner_action_node_bootstrap\n", ""),
            "build job without admission": ("        name: runner action Node admission\n",
                                            "        name: runner action Node admission (edited)\n"),
            "floating Python": ('python-version: "3.12.15"', 'python-version: "3.12"'),
            "Python not provisioned": ('          runpy.run_path("scripts/bootstrap_ci_python.py", run_name="__main__")\n',
                                       '          pass\n'),
            "Python not admitted": ("      - name: actual Python runtime admission\n",
                                    "      - name: Python runtime admission\n"),
            "Node not admitted": ("      - name: actual Node security admission\n        run: node packages/workbench/bin/runtime-security.mjs\n", ""),
            "global pnpm": (tools, "      - name: global pnpm\n        run: npm install --global pnpm@10.34.7\n" + tools),
            "system pnpm install": ('\'"$RUNNER_TEMP/vivary-build-tools/bin/pnpm" --dir packages/workbench install --frozen-lockfile --ignore-scripts\'',
                                    "pnpm --dir packages/workbench install --frozen-lockfile --ignore-scripts"),
            "install scripts run": ("--frozen-lockfile --ignore-scripts", "--frozen-lockfile"),
            "system npm desktop install": ('\'"$RUNNER_TEMP/vivary-build-tools/bin/npm" --prefix packages/desktop ci --ignore-scripts\'',
                                           "npm --prefix packages/desktop ci"),
            "no compiler build": (' --typescript || exit $?', ' || exit $?'),
            "pull request trigger": ("  workflow_dispatch:\n", "  workflow_dispatch:\n  pull_request:\n"),
            "draft job on any run": ("    if: github.event_name == 'push' && github.ref_type == 'tag'\n", ""),
            "draft job on a dry-run branch": ("github.event_name == 'push' && github.ref_type == 'tag'", "github.event_name == 'push'"),
            "any branch triggers": ('branches: ["release-dry-run/**"]', 'branches: ["**"]'),
            "write permission for every job": ("permissions:\n  contents: read\n", "permissions:\n  contents: write\n"),
            "published release": ("--draft --prerelease", "--prerelease"),
            "release marked latest": (" --latest=false", ""),
            "prebuilt Workbench": ("--windows-x64 --build-workbench", "--windows-x64"),
            "checkout keeps credentials": ("persist-credentials: false", "persist-credentials: true"),
            "secret read": ("GH_TOKEN: ${{ github.token }}", "GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}"),
            "tag not checked": ('test "$GITHUB_REF_NAME" = "v$VERSION"', "true"),
            "tag check skipped": ("        if: github.ref_type == 'tag'\n        env:\n          VERSION:",
                                  "        if: false\n        env:\n          VERSION:"),
            "tag check commented out": ('        run: test "$GITHUB_REF_NAME" = "v$VERSION"',
                                        '        run: echo # test "$GITHUB_REF_NAME" = "v$VERSION"'),
            "unchecked download": ("          sha256sum --check --strict SHA256SUMS\n          gh release", "          gh release"),
        }
        for name, (old, new) in cases.items():
            with self.subTest(name):
                self.assertNotEqual(self.broken(old, new), [])


if __name__ == "__main__":
    unittest.main()
