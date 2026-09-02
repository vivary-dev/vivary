"""Complete stdout and stderr recorded for the characterized commands.

Each entry holds the whole stream one run produced, trailing whitespace
stripped per line and closed by a single newline. Streams that a case
declares silent, environment-dependent, or that vary between runs are
absent by design.
"""

SNAPSHOTS = {
    "create-vivary-help": {
        "stdout": (
            "usage: create-vivary [-h] [--version] [--receipt PATH]\n"
            "                     {init,wizard,doctor,capabilities,adopt,record} ...\n"
            "\n"
            "Create a lightweight local-first Vivary context workspace.\n"
            "\n"
            "positional arguments:\n"
            "  {init,wizard,doctor,capabilities,adopt,record}\n"
            "    init                create a Vivary workspace scaffold\n"
            "    wizard              reconfigure storage for an existing workspace\n"
            "    doctor              validate a Vivary workspace scaffold\n"
            "    capabilities        list optional preset capabilities\n"
            "    adopt               plan and apply bounded governed context for an\n"
            "                        existing workspace\n"
            "    record              plan and apply one capsule-bound record earned by real\n"
            "                        work\n"
            "\n"
            "options:\n"
            "  -h, --help            show this help message and exit\n"
            "  --version             show program's version number and exit\n"
            "  --receipt PATH        append a local privacy-preserving JSONL run receipt\n"
            "                        (or set VIVARY_RECEIPT_LOG)\n"
        ),
    },
    "create-vivary-init-help": {
        "stdout": (
            "usage: create-vivary init [-h] [--receipt PATH]\n"
            "                          [--preset {coding,second-brain,knowledge-work,writing}]\n"
            "                          [--adapter {agents,claude}] [--force]\n"
            "                          [--active-context {cocoindex-code}]\n"
            "                          [--repo-root REPO_ROOT] [--json] [--dry-run]\n"
            "                          [--auto] [--yes] [--no-wizard]\n"
            "                          [--storage {auto,file,embedded,cloud}]\n"
            "                          [--provider {lancedb,sqlite-vec,qdrant,astra}]\n"
            "                          [--memory {none,local,cognee}]\n"
            "                          [--size {small,medium,large}]\n"
            "                          [--privacy {local,cloud}]\n"
            "                          target\n"
            "\n"
            "positional arguments:\n"
            "  target                directory to create or populate\n"
            "\n"
            "options:\n"
            "  -h, --help            show this help message and exit\n"
            "  --receipt PATH        append a local privacy-preserving JSONL run receipt\n"
            "                        (or set VIVARY_RECEIPT_LOG)\n"
            "  --preset {coding,second-brain,knowledge-work,writing}\n"
            "  --adapter {agents,claude}\n"
            "                        add one bounded runtime projection; repeat for both\n"
            "                        supported adapters\n"
            "  --force               compatibility flag; init still refuses nonempty\n"
            "                        targets and directs existing workspaces to governed\n"
            "                        adopt\n"
            "  --active-context {cocoindex-code}\n"
            "                        declare an optional active-context capability in the\n"
            "                        five-file seed; does not install or materialize its\n"
            "                        sidecar\n"
            "  --repo-root REPO_ROOT\n"
            "                        Vivary source checkout root (mainly for local\n"
            "                        development/tests)\n"
            "  --json                machine-readable output\n"
            "  --dry-run             simulate without writing\n"
            "  --auto                skip prompts; pick best config from available signals\n"
            "  --yes                 auto-confirm installs and prompts\n"
            "  --no-wizard           skip wizard; use flag values or defaults directly\n"
            "  --storage {auto,file,embedded,cloud}\n"
            "                        storage backend (auto=file unless cloud locality is\n"
            "                        explicit)\n"
            "  --provider {lancedb,sqlite-vec,qdrant,astra}\n"
            "                        storage provider (default: lancedb)\n"
            "  --memory {none,local,cognee}\n"
            "                        optional semantic memory policy (default: none)\n"
            "  --size {small,medium,large}\n"
            "                        workspace size hint for --auto decisions\n"
            "  --privacy {local,cloud}\n"
            "                        data locality hint for --auto decisions\n"
        ),
    },
    "create-vivary-adopt-help": {
        "stdout": (
            "usage: create-vivary adopt [-h] [--receipt PATH]\n"
            "                           [--preset {coding,second-brain,knowledge-work,writing}]\n"
            "                           [--yes] [--plan PLAN] [--recover PLAN_HASH]\n"
            "                           [--adapter {agents,claude}] [--json]\n"
            "                           [--repo-root REPO_ROOT]\n"
            "                           target\n"
            "\n"
            "positional arguments:\n"
            "  target                existing directory to adopt\n"
            "\n"
            "options:\n"
            "  -h, --help            show this help message and exit\n"
            "  --receipt PATH        append a local privacy-preserving JSONL run receipt\n"
            "                        (or set VIVARY_RECEIPT_LOG)\n"
            "  --preset {coding,second-brain,knowledge-work,writing}\n"
            "                        thin workspace policy; default is inferred from the\n"
            "                        tree\n"
            "  --yes                 write the planned files (default is dry-run: plan\n"
            "                        only)\n"
            "  --plan PLAN           exact plan hash from the approved dry-run; required\n"
            "                        with --yes\n"
            "  --recover PLAN_HASH   plan recovery for an interrupted transaction bound to\n"
            "                        this adoption hash; apply only with --yes --plan\n"
            "                        <recovery-hash>\n"
            "  --adapter {agents,claude}\n"
            "                        add one bounded runtime projection; repeat for both\n"
            "                        supported adapters\n"
            "  --json                machine-readable output\n"
            "  --repo-root REPO_ROOT\n"
            "                        Vivary source checkout root (mainly for local\n"
            "                        development/tests)\n"
        ),
    },
    "create-vivary-doctor-help": {
        "stdout": (
            "usage: create-vivary doctor [-h] [--receipt PATH] [--json] [--repair] [--yes]\n"
            "                            [--trend] [--repo-root REPO_ROOT]\n"
            "                            target\n"
            "\n"
            "positional arguments:\n"
            "  target                workspace directory to validate\n"
            "\n"
            "options:\n"
            "  -h, --help            show this help message and exit\n"
            "  --receipt PATH        append a local privacy-preserving JSONL run receipt\n"
            "                        (or set VIVARY_RECEIPT_LOG)\n"
            "  --json                print a JSON report\n"
            "  --repair              include conservative repair diagnostics; legacy-full\n"
            "                        workspaces remain report-only\n"
            "  --yes                 with --repair, apply deterministic safe repairs to\n"
            "                        supported contracts; never writes legacy-full\n"
            "                        workspaces\n"
            "  --trend               compare this run against its prior local runtime\n"
            "                        snapshot and report drift (write gate: only --trend\n"
            "                        writes this file)\n"
            "  --repo-root REPO_ROOT\n"
            "                        Vivary source checkout root (mainly for local\n"
            "                        development/tests)\n"
        ),
    },
    "create-vivary-capabilities-help": {
        "stdout": (
            "usage: create-vivary capabilities [-h] [--receipt PATH]\n"
            "                                  [--preset {coding,second-brain,knowledge-work,writing}]\n"
            "                                  [--json]\n"
            "\n"
            "options:\n"
            "  -h, --help            show this help message and exit\n"
            "  --receipt PATH        append a local privacy-preserving JSONL run receipt\n"
            "                        (or set VIVARY_RECEIPT_LOG)\n"
            "  --preset {coding,second-brain,knowledge-work,writing}\n"
            "  --json                print a JSON report\n"
        ),
    },
    "create-vivary-wizard-help": {
        "stdout": (
            "usage: create-vivary wizard [-h] [--receipt PATH] [--auto] [--yes]\n"
            "                            [--no-wizard]\n"
            "                            [--storage {auto,file,embedded,cloud}]\n"
            "                            [--provider {lancedb,sqlite-vec,qdrant,astra}]\n"
            "                            [--memory {none,local,cognee}]\n"
            "                            [--size {small,medium,large}]\n"
            "                            [--privacy {local,cloud}] [--json] [--dry-run]\n"
            "                            [--repo-root REPO_ROOT]\n"
            "                            target\n"
            "\n"
            "positional arguments:\n"
            "  target                workspace directory to reconfigure\n"
            "\n"
            "options:\n"
            "  -h, --help            show this help message and exit\n"
            "  --receipt PATH        append a local privacy-preserving JSONL run receipt\n"
            "                        (or set VIVARY_RECEIPT_LOG)\n"
            "  --auto\n"
            "  --yes\n"
            "  --no-wizard\n"
            "  --storage {auto,file,embedded,cloud}\n"
            "  --provider {lancedb,sqlite-vec,qdrant,astra}\n"
            "  --memory {none,local,cognee}\n"
            "  --size {small,medium,large}\n"
            "  --privacy {local,cloud}\n"
            "  --json\n"
            "  --dry-run\n"
            "  --repo-root REPO_ROOT\n"
        ),
    },
    "create-vivary-record-help": {
        "stdout": (
            "usage: create-vivary record [-h] [--receipt PATH] --from PATH --capsule PATH\n"
            "                            [--yes] [--plan PLAN] [--json]\n"
            "                            [--repo-root REPO_ROOT]\n"
            "                            target record\n"
            "\n"
            "positional arguments:\n"
            "  target                existing thin Vivary workspace\n"
            "  record                bounded record path such as changes/verified-slice.md\n"
            "\n"
            "options:\n"
            "  -h, --help            show this help message and exit\n"
            "  --receipt PATH        append a local privacy-preserving JSONL run receipt\n"
            "                        (or set VIVARY_RECEIPT_LOG)\n"
            "  --from PATH           complete UTF-8 Markdown record to validate and propose\n"
            "  --capsule PATH        complete governed or public Task Capsule JSON returned\n"
            "                        by Tropo or vivary_capsule\n"
            "  --yes                 apply the approved single-record plan (default is dry-\n"
            "                        run)\n"
            "  --plan PLAN           exact plan hash from the approved dry-run; required\n"
            "                        with --yes\n"
            "  --json                machine-readable output\n"
            "  --repo-root REPO_ROOT\n"
            "                        Vivary source checkout root (mainly for local\n"
            "                        development/tests)\n"
        ),
    },
    "create-vivary-unknown-flag": {
        "stderr": (
            "usage: create-vivary [-h] [--version] [--receipt PATH]\n"
            "                     {init,wizard,doctor,capabilities,adopt,record} ...\n"
            "create-vivary: error: unrecognized arguments: --nope\n"
        ),
    },
    "tropo-help": {
        "stdout": (
            "usage: tropo [-h] [--version] [--strict] [--lenient] [--json] [--quiet]\n"
            "             [--dry-run] [--depth DEPTH] [--max-entries MAX_ENTRIES]\n"
            "             [--out OUT] [--packs PACKS] [--root ROOT] [--config CONFIG]\n"
            "             [--receipt PATH] [--from {file,embedded,cloud}]\n"
            "             [--to {file,embedded,cloud}] [--yes] [--k K]\n"
            "             [--mode {text,vector,semantic}] [--type TYPE] [--path PATH]\n"
            "             [--edge EDGE] [--snippet SNIPPET] [--explain] [--budget BUDGET]\n"
            "             [--governed] [--max-claims MAX_CLAIMS]\n"
            "             [{check,signal,types,stats,graph,blast,view,plan,fix,init,migrate,query,find,map}]\n"
            "             [paths ...]\n"
            "\n"
            "The filesystem is the schema.\n"
            "\n"
            "positional arguments:\n"
            "  {check,signal,types,stats,graph,blast,view,plan,fix,init,migrate,query,find,map}\n"
            "  paths                 files or folders (default: whole tree); for\n"
            "                        blast/query/find, the target id/text; for map, the\n"
            "                        single tree to inventory\n"
            "\n"
            "options:\n"
            "  -h, --help            show this help message and exit\n"
            "  --version             show program's version number and exit\n"
            "  --strict              check: force warnings to fail (the default; overrides\n"
            "                        a lenient config)\n"
            "  --lenient             check: allow warnings without failing (relax the\n"
            "                        opinionated default)\n"
            "  --json                machine-readable output\n"
            "  --quiet               hide warnings\n"
            "  --dry-run             fix/migrate: preview without writing\n"
            "  --depth DEPTH         blast: max hops (default: unlimited); map: directory\n"
            "                        table depth (default: 3)\n"
            "  --max-entries MAX_ENTRIES\n"
            "                        map: cap the number of directory rows in the table\n"
            "                        (default: unlimited)\n"
            "  --out OUT             view: write HTML here (default: stdout)\n"
            "  --packs PACKS         init: comma-separated pack names\n"
            "  --root ROOT           tree root (default: walk up for tropo.toml)\n"
            "  --config CONFIG       explicit tropo.toml path\n"
            "  --receipt PATH        append a local privacy-preserving JSONL run receipt\n"
            "                        (or set VIVARY_RECEIPT_LOG)\n"
            "  --from {file,embedded,cloud}\n"
            "                        migrate: source backend (default: file)\n"
            "  --to {file,embedded,cloud}\n"
            "                        migrate: destination backend (default: embedded)\n"
            "  --yes                 auto-confirm prompts (agent/CI use)\n"
            "  --k K                 query/find: number of results (query default: 10, find\n"
            "                        default: 5)\n"
            "  --mode {text,vector,semantic}\n"
            "                        query: text graph search (default), local typed vector\n"
            "                        search, or optional semantic-memory provider search\n"
            "  --type TYPE           query/find: restrict results to a document type;\n"
            "                        repeatable\n"
            "  --path PATH           query/find: restrict results to a path glob;\n"
            "                        repeatable\n"
            "  --edge EDGE           query/find: require outbound edge FIELD or\n"
            "                        FIELD:TARGET; repeatable\n"
            "  --snippet SNIPPET     query/find: snippet characters per result (default:\n"
            "                        160; 0 disables)\n"
            "  --explain             query: include stable match reasons\n"
            "  --budget BUDGET       find: approximate token budget (default: 1200)\n"
            "  --governed            find: experimental read-only scan -> graph -> capsule\n"
            "                        pipeline\n"
            "  --max-claims MAX_CLAIMS\n"
            "                        find --governed: maximum capsule claims (default: 24)\n"
        ),
    },
    "tropo-check": {
        "stdout": (
            "\n"
            "tropo: 4 document(s), 0 error(s), 0 warning(s)\n"
        ),
    },
    "tropo-check-json": {
        "stdout": (
            "{\n"
            "  \"checked\": 4,\n"
            "  \"clean\": 4,\n"
            "  \"errors\": 0,\n"
            "  \"warnings\": 0,\n"
            "  \"findings\": []\n"
            "}\n"
        ),
    },
    "tropo-unknown-flag": {
        "stderr": (
            "usage: tropo [-h] [--version] [--strict] [--lenient] [--json] [--quiet]\n"
            "             [--dry-run] [--depth DEPTH] [--max-entries MAX_ENTRIES]\n"
            "             [--out OUT] [--packs PACKS] [--root ROOT] [--config CONFIG]\n"
            "             [--receipt PATH] [--from {file,embedded,cloud}]\n"
            "             [--to {file,embedded,cloud}] [--yes] [--k K]\n"
            "             [--mode {text,vector,semantic}] [--type TYPE] [--path PATH]\n"
            "             [--edge EDGE] [--snippet SNIPPET] [--explain] [--budget BUDGET]\n"
            "             [--governed] [--max-claims MAX_CLAIMS]\n"
            "             [{check,signal,types,stats,graph,blast,view,plan,fix,init,migrate,query,find,map}]\n"
            "             [paths ...]\n"
            "tropo: error: unrecognized arguments: --nope\n"
        ),
    },
    "strato-help": {
        "stdout": (
            "usage: strato [-h] [--version] {decide} ...\n"
            "\n"
            "Vivary governed loop policy\n"
            "\n"
            "positional arguments:\n"
            "  {decide}\n"
            "    decide    evaluate the next governed loop step\n"
            "\n"
            "options:\n"
            "  -h, --help  show this help message and exit\n"
            "  --version   show program's version number and exit\n"
        ),
    },
    "strato-decide-help": {
        "stdout": (
            "usage: strato decide [-h] --governed [--json] [--strict] request\n"
            "\n"
            "positional arguments:\n"
            "  request     decision-request JSON file, or - for stdin\n"
            "\n"
            "options:\n"
            "  -h, --help  show this help message and exit\n"
            "  --governed  explicitly opt in to the experimental governed policy contract\n"
            "  --json      emit the decision as JSON\n"
            "  --strict    exit 1 when a valid policy evaluation blocks or requests a gate\n"
        ),
    },
    "strato-missing-command": {
        "stderr": (
            "usage: strato [-h] [--version] {decide} ...\n"
            "strato: error: the following arguments are required: command\n"
        ),
    },
    "strato-decide-missing-request": {
        "stdout": (
            "strato decide: blocked\n"
            "reasons: invalid_request_document\n"
        ),
        "stderr": "strato: [Errno 2] No such file or directory: 'missing.json'\n",
    },
    "strato-decide-missing-request-json": {
        "stdout": "{\"budget\":null,\"decision\":\"blocked\",\"gate\":null,\"policy_version\":\"vivary.strato-policy/v0\",\"reason_codes\":[\"invalid_request_document\"],\"schema\":\"vivary.strato-decision-refusal/v0\"}\n",
        "stderr": "strato: [Errno 2] No such file or directory: 'missing.json'\n",
    },
    "ozone-help": {
        "stdout": (
            "usage: ozone [-h] [--version] [--governed] [--root ROOT] [--json] [--strict]\n"
            "             [--pack {structure,context-budget,editorial,all}]\n"
            "             [--receipt PATH]\n"
            "             [{review,impact,packs,verify}] [id]\n"
            "\n"
            "Vivary review, impact, and governed evidence verification.\n"
            "\n"
            "positional arguments:\n"
            "  {review,impact,packs,verify}\n"
            "  id                    impact node id or verify request document\n"
            "\n"
            "options:\n"
            "  -h, --help            show this help message and exit\n"
            "  --version             show program's version number and exit\n"
            "  --governed            explicitly opt in to governed receipt and gate\n"
            "                        verification\n"
            "  --root ROOT           workspace root (default: walk up for tropo.toml)\n"
            "  --json                machine-readable output\n"
            "  --strict              review/verify: exit non-zero on warnings or\n"
            "                        insufficient evidence\n"
            "  --pack {structure,context-budget,editorial,all}\n"
            "                        review: rule pack to run (default: structure)\n"
            "  --receipt PATH        append a local privacy-preserving JSONL run receipt\n"
            "                        (or set VIVARY_RECEIPT_LOG)\n"
        ),
    },
    "ozone-review": {
        "stdout": (
            "projects/tropo/decisions/0001-folder-as-type.md: info orphan: node '0001-folder-as-type' is disconnected (no edges in or out)\n"
            "people/jeff.md: info orphan: node 'jeff' is disconnected (no edges in or out)\n"
            "\n"
            "ozone: reviewed 4 node(s), 0 warning(s), 2 note(s)\n"
        ),
    },
    "ozone-packs": {
        "stdout": (
            "structure    deterministic completeness + topology review over the Vivary graph\n"
            "context-budget deterministic context-bloat review over public routing surfaces\n"
            "editorial    deterministic editorial coverage review for writing workspaces\n"
        ),
    },
    "ozone-unknown-flag": {
        "stderr": (
            "usage: ozone [-h] [--version] [--governed] [--root ROOT] [--json] [--strict]\n"
            "             [--pack {structure,context-budget,editorial,all}]\n"
            "             [--receipt PATH]\n"
            "             [{review,impact,packs,verify}] [id]\n"
            "ozone: error: unrecognized arguments: --nope\n"
        ),
    },
    "ozone-verify-ungoverned": {
        "stderr": (
            "usage: ozone [-h] [--version] [--governed] [--root ROOT] [--json] [--strict]\n"
            "             [--pack {structure,context-budget,editorial,all}]\n"
            "             [--receipt PATH]\n"
            "             [{review,impact,packs,verify}] [id]\n"
            "ozone: error: verify requires --governed\n"
        ),
    },
    "ozone-impact-missing-node": {
        "stderr": "ozone: no node with id 'nope-id' (run `ozone review` or `tropo graph`)\n",
    },
    "exo-help": {
        "stdout": (
            "usage: exo [-h] [--version] [--agent AGENT] [--root ROOT] [--json]\n"
            "           [--receipt PATH]\n"
            "           [{conflicts,board,claim,roles}] [target]\n"
            "\n"
            "The coordination layer over the tropo graph.\n"
            "\n"
            "positional arguments:\n"
            "  {conflicts,board,claim,roles}\n"
            "  target                claim: work item id\n"
            "\n"
            "options:\n"
            "  -h, --help            show this help message and exit\n"
            "  --version             show program's version number and exit\n"
            "  --agent AGENT         claim: agent handle\n"
            "  --root ROOT           workspace root (default: walk up for tropo.toml)\n"
            "  --json                machine-readable output\n"
            "  --receipt PATH        append a local privacy-preserving JSONL run receipt\n"
            "                        (or set VIVARY_RECEIPT_LOG)\n"
        ),
    },
    "exo-control-help": {
        "stdout": (
            "usage: exo control [-h] [--json] [--strict] REQUEST\n"
            "\n"
            "Dispatch one governed Core control request.\n"
            "\n"
            "positional arguments:\n"
            "  REQUEST     JSON request path, or - for stdin\n"
            "\n"
            "options:\n"
            "  -h, --help  show this help message and exit\n"
            "  --json      emit canonical compact JSON\n"
            "  --strict    fail on a refusal or reason code\n"
        ),
    },
    "exo-conflicts": {
        "stdout": "exo: no conflicts among 0 active work item(s)\n",
    },
    "exo-roles": {
        "stdout": (
            "exo: role contracts (workers get bounded contracts; never product owners)\n"
            "  Orchestrator  intent, scope, gates, synthesis\n"
            "  Scout         paths, confidence, gaps\n"
            "  Researcher    fact / inference / recommendation, with credits\n"
            "  Builder       one slice + changed paths + checks\n"
            "  Verifier      pass / fail / skipped / risk \u2014 no silent edits\n"
            "  Reviewer      findings first\n"
            "  Archivist     notes, handoffs; PRIV kept separate\n"
        ),
    },
    "exo-unknown-flag": {
        "stderr": (
            "usage: exo [-h] [--version] [--agent AGENT] [--root ROOT] [--json]\n"
            "           [--receipt PATH]\n"
            "           [{conflicts,board,claim,roles}] [target]\n"
            "exo: error: unrecognized arguments: --nope\n"
        ),
    },
    "exo-claim-without-agent": {
        "stderr": (
            "usage: exo [-h] [--version] [--agent AGENT] [--root ROOT] [--json]\n"
            "           [--receipt PATH]\n"
            "           [{conflicts,board,claim,roles}] [target]\n"
            "exo: error: claim requires --agent <handle>\n"
        ),
    },
    "exo-control-missing-request": {
        "stdout": "exo control: refused: invalid_request_document\n",
    },
    "vivary-nope": {
        "stderr": (
            "usage: vivary [-h] [--version] {logs,email,create,adopt,doctor,capabilities,\n"
            "       check,find,decide,review,impact,control} ...\n"
            "vivary: error: argument command: invalid choice: 'nope' (choose from 'logs', 'email', 'create', 'adopt', 'doctor', 'capabilities', 'check', 'find', 'decide', 'review', 'impact', 'control')\n"
        ),
    },
    "vivary-help": {
        "stdout": (
            "usage: vivary [-h] [--version] {logs,email,create,adopt,doctor,capabilities,\n"
            "       check,find,decide,review,impact,control} ...\n"
            "\n"
            "The Vivary front door, plus local visibility helpers.\n"
            "\n"
            "`--` ends the front door's own options, as in `vivary -- check --help`.\n"
            "\n"
            "Task verbs:\n"
            "\n"
            "  Workspace\n"
            "    create        Create a Vivary workspace scaffold\n"
            "    adopt         Plan governed context for an existing workspace\n"
            "    doctor        Validate a Vivary workspace scaffold\n"
            "    capabilities  List the optional preset capabilities\n"
            "\n"
            "  Graph and retrieval\n"
            "    check         Validate the context graph and report errors and warnings\n"
            "    find          Retrieve a token-budgeted context set for a query\n"
            "\n"
            "  Policy\n"
            "    decide        Evaluate one governed decision request\n"
            "\n"
            "  Review\n"
            "    review        Run a review rule pack over the context graph\n"
            "    impact        Show what one node affects\n"
            "\n"
            "  Coordination\n"
            "    control       Dispatch one governed Core control request\n"
            "\n"
            "positional arguments:\n"
            "  command\n"
            "    logs      summarize local Vivary JSONL run receipts\n"
            "    email     build a local email draft from receipts (also available as\n"
            "              `vivary logs email`)\n"
            "\n"
            "options:\n"
            "  -h, --help  show this help message and exit\n"
            "  --version   show program's version number and exit\n"
            "\n"
            "Advanced:\n"
            "\n"
            "  Each component also installs its own command with the full operation set.\n"
            "\n"
            "    create-vivary  create, adopt, doctor, capabilities\n"
            "    tropo          check, find\n"
            "    strato         decide\n"
            "    ozone          review, impact\n"
            "    exo            control\n"
        ),
    },
    "vivary-no-arguments": {
        "stdout": (
            "usage: vivary [-h] [--version] {logs,email,create,adopt,doctor,capabilities,\n"
            "       check,find,decide,review,impact,control} ...\n"
            "\n"
            "The Vivary front door, plus local visibility helpers.\n"
            "\n"
            "`--` ends the front door's own options, as in `vivary -- check --help`.\n"
            "\n"
            "Task verbs:\n"
            "\n"
            "  Workspace\n"
            "    create        Create a Vivary workspace scaffold\n"
            "    adopt         Plan governed context for an existing workspace\n"
            "    doctor        Validate a Vivary workspace scaffold\n"
            "    capabilities  List the optional preset capabilities\n"
            "\n"
            "  Graph and retrieval\n"
            "    check         Validate the context graph and report errors and warnings\n"
            "    find          Retrieve a token-budgeted context set for a query\n"
            "\n"
            "  Policy\n"
            "    decide        Evaluate one governed decision request\n"
            "\n"
            "  Review\n"
            "    review        Run a review rule pack over the context graph\n"
            "    impact        Show what one node affects\n"
            "\n"
            "  Coordination\n"
            "    control       Dispatch one governed Core control request\n"
            "\n"
            "positional arguments:\n"
            "  command\n"
            "    logs      summarize local Vivary JSONL run receipts\n"
            "    email     build a local email draft from receipts (also available as\n"
            "              `vivary logs email`)\n"
            "\n"
            "options:\n"
            "  -h, --help  show this help message and exit\n"
            "  --version   show program's version number and exit\n"
            "\n"
            "Advanced:\n"
            "\n"
            "  Each component also installs its own command with the full operation set.\n"
            "\n"
            "    create-vivary  create, adopt, doctor, capabilities\n"
            "    tropo          check, find\n"
            "    strato         decide\n"
            "    ozone          review, impact\n"
            "    exo            control\n"
        ),
    },
    "vivary-logs-help": {
        "stdout": (
            "usage: vivary logs [-h] [--json] [--tail TAIL] [--failed] [path]\n"
            "\n"
            "positional arguments:\n"
            "  path\n"
            "\n"
            "options:\n"
            "  -h, --help   show this help message and exit\n"
            "  --json       print machine-readable output\n"
            "  --tail TAIL  show only the last N matching receipts\n"
            "  --failed     show only failed receipts\n"
        ),
    },
    "vivary-logs-email-help": {
        "stdout": (
            "usage: vivary logs email [-h] --to TO [--subject SUBJECT] [--out OUT] [--json]\n"
            "                         [--tail TAIL] [--failed]\n"
            "                         [path]\n"
            "\n"
            "positional arguments:\n"
            "  path\n"
            "\n"
            "options:\n"
            "  -h, --help         show this help message and exit\n"
            "  --to TO            recipient address for the draft or mailto link\n"
            "  --subject SUBJECT\n"
            "  --out OUT          write an .eml draft instead of printing a mailto URL\n"
            "  --json             print machine-readable output\n"
            "  --tail TAIL        include only the last N matching receipts\n"
            "  --failed           include only failed receipts\n"
        ),
    },
    "vivary-logs-empty": {
        "stdout": (
            "Vivary receipt log\n"
            "total=0 failed=0 invalid_lines=0\n"
        ),
    },
    "vivary-logs-empty-json": {
        "stdout": (
            "{\n"
            "  \"summary\": {\n"
            "    \"total\": 0,\n"
            "    \"failed\": 0,\n"
            "    \"invalid_lines\": 0,\n"
            "    \"tools\": {}\n"
            "  },\n"
            "  \"records\": []\n"
            "}\n"
        ),
    },
    "vivary-logs-email": {
        "stdout": "mailto:support@example.com?subject=Vivary%20support%20receipt%20summary&body=Vivary%20support%20receipt%20summary%0A%0AThis%20is%20a%20local%2C%20user-created%20summary%20of%20Vivary%20run%20receipts.%0AIt%20excludes%20stdout%2C%20stderr%2C%20file%20contents%2C%20raw%20query%20text%2C%20target%20ids%2C%20and%20local%20paths.%0A%0Atotal%3D0%20failed%3D0%20invalid_lines%3D0%0A%0ARecent%20receipts%3A%0A\n",
    },
    "vivary-logs-missing": {
        "stderr": "vivary logs: receipt log not found\n",
    },
    "vivary-logs-email-missing": {
        "stderr": "vivary logs email: receipt log not found\n",
    },
    "vivary-logs-unknown-flag": {
        "stderr": (
            "usage: vivary [-h] [--version] {logs,email,create,adopt,doctor,capabilities,\n"
            "       check,find,decide,review,impact,control} ...\n"
            "vivary: error: unrecognized arguments: --nope\n"
        ),
    },
}
