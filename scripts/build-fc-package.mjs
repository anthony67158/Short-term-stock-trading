import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const output = path.join(root, '.fc-package')
const runtime = path.join(root, 'fc-runtime')
const rootPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const runtimePackage = JSON.parse(
  readFileSync(path.join(runtime, 'package.json'), 'utf8'),
)

if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  throw new Error('dist is missing; run npm run build first')
}

rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })

for (const name of ['api', 'shared', 'dist', 'public', 'harness']) {
  cpSync(path.join(root, name), path.join(output, name), { recursive: true })
}
cpSync(path.join(root, 'server.js'), path.join(output, 'server.js'))

for (const [name, version] of Object.entries(runtimePackage.dependencies || {})) {
  if (rootPackage.dependencies?.[name] !== version) {
    throw new Error(
      `FC runtime dependency mismatch for ${name}: ${version} != ${rootPackage.dependencies?.[name] || 'missing'}`,
    )
  }
}
cpSync(path.join(runtime, 'package.json'), path.join(output, 'package.json'))
cpSync(
  path.join(runtime, 'package-lock.json'),
  path.join(output, 'package-lock.json'),
)

const installArgs = [
  'ci',
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  '--prefer-offline',
  '--registry=https://registry.npmjs.org/',
  '--fetch-retries=5',
  '--fetch-retry-mintimeout=10000',
  '--fetch-retry-maxtimeout=120000',
]

execFileSync('npm', installArgs, {
  cwd: output,
  stdio: 'inherit',
})

console.log(`FC package ready: ${output}`)
