# Content–template contract

Status: proposal for discussion. This document describes a possible architecture, not an implemented API or a set of final decisions. TypeScript and JSX examples are illustrative.

## Purpose

Imageflow should let users work visually with photographs and text while templates define page design. Templates should be simple to author in code, potentially with a coding agent, and interchangeable where their content requirements are compatible.

The contract must accommodate:

- Photo layouts with associated captions and standalone text.
- A continuous story flowing through linked text frames, including frames on later pages.
- Optional regions that accept a photograph, body text, or no content.
- Parameterized components, such as a calendar with a selected month and year.
- Explicit handling of content that cannot be displayed after a template switch.

The central question is how much publishing meaning belongs in the contract. A contract consisting only of images and strings loses relationships; an exhaustive publishing model restricts future uses.

## Current prototype

In `src/book.ts`, layouts declare photo and text frames. A spread stores content keyed by frame identifiers such as `photo1` and `caption2`. Switching layouts changes the layout identifier and retains those maps.

This preserves values, but identifier reuse does not guarantee equivalent meaning: a caption may describe a spread in one template and a particular photo in another. Text is currently broken into lines independently for each frame, with excess text reported as overflow.

`src/bookRender.ts` resolves content and frame geometry into layers consumed by the SVG editor and Swift PDF exporter. This intermediate representation is worth preserving and extending.

## Proposed separation

Content records what the user wants to communicate. Templates describe how it can appear. Bindings connect the two.

| Layer | Responsibility | Examples |
| --- | --- | --- |
| Content | Meaningful material independent of a particular layout | Stories, photographs, editorial captions, dates |
| Template | Accepted inputs and presentation rules | Geometry, typography, component definitions, default flow order |
| Binding | Assignment of document content to template inputs | A figure assigned to a photo region; a story assigned to a flow |
| Presentation state | Adjustments for a particular composition | Crop, zoom, explicitly permitted style overrides |
| Resolved layout | Derived output for preview and export | Positioned images, laid-out text fragments, diagnostics |

These are conceptual boundaries, not necessarily separate files or services.

A template declaring an input does not own the supplied value. A calendar component declares a month/year parameter schema; the selected month/year belongs to the document instance. Template defaults can initialize missing values but should not silently replace saved values during switching.

Themes can supply shared typography, colors, and defaults; templates define compositions. Whether these ship as separate packages remains open.

## Assets, figures, and captions

An asset represents a source file and its intrinsic metadata:

```ts
type ImageAsset = {
  id: string;
  source: string; // Portable project reference; storage format remains open.
  width: number;
  height: number;
  metadata?: {
    title?: string;
    description?: string;
    credit?: string;
  };
};
```

An editorial figure represents a photograph as used in the publication:

```ts
type Figure = {
  id: string;
  image: AssetRef;
  caption?: TextRef;
  credit?: TextRef;
  altText?: string;
};
```

Reference types here denote stable document identifiers; their concrete encoding is undecided.

Proposed default: a caption belongs to an editorial figure rather than its image file or its template frame. A travel book and an exhibition catalogue can use the same image asset with different captions. Asset metadata may initialize a caption, but copying from metadata should be an explicit operation with clear subsequent editing behavior.

Multiple placements can reference one figure when its caption should stay synchronized. Separate figures can reference the same asset when their editorial treatment differs. Duplication semantics must be visible to the user.

A caption is ordinary text with an explicit relationship to a figure. It does not require a separate text-rendering engine. A template may display, omit, or reposition it:

```tsx
<PhotoFrame source={inputs.figure.image} {...photoBounds} />
<TextFrame source={inputs.figure.caption} style="caption" {...captionBounds} />
```

Standalone text remains supported. Text placed near an image is not automatically its caption.

### Alternatives still under consideration

