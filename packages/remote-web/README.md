# OpenCode Lab Remote Web

This package provides the browser entry point and backend-for-frontend for OpenCode Lab remote access. The browser signs in with GitHub, lists the current account's labelled Microsoft Dev Tunnels, and opens an online device. Tasks continue to run on that device.

GitHub authorization requests `read:user` and `read:org`; the tunnel service requires both even for owner-only devices. An existing authorization without `read:org` must be renewed by signing out and signing in again.

GitHub device codes, access tokens, and refresh tokens stay in an encrypted, authenticated `HttpOnly` session cookie. API responses expose only the one-time user code, account identity, and credential-free device projections. Sessions have a 30-day absolute expiration that is preserved when credentials rotate.

Production entry point: [opencode-lab-remote.vercel.app](https://opencode-lab-remote.vercel.app).

## Configuration

- `REMOTE_WEB_ORIGIN`: the exact public HTTPS origin, without credentials, a path, query, or fragment. Local development also accepts loopback HTTP origins.
- `SESSION_SECRET`: at least 32 bytes encoded as hexadecimal. Generate one with `openssl rand -hex 32` and keep it in the deployment's secret store.

Run `bun run dev` from this directory for an isolated loopback development server. Run `bun run typecheck`, `bun run test`, and `bun run build` before deployment.

For a Vercel project, set **Root Directory** to `packages/remote-web` and enable access to source files outside that directory. The latter is required for the repository's root `bun.lock` and the workspace dependency on `@opencode-ai/remote`. The five public API routes use explicit JavaScript function entry points under `api/`. `bun run build` first bundles the website server and shared workspace code into `dist-server/vercel.js`, leaving Microsoft SDK dependencies for Vercel to trace. This avoids deployed JavaScript retaining imports or workspace exports that point to TypeScript source files.

Set the install command to `bun install --frozen-lockfile --filter @opencode-ai/remote-web --ignore-scripts`, the build command to `bun run build`, and the output directory to `dist`. Store both configuration values in the Production environment before deploying.

The default public GitHub OAuth client identifier follows the Code OSS implementation used by Sandy. Its provenance and license are recorded in [`../remote/NOTICE`](../remote/NOTICE). GitHub may therefore display **Visual Studio Code** on the authorization page. Using a separately registered OAuth app requires passing its client identifier consistently through the shared module's login, polling, and refresh calls; there is no website configuration switch for that integration yet.

The tunnel service performs its own access check. A browser may be asked to authorize with the same
GitHub account before displaying the workbench. The website does not make a tunnel public or forward
workspace traffic through Vercel. A successful static build does not verify deployment, GitHub consent,
or the browser's authenticated connection to a real sharing computer.
