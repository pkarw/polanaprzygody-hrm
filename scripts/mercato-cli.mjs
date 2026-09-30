// Launcher for `mercato` package scripts. Invoking the bare bin name lets the
// shell resolve it through .cmd shims — under Yarn Berry that is a temp PATH
// wrapper holding an absolute UTF-8 path, which cmd.exe decodes with the OEM
// code page and mangles on non-ASCII checkout paths (MODULE_NOT_FOUND with a
// mojibake path). Importing the CLI's JS entry directly keeps every path in
// process, with no batch files anywhere. Works from the monorepo app workspace
// (entry lives in the repo-root node_modules) and from standalone apps (local
// node_modules) via the ancestor walk.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
let currentDir = path.resolve(scriptsDir, '..')
let entry = null
for (;;) {
  const candidate = path.join(currentDir, 'node_modules', '@open-mercato', 'cli', 'bin', 'mercato')
  if (fs.existsSync(candidate)) {
    entry = candidate
    break
  }
  const parentDir = path.dirname(currentDir)
  if (parentDir === currentDir) break
  currentDir = parentDir
}

if (!entry) {
  console.error('Could not find @open-mercato/cli in any node_modules above this app. Run `yarn install` first.')
  process.exit(1)
}

// `mercato init` falls back to the framework's "Acme Corp" placeholder when no
// organization name is given. This app installs itself as Polana Przygody, so
// supply that default here — every install path (`yarn setup`, `yarn initialize`,
// `yarn reinstall`, a bare `yarn mercato init`) goes through this launcher.
// An explicit `--org=`/`--orgName=` on the command line still wins, and
// OM_INIT_ORG_NAME overrides the built-in default for a differently named site.
const DEFAULT_INIT_ORG_NAME = 'Polana Przygody'
const initArgs = process.argv.slice(2)
if (initArgs[0] === 'init' && !initArgs.some((arg) => arg.startsWith('--org=') || arg.startsWith('--orgName='))) {
  const configured = process.env.OM_INIT_ORG_NAME?.trim()
  process.argv.push(`--org=${configured && configured.length > 0 ? configured : DEFAULT_INIT_ORG_NAME}`)
}

await import(pathToFileURL(entry).href)
