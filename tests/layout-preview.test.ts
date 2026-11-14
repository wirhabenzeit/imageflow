import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutPreviewKey } from '../src/layout-preview';
import type { ProjectSummary, TemplateInfo } from '../src/desktop';

const fixture = () => {
  const summary = { id: 'revision-1', folder: 'Book.imageflow', templateHash: 'template-1', network: [],
    project: { params: { paper: 'white' }, files: { route: 'files/route.gpx' }, spreads: [
      { id: 'one', definition: 'plain', params: {}, boxes: { photo: { params: {}, photo: 'coast' } }, elements: {} },
      { id: 'two', definition: 'plain', params: {}, boxes: {}, elements: {} },
      { id: 'chapter', definition: 'chapter', params: { title: 'Chapter' }, boxes: {}, elements: {} },
    ] }, photoIndex: { coast: { title: 'Coast' }, other: { title: 'Another' } },
    photoRevisions: { coast: 'photo-1' }, photos: { coast: '/render/revision-1/thumb/coast' }, photoSizes: { coast: { width: 1000, height: 1000 } }, texts: {},
    sources: { 'photo:coast': { digest: 'photo-1', state: 'available' }, 'file:route': { digest: 'route-1', state: 'available' } },
  } as unknown as ProjectSummary;
  const template = { format: { label: 'Square' }, spreads: { plain: { span: 'spread' }, chapter: { span: 'spread', declaresAnchors: true } } } as unknown as TemplateInfo;
  return { summary, template, key: () => layoutPreviewKey(summary, template, summary.project.spreads.find(({ id }) => id === 'one')!) };
};

test('layout previews survive unrelated saves and content edits on other spreads', () => {
  const { summary, key } = fixture();
  const before = key();
  summary.id = 'revision-2';
  summary.photos.coast = '/render/revision-2/thumb/coast';
  summary.project.title = 'Renamed metadata';
  summary.project.importMode = 'link';
  summary.project.spreads[1].params.heading = 'Edited elsewhere';
  summary.photoIndex.other.caption = 'Unrelated caption';
  assert.equal(key(), before);
});

test('layout previews invalidate for content, file bytes, anchors, format, template and permissions', () => {
  const changes: ((data: ReturnType<typeof fixture>) => void)[] = [
    ({ summary }) => { summary.project.spreads[0].boxes.photo.crops = { plain: { zoom: 2, centerX: .5, centerY: .5 } }; },
    ({ summary }) => { summary.photoIndex.coast.caption = 'Edited caption'; },
    ({ summary }) => { summary.photoRevisions!.coast = 'new-original'; },
    ({ summary }) => { summary.project.params.paper = 'cream'; },
    ({ summary }) => { summary.project.spreads[2].params.title = 'New anchor title'; },
    ({ summary }) => { summary.project.spreads.reverse(); },
    ({ summary }) => { summary.templateHash = 'template-2'; },
    ({ summary }) => { summary.network = ['https://maps.example']; },
    ({ template }) => { template.format.label = 'Landscape'; },
    ({ summary }) => { summary.sources!['file:route'].digest = 'route-2'; },
    ({ summary }) => { summary.project.files.track = 'files/track.gpx'; },
    // The book index: other spreads' layouts, photo assignments and placed photos' metadata.
    ({ summary }) => { summary.project.spreads[1].definition = 'chapter'; },
    ({ summary }) => { summary.project.spreads[1].boxes.photo = { params: {}, photo: 'other' }; },
    ({ summary }) => { summary.project.spreads[1].boxes.photo = { params: {}, photo: 'other' }; summary.photoIndex.other.credit = 'Someone'; },
  ];
  // A placed photo's credit on another spread changes the preview too.
  const data = fixture();
  data.summary.project.spreads[1].boxes.photo = { params: {}, photo: 'other' };
  const placed = data.key();
  data.summary.photoIndex.other.credit = 'Someone';
  assert.notEqual(data.key(), placed);
  for (const change of changes) {
    const data = fixture(); const before = data.key(); change(data); assert.notEqual(data.key(), before);
  }
});
