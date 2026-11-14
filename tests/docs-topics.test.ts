import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error The docs generator is a plain ES module script without declarations.
import { docsOutputs, readTopics, skillFolder } from '../scripts/docs-topics.mjs';
import { docTopics } from '../src/doc-topics';

type Topic = { id: string; title: string; summary: string; text: string };

test('generated API page, skill references and skill examples match the topic files', async () => {
  const outputs = await docsOutputs(resolve('.')) as Record<string, string>;
  for (const [path, text] of Object.entries(outputs)) {
    assert.equal(await readFile(resolve(path), 'utf8').catch(() => undefined), text, path + ' differs from its source. Edit the topic files in docs/template-api/ (template-api.md is generated), then run npm run generate:docs.');
  }
  for (const folder of ['references', 'examples']) {
    for (const name of await readdir(resolve(skillFolder, folder))) {
      assert.ok(skillFolder + '/' + folder + '/' + name in outputs, skillFolder + '/' + folder + '/' + name + ' has no source.');
    }
  }
});

test('the MCP topic list is the docs manifest, and every topic links only to topics and examples that exist', async () => {
  const topics = await readTopics(resolve('.')) as Topic[];
  assert.deepEqual(docTopics, topics.map(({ id, title, summary }) => ({ id, title, summary })));
  const ids = new Set(topics.map(({ id }) => id));
  const examples = new Set(await readdir(resolve('docs/examples')));
  for (const { id, text } of topics) {
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^https?:/.test(target)) continue;
      const topic = target.match(/^([a-z0-9-]+)\.md$/)?.[1];
      const example = target.match(/^\.\.\/examples(?:\/(.+))?$/);
      assert.ok(topic ? ids.has(topic) : example ? !example[1] || examples.has(example[1]) : false, id + ' links to ' + target);
    }
  }
});

test('the skill maps every topic and example to its reference file', async () => {
  const skill = await readFile(resolve(skillFolder, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: imageflow-templates\ndescription: .{20,1024}\n---\n/);
  for (const { id } of docTopics) assert.ok(skill.includes('(references/' + id + '.md)'), 'SKILL.md does not link ' + id);
  for (const name of await readdir(resolve('docs/examples'))) assert.ok(skill.includes('(examples/' + name + ')'), 'SKILL.md does not link ' + name);
  for (const [, target] of skill.matchAll(/\]\(((?:references|examples)\/[^)]+)\)/g)) {
    await assert.doesNotReject(readFile(resolve(skillFolder, target)), target);
  }
});
