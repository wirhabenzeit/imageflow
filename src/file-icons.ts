import { useEffect, useState } from 'react';

// System document icons, shared by every list and kept for the life of the window. A type without an icon
// (or a platform that cannot supply one) is remembered as missing, so it is asked for once.
const icons = new Map<string, string | undefined>();

export const fileExtension = (name: string) => (/\.([a-z0-9]{1,10})$/i.exec(name)?.[1] ?? '').toLowerCase();

export function useFileIcons(extensions: string[]) {
  const [, loaded] = useState(0);
  const wanted = JSON.stringify([...new Set(extensions)].filter((extension) => !icons.has(extension)).slice(0, 64));
  useEffect(() => {
    const asked: string[] = JSON.parse(wanted);
    const api = window.imageflow;
    if (!asked.length || !api) return;
    let active = true;
    // A failed request is not remembered, so a later render can ask again; a type the system has no icon for is.
    void api.fileIcons(asked).then((found) => {
      for (const extension of asked) icons.set(extension, found[extension]);
      if (active) loaded((count) => count + 1);
    }, () => {});
    return () => { active = false; };
  }, [wanted]);
  return (extension: string) => icons.get(extension);
}
