import assert from 'node:assert/strict'
import { projectForPath } from '../core/runs/adopt'

// Project-less directory sessions are adopted by the project whose clone contains them — exact path or inside it,
// never a sibling that merely shares the prefix.
const projects = [
  { id: 'app', localPath: '/Users/x/work/app' },
  { id: 'mobile', localPath: '/Users/x/work/app-mobile/' }, // trailing slash tolerated
  { id: 'nopath', localPath: null },
]
assert.equal(projectForPath(projects, '/Users/x/work/app'), 'app')
assert.equal(projectForPath(projects, '/Users/x/work/app/src'), 'app')
assert.equal(projectForPath(projects, '/Users/x/work/app-mobile'), 'mobile')
assert.equal(projectForPath(projects, '/Users/x/work/app-mobile/lib'), 'mobile')
assert.equal(projectForPath(projects, '/Users/x/work/appx'), null)
assert.equal(projectForPath(projects, '/Users/x/work'), null)
assert.equal(projectForPath(projects, null), null)
console.log('runs-adopt: ok')
