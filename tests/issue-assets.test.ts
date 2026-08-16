import assert from 'node:assert/strict'
import { extractGithubRefs, extractImageUrls } from '../core/github/issueAssets'

// extractGithubRefs: pull issue/PR links out of the requirement text (deduped + issue/pr distinguished)
{
  const refs = extractGithubRefs('see https://github.com/octocat/hello-world/issues/7370 thanks')
  assert.equal(refs.length, 1)
  assert.deepEqual(refs[0], { repo: 'octocat/hello-world', kind: 'issue', number: 7370 })
}
{
  const refs = extractGithubRefs('https://github.com/owner/repo/pull/42')
  assert.equal(refs[0]!.kind, 'pr')
  assert.equal(refs[0]!.number, 42)
}
{
  // the same link appearing several times counts as one
  const refs = extractGithubRefs('a https://github.com/o/r/issues/1 b https://github.com/o/r/issues/1')
  assert.equal(refs.length, 1)
}
{
  // several different links are all extracted
  const refs = extractGithubRefs('https://github.com/o/r/issues/1 and https://github.com/o/r/pull/2')
  assert.equal(refs.length, 2)
}
{
  // no links → empty
  assert.equal(extractGithubRefs('just a normal requirement text').length, 0)
}

// extractImageUrls: pull images out of the issue body (HTML <img> + markdown), keeping only GitHub image domains
{
  const body = '<img width="100" alt="x" src="https://github.com/user-attachments/assets/abc-123" />'
  assert.deepEqual(extractImageUrls(body), ['https://github.com/user-attachments/assets/abc-123'])
}
{
  const body = '![shot](https://private-user-images.githubusercontent.com/1/2.png)'
  assert.deepEqual(extractImageUrls(body), ['https://private-user-images.githubusercontent.com/1/2.png'])
}
{
  // non-GitHub image domains are filtered out (SSRF protection / don't go fetching arbitrary external images)
  const body = '<img src="https://evil.example.com/x.png"> ![y](http://internal/y.png)'
  assert.deepEqual(extractImageUrls(body), [])
}
{
  // dedupe
  const u = 'https://github.com/user-attachments/assets/dup'
  const body = `<img src="${u}"> <img src="${u}">`
  assert.deepEqual(extractImageUrls(body), [u])
}
{
  // mixed HTML + markdown: in order of appearance, deduped, filtered
  const body = [
    '<img src="https://github.com/user-attachments/assets/one">',
    '![two](https://github.com/user-attachments/assets/two)',
    '<img src="https://example.com/skip.png">',
  ].join('\n')
  assert.deepEqual(extractImageUrls(body), [
    'https://github.com/user-attachments/assets/one',
    'https://github.com/user-attachments/assets/two',
  ])
}

console.log('issue-assets.test.ts ✓')
