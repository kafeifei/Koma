// Official standalone packages include the CLI, code-mode host and native resources.
// Keep their checksums pinned with the app-server protocol, never resolve "latest".
export const CODEX_RUNTIME_ARCHIVE = "koma-codex-runtime.tar.gz"
export const CODEX_RUNTIME_VERSION = "0.154.0"
const packages: Record<string, [string, string]> = {
  "darwin-arm64": ["aarch64-apple-darwin", "427ca74c027049e0cd1a330d611e7f8d1fe0f1eb6a6d85ac16f61bcf2cb4a485"],
  "darwin-x64": ["x86_64-apple-darwin", "8052c6accbe0361bfbd424a10aa5f2226636ed8afb6dcbd5e6437993e57b16d8"],
  "linux-arm64": ["aarch64-unknown-linux-musl", "97d93e11df72d3c26772db019e6ea8bb72c246500d46b98c760839f3240355e6"],
  "linux-x64": ["x86_64-unknown-linux-musl", "fc6e3e3b85f2cf7d664520ee5c66a7fe4aa12bae7d46834f47e2f165fd0d6f78"],
  "win32-arm64": ["aarch64-pc-windows-msvc", "fcd888733e50e40acaf4278bedfbf4245cb2b934c99c6e5b263da850fd9f90c2"],
  "win32-x64": ["x86_64-pc-windows-msvc", "94cc5b3632769504c809f6c0364b693c0dfddc5c30c8361095d2263a07ac45a4"],
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
