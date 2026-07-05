from pathlib import Path


WORKFLOW = Path(".github/workflows/npm-trusted-publish.yml")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def main() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")

    required_snippets = [
        "workflow_dispatch:",
        "release_tag:",
        "publish:",
        "contents: read",
        "id-token: write",
        "needs: verify",
        "environment: npm-publish",
        "runs-on: ubuntu-latest",
        "actions/setup-node@v6",
        'node-version: "24"',
        'registry-url: "https://registry.npmjs.org"',
        "package-manager-cache: false",
        "Verify trusted publishing runtime",
        "npm 11.5.1+ is required for trusted publishing",
        "packages/create-vivary/tests/test_create_vivary.py",
        "packages/create-vivary/tests/test_assets_parity.py",
        "packages/create-vivary/tests/test_npm_launcher.js",
        "npm pack --dry-run",
        "npm publish",
        "packages/create-vivary/npm",
        "persist-credentials: false",
    ]

    for snippet in required_snippets:
        require(snippet in text, f"{WORKFLOW}: missing required snippet: {snippet}")

    forbidden_snippets = [
        "NPM_TOKEN",
        "NODE_AUTH_TOKEN",
        "_authToken",
        "always-auth",
        "npm publish --otp",
        "--auth-type",
    ]

    for snippet in forbidden_snippets:
        require(snippet not in text, f"{WORKFLOW}: forbidden token/auth snippet: {snippet}")

    require(
        'test "${{ inputs.release_tag }}" = "v${{ inputs.version }}"' in text,
        f"{WORKFLOW}: publish path must be release-tag gated",
    )
    require(
        'git rev-parse "refs/tags/${{ inputs.release_tag }}^{commit}"' in text,
        f"{WORKFLOW}: checked-out commit must be verified against the release tag",
    )
    require(
        "require('./packages/create-vivary/npm/package.json').version" in text,
        f"{WORKFLOW}: npm package version must be verified before publish",
    )
    require(
        "pyproject={pypi_version} npm={npm_version}" in text,
        f"{WORKFLOW}: PyPI/npm lockstep version check must be present",
    )
    require(
        "if: ${{ inputs.publish }}" in text,
        f"{WORKFLOW}: npm publish must require explicit publish=true",
    )
    require(
        "if: ${{ !inputs.publish }}" in text,
        f"{WORKFLOW}: dry-run gate must be the default path",
    )
    publish_job = text.index('\n  publish:\n    name: "@vivary/create trusted publish"')
    require(
        "id-token: write" not in text[:publish_job],
        f"{WORKFLOW}: OIDC permission must only exist on the publish job",
    )
    require(
        text.index("run: npm publish") > publish_job,
        f"{WORKFLOW}: npm publish must only run inside the publish job",
    )

    print(f"{WORKFLOW}: trusted publish guard passed")


if __name__ == "__main__":
    main()
