import { useEffect, useRef, useState } from 'react';

// Reusable address box with live Google Places autocomplete. `suggest(text)`
// returns [{description, placeId}]; picking one calls onPick(item); typing +
// submit calls onText. Used by the Drive nav panel.
export default function AddressSearch({ placeholder, actionLabel, suggest, onPick, onText }) {
  const [val, setVal] = useState('');
  const [sugs, setSugs] = useState([]);
  const [busy, setBusy] = useState(false);
  const tRef = useRef(0);
  const reqRef = useRef(0);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; clearTimeout(tRef.current); reqRef.current++; }, []);
  const onChange = (v) => {
    const q = v.trim().replace(/\s+/g, ' ');
    setVal(v);
    clearTimeout(tRef.current);
    if (q.length < 4) { reqRef.current++; setSugs([]); return; }
    const req = ++reqRef.current;
    tRef.current = setTimeout(() => {
      suggest(q)
        .then(s => { if (req === reqRef.current) setSugs((s || []).slice(0, 4)); })
        .catch(() => { if (req === reqRef.current) setSugs([]); });
    }, 360);
  };
  const choose = (item) => { setBusy(true); setSugs([]); setVal(item.description); Promise.resolve(onPick(item)).finally(() => { if (aliveRef.current) setBusy(false); }); };
  const submit = (e) => { e.preventDefault(); if (!val.trim()) return; setBusy(true); setSugs([]); Promise.resolve(onText(val.trim())).finally(() => { if (aliveRef.current) setBusy(false); }); };
  return (
    <form className="addrBox" onSubmit={submit} autoComplete="off">
      <div className="addrRow">
        <input value={val} onChange={e => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck="false" />
        <button type="submit" className="addrGo" disabled={busy}>{busy ? '…' : actionLabel}</button>
      </div>
      {sugs.length > 0 && (
        <ul className="addrSug">
          {sugs.map(s => <li key={s.placeId}><button type="button" onClick={() => choose(s)}><span className="pin">📍</span>{s.description}</button></li>)}
        </ul>
      )}
    </form>
  );
}
