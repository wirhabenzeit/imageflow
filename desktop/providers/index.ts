import type { Locator } from '../../src/source-locator';
import type { SourceProvider } from '../source-provider';
import { linkedProvider, packageProvider } from './files';

// A provider's methods take its own locators, and each is only ever handed those: `providerOf` picks it by the
// locator's own tag.
const providers = new Map<string, SourceProvider<Locator>>([
  ['package', packageProvider as unknown as SourceProvider<Locator>], ['linked', linkedProvider as unknown as SourceProvider<Locator>]]);

/** The provider that reads a photo's locator (ADR 0011, Source providers). */
export function providerOf(locator: Locator): SourceProvider<Locator> {
  const provider = providers.get(locator.provider);
  if (!provider) throw new Error('This photo names no source this version of ImageFlow can read.');
  return provider;
}

/**
 * Adds a provider and returns a function that removes it again. A provider without files registers here together with
 * its locator kind (`registerLocatorKind` in src/source-locator.ts); until one ships, only tests do.
 */
export function registerProvider<L extends Locator>(provider: SourceProvider<L>): () => void {
  if (providers.has(provider.provider)) throw new Error('The source provider ' + provider.provider + ' is registered already.');
  providers.set(provider.provider, provider as unknown as SourceProvider<Locator>);
  return () => { if (providers.get(provider.provider) === (provider as unknown)) providers.delete(provider.provider); };
}
