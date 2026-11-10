# Platform, template, and project contract

Status: historical design proposal, superseded for implementation by [Template API (contract 1)](template-api.md) and [v1 decisions](v1-decisions.md). Do not copy the illustrative interfaces below into current templates. Current code uses `contract`, `definition`, and `params`; supports one or several named formats per template (one per book), React/Chromium rendering, and multi-column Markdown boxes.

Original proposal follows. Status: proposed baseline for discussion. This document defines responsibilities and illustrative interfaces, not an implemented API. Exact serialization and rendering APIs remain open. [validation-plan.md](validation-plan.md) orders the open points and the experiments needed to resolve them. Decisions for the first version are in [v1-decisions.md](v1-decisions.md), the rendering decision in [decisions/0001-rendering.md](decisions/0001-rendering.md), and the template API draft in [template-api.md](template-api.md).

## Goals and baseline

Imageflow separates reusable project content from programmable page design. Users assign photos and Markdown documents visually; templates define their presentation and expose small, understandable parameter controls.

The proposed baseline is:

- Two native content types: photos and Markdown documents.
- A lightweight project photo index with editable metadata, including captions.
- Template-declared parameters at document, page/spread, and element scopes.
- Two distinct content-box types: photo boxes and Markdown text boxes. Mixed boxes are deferred.
- Platform-managed text continuation: assigning the same Markdown source to multiple text boxes continues it in deterministic order, including across pages.
- Short per-instance text, such as titles and labels, as template string parameters rather than Markdown documents.
- Parameterized generated elements, such as calendars, without adding native content types.
- Project-owned content and saved parameter values; template-owned declarations and defaults.

There is no separate editorial figure or placement object in this baseline. Content assignments, crop state, and parameter values are saved as project instance state rather than introduced as additional user-facing entities.

## Responsibility contract

| Concern | Platform | Template | Project |
| --- | --- | --- | --- |
| Content | Defines photo/Markdown capabilities and reference semantics | Reads assigned content through those capabilities | Owns files, photo index, metadata, and Markdown |
| Parameters | Validates types, resolves defaults, generates controls | Declares stable keys, scopes, labels, types, defaults, constraints | Saves user values at each instance scope |
| Boxes | Provides typed photo/text primitives and assignment editing | Declares identifiers, type, geometry, styling, optionality | Saves content assignments and photo crop adjustments |
| Text flow | Parses supported Markdown, lays out continuations, reports overflow | Defines text geometry/style and optional default flow order | Saves Markdown assignments; flow order derives from assignments and template order |
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

Supported parameter types should include single- and multi-line plain text, booleans, integers, floating-point numbers, dates, and simple schema-defined objects. Values should be serializable; functions and arbitrary executable objects are not parameter values. Date encoding, nullability, and object limits remain open.

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

Typed boxes keep element popovers coherent: a photo box can expose caption visibility and platform crop controls; a text box exposes Markdown assignment and platform continuation controls. Derived flow ordering and saved crop values are platform-defined concerns, not arbitrary custom variables a template must reinvent.

The template may expose additional element parameters, but they should be meaningful for that element's fixed role. Parameter-dependent alternate content types are deferred.

An empty box retains its declared type. Its empty-state behavior is defined by the template: preserve space, hide artwork, or use a supported alternate composition. Editor drop targets may still be shown while empty.

### Short text as string parameters

Titles, chapter labels, subtitles, and similar short text are not Markdown boxes. A template declares them as string parameters at the appropriate scope, typically page/spread or element, and renders the value in its design. A multi-line string preserves explicit line breaks, as in a two-line heading.

```ts
const parameters = {
  heading: { type: "string", multiline: true, label: "Heading", default: "" },
  eyebrow: { type: "string", label: "Chapter label", default: "" },
};
```

The template marks where each string is rendered so the editor can map a click on the canvas to the parameter and edit it in place, in addition to the generated settings control. The platform measures rendered string parameters against their declared area and reports overflow in the same way as for Markdown boxes. String parameters do not flow or continue; formatting within them is limited to what the template applies.

The value belongs to the project instance like any other parameter value. Template switching maps it only through explicit compatible declarations.

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

## Markdown rendering and text continuation

### User-facing continuation rule

