import assert from 'node:assert/strict'
import { extractGithubRefs, extractImageUrls } from '../core/github/issueAssets'

// extractGithubRefs：从需求文本里抠出 issue/PR 链接（去重 + 区分 issue/pr）
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
  // 同一链接出现多次只算一个
  const refs = extractGithubRefs('a https://github.com/o/r/issues/1 b https://github.com/o/r/issues/1')
  assert.equal(refs.length, 1)
}
{
  // 多个不同链接全部抠出
  const refs = extractGithubRefs('https://github.com/o/r/issues/1 and https://github.com/o/r/pull/2')
  assert.equal(refs.length, 2)
}
{
  // 没有链接 → 空
  assert.equal(extractGithubRefs('just a normal requirement text').length, 0)
}

// extractImageUrls：从 issue 正文（HTML <img> + markdown）抠图，只留 GitHub 图片域
{
  const body = '<img width="100" alt="x" src="https://github.com/user-attachments/assets/abc-123" />'
  assert.deepEqual(extractImageUrls(body), ['https://github.com/user-attachments/assets/abc-123'])
}
{
  const body = '![shot](https://private-user-images.githubusercontent.com/1/2.png)'
  assert.deepEqual(extractImageUrls(body), ['https://private-user-images.githubusercontent.com/1/2.png'])
}
{
  // 非 GitHub 图片域被过滤（防 SSRF / 别乱下外部图）
  const body = '<img src="https://evil.example.com/x.png"> ![y](http://internal/y.png)'
  assert.deepEqual(extractImageUrls(body), [])
}
{
  // 去重
  const u = 'https://github.com/user-attachments/assets/dup'
  const body = `<img src="${u}"> <img src="${u}">`
  assert.deepEqual(extractImageUrls(body), [u])
}
{
  // 混合 HTML + markdown，按出现顺序、去重、过滤
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
