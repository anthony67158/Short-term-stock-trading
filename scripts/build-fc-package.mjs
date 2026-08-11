import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const output = path.join(root, '.fc-package')
const rootPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  throw new Error('dist is missing; run npm run build first')
}

rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })

for (const name of ['api', 'shared', 'dist', 'public']) {
  cpSync(path.join(root, name), path.join(output, name), { recursive: true })
}
cpSync(path.join(root, 'server.js'), path.join(output, 'server.js'))

const runtimePackage = {
  name: rootPackage.name,
  version: rootPackage.version,
  private: true,
  type: 'module',
  dependencies: {
    '@alicloud/eas20210701': rootPackage.dependencies['@alicloud/eas20210701'],
    '@alicloud/openapi-core': rootPackage.dependencies['@alicloud/openapi-core'],
    'ali-oss': rootPackage.dependencies['ali-oss'],
    'web-push': rootPackage.dependencies['web-push'],
  },
}
writeFileSync(path.join(output, 'package.json'), JSON.stringify(runtimePackage, null, 2) + '\n')

execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: output,
  stdio: 'inherit',
})

console.log(`FC package ready: ${output}`)
