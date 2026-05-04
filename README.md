# GitCP (Git Command Palette)

Minimal v0.1: a global shortcut opens a small window. Sign in with **GitHub OAuth only**, search **issues and pull requests** with the GitHub Search API, and press **Enter** to open the **canonical** `html_url` for that item in your browser.

## Requirements

- [Bun](https://bun.sh) (used for install and `bun x electron`)
- A **GitHub OAuth App** (not a GitHub App installation)

## GitHub OAuth app setup

1. Create an OAuth app: GitHub → **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App**.
2. **Authorization callback URL** must be exactly:

   `http://127.0.0.1:53682/callback`

   (This matches the default loopback port. To use another port, set `GITCP_OAUTH_PORT` and use the same URL with that port in the GitHub app settings.)
3. Copy the **Client ID** and generate a **Client secret**.

## Environment

**Option A — `.env` file (recommended)**  

In the project root, copy [`.env.example`](.env.example) to **`.env`** and add your values:

```bash
cp .env.example .env
# edit .env — it is gitignored
```

The app loads **`.env`** and **`.env.local`** (local overrides) on startup from the same directory as `package.json`.

| Variable | Required | Description |
|----------|----------|-------------|
| `GITCP_GITHUB_CLIENT_ID` | Yes | OAuth App Client ID |
| `GITCP_GITHUB_CLIENT_SECRET` | Yes | OAuth App client secret |
| `GITCP_OAUTH_PORT` | No | Loopback port (default `53682`); must match the callback URL on GitHub |

**Option B — shell**  

```bash
export GITCP_GITHUB_CLIENT_ID="your_client_id"
export GITCP_GITHUB_CLIENT_SECRET="your_client_secret"
```

## Run

```bash
bun install
bun run start
```

On Linux, if you see a sandbox error when running as root, you can start the binary with `--no-sandbox` (only when you understand the tradeoff), e.g. `bun x electron . --no-sandbox`.

## Opening GitCP (shortcut + tray)

GitCP registers **several** global shortcuts when possible (you’ll see which ones worked in the footer):

| Priority (macOS) | Typical binding |
|------------------|------------------|
| 1 | **⌘+Shift+P** |
| 2 | **⌘+⌥+P+R** (if Electron accepts it on your OS) |
| 3 | **⌘+Option+P** |
| 4 | **⌥+Space** |

Windows/Linux: **Ctrl+Shift+P**, **Ctrl+Alt+P+R**, **Ctrl+Alt+P**, **Alt+Space**.

If **none** of them register (system shortcuts already taken), use the **menu bar** icon on macOS or **system tray** on Windows/Linux — click it to open the palette.

**Technical note:** The preload script must load correctly (`preload.cjs`). If the UI shows “preload failed”, reinstall deps or run `bun install` from this repo.

**Window:** Frameless composer-style panel; **Escape** hides it; the app **stays running** and keeps search state. **Drag** the top strip to move.

**Quit:** Tray/menu → **Quit**, or **⌘+Q** / **Alt+F4** when focused (depending on OS).

## What v0.1 does not include

- Personal access tokens (OAuth only)
- GitHub Enterprise host switching
- Persistent search cache / SQLite
- Installers and code signing (use `bun run start` for local use)

## License

MIT (match your repo policy if different).
