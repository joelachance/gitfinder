# GitCP Improvements

This is the saved product/engineering improvement list from the planning discussion.

## Product

1. Make the core loop faster

- faster local filtering on already-fetched results
- stronger empty states
- better command discovery

2. Fix keyboard completeness

- full keyboard support across search, filters, theme, AI, repo drill-down, auth, and dismiss

3. Let users act, not just view

- assign or unassign issue
- copy branch name, PR URL, issue number
- reopen or close issue
- rerun failed workflow
- open latest failing job logs

4. Add saved commands and recents

- recent searches
- pinned repos
- favorite commands
- last-used repo contexts

5. Make `/ai` workflow-native

- summarize current result set
- explain failing CI for the selected repo
- answer in current repo context without retyping owner/repo
- turn AI output into clickable follow-up actions

6. Add repo-scoped mode

- let a chosen repo stay “latched” until cleared
- make `/issues`, `/pr`, `/ci`, `/branches` faster inside that context

7. Improve visual status density

- emphasize failing vs passing
- last run time
- branch
- actor
- workflow name
- failure count

## Desktop App Quality

8. Ship it like a real desktop app

- code signing
- packaged app
- launch at login
- hotkey customization
- file-backed tray/menu bar assets

9. Add resilience and observability

- startup error reporting
- tray creation logging
- renderer crash banner
- explicit auth failure states
- request timeout and rate-limit handling

## Engineering

10. Put tests around the risky paths

- command parsing
- theme persistence
- filter-pill keyboard behavior
- Escape behavior
- repo drill-down navigation
- auth state sync between renderer and tray
