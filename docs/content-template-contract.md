# Platform, template, and project contract

Status: proposed baseline for discussion. This document defines responsibilities and illustrative interfaces, not an implemented API. Exact serialization and rendering APIs remain open.

## Goals and baseline

Imageflow separates reusable project content from programmable page design. Users assign photos and Markdown documents visually; templates define their presentation and expose small, understandable parameter controls.

The proposed baseline is:

- Two native content types: photos and Markdown documents.
- A lightweight project photo index with editable metadata, including captions.
- Template-declared parameters at document, page/spread, and element scopes.
- Two distinct content-box types: photo boxes and Markdown text boxes. Mixed boxes are deferred.
- Platform-managed text continuation between text boxes, including across pages.
- Parameterized generated elements, such as calendars, without adding native content types.
- Project-owned content and saved parameter values; template-owned declarations and defaults.

There is no separate editorial figure or placement object in this baseline. Content assignments, crop state, and parameter values are saved as project instance state rather than introduced as additional user-facing entities.

## Responsibility contract

| Concern | Platform | Template | Project |
| --- | --- | --- | --- |
| Content | Defines photo/Markdown capabilities and reference semantics | Reads assigned content through those capabilities | Owns files, photo index, metadata, and Markdown |
| Parameters | Validates types, resolves defaults, generates controls | Declares stable keys, scopes, labels, types, defaults, constraints | Saves user values at each instance scope |
| Boxes | Provides typed photo/text primitives and assignment editing | Declares identifiers, type, geometry, styling, optionality | Saves content assignments and photo crop adjustments |
| Text flow | Parses supported Markdown, lays out continuations, reports overflow | Defines text geometry/style and optional default flow order | Saves Markdown references and explicit flow connections |
| Generated elements | Provides supported drawing and interaction primitives | Implements components, such as a calendar | Saves component parameter values |
| Output | Produces inspectable resolved pages for preview/export | Expands design into supported primitives | Supplies content and configuration |
| Persistence | Defines format, validation, and reference handling | Declares compatible API/package version | Records template versions and durable instance state |

A template declaring a variable does not own its user-supplied value. Definitions belong to the template; values belong to the project using it.

## Native content

### Photos and the photo index

Photos remain ordinary source files. A project index associates each with a stable identifier and editable publication metadata:

```ts
type ProjectPhoto = {
  id: string;
  path: string;
  title?: string;
  caption?: string;
  credit?: string;
  altText?: string;
};
```

The index is a sidecar to the files, not an inference from nearby text. Stable identifiers are recommended so renaming a file updates its path without breaking assignments. The exact index format is open.

Imported embedded metadata may initialize fields. How explicit edits override imported metadata, and whether later imports refresh untouched fields, needs a defined policy.

Caption text belongs to the project photo. The template decides whether and how it is displayed. Changing templates must not rewrite or delete the caption.

Initially, a project photo has one caption shared by all its uses. Whether to support contextual caption overrides or multiple records referencing one source file is deferred. Neither is required to introduce a new content type now.

### Markdown documents

Markdown files hold continuous text independently of boxes:

```ts
type ProjectMarkdown = {
  id: string;
  path: string;
};
```

Assigning a document references the source rather than copying it into a box. Layout fragments are derived; edits affect the Markdown source.

The platform must specify a supported Markdown dialect. Paragraphs, headings, emphasis, links, and lists are candidates for the initial subset. Tables, raw HTML, and embedded photos need explicit decisions; arbitrary browser HTML is not implied.

Markdown documents are the source of flowing stories. No separate persisted story content type is required.

## Three parameter scopes

| Scope | Meaning | Example | Editor location |
| --- | --- | --- | --- |
| Document | Shared across the project's use of a template | Show page numbers | Document settings |
| Page/spread instance | Varies between compositions using the same definition | Calendar month/year | Selected page/spread settings |
| Element instance | Local to one identifiable element | Show this photo's caption | Element popover |