Assigning the same Markdown source to multiple text boxes means that the text continues through them. Users do not need to create a separate flow object or manually link each box.

Order is deterministic: project page/spread order first, then an explicit template-declared text-box order within each page/spread. Visual position alone is insufficient. For spreads, that declared order may cross the neighboring page boundary.

The project saves Markdown assignments; the platform derives the ordered flow from those assignments and template declarations. A derived flow may be cached internally but is not a separate authoritative user-managed connection list.

Initially, the same source always means continuation. Independently repeating an entire source is deferred. A template with multiple text boxes must supply an unambiguous order; missing or duplicate ordering is a validation error.

### Rendering ownership

The platform parses the supported Markdown dialect into a consistent document structure and renders its content. The template supplies scoped CSS for supported elements such as paragraphs, headings, emphasis, links, and lists.

Illustrative authoring interface:

```tsx
<MarkdownBox id="body" className="editorial-text" />
```

The template can style `.editorial-text p`, `.editorial-text h2`, and other supported elements. The platform supplies assigned content and manages fragmentation. Templates do not replace the Markdown parser or arbitrarily transform the source structure in the initial contract.

Markdown determines structure; template CSS determines appearance; the platform owns rendering, measurement, and continuation. Box dimensions and flow-relevant styles must be measurable and deterministic. Style scoping and the allowed CSS subset need specification.

### Browser-assisted layout

The browser can handle font shaping, line wrapping, and inline/paragraph layout inside a box. It does not automatically continue content through arbitrary separate boxes.

Breakpoints depend on the actual box geometry and applied styles. They are derived layout results, never intrinsic properties of the Markdown source.

A candidate algorithm is:

1. Parse the source into a structure retaining stable source positions.
2. Render candidate content using the box's actual CSS and dimensions.
3. Wait for required fonts and any supported intrinsic-size content.
4. Use DOM measurements, potentially including text Range rectangles, to locate a valid fitting boundary.
5. Fragment at a supported paragraph or line boundary and continue the remainder in the next box, using that box's styles.
6. Report source content remaining after the final box as overflow.

This is a hypothesis to prototype, not a validated algorithm. Splitting changes DOM structure and can change margins, selectors, and layout, so measuring and then cutting once is not sufficient in every case. The implementation must verify the resulting fragments and converge reliably.

A style, font, geometry, source, or box-order change invalidates affected layout. Reflow proceeds from the earliest affected box onward. Markdown source remains unchanged.

### Complexity and initial limits

Reliable fragmentation is a substantial engineering task and an architectural risk. Measurement avoids building a typography engine from scratch, but does not solve structural splitting.

Difficult cases include preserving inline emphasis/links, continuing paragraphs and lists, list numbering, margin behavior, headings kept with following text, widow/orphan rules, and CSS whose behavior changes after fragmentation.

A first version should target rectangular boxes, paragraphs/headings, basic inline formatting, and a documented set of styles. Lists need explicit continuation tests before being promised. Tables, raw HTML, embedded photos, floats, columns, and arbitrary CSS should not be assumed supported.

Pages/spreads are explicit. Automatic continuation-page creation is deferred.

## Browser versus native PDF export

Preferred direction to investigate: React templates rendered through a controlled browser engine, with browser-generated PDF. This is provisional until text flow and intended printer requirements are tested.

React describes the template; the browser performs layout and PDF rendering. A controlled Chromium export process should wait for fonts/content, apply explicit page dimensions and print styles, use original-resolution photos, and render the already resolved text fragments.

Export should not intentionally repaginate the story independently. Identical preview/export fragments still require verification: browser versions, print CSS, font availability, and page sizing can affect output.

| Approach | Benefits | Constraints |
| --- | --- | --- |
| Browser layout and PDF | One rendering engine; broad HTML/CSS/SVG support; fewer preview/export translation rules | Arbitrary linked-box flow still needs implementation; printer-specific PDF requirements need validation |
| Shared primitives with native PDF | Direct control over PDF geometry and page boxes; existing prototype foundation | CSS/effects must be restricted or reproduced; typography can differ between engines |
| Browser PDF plus post-processing | May address specific PDF packaging requirements | Does not automatically solve color management, font issues, or PDF/X compliance |

