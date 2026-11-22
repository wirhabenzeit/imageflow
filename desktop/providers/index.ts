import type { PhotoLocator } from '../../src/source-locator';
import type { SourceProvider } from '../source-provider';
import { linkedProvider, packageProvider } from './files';

// A provider's methods take its own locators, and each is only ever handed those: `providerOf` picks it by the
// locator's own tag.
const providers: Record<PhotoLocator['provider'], SourceProvider<PhotoLocator>> = { package: packageProvider, linked: linkedProvider };
/** The provider that reads a photo's locator (ADR 0011, Source providers). */
export const providerOf = (locator: PhotoLocator) => providers[locator.provider];