Page and spread are alternatives at the same scope level, not two additional levels. A spread can represent neighboring pages, with known page boundaries and a shared coordinate system.

A template package may provide multiple page/spread definitions. Shared document settings should have one declaration per package; page/spread and element values are resolved for the selected instances.

Supported parameter types should include plain text, booleans, integers, floating-point numbers, dates, and simple schema-defined objects. Values should be serializable; functions and arbitrary executable objects are not parameter values. Date encoding, nullability, and object limits remain open.

Each parameter declaration needs a stable key, label, type, default or required status, and optional validation constraints. The platform generates basic controls from declarations.

### Defaults and sharing

Scope identifies where a value is stored. It does not automatically make unrelated parameters inherit from each other.

For example, four photo elements may each declare a `showCaption` boolean. Their instance values are independent. A document-level caption default could be added later, with explicit inheritance semantics, but is not necessary for the initial contract.

Templates may read document, enclosing page/spread, and local element values. Precedence and defaults must be explicit rather than based on coincidentally matching names.

Defaults fill absent values. They do not silently replace saved values when reloading or switching templates.

## Typed content boxes

A photo box accepts a photo reference. A text box accepts Markdown through an assignment or text flow. Either may be empty if the template allows it.

```ts
const elements = {
  photoA: {
    kind: "photoBox",
    parameters: {
      showCaption: {
        type: "boolean",
        label: "Show caption",
        default: true,
      },
    },
  },
  body: {
    kind: "textBox",
  },
  calendar: {
    kind: "generated",
  },
};
```

This example omits geometry and styling. Parameter schemas are illustrative.

A photo box cannot receive Markdown in the first version. Changing a four-photo spread into a composition containing text means selecting or authoring a different template composition, rather than changing one box's type dynamically.

Typed boxes keep element popovers coherent: a photo box can expose caption visibility and platform crop controls; a text box exposes Markdown assignment and platform continuation controls. Flow links and crop values are platform-defined project state, not arbitrary custom variables a template must reinvent.

The template may expose additional element parameters, but they should be meaningful for that element's fixed role. Parameter-dependent alternate content types are deferred.

An empty box retains its declared type. Its empty-state behavior is defined by the template: preserve space, hide artwork, or use a supported alternate composition. Editor drop targets may still be shown while empty.

## Concrete example: four-photo spread

The template declares four stable photo-box identifiers: `photoA` through `photoD`. Each declares its own `showCaption` boolean. The project assigns photos and stores independent values:

```ts
const spread = {
  id: "spread-1",
  definitionId: "four-photos",
  parameterValues: {},
  elements: {
    photoA: { photoId: "photo-01", parameterValues: { showCaption: true } },
    photoB: { photoId: "photo-02", parameterValues: { showCaption: false } },
    photoC: { photoId: "photo-03", parameterValues: { showCaption: true } },
    photoD: { photoId: "photo-04", parameterValues: { showCaption: false } },
  },
};
```

This is an example of saved instance state, not a commitment to this file format. Repeated parameter keys are scoped by element identity, so four unrelated spread-level names are unnecessary.

Clicking `photoB` opens its parameter popover. Editing its caption text changes the project photo metadata; toggling caption visibility changes only this element instance. Using the same photo elsewhere can display its shared caption independently.

Missing caption text produces no caption artwork even if visibility is enabled. It must not display a placeholder in exported output.

## Text continuation

The platform understands text flow. The template provides text boxes, their styling, and optional default ordering within a page/spread. The project saves the actual document assignment and connections across instantiated boxes.

One possible representation is:

```ts
const flow = {
  markdownId: "intro",
  boxes: [
    { spreadId: "spread-1", elementId: "bodyLeft" },
    { spreadId: "spread-1", elementId: "bodyRight" },
    { spreadId: "spread-2", elementId: "body" },
  ],
};
```

