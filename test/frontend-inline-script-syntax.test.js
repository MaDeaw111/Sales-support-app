import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function inlineScriptsFromHtml(html) {
  const scripts = [];
  const openTag = /<script\b[^>]*>/gi;
  let match;

  while ((match = openTag.exec(html))) {
    const tag = match[0];
    const closeIndex = html.indexOf('</script>', openTag.lastIndex);
    assert.notEqual(closeIndex, -1, 'every script element must have a closing tag');

    if (!/\bsrc\s*=/i.test(tag)) {
      scripts.push(html.slice(openTag.lastIndex, closeIndex));
    }

    openTag.lastIndex = closeIndex + '</script>'.length;
  }

  return scripts;
}

test('every inline frontend script parses as JavaScript', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const scripts = inlineScriptsFromHtml(html);

  assert.ok(scripts.length > 0, 'the frontend must contain an inline script to validate');
  scripts.forEach((script, index) => {
    assert.doesNotThrow(
      () => new vm.Script(script, { filename: `public/index.html:inline-script-${index + 1}` }),
      `inline script ${index + 1} must not contain raw HTML outside a JavaScript string`
    );
  });
});