Browser PDF may be suitable for photobook workflows accepting ordinary RGB PDFs. Validated PDF/X, particular CMYK profiles, exact TrimBox/BleedBox requirements, and other prepress constraints can require additional tooling or native export. Requirements should come from the actual printer.

The existing Swift exporter provides useful control over page geometry and PDF boxes, but should not be treated as an arbitrary React/CSS renderer. Supporting unrestricted browser effects in a second renderer creates significant maintenance work.

No final export architecture is selected by this document. Preserve the existing implementation until a browser experiment supplies evidence for replacement or a hybrid approach.

## Early technical prototype: text flow and export

Text flow should be tested before committing to a public rendering API.

Build a focused experiment with one Markdown source assigned to three differently sized and styled text boxes across pages. Include headings, paragraph splits, emphasis/links, and representative lists. Exercise font and size changes, captioned photos, a calendar, and selected visual effects.

Compare an appropriate existing pagination library with a small browser-measurement implementation. A library must be evaluated for arbitrary frame sequences, rather than assumed suitable because it paginates conventional pages.

Evaluate:

- Deterministic continuation with no omitted or duplicated source text.
- Preservation of inline structure and defined paragraph/list semantics.
- Stable reflow after font loading and changes in styles or geometry.
- Overflow behavior and useful diagnostics for unsupported content.
- Interactive layout performance on representative document sizes.
- Preview/PDF agreement for line breaks, crops, typography, effects, and page geometry.
- Output against an intended printer's specifications, including resolution and PDF boxes.

Use the results to choose a flow implementation, initial Markdown/CSS limits, and browser/native export strategy. This is exploratory validation, not an implementation milestone already completed.

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
3. Available page/spread definitions, dimensions, and page boundaries, including the print formats the template supports (trim, bleed, safe area, delivery unit, output constraints; see [print-targets.md](print-targets.md)). In v1, print formats are declared in the template and the project selects one.
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
- Show crop controls for photo boxes and Markdown assignment/continuation information for text boxes.
- Edit project photo metadata or Markdown using platform operations.
- Select page/spread and document settings at their corresponding scopes.

Templates supply labels, defaults, constraints, and visual design. A custom component such as a calendar gets basic controls from its schema without implementing a settings UI.

A freeform custom React inspector is not required initially. Whether to allow richer custom controls later remains open.

## Illustrative TypeScript declaration format

This is a proposed API shape, not an implemented or finalized SDK. Imageflow could publish a small versioned TypeScript API with runtime validation. A template entry point can contain both declarations and React rendering, or import components from other files; no separate JSON registry is required.

Keep content boxes separate from ordinary variables:

- `parameters` declares editable scalar/object values at its enclosing scope.
- `boxes` declares typed places accepting references to project content.
- `render` supplies the design using those declared boxes.
- Generated `elements` can declare local parameters without becoming native content boxes.

React props are implementation details; the explicit declaration is the editor/persistence contract. The editor does not infer input types by inspecting arbitrary JSX or register the same input twice.

```tsx
import {
  defineTemplate,
  PhotoBox,
  MarkdownBox,
} from "imageflow";

export default defineTemplate({
  id: "photo-journal",
  version: "0.1.0",
  contractVersion: 1,

  // Document scope
  parameters: {
    showPageNumbers: {
      type: "boolean",
      label: "Show page numbers",
      default: true,
    },
  },

  spreads: {
    story: {
      size: { width: 420, height: 210, unit: "mm" },
      pageBoundary: { axis: "x", position: 210 },

      // Page/spread instance scope
      parameters: {
        background: {
          type: "string",
          label: "Background color",
          default: "#ffffff",
        },
      },

      boxes: {
        hero: {
          type: "photo",
          label: "Main photograph",

          // Element instance scope
          parameters: {
            showCaption: {
              type: "boolean",
              label: "Show caption",
              default: true,
            },
          },
        },

        body: {
          type: "markdown",
          label: "Article",
          flowOrder: 1,
        },
      },

      render: ({ parameters, documentParameters }) => (
        <div
          className="story-spread"
          style={{ background: parameters.background }}
        >
          <PhotoBox id="hero" className="hero" />
          <MarkdownBox id="body" className="editorial-text" />
          {documentParameters.showPageNumbers && (
            <div className="page-number-decoration">
              {/* Platform-provided page numbering would be used here. */}
            </div>
          )}
        </div>
      ),
    },
  },
});
```

