# Contributing to Selah

Thank you for your interest in helping Selah grow!

Selah is an early-stage, local-first journaling and note-taking app designed to give people a calm place for daily writing, prayer, Scripture study, dreams, testimonies, and the moments they want to remember. The project is still evolving, so thoughtful feedback and practical improvements are especially valuable.

## Ways to contribute

You do not have to contribute code to help. You can:

- Report a reproducible bug or suggest a feature through [GitHub Issues](https://github.com/El3ctricFX/Selah/issues). The bug report and feature request forms are optional; use a blank issue whenever you prefer to write freely.
- Discuss broader ideas and ask questions in [GitHub Discussions](https://github.com/El3ctricFX/Selah/discussions).
- Improve documentation, accessibility, usability, translations, or the interface.
- Submit code fixes and carefully scoped features.
- Help test changes on different Linux distributions and other supported platforms.

## Before you start

1. Search existing issues and discussions to see whether the problem or idea has already been raised.
2. For larger changes, open an issue or discussion first. This helps us agree on the direction before anyone spends significant time implementing it.
3. Keep changes focused. Smaller pull requests are easier to review, test, and maintain.
4. Please be kind and constructive. Selah should be a welcoming project for people with different backgrounds and experience levels. Everyone participating in the project is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Important privacy guidance

Selah is a journaling app, so its data can be deeply personal. **Never include real journal entries, prayer requests, private Scripture notes, personal photos, or real `.selah` files containing personal information in issues, pull requests, screenshots, test fixtures, or logs.** Use invented sample content instead.

Before sharing logs or screenshots, review them and remove names, file paths, account details, tokens, and other private information. Do not upload a user's journal data to third-party services to debug a problem without their explicit consent.

Please keep Selah's local-first approach in mind. Changes that introduce telemetry, cloud storage, accounts, network requests, or new external services should be discussed before implementation and should clearly explain their privacy implications.

If you believe you have found a security vulnerability, do not publish exploit details in a public issue. Follow the private reporting instructions in [SECURITY.md](SECURITY.md).

## Development setup

Selah currently uses React, TypeScript, Vite, and Tauri 2. You'll need Node.js with npm, Rust with Cargo, and the platform-specific dependencies required by Tauri.

1. Fork the repository on GitHub and clone your fork:

   ```bash
   git clone https://github.com/<your-github-username>/Selah.git
   cd Selah
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the desktop app in development mode:

   ```bash
   npm run tauri dev
   ```

   To run only the frontend development server, use:

   ```bash
   npm run dev
   ```

4. Create a branch for your change:

   ```bash
   git switch -c type/short-description
   ```

   For example: `fix/note-save-feedback` or `docs/installation-guide`.

## Making changes

- Follow the style and patterns already used in the codebase. Prefer clear, maintainable TypeScript and avoid unrelated refactoring.
- Keep the interface calm, understandable, and accessible. Avoid adding visual complexity without a clear user benefit.
- Protect users' writing. Saving, editing, importing, exporting, and file operations should handle errors clearly and avoid silent data loss.
- Treat the `.selah` format and persisted data as important compatibility surfaces. If your change touches them, explain the impact, consider existing files, and avoid destructive migrations or silent format changes.
- Do not add dependencies unless they are needed. Explain new dependencies and consider their maintenance, license, size, and privacy implications.
- Add or update documentation when user-facing behavior, setup, or configuration changes.
- If you change the interface, include screenshots when helpful, using invented sample content only.

## Testing your changes

Before opening a pull request, run the checks relevant to your change:

```bash
npm run build
```

For changes to desktop behavior, file access, or other runtime functionality, also test Selah locally when possible:

```bash
npm run tauri dev
```

If you cannot run a check, say so in the pull request and explain what you did verify. Include clear reproduction steps for fixes. The project is under active development, so please do not assume an unimplemented feature is already supported.

## Pull requests

1. Push your branch to your fork and open a pull request against the repository's default branch.
2. Use the pull request template and explain the problem, the approach, and how you tested it.
3. Link related issues where applicable.
4. Respond to review feedback and update your branch as needed. Review may involve questions, revisions, or deciding not to merge a change if it does not fit the project's current direction.

Please do not combine unrelated fixes or large feature changes in one pull request. If your work changes the user experience or data behavior, explain the trade-offs clearly.

## Giving back to Selah

Selah is intended to improve in the open, so contributions should aim to benefit the project and its users—not just a one-off fork. When you discover a fix or improvement that could help other Selah users, please consider sending it upstream so the community can benefit too. Discussion, documentation, testing, and helping other contributors are also meaningful ways to give back.

Selah is licensed under **GNU General Public License v3.0 (GPL-3.0)**. Contributions must be your own work or work you have permission to submit, and must be compatible with the project's license. By submitting a contribution for inclusion in Selah, you agree that it may be distributed as part of the project under GPL-3.0. This community expectation to share useful improvements upstream does not add a legal requirement to submit every private change to the original repository; the license's actual terms govern.

## Thank you

Every thoughtful report, test, discussion, document improvement, and code contribution helps Selah become more dependable and useful. Thank you for being part of that process.
