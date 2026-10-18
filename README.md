# pi-devcontainer

Pi extension: run project commands inside the project's devcontainer.

`bash` stays on the host. This extension registers a `devcontainer` tool whose
commands run INSIDE the container, so the two filesystems never silently swap
under the model: the tool result reports both the container path it ran in and
the host path of the same directory, so `read`/`edit`/`write` can target the
same files from the host side.

## Tools

| Tool | What it does |
| --- | --- |
| `devcontainer` | Run a shell command inside the container (`bash -c`, with `cwd`, `stdin`, `timeout`, `tail`, `waitForContainer`). |
| `create_devcontainer` | Create or edit `.devcontainer/devcontainer.json`. First call with no arguments reports the detected stack, the available base images and the ~1440-feature catalog from containers.dev; later calls write the image/features picked. |
| `devcontainer_rebuild` | Re-run `devcontainer up` in the background after editing anything the image is built from. |

The run tool is registered at startup but stays INACTIVE until the container is
actually up, so a project without a devcontainer sees no tool it cannot serve.

## How bring-up works

- If the project directory contains `.devcontainer/devcontainer.json` (or a
  bare `devcontainer.json`) and pi is not already inside a container:
  - with the `devcontainer` CLI, `devcontainer up` runs in the BACKGROUND at
    session start (never blocking the prompt); the first tool call awaits it,
    streaming pull/build progress into the tool row and the status bar;
  - without the CLI, a plain `docker run` fallback mounts the workspace at its
    host path and keeps the container alive — but only for image-based configs;
    build/dockerCompose configs require the CLI.
- Container ports are published on the host as the container opens them,
  announced as `container port -> host 127.0.0.1:<high port>` mappings. Host
  ports come from the ephemeral range so nothing already listening is
  displaced; the run tool's result and `/devcontainer-ports` report the
  mapping, since `localhost:<container port>` is NOT the container's service.

## Session commands

- `/devcontainer` — watch what the bring-up is doing right now.
- `/devcontainer-ports` — list the container ports published on the host.

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