| Approach | Benefit | Cost |
| --- | --- | --- |
| Caption only in asset metadata | Simple reuse and import | Conflates source description with publication-specific copy |
| Caption as an unrelated text field | Maximum placement freedom | Association is lost during reordering and template switching |
| Caption linked to an editorial figure | Preserves meaning while reusing assets | Adds a concept and requires clear reference/copy behavior |

The figure approach is a recommendation for discussion, not a requirement already accepted.

## Small primitives, extensible schemas

The core contract should support asset references, text/story references, scalar values, records, lists, and optional values. Reusable schemas compose these into concepts such as Figure, PhotoStory, and CalendarPage.

The layout engine should not need special knowledge of every publishing concept. It must understand structure, references, validation, and supported rendering primitives. Schema packages can express domain relationships.

For example:

```ts
type CalendarPageInputs = {
  period: { year: number; month: number };
  figure?: FigureRef;
};
```

A calendar component declares validation and inspector controls for these inputs. Its implementation expands them into text, lines, and rectangles. The document stores the chosen period. Locale and first weekday may be document preferences with defaults; fonts and cell borders are template styling.

Changing a calendar template should preserve the calendar period where compatible. This is one reason that parameter names and types alone may be insufficient: shared schema identity and meaning also matter.

## Stories and linked text frames

Continuous text belongs to a story, not to individual frames. The complete story is stored once, initially as plain paragraphs or eventually as structured rich text.

A template exposes text regions and may declare a default flow order within a page or spread. Document bindings connect instantiated regions, including across page boundaries:

```ts
const flow = {
  storyId: "introduction",
  regions: [
    { pageId: "page-1", regionId: "body" },
    { pageId: "page-2", regionId: "body" },
  ],
};
```

An ordered list is one possible encoding; linked frames are another. The persisted representation should have one authoritative flow order.

The layout engine computes the text range displayed in each region and the continuation position. Those fragments are derived output and must not become independent copies of the story.

For the initial implementation:

- Pages and continuation links are explicit.
- Remaining text yields an overflow diagnostic.
- Invalid references, duplicate region assignments, and invalid flow structures are diagnosed.
- Automatic creation of continuation pages is deferred.

Automatic pagination would require policies for selecting continuation templates, handling headings and images, and terminating layout.

Text measurement and shaping need an authoritative strategy shared by preview and export. The prototype passes browser-calculated lines to CoreText, but browser and native font metrics can still diverge. Rich text, hyphenation, paragraph rules, and widow/orphan handling remain separate design work.

## Flexible and specialized regions

Templates may expose a constrained choice:

```ts
{
  id: "main",
  accepts: ["figure", "story"],
  optional: true
}
```

The template defines presentation for each accepted type. A figure may expand into an image/caption arrangement; a story may fill the region with flowing text. Some regions remain specialized, such as a running header or calendarium.

Assigning a story to a region creates or selects a story reference. Linking another text region continues that story rather than copying its contents.

Empty-region behavior must be explicit: preserve space, hide the region, or select an alternate composition. Accepting multiple content types does not imply automatic arbitrary reflow.

A flexible region also needs stable editing identities for its expanded child frames so that selections and presentation adjustments survive recomputation.

## Template switching

The proposed promise is: switching preserves content and explains what needs adaptation. It does not guarantee an unchanged composition or that every template can show all content.

Switching should produce a reviewable mapping result:

1. Compatible inputs mapped directly.
2. Ambiguous inputs requiring a mapping choice.
3. Retained content that will not be displayed.
4. Spatial problems such as text overflow or poor image resolution.

Field-name equality alone is insufficient. Compatibility should use declared schemas, versions, and explicit mappings. Required inputs and collection cardinality must be checked.

Content that is omitted must remain accessible in the document. Existing flow bindings must be remapped or reported as unresolved; a switch must not silently truncate a story or reconnect it to unrelated text.

Crop and zoom belong to placements. A figure or asset may provide a reusable focal-point preference, but different frame proportions can require different crops. Whether old template-specific adjustments are restored when switching back is open.

## React and the rendering boundary

React or plain TypeScript functions can author templates. The saved content model and validation contract should remain independent of React.

