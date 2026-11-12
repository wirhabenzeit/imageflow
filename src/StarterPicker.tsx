import { useState } from 'react';
import type { DesktopApi } from './desktop';
import { starters } from './starters';

/** The shared creation picker; both the start window and File → New Book use this catalogue. */
export function StarterPicker({ api }: { api?: DesktopApi }) {
  const [selected, setSelected] = useState<string>(starters[0].id);
  return <main className="studio starter-picker">
    <header><h1>Choose a starter</h1><p className="muted">Your book keeps its own copy. Make it yours.</p></header>
    <div className="starter-choices" role="radiogroup" aria-label="Starter template">
      {starters.map((starter) => <label className="starter-choice" key={starter.id}>
        <input type="radio" name="starter" value={starter.id} checked={selected === starter.id} onChange={() => setSelected(starter.id)} />
        <span className="starter-art" aria-hidden="true"><span>FIELD<br />NOTES</span><span>Along the coast</span></span>
        <span className="starter-description"><strong>{starter.label}</strong><span>{starter.description}</span><small>{starter.formats}</small></span>
      </label>)}
    </div>
    <footer><button onClick={() => void api?.chooseStarter()}>Cancel</button><button className="primary" disabled={!api} onClick={() => void api?.chooseStarter(selected)}>Continue…</button></footer>
  </main>;
}
