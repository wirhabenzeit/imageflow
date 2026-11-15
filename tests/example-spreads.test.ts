import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TemplateInfo } from '../src/desktop';
import type { SpreadState } from '../src/project';
import { exampleSpreadStates, examplesDiffer } from '../src/example-spreads';

const info: Pick<TemplateInfo, 'spreads' | 'openingSpreads'> = {
  spreads: {
    story: {
      label: 'Story', span: 'spread',
      parameters: {
        heading: { type: 'string', label: 'Heading', default: '' },
        framed: { type: 'boolean', label: 'Framed', default: true },
        columns: { type: 'integer', label: 'Columns', default: 1 },
        tone: { type: 'enum', label: 'Tone', default: 'light', options: ['light', 'dark'] },
      },
      boxes: {
        hero: { type: 'photo', label: 'Photo', parameters: {
          caption: { type: 'boolean', label: 'Caption', default: false },
          shape: { type: 'enum', label: 'Shape', default: 'rect', options: ['rect', 'arch'] },
          note: { type: 'string', label: 'Note', default: '' },
        } },
        body: { type: 'markdown', label: 'Text', parameters: {} },
      },
      elements: {
        route: { label: 'Route', parameters: {
          track: { type: 'file', label: 'GPX track', default: '', accept: ['.gpx'] },
          zoom: { type: 'number', label: 'Zoom', default: 8 },
        } },
      },
    },
    closing: { label: 'Closing', span: 'spread', parameters: {}, boxes: {}, elements: {} },
  },
  openingSpreads: [{ layout: 'story', params: {} }, { layout: 'closing', params: {} }],
};

const sample: SpreadState[] = [
  {
    id: 'arriving', definition: 'story',
    params: { heading: 'Arriving', framed: false, columns: 2, tone: 'dark', undeclared: true },
    boxes: {
      hero: { photo: 'segla', crops: { story: { centerX: 0.4, centerY: 0.5, zoom: 2 } }, params: { caption: true, shape: 'arch', note: 'Senja' } },
      body: { text: 'arrival', params: {} },
      gone: { photo: 'shore', params: { caption: true } },
    },
    elements: { route: { params: { track: 'senja-road', zoom: 10 } } },
  },
  { id: 'removed-layout', definition: 'panorama', params: {}, boxes: { hero: { photo: 'light', params: {} } }, elements: {} },
  { id: 'end', definition: 'closing', params: { colophon: 'Made with ImageFlow' }, boxes: {}, elements: {} },
];

test('example spreads keep the layouts and their settings but none of the sample content', () => {
  const examples = exampleSpreadStates(sample, info);
  assert.deepEqual(examples.map(({ definition }) => definition), ['story', 'closing'], 'layouts the template no longer declares are left out');
  const [story, closing] = examples;
  assert.deepEqual(story.params, { framed: false, columns: 2, tone: 'dark' }, 'switches, numbers and choices stay; text goes');
  assert.deepEqual(story.boxes, { hero: { params: { caption: true, shape: 'arch' } } }, 'no photos, texts or crops');
  assert.deepEqual(story.elements, { route: { params: { zoom: 10 } } }, 'file references go');
  assert.deepEqual(closing, { ...closing, params: {}, boxes: {}, elements: {} });
  assert.ok(examples.every(({ id }) => !sample.some((spread) => spread.id === id)), 'each example spread gets a new ID');
  assert.notEqual(exampleSpreadStates(sample, info)[0].id, story.id);
});

test('example spreads are offered only when they differ from the opening spreads', () => {
  assert.equal(examplesDiffer(exampleSpreadStates(sample, info), info), false, 'the same layouts in the same order');
  assert.equal(examplesDiffer(exampleSpreadStates([sample[0]], info), info), true);
  assert.equal(examplesDiffer(exampleSpreadStates([sample[2], sample[0]], info), info), true);
});
