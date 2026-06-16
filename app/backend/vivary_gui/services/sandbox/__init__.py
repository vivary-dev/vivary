"""Execution backends. The SandboxProvider seam: a `local` driver ships now;
`docker`/`daytona` are designed-for but not built (see GUI-EXPERIMENT.md)."""

from .local import LocalProvider, Sandbox

__all__ = ["LocalProvider", "Sandbox"]
