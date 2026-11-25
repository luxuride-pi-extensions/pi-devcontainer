# pi-devcontainer

Pi extension: run project commands inside a project's devcontainer.

`bash` stays on the host. This extension registers a `devcontainer` tool whose
commands run INSIDE the container, so the two filesystems never silently swap
under the model: the tool result reports both the container path it ran in and
the host path of the same directory, so `read`/`edit`/`write` can target the
same files from the host side.

## Tools

| Tool | What it does |
| --- | --- |
| `devcontainer` | Run a shell command inside the container (`bash -c`, with `cwd`, `stdin`, `timeout`, `tail`, `waitForContainer`). `project` targets another directory's container. |
| `create_devcontainer` | Create or edit `.devcontainer/devcontainer.json`. First call with no arguments reports the detected stack, the available base images and the ~1440-feature catalog from containers.dev; later calls write the image/features picked. `project` targets another directory. |
| `devcontainer_rebuild` | Re-run `devcontainer up` in the background after editing anything the image is built from. `project` targets another directory's config. |

The run tool is registered at startup but stays INACTIVE until the container is
actually up, so a project without a devcontainer sees no tool it cannot serve.

## How bring-up works

- If the project directory contains `.devcontainer/devcontainer.json` (or a
  bare `devcontainer.json`) and pi is not already inside a container:
  - with the `devcontainer` CLI, `devcontainer up` runs in the BACKGROUND at
    session start (never blocking the prompt); the first tool call awaits it,
    streaming pull/build progress into the tool row and the status bar;
  - without the CLI, a plain engine-run fallback (`docker run`, `podman run`)
    mounts the workspace at its host path and keeps the container alive — but
    only for image-based configs; build/dockerCompose configs require the CLI.
- Container ports are published on the host, announced as `container port ->
  host 127.0.0.1:<high port>` mappings. Where the container has a routable
  address (Docker) a port the container opens LATER is relayed to a free
  ephemeral host port, so nothing already listening is displaced; where it does
  not (rootless Podman) the ports published at create time — `appPort` — are
  reported instead, with a warning when nothing is declared. The run tool's
  result and `/devcontainer-ports` report the mapping, since
  `localhost:<container port>` is NOT the container's service.

## Container engine: Docker or Podman

Both are driven through the same Docker-compatible command surface; the engine
is resolved once per session, in this order:

1. `PI_DEVCONTAINER_ENGINE` — `docker`, `podman`, `auto`, or a command/path;
   anything matching `podman` is Podman, everything else Docker.
2. `docker`, when `docker info` answers — the DAEMON, not the client, so a
   client with a stopped daemon is not an engine.
3. `podman`, when `podman info` answers.
4. Otherwise Docker, with a warning naming both failures and the variable.

The resolved engine is used everywhere: `devcontainer up --docker-path
<podman>` (plus `--docker-compose-path podman-compose` when compose is there),
`devcontainer exec`, liveness checks, and the CLI-less fallback. Those flags
are only added when the engine is not a plain `docker`, so a Docker setup —
including an older CLI that does not know them — behaves exactly as before.

| | Docker | Podman |
| --- | --- | --- |
| socket mounted by `shareHostDocker` | `/var/run/docker.sock` | the user's `$XDG_RUNTIME_DIR/podman/podman.sock`, mounted AT `/var/run/docker.sock` so in-container tools still find it (Linux only) |
| relaying a port opened after start | yes (socat to the container IP) | no: a rootless container's address is the host's own, so nothing is routable — only ports published at create time are reachable |

`appPort` in `devcontainer.json` is therefore how a port reaches the host
under rootless Podman (`"appPort": [3000]`, or
`"127.0.0.1:8080:3000"` to pin the host port). The CLI passes it to the engine
at create time and the extension reports the mapping without relaying; the
CLI-less fallback publishes `appPort` itself.

Podman notes: `systemctl --user start podman.socket` for `shareHostDocker`;
compose configs need `podman-compose` on `PATH`; rootless Podman cannot bind
host ports below 1024.

## Other projects

A session anchored in one project can also work in a sibling checkout whose
devcontainer is different. Pass the host directory as the tools' `project`
parameter (absolute, or relative to the session directory) — relative paths
resolve against the session directory. The first bring-up for that directory
still has to happen once: either by starting a session there, or by calling
`create_devcontainer` with `project` pointed at it. Afterwards `devcontainer`,
`create_devcontainer` and `devcontainer_rebuild` all accept `project`, each
project keeps its own container, config and port mappings, and the run tool
reports the `project` it targeted. Omitting `project` keeps every tool
anchored to the session's own project.

## Session commands

- `/devcontainer` — watch what the bring-up is doing right now.
- `/devcontainer-ports` — list the container ports published on the host,
  across every project this session brought up.

## Global override

`~/.devcontainer/pi-override.json` (JSONC) is applied to every project's
devcontainer:

```jsonc
{
  "features": { /* merged via devcontainer up --additional-features */ },
  "provision": [ "bash -lc command lines run once per container" ]
}
```

Provisioning is idempotent (marker file in the container's `$HOME`) and
best-effort: a failure warns and the tools stay available.

## Install

```bash
pi install npm:@luxuride-pi/devcontainer
```

The extension is TypeScript loaded from source; there is no build step.

## Releases

Every release is both a **git tag** and an npm package. The package publishes
as `@luxuride-pi/devcontainer` from the release workflow via npm trusted
publishing (OIDC from GitHub Actions — no publish token exists anywhere).

pi can also install this extension from a **git ref**: pi clones, checks out
the ref, runs `npm install --legacy-peer-deps`, and loads the extension's
TypeScript straight from source — so a tag *is* the artifact; there is no
build step and nothing to compile.

### Install a release

```bash
pi install npm:@luxuride-pi/devcontainer@^<version>
# or, pinned to a git tag:
pi install git:github.com/luxuride-pi-extensions/pi-devcontainer@v<version>
```

### Cut a release

1. Bump `version` in `package.json` and commit that on its own.
2. Tag the commit that contains the bump — the tag and the version must agree:
   ```bash
   git tag v<version> && git push origin master --tags
   ```
3. `.github/workflows/release.yml` packs the tarball, checks it, and publishes
   the release with generated notes.

The workflow refuses to guess: it fails when the tag is not on the commit being
released, and again when the tag does not match `package.json`'s `version`.
Bump the version *before* tagging; the tag is not the place to bump.

## License

MIT
