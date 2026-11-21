// The Terraform gate (part of `pnpm gate`): every platform's module (`platforms/*/infra`) is
// formatted (`terraform fmt`) and valid, checked through its example root modules
// (`infra/examples/*`: a module alone can't always be validated, as AWS's takes an aliased provider
// from its caller; one without examples is validated as it is), and passes its tests (`terraform test`, `infra/tests/*.tftest.hcl`: plans
// against mocked providers) when it has any. Offline apart from downloading the providers on first
// run; never talks to a cloud (`init -backend=false`, validate reads no state, the tests mock the
// providers).
//
// Without terraform on PATH this skips with a notice, so the gate still passes on a laptop without
// it. In CI (CI=true; ci.yml installs it) a missing terraform fails instead.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** The subdirectories of `dir` (relative to the repo), sorted; none when it doesn't exist. */
const dirsIn = dir =>
  existsSync(join(root, dir))
    ? readdirSync(join(root, dir), { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => `${dir}/${d.name}`)
        .sort()
    : []

const MODULES = dirsIn('platforms')
  .map(platform => `${platform}/infra`)
  .filter(module => existsSync(join(root, module)))

if (MODULES.length === 0) {
  console.log('check-terraform: no platforms/*/infra modules')
  process.exit(0)
}

if (spawnSync('terraform', ['version'], { stdio: 'ignore' }).error) {
  if (process.env.CI) {
    console.error('check-terraform: terraform is not installed (ci.yml sets it up)')
    process.exit(1)
  }
  console.log(
    `check-terraform: skipped, terraform not found (install it to check ${MODULES.join(', ')})`
  )
  process.exit(0)
}

const env = { ...process.env, TF_IN_AUTOMATION: '1' }
const run = (args, cwd = root) => {
  try {
    execFileSync('terraform', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    console.error(`check-terraform: terraform ${args.join(' ')} failed in ${cwd}`)
    console.error(`${error.stdout ?? ''}${error.stderr ?? ''}`)
    process.exit(1)
  }
}

const done = []
for (const module of MODULES) {
  run(['fmt', '-check', '-recursive', '-diff', module])
  // A module without examples is validated as it is.
  const examples = dirsIn(`${module}/examples`)
  for (const dir of examples.length ? examples : [module]) {
    const cwd = join(root, dir)
    run(['init', '-backend=false', '-input=false', '-no-color'], cwd)
    run(['validate', '-no-color'], cwd)
  }
  const tests = existsSync(join(root, module, 'tests'))
    ? readdirSync(join(root, module, 'tests')).filter(f => f.endsWith('.tftest.hcl'))
    : []
  if (tests.length > 0) {
    run(['init', '-backend=false', '-input=false', '-no-color'], join(root, module))
    run(['test', '-no-color'], join(root, module))
  }
  done.push(
    `fmt ${module}; validate ${examples.join(', ') || module}; ${tests.length ? `test ${module}` : 'no tests'}`
  )
}
console.log(`check-terraform: ok (${done.join('; ')})`)