An ordered list or linked-box representation can work; there must be one authoritative order. A flow is project composition data referencing a Markdown document, not a third native content type.

The engine computes which source range fits in each box and continues from that position. Source text is never persisted as separate fragments per box.

Initial behavior:

- Pages/spreads and continuation connections are explicit.
- Templates can suggest local defaults; saved project connections are authoritative.
- Invalid references, conflicting box assignments, and invalid flow structures are diagnosed.
- Remaining text produces visible overflow diagnostics.
- Automatic creation of continuation pages is deferred.

The editor should let users inspect and connect text boxes using consistent platform controls. Templates should not implement their own competing text-flow mechanisms.

Preview and export need an authoritative text measurement/shaping strategy. Passing browser-selected line breaks to CoreText helps but does not guarantee identical font metrics. Markdown parsing, shaping, continuation positions, hyphenation, and paragraph rules need a focused implementation design.

## Parameterized components: calendar

A calendar is generated template artwork, not native project content. Its template declares page/spread parameters such as:

```ts
const parameters = {
  year: { type: "integer", default: 2026 },
  month: { type: "integer", minimum: 1, maximum: 12, default: 1 },
};
```

The component reads the resolved values and produces text, lines, and rectangles. A neighboring photo box uses the normal native photo assignment mechanism.

Month/year belong to this page/spread instance's saved values. They are not inferred from page order or reset when the template rerenders. Locale and first weekday may be additional parameters.

A component could instead declare element-scoped parameters when appropriate, for example if several independent calendars appear on one spread. The template chooses the declaration scope; the platform handles persistence and editing uniformly.

## Template-to-platform interface

A template package needs to declare:

1. Package identity, version, and supported platform contract version.
2. Document parameter schema.
3. Available page/spread definitions, dimensions, and page boundaries.
4. Page/spread and element parameter schemas.
5. Stable element identities and fixed photo/text box types.
6. Geometry, styling, generated artwork, and optional default text-flow order.
7. Optional compatibility hints or explicit mappings for template changes.

Rendering receives resolved parameters and project content references through a platform-provided context. It returns inspectable primitives carrying element identities so the editor can map clicks to settings and assignments.

React is a possible authoring interface. A React component alone is insufficient unless its output exposes these editing and rendering contracts. Initially, components should compose supported layout/vector primitives rather than arbitrary DOM/CSS. Exact React syntax remains open.

Templates request project changes through platform operations rather than directly mutating files. The platform validates and persists edits, supports undo/redo, and rerenders affected output.

## Editor interaction contract

The platform supplies consistent interactions:

- Select an element by its stable identity.
- Open a popover generated from its declared parameter schema.
- Show native content assignment controls appropriate to the fixed box type.
- Show crop controls for photo boxes and continuation controls for text boxes.
- Edit project photo metadata or Markdown using platform operations.
- Select page/spread and document settings at their corresponding scopes.

Templates supply labels, defaults, constraints, and visual design. A custom component such as a calendar gets basic controls from its schema without implementing a settings UI.

A freeform custom React inspector is not required initially. Whether to allow richer custom controls later remains open.

## Project-to-platform interface

The saved project needs to contain or reference:

- A project format version.
- Photo files and their metadata index.
- Markdown files and stable references.
- Template package identities and pinned versions.
- Ordered page/spread instances and their definition identifiers.
- Document, page/spread, and element parameter values.
- Typed content assignments, crop adjustments, and text-flow connections.

Stable instance and element identifiers let the editor preserve selections and saved values across rerenders. File paths locate content; they should not be the sole identity mechanism.

Resolved geometry and text fragments are caches/output, not authoritative project content.

## Template switching and evolution

Switching preserves source content and reports what needs adaptation. It does not guarantee every layout can display everything.

The platform should:

1. Map compatible typed boxes and parameter values using explicit declarations where available.
2. Ask for mapping where roles are ambiguous; matching names alone do not establish meaning.
3. Retain unused photos, Markdown, metadata, and unmapped state.
4. Report broken text-flow links, required missing values, and overflow.
5. Validate new geometry and crops without rewriting source content.

