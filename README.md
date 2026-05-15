# gitfinder

**gitfinder** is a tiny command palette for developers. press **⌘G**, sign in with GitHub, and interact with your code, just as you do in Github.

You can search repos, issues, pull up ci jobs, and use ai to search Github.

vim bindings, and Enter to navigate to the Github page.

This is for anyone who lives in GitHub and wants a **fast, keyboard-first** way to jump to the right page without navigating the Github website.

![gitfinder in action — search issues and PRs, open in the browser](demos/pr.gif)

## How it works

1. **Install and run** the  app on your machine ([Bun](https://bun.sh) + `bun install` / `bun run start` from this repo. website & .dmg coming soon).
2. **Sign in once** with **GitHub OAuth** (device flow). **Your email and name is collected for usage purposes.**
3. Open the command palette using **⌘G**.
4. /help to get started. All commands are slash commands, which you can find in the help menu.
5.**Escape** hides the command palette while the app keeps running and preserves search state. Drag the top strip to move the palette.

## Who it’s for

Anyone who lives in GitHub issues and PRs and wants a **fast, keyboard-first** way to jump to the right thread without leaving their editor flow for long.

## Get started (developers)

- **Requirements:** [Bun](https://bun.sh) (install and `bun x electron`), and a **GitHub OAuth App** with **Device Flow** enabled. Copy [`.env.example`](.env.example) to `.env` and set `GITFINDER_GITHUB_CLIENT_ID` if you are not using the bundled defaults. Optional env: `INGEST_API_KEY` / `INGEST_API_KEYS`, `GITFINDER_EMAIL_INGEST_URL` for the sign-in email ingest path.

```bash
bun install
bun run start
```

On Linux, if you hit Electron sandbox errors as root, you may use `bun x electron . --no-sandbox`.

## License
MIT.
