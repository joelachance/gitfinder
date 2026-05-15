const DOWNLOAD_URL =
  "https://github.com/joelachance/gitfinder/releases/latest/download/GitFinder-0.1.0-arm64.dmg";
const GITHUB_URL = "https://github.com/joelachance/gitcp";

const QUICK_DOCS = [
  {
    title: "Install",
    body: "Download the macOS DMG, open it, and move GitFinder into Applications.",
    code: "open GitFinder-0.1.0-arm64.dmg",
  },
  {
    title: "Sign in",
    body: "Use the menu bar item to sign in once with GitHub OAuth device flow.",
    code: "GitFinder -> Sign In with GitHub",
  },
  {
    title: "Search",
    body: "Press Command-G, type a repo, issue, pull request, CI run, or slash command, then press Enter.",
    code: "Command-G\n/help\n/issues\n/ci owner/repo",
  },
];

const FAQ = [
  {
    question: "What is GitFinder?",
    answer:
      "GitFinder is a small macOS command palette for GitHub. It helps you jump to repos, issues, pull requests, and CI runs without opening GitHub first.",
  },
  {
    question: "Who is it for?",
    answer:
      "Developers who live in GitHub and want a fast, keyboard-first way to get to the right page from anywhere on their Mac.",
  },
  {
    question: "Does it use my GitHub account?",
    answer:
      "Yes. GitFinder signs in with GitHub OAuth device flow so it can search the repos and organization resources your account can access.",
  },
  {
    question: "What does the AI search need?",
    answer:
      "AI features use your local provider keys when configured. Core GitHub navigation works without an AI key.",
  },
  {
    question: "Is there a Windows or Linux build?",
    answer:
      "Not yet. The current download is a macOS DMG for Apple silicon.",
  },
];

function DownloadButton({ className = "" }: { className?: string }) {
  return (
    <a
      href={DOWNLOAD_URL}
      download
      className={`inline-flex h-10 items-center justify-center rounded-md bg-black px-4 text-sm font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black ${className}`}
    >
      Download macOS
    </a>
  );
}

function SectionTitle({
  kicker,
  title,
}: {
  kicker: string;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs uppercase tracking-[0.18em] text-[var(--git-orange)]">
        {kicker}
      </p>
      <h2 className="text-2xl font-medium tracking-normal sm:text-3xl">
        {title}
      </h2>
    </div>
  );
}

export default function Home() {
  return (
    <main className="min-h-screen bg-white text-black">
      <header className="border-b border-black/10">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <a href="#" className="text-sm font-medium">
            GitFinder
          </a>
          <nav className="flex items-center gap-4 text-sm">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="text-black/65 transition-colors hover:text-black"
            >
              GitHub
            </a>
            <DownloadButton />
          </nav>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-5xl flex-col px-5 py-12 sm:px-8 sm:py-16">
        <section className="flex flex-col gap-8">
          <div className="flex max-w-3xl flex-col gap-4">
            <p className="text-xs uppercase tracking-[0.18em] text-[var(--git-orange)]">
              GitHub command palette for macOS
            </p>
            <h1 className="text-5xl font-medium tracking-normal sm:text-7xl">
              GitFinder
            </h1>
            <p className="max-w-2xl text-base leading-7 text-black/65 sm:text-lg">
              Search repos, issues, pull requests, and CI from a tiny
              keyboard-first palette. Press Command-G, type what you need, and
              jump straight to GitHub.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <DownloadButton className="h-11 px-5" />
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-11 items-center justify-center rounded-md border border-black/15 px-5 text-sm font-medium transition-colors hover:border-black/35"
              >
                View on GitHub
              </a>
            </div>
          </div>

          <video
            className="aspect-[720/470] w-full border border-black/10 bg-white"
            src="/demo.mp4"
            autoPlay
            muted
            loop
            playsInline
            controls
          />
        </section>

        <section className="mt-16 border-t border-black/10 pt-10 sm:mt-20">
          <SectionTitle kicker="Quick docs" title="Install, sign in, search." />
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {QUICK_DOCS.map((item) => (
              <article
                key={item.title}
                className="flex min-h-64 flex-col justify-between gap-6 border border-black/10 p-5"
              >
                <div className="flex flex-col gap-3">
                  <h3 className="text-base font-medium">{item.title}</h3>
                  <p className="text-sm leading-6 text-black/65">{item.body}</p>
                </div>
                <pre className="overflow-x-auto bg-neutral-50 p-4 text-xs leading-6 text-black">
                  <code>{item.code}</code>
                </pre>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-16 border-t border-black/10 pt-10 sm:mt-20">
          <SectionTitle kicker="Usage" title="Built for repeated GitHub jumps." />
          <div className="mt-8 grid gap-px overflow-hidden border border-black/10 bg-black/10 md:grid-cols-2">
            {[
              "Search issues and pull requests across accessible repos.",
              "Open GitHub pages directly from the palette.",
              "Use slash commands for help, issues, CI, and repo views.",
              "Keep the app in the menu bar and summon it with Command-G.",
            ].map((item) => (
              <div key={item} className="bg-white p-5 text-sm leading-6">
                {item}
              </div>
            ))}
          </div>
        </section>

        <section className="mt-16 border-t border-black/10 pt-10 sm:mt-20">
          <SectionTitle kicker="FAQ" title="Small answers." />
          <div className="mt-8 divide-y divide-black/10 border-y border-black/10">
            {FAQ.map((item) => (
              <details key={item.question} className="group py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-base font-medium">
                  {item.question}
                  <span className="text-[var(--git-orange)] transition-transform group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="mt-4 max-w-3xl text-sm leading-6 text-black/65">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </section>
      </div>

      <footer className="border-t border-black/10">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-5 py-6 text-xs text-black/55 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <span>GitFinder for macOS.</span>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-black"
          >
            GitHub
          </a>
        </div>
      </footer>
    </main>
  );
}
