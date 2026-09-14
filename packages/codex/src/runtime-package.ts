// Official standalone packages include the CLI, code-mode host and native resources.
// Keep their checksums pinned with the app-server protocol, never resolve "latest".
export const CODEX_RUNTIME_ARCHIVE = "koma-codex-runtime.tar.gz"
export const CODEX_RUNTIME_VERSION = "0.153.4"
const packages: Record<string, [string, string]> = {
  "darwin-arm64": ["aarch64-apple-darwin", "35438da1fbf7a6db7ddb3bcec84448fa6015ba188461472a97d9d1da7d9c4353"],
  "darwin-x64": ["x86_64-apple-darwin", "3ee638d7155c856ef31f3f4a85cb2195de1939962d3924c935b24f0514564a3d"],
  "linux-arm64": ["aarch64-unknown-linux-musl", "fc395cb043a1093ab0db34f44aba3199bfaa9ce640cd9be7fd588f44b0da64a4"],
  "linux-x64": ["x86_64-unknown-linux-musl", "a822187e1a2420c61c5926721bfbd878701ed95547c9bb0d4de4498a16ba1821"],
  "win32-arm64": ["aarch64-pc-windows-msvc", "ac51b1a5932e07dffcaa6e98f4801f13b25192094739b732fc8b40ddb41bbda2"],
  "win32-x64": ["x86_64-pc-windows-msvc", "a6ef3442cb12766a88b39311d79244289e4f9763e2c53ff4fbebc2cb653cc5f3"],
}

export function codexRuntimePackage(platform = process.platform, arch = process.arch) {
  const entry = packages[`${platform}-${arch}`]
  if (!entry) throw new Error(`Unsupported Codex runtime platform: ${platform}-${arch}`)
  const [target, sha256] = entry
  return {
    target,
    sha256,
    url: `https://github.com/openai/codex/releases/download/rust-v${CODEX_RUNTIME_VERSION}/codex-package-${target}.tar.gz`,
  }
}
