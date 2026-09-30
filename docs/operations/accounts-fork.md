# T3 Accounts builds and updates

This fork is maintained at [amal-elk/t3code-accounts](https://github.com/amal-elk/t3code-accounts). The upstream source is [pingdotgg/t3code](https://github.com/pingdotgg/t3code). `origin` is the fork; `upstream` is read-only for fetching published releases.

## Installation identity and data

The Mac app is **T3 Accounts**, bundle ID `com.amalelk.t3accounts`. It registers `t3accounts://` and `t3accounts-dev://`, so installing it alongside T3 Code does not replace the official app's URL handlers.

The default T3 home is `~/.t3-accounts`. Production data lives in `~/.t3-accounts/userdata`; implicit desktop development data lives in `~/.t3-accounts/dev`. Electron user data lives in `~/Library/Application Support/t3accounts` (`t3accounts-dev` during development). The fork never adopts the official app's legacy Electron directory. The Mac background-service label is `com.amalelk.t3accounts.service`; Linux uses `t3accounts.service`, so service installation targets our fork rather than the official service. An explicit `T3CODE_HOME` remains available for isolated test homes; do not point it at the running official app's home.

Accounts assignments, manual dates, and notes live in runtime data rather than the installer or Git repository. Retain the data directories when replacing the app. Quit the fork before making a complete backup; keep the previous installer and backup together when testing a new release.

To connect Linear billing and alerts, provide `T3ACCOUNTS_LINEAR_API_KEY` in the server's environment and restart that server. The key stays on the server; it is not part of the account ledger or installer. Without it, saved Linear credit dates still work. The API's subscription billing date and historical alerts do not establish a complete credit balance or expiration ledger.

## Local Apple silicon preview

Use Node 24, the repository's Vite+ CLI, and Rust stable with Xcode command-line tools available. From the fork checkout:

```bash
vp install --frozen-lockfile
node scripts/update-release-package-versions.ts 0.0.44-accounts.1
vp run dist:desktop:dmg:arm64
```

The artifact builder builds the web client, server, and Electron shell from the same checkout and packages them together. It emits `release/T3-Accounts-<version>-arm64.dmg`, the ZIP, `latest-mac.yml`, and updater blockmaps. It does not publish them. The package manifests must carry the same custom version before building so the bundled server reports the installer version.

Local builds are unsigned by default. They are previews installed by hand; macOS may require opening the downloaded app through its security prompt. In-app installation requires matching Developer ID signatures across installed and offered builds. Keep an unsigned preview out of the published update feed.

Versions use `<upstream-version>-accounts.<revision>`, such as `0.0.44-accounts.1`. Increase the final revision for our changes on one upstream version; start at `.1` when incorporating a new upstream release. The installer embeds the fork commit hash for the About panel. The first fork baseline includes eleven upstream commits after `v0.0.44`; subsequent sync candidates follow published stable tags.

## Checked Mac builds and releases

Run **T3 Accounts Mac build** (`accounts-mac.yml`) in this fork's Actions tab. Select a committed fork branch or SHA. Leave `signed` and `publish` false for a downloadable preview artifact. The workflow checks the affected packages, runs focused Accounts and identity tests, builds a Mac arm64 installer and ZIP, verifies the updater files exist, and saves them as one artifact.

For a local fork change, merge the completed branch into fork `main`, increment the custom version consistently, and build that committed revision. For an upstream candidate, build the candidate branch before merging it into fork `main`. The workflow never merges source changes.

To publish, configure this fork's signing credentials, then select both `signed` and `publish`. The workflow requires these repository secrets:

- `ACCOUNTS_CSC_LINK`: base64 Developer ID Application certificate in PKCS#12 format.
- `ACCOUNTS_CSC_KEY_PASSWORD`: certificate password.
- `ACCOUNTS_APPLE_API_KEY`: App Store Connect API key contents.
- `ACCOUNTS_APPLE_API_KEY_ID` and `ACCOUNTS_APPLE_API_ISSUER`: notarization key identity.
- `ACCOUNTS_MACOS_PROVISIONING_PROFILE`: base64 profile for `com.amalelk.t3accounts` and this fork's Apple team.

Set repository variable `ACCOUNTS_APPLE_TEAM_ID`. Signed passkey builds also need `ACCOUNTS_CLERK_PASSKEY_RP_DOMAINS` (comma-separated relying-party hostnames), or `ACCOUNTS_CLERK_PUBLISHABLE_KEY` from which the hostname can be derived. The profile and the relying party's Apple association must authorize our bundle ID and team. Changing the scheme alone does not establish that hosted Clerk or T3 Connect accepts this fork; local provider accounts do not require hosted Connect. Hosted sign-in and passkeys need separate verification with the chosen configuration.

Publishing creates `accounts-v<version>` as a draft in our repository, uploads the installer, ZIP, `latest-mac.yml`, blockmaps, and checksums, verifies the asset names, and only then publishes it as the latest release. Existing releases are never overwritten. If publication fails, inspect the retained draft and assets before retrying. Our release tags deliberately do not match the upstream `v*` release workflow.

The installer always defaults to our GitHub update repository. `T3CODE_DESKTOP_UPDATE_REPOSITORY` can explicitly override the repository at build time; ambient `GITHUB_REPOSITORY` does not select a feed. Custom versions use the `latest` updater channel, with automatic channel detection disabled so `-accounts.1` does not produce a different manifest name. Stay on the Latest channel in the app.

Enable the two `accounts-*.yml` workflows in the fork. Leave upstream deployment/release workflows disabled: they publish additional upstream services and packages and are not our build procedure.

## Incorporating upstream releases

**T3 Accounts upstream release candidate** (`accounts-upstream.yml`) checks the latest published stable upstream release daily. It skips releases already included in fork `main` and avoids creating repeated candidates for the same tag. Manual dispatch accepts a published stable tag such as `v0.0.45`; specifying the tag explicitly allows a fresh candidate from current fork `main`.

The workflow merges into a unique `codex/upstream-<tag>-<run-id>` branch. Version and desktop product-name conflicts are resolved narrowly; competing edits to other manifest fields or source files stop for manual resolution. A successful candidate gets aligned custom versions, focused checks, and a push to our fork. It does not change `main`, create a pull request, publish a release, or force-push. A failed merge saves its conflict paths as an Actions artifact.

Fetch and inspect a successful candidate, run the Mac build on its branch, then merge it into fork `main` after validation. Publish that checked source with the Mac workflow when ready. Upstream updates never enter the installed app directly.

## Remote environments

The desktop-managed local server is bundled and updates with T3 Accounts. A remote environment needs the Accounts server from this fork for the new RPCs and retained fields; an official server may not support them.

This Mac workflow does not publish standalone CLI archives. The fork's CLI release repository is isolated from upstream, but no compatible CLI feed is established by a Mac release. Maintain remote custom servers from a pinned source checkout and rebuild that checkout when updating. Do not use `npx t3` or expect `t3 update`/boot-service self-update to install Accounts code. A CLI release pipeline must exist before enabling those update paths.