The example omits geometry CSS and the caption-rendering interface. CSS would position the boxes and style platform-rendered Markdown. `showCaption` is a declared user value, not automatically executable behavior: the template must consume it through a caption primitive or an explicit render context. The final API must specify how to access box-local parameters and assigned photo metadata without giving templates direct project mutation access.

`PhotoBox` and `MarkdownBox` resolve project assignments using their declared stable identifiers. Element identifiers are scoped to a page/spread definition; the project instance identifier distinguishes repeated uses. A component such as a calendar can use spread parameters or declare a generated element's parameters through the same schema mechanism.

A corresponding project instance could save:

```ts
const instance = {
  id: "spread-01",
  definitionId: "story",
  parameterValues: { background: "#f6f2e8" },
  elements: {
    hero: {
      photoId: "photo-01",
      parameterValues: { showCaption: true },
    },
    body: {
      markdownId: "introduction",
    },
  },
};
```

Template package/version references and document parameter values belong to the enclosing project configuration. Projects save references and values, not JSX. A photo picker is derived from a photo-box declaration, a Markdown picker from a Markdown-box declaration, and ordinary controls from parameter schemas.

Formal validation should check package/contract versions, stable identifiers, parameter types and constraints, page/spread dimensions and boundaries, fixed box types, and unambiguous text-flow ordering. Runtime checks should also verify rendered box identifiers, conflicting/duplicate instances, and required declared boxes. Exact optional/conditional rendering rules remain open.

Open API decisions include the caption primitive, generated-element declaration syntax, scoped parameter access, geometry/style restrictions, and how TypeScript inference connects declarations to render contexts. This example does not settle browser-versus-native export or imply unrestricted DOM/CSS support.

## Project-to-platform interface

The saved project needs to contain or reference:

- A project format version.
- Photo files and their metadata index.
- Markdown files and stable references.
- Template package identities and pinned versions.
- Ordered page/spread instances and their definition identifiers.
- Document, page/spread, and element parameter values.
- Typed content assignments, crop adjustments, and Markdown assignments that determine continuation.

Stable instance and element identifiers let the editor preserve selections and saved values across rerenders. File paths locate content; they should not be the sole identity mechanism.

Resolved geometry and text fragments are caches/output, not authoritative project content.

## Template switching and evolution

Switching preserves source content and reports what needs adaptation. It does not guarantee every layout can display everything.

The platform should:

1. Map compatible typed boxes and parameter values using explicit declarations where available.
2. Ask for mapping where roles are ambiguous; matching names alone do not establish meaning.
3. Retain unused photos, Markdown, metadata, and unmapped state.
4. Report invalid text-box ordering, unresolved Markdown assignments, required missing values, and overflow.
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

A useful first slice is a saved project with photo metadata, Markdown references, one typed photo/text template, three parameter scopes, and assignment-based cross-page text continuation. Add a four-photo spread and a parameterized calendar to exercise the contract.

Acceptance scenarios:

- Four photo boxes independently show or hide their captions.
- The same project photo appears twice with shared caption text and independent visibility/crops.
- A text box never offers photo-only parameters or accepts a photo assignment.
- A two-line spread heading is edited in place on the canvas, stored as a string parameter value, and reported when it no longer fits.
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
- How are Markdown continuation positions represented across blocks and inline formatting, with fragmentation that preserves source coverage?
- How does the editor explain derived flow order and resolve invalid assignments?
- What explicit mechanism, if any, should later allow independent repetition of the same Markdown source?
- What are the later policies for automatic continuation pages and paragraph layout?
- Should a text box support multiple columns, with column count and gap as element parameters? (Deferred; see Deferred alternatives.)
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

Multi-column text boxes are deferred but should remain possible: a Markdown box could declare a column count and gap, as a template default or a user-editable element parameter, and continuation would then run through each column of a box before moving to the next box in the flow order. A fragmenter that uses the browser's column layout to find breaks supports this directly (see the text-flow spike); a measure-and-split fragmenter would need to treat each column as a separate frame.

Agent-assisted template authoring remains a goal. An MCP interface can expose declarations, validation, preview rendering, and diagnostics after the underlying contract is established.
