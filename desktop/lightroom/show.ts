import { gte, valid } from 'semver';
import type { LightroomLocator } from '../../src/source-locator';
import type { LightroomBridge } from './bridge';
import { launchLightroom } from './launch';
import { parseResult, showResultSchema, showSince } from './protocol';

const photosOf = (count: number) => count === 1 ? 'the photo' : count + ' photos';
const hiddenBy = 'A filter or a collapsed stack in Lightroom may hide ';

/**
 * Show in Lightroom Classic: selects the photos in Lightroom, in Develop or else in Library, and brings it to the front. Nothing in the
 * catalog changes. Throws why none could be shown; returns what to tell the user when only some were.
 */
export async function showInLightroom(bridge: Pick<LightroomBridge, 'connection' | 'request'>, locators: readonly LightroomLocator[],
  front: () => Promise<void> = launchLightroom): Promise<string | undefined> {
  if (!locators.length) throw new Error('Choose photos from Lightroom Classic.');
  const { connection } = bridge;
  if (!connection) throw new Error('Lightroom Classic is not running, or its ImageFlow plugin is not connected.');
  const uuids = locators.filter(({ catalog }) => catalog === connection.catalog.id).map(({ uuid }) => uuid);
  if (!uuids.length) throw new Error('Another Lightroom catalog is open' + (connection.catalog.name ? ' (' + connection.catalog.name + ')' : '') + '.');
  // An older plugin does not answer a job it does not know: asking it would only run into the timeout.
  const version = valid(connection.plugin.version);
  if (!version || !gte(version, showSince)) {
    throw new Error('The ImageFlow plugin in Lightroom Classic is too old to show photos (' + connection.plugin.version + '). Choose Update Plugin in Settings → Sources, then quit and reopen Lightroom Classic.');
  }
  const { shown, missing = [] } = parseResult(showResultSchema, await bridge.request('show', { uuids }, { timeout: 30_000 }), 'show');
  const known = uuids.length - missing.length;
  if (known <= 0) throw new Error(uuids.length === 1 ? 'The photo is no longer in the Lightroom catalog.' : 'The photos are no longer in the Lightroom catalog.');
  if (!shown) throw new Error('Lightroom Classic could not select ' + photosOf(known) + '. ' + hiddenBy + (known === 1 ? 'it.' : 'them.'));
  // Opening an app that runs brings it to the front.
  await front();
  if (shown === locators.length) return undefined;
  const elsewhere = locators.length - uuids.length, hidden = known - shown;
  return 'Showing ' + shown + ' of ' + locators.length + ' photos in Lightroom Classic.' +
    (hidden > 0 ? ' ' + hiddenBy + (hidden === 1 ? 'the other one.' : 'the others.') : '') +
    (missing.length ? ' ' + missing.length + (missing.length === 1 ? ' is' : ' are') + ' no longer in the catalog.' : '') +
    (elsewhere ? ' ' + elsewhere + (elsewhere === 1 ? ' is' : ' are') + ' in another catalog.' : '');
}
