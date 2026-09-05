# External delivery dependencies

Updated: 2026-09-05

This file records public contracts for work that is required by the Vivary graph but is not implemented by the multi-project tickets themselves. It does not publish private planning material or mark held work complete.

## Held template-installer program

The template-installer program remains on hold. Ticket 19 may start only after the repository owner explicitly lifts the hold, a canonical approved source packet is available, and an installed artifact exposes a compatible API.

The external program must provide evidence for all six outcomes:

1. Define portable template semantics, conformance fixtures, and a pinned transport contract.
2. Add bounded, read-only template discovery against offline fixtures before enabling a public endpoint.
3. Define a combined template and Vivary adoption plan whose digest binds the catalog, archive, target, file list, Vivary plan, and relevant tool versions.
4. Apply into an isolated sibling staging directory and atomically rename only into an absent target, with deterministic recovery and no partial target.
5. Prove hostile-input handling, archive bounds, path safety, digest verification, and catalog-wide conformance without copying catalog content into Vivary.
6. Synchronize canonical documentation, release truth, and installed-artifact verification for both sides of the contract.

Vivary owns portable semantics, composition, adoption planning, authority gates, receipts, and post-install verification. The catalog owner retains template content, manifests, versions, deterministic archives, endpoints, transport, and distribution policy. Ticket 19 owns only the workbench wrapper, capability detection, project binding, UI, and wrapper tests.

Existing thin initialization and adoption remain usable when template support is missing or held. The wrapper must not vendor template bytes, duplicate the catalog, imply that another coordinator is installed, or enable a live catalog without its reviewed transport contract.