Photo and Markdown box types provide basic compatibility. Exact migration rules for template-specific parameters remain open. A calendar period should survive when an explicit compatible mapping exists; arbitrary parameter names cannot guarantee that.

Whether prior template-specific settings are restored when switching back is open. Template package upgrades also need migrations rather than silently reinterpreting saved values.

## Relationship to the prototype

The current prototype already separates frame geometry from spread photo/text maps and resolves them into shared SVG/PDF layers. Preserve that intermediate rendering approach.

The proposed contract changes:

- Inline frame-owned text becomes references to Markdown documents.
- Project photo records acquire explicit editable metadata.
- Hardcoded layout definitions become declarative template interfaces.
- Settings are declared at three scopes and stored per project instance.
- Text layout becomes a flow across boxes rather than independent truncation per frame.

This document does not implement those changes. Browser/native export fidelity and a portable project format still require validation.

## Initial implementation and acceptance scenarios

A useful first slice is a saved project with photo metadata, Markdown references, one typed photo/text template, three parameter scopes, and explicit cross-page text continuation. Add a four-photo spread and a parameterized calendar to exercise the contract.

Acceptance scenarios:

- Four photo boxes independently show or hide their captions.
- The same project photo appears twice with shared caption text and independent visibility/crops.
- A text box never offers photo-only parameters or accepts a photo assignment.
- Clicking a calendar element or selecting its spread exposes the parameters at the declared scope.
- Two calendar instances using the same definition retain different months.
- One Markdown file flows through boxes on successive pages; resizing redistributes text without changing the source.
- Switching to fewer boxes retains all source content and reports unresolved flow or assignments.
- Saving and reopening preserves metadata, assignments, parameters, crops, and flow.
- Preview and PDF are compared for text continuation, captions, crops, and page geometry.

## Open questions

### Content and persistence

- Which photo-index format best supports manual editing, portability, and stable identity?
- What is the override policy between imported metadata and project edits?
- Are per-use caption overrides needed, or is one caption per project photo sufficient?
- Which Markdown dialect is supported, especially for tables, embedded images, and raw HTML?
- How are external file edits and moved/missing files detected and reconciled?
- What does the project bundle contain, and how are template packages/fonts pinned?

### Parameters and editor

- What exact serializable schema represents types, dates, constraints, and defaults?
- Is explicit default inheritance needed initially?
- Should document settings apply to one active template package or several packages used together?
- How do generated elements declare click targets and stable identities?
- Are schema-generated controls sufficient before custom inspectors are considered?
- When a parameter changes geometry, how are now-invalid crop or flow settings surfaced?

### Text flow and rendering

- Which layout/shaping engine can produce reliable preview and export output?
- How are Markdown continuation positions represented across blocks and inline formatting?
- How does the editor connect boxes and resolve conflicting assignments?
- Is repeated independent rendering of the same Markdown document supported initially?
- What are the later policies for automatic continuation pages and paragraph layout?
- Which rendering primitives are sufficient for calendars and other generated components?

### Compatibility and extensibility

- How are template contract versions and project migrations handled?
- What mapping declarations make switches predictable without rebuilding a general publishing schema system?
- When should a switch require review rather than be applied immediately?
- Should template-specific state be restored when switching back?
- When, if ever, are mixed photo/Markdown boxes worth introducing?
- What execution boundary is required for third-party React templates?

## Deferred alternatives

Earlier exploration considered editorial figures, general semantic content schemas, and universal photo-or-text regions. Those remain possible extensions, but are not part of this baseline. The current proposal favors two native content types, typed boxes, and template-declared scoped parameters to keep the editor and ownership model understandable.

Agent-assisted template authoring remains a goal. An MCP interface can expose declarations, validation, preview rendering, and diagnostics after the underlying contract is established.
