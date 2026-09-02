"""Compare a routed run with its standalone run across the two program names.

A routed component names the front door, so the usage line wraps at different
points and the argparse error prefix changes. Normalizing rewrites the program
name, compares the usage block as a token sequence, and leaves every other line
byte for byte.
"""

from __future__ import annotations

COMMAND_FOR_MODULE = {
    "create_vivary": "create-vivary",
    "tropo": "tropo",
    "strato": "strato",
    "ozone": "ozone",
    "exo": "exo",
}

# Components whose standalone program name already carries the operation, either
# because the operation is a subparser or because it builds its own parser.
OPERATION_NAMED_MODULES = frozenset({"create_vivary", "strato", "exo"})


def standalone_prog(module: str, operation: tuple[str, ...]) -> str:
    """Name the program a standalone run of this operation prints."""
    command = COMMAND_FOR_MODULE[module]
    if module in OPERATION_NAMED_MODULES and operation:
        return f"{command} {operation[0]}"
    return command


def routed_prog(verb: str) -> str:
    return f"vivary {verb}"


def normalize_prog(text: str, standalone: str, routed: str) -> str:
    """Rewrite one stream so the routed and standalone runs can be compared."""
    lines = text.splitlines()
    out: list[str] = []
    index = 0
    if lines and lines[0].startswith("usage: "):
        block = [lines[0]]
        index = 1
        while index < len(lines) and lines[index].startswith(" "):
            block.append(lines[index])
            index += 1
        usage = " ".join(" ".join(block).split())
        out.append(usage.replace(standalone, routed, 1))
    prefix = f"{standalone}: error: "
    for line in lines[index:]:
        if line.startswith(prefix):
            line = f"{routed}: error: {line[len(prefix):]}"
        out.append(line)
    return "\n".join(out) + ("\n" if text.endswith("\n") else "")
