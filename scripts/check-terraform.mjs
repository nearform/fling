// The Terraform gate (part of `pnpm gate`): platforms/aws/infra is formatted (`terraform fmt`) and
// valid, checked through its example root module (the module alone can't be validated: it takes
// an aliased provider from its caller), and its tests (`terraform test`, infra/tests/*.tftest.hcl:
// plans against mocked AWS providers). Offline apart from downloading the providers on first run;
// never talks to AWS (`init -backend=false`, validate reads no state, the tests mock AWS).
//
// Without terraform on PATH this skips with a notice, so the gate still passes on a laptop without
// it. In CI (CI=true; ci.yml installs it) a missing terraform fails instead.
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const MODULE = 'platforms/aws/infra'
const EXAMPLES = ['platforms/aws/infra/examples/basic']

if (spawnSync('terraform', ['version'], { stdio: 'ignore' }).error) {
  if (process.env.CI) {
    console.error('check-terraform: terraform is not installed (ci.yml sets it up)')
    process.exit(1)
  }
  console.log(
    'check-terraform: skipped, terraform not found (install it to check platforms/aws/infra)'
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

run(['fmt', '-check', '-recursive', '-diff', MODULE])
for (const dir of EXAMPLES) {
  const cwd = `${root}${dir}`
  run(['init', '-backend=false', '-input=false', '-no-color'], cwd)
  run(['validate', '-no-color'], cwd)
}
run(['init', '-backend=false', '-input=false', '-no-color'], `${root}${MODULE}`)
run(['test', '-no-color'], `${root}${MODULE}`)
console.log(`check-terraform: ok (fmt ${MODULE}; validate ${EXAMPLES.join(', ')}; test ${MODULE})`)