Recommended initial boundary: components produce inspectable layout primitives with geometry, content bindings, stable identities, and editing capabilities. The layout engine resolves those primitives into pages and diagnostics for preview and export.

```text
Document content + template instance bindings + presentation state
                              |
                 Template/component expansion
                              |
                 Layout and text-flow engine
                              |
                 Resolved pages + diagnostics
                              |
                       Editor / PDF export
```

Extensible computation does not require unrestricted DOM/CSS rendering. Calendars and many charts can be expressed through a bounded vector vocabulary.

Arbitrary React DOM/CSS would substantially expand export and inspection requirements. Support for it should be a deliberate later decision. Template code execution also requires a clear trust boundary before third-party packages are supported.

## Agent-assisted authoring

The first workflow can use normal code-editing tools to create template files. An MCP interface can later expose:

- Template contracts, schemas, and supported primitives.
- Validation of bindings, geometry, and text flows.
- Preview rendering against representative sample content.
- Screenshots and diagnostics for iterative correction.

The feedback loop matters more than the transport. Generated templates should pass the same validation as manually authored templates.

## Proposed first implementation slice

1. Define stable content references and a versioned, durable project representation.
2. Add stories and explicit cross-page flow with fixed pages and overflow reporting.
3. Model an editorial figure with optional caption; keep standalone text available.
4. Declare template input schemas and explicit bindings.
5. Demonstrate three compatible templates switching without content loss.
6. Add a parameterized calendar component as an extensibility test.

The order is tentative; persistence and text-layout feasibility should be explored before committing to a public template API.

Acceptance scenarios:

- One story flows across two pages; resizing a frame redistributes text without changing stored content.
- Two figures share an image asset but have different captions.
- A shared figure displayed twice updates both captions when edited.
- Switching to a template with fewer regions retains unplaced figures and undisplayed text.
- A broken flow mapping is reported rather than silently dropping text.
- A calendar keeps its selected month/year when changing compatible templates.
- Preview and exported PDF are compared for text breaks, crops, and geometry using representative fonts and content.

## Open questions

### Content and editorial identity

- Should importing a photo create only an asset, or also a default figure?
- Should adding the same photo twice reuse a figure or create independent editorial figures?
- Should captions be inline text values, references to ordinary stories, or a restricted text type? Which formatting and flow behavior is appropriate?
- Is a reusable focal point asset-level metadata, figure-level editorial preference, or both with an explicit override order?
- How should photo lists preserve ordering and caption association across layouts?

### Schemas and compatibility

- Which schemas ship with the core, and can projects define their own?
- How are schemas identified, versioned, and migrated?
- Should bindings target schema paths, stable field identifiers, semantic roles, or a combination?
- What constitutes automatic compatibility, and when must the user review a mapping?
- How should templates express accepted list sizes, optional fields, and alternative compositions?

### Text flow

- What story representation is needed initially: plain text, paragraphs, or rich-text nodes?
- How does the user create, inspect, and repair cross-page flow links?
- Can one story participate in multiple independent flows, and if so, with what meaning?
- Which engine can provide reliable text measurement/shaping for both preview and PDF?
- What are the eventual policies for automatic continuation pages and paragraph layout?

### Presentation and component extensibility

- What is the minimum useful set of layout and drawing primitives?
- Should templates primarily be plain TypeScript, React components, or support both?
- Where is the boundary between theme, template, and component package?
- Which user overrides are allowed, and how are they scoped and restored across switches?
- How are third-party template dependencies, fonts, and execution permissions handled?
- Are unrestricted HTML/CSS components needed, or is vector composition sufficient?

### Persistence and interaction

- What portable format stores content, assets, schemas, template versions, and bindings?
- What happens if a required template or component package is unavailable?
- How are shared-reference edits distinguished from edits to independent copies?
- How does the editor present retained but currently unplaced content?
- Should incompatible template switches be blocked, previewed, or applied with unresolved bindings?
